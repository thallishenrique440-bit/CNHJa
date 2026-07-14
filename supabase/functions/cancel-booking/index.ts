import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check"
import { NotificationService } from '../_shared/NotificationService.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
  telemetry: false,
})

class PaymentProviderResolver {
  static resolveProviderForAppointment(appointmentId: string): string {
    const defaultProvider = Deno.env.get("DEFAULT_PAYMENT_PROVIDER");
    return defaultProvider === "asaas" || defaultProvider === "stripe" ? defaultProvider : "stripe";
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Setup Clients
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing Authorization header');
    }

    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. Authentication
    const { data: { user }, error: authError } = await authClient.auth.getUser()
    if (authError || !user) {
      throw new Error('Unauthorized: Invalid user session')
    }

    const { appointment_id } = await req.json()
    if (!appointment_id) {
      throw new Error('Missing appointment_id')
    }

    // 3. Fetch Appointment
    const { data: appointment, error: fetchError } = await authClient
      .from('appointments')
      .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, student_id, price, date, start_time')
      .eq('id', appointment_id)
      .single()

    if (fetchError || !appointment) {
      throw new Error('Appointment not found')
    }

    // Validate permission: must be the student who booked
    if (appointment.student_id !== user.id) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: You are not the student who booked this appointment' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validation 1: Already cancelled?
    if (appointment.status === 'cancelled') {
      return new Response(
        JSON.stringify({ message: 'Appointment already cancelled', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validation 2: Existing refund transaction?
    const { data: existingRefund, error: refundQueryError } = await adminClient
      .from('transactions')
      .select('id')
      .eq('appointment_id', appointment_id)
      .eq('type', 'refund')
      .maybeSingle()

    if (existingRefund) {
      return new Response(
        JSON.stringify({ message: 'Refund transaction already exists for this appointment', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validation 4: 24h rule validation
    const timeStr = appointment.start_time.includes(':') 
      ? appointment.start_time.split(':').slice(0, 2).join(':') 
      : appointment.start_time;
    const lessonStart = new Date(`${appointment.date}T${timeStr}:00-03:00`);
    const now = new Date();
    const diffMs = lessonStart.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 24) {
      throw new Error('Faltam menos de 24h para o início da aula. Cancelamento não permitido.');
    }

    const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;
    const providerName = appointment.provider_name || PaymentProviderResolver.resolveProviderForAppointment(appointment.id);

    console.log(JSON.stringify({
      event: "cancel_booking_start",
      provider_name: providerName,
      appointment_id: appointment.id,
      payment_id: paymentId,
      price: appointment.price
    }));

    let isPaid = appointment.payment_status === 'paid' || appointment.payment_status === 'received' || appointment.payment_status === 'confirmed';

    // 4. Act on Payment Provider
    if (paymentId) {
      if (providerName === 'asaas') {
        const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
        const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

        if (!asaasApiKey) {
          console.error('❌ ASAAS_API_KEY is not defined. Cannot cancel/refund Asaas payment.');
          throw new Error('CONFIG_ERROR: Missing ASAAS_API_KEY');
        }

        console.log(`[Asaas] Fetching payment details for ${paymentId}`);
        const paymentRes = await fetch(`${asaasApiUrl}/payments/${paymentId}`, {
          method: 'GET',
          headers: {
            'access_token': asaasApiKey,
            'Content-Type': 'application/json'
          }
        });

        if (!paymentRes.ok) {
          const errText = await paymentRes.text();
          console.error(`❌ Failed to retrieve Asaas payment ${paymentId}: ${errText}`);
          throw new Error(`Asaas verification failed: ${errText}`);
        }

        const paymentData = await paymentRes.json();
        const installmentId = paymentData.installment;
        isPaid = paymentData.status === 'RECEIVED' || paymentData.status === 'CONFIRMED';

        if (!installmentId) {
          if (isPaid) {
            const refundValue = appointment.price / 100;
            console.log(`[Asaas Refund] Issuing partial refund of ${refundValue} for payment ${paymentId}`);
            const refundRes = await fetch(`${asaasApiUrl}/payments/${paymentId}/refund`, {
              method: 'POST',
              headers: {
                'access_token': asaasApiKey,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                value: refundValue,
                description: 'Cancelamento parcial de aula pelo aluno'
              })
            });

            if (!refundRes.ok) {
              const errText = await refundRes.text();
              console.error(`❌ Asaas refund failed for payment ${paymentId}: ${errText}`);
              throw new Error(`Asaas refund failed: ${errText}`);
            }
            console.log(`✅ Asaas payment ${paymentId} partially refunded successfully.`);
          } else {
            console.log(`[Asaas Cancel] Cancelling pending payment ${paymentId}`);
            const cancelRes = await fetch(`${asaasApiUrl}/payments/${paymentId}`, {
              method: 'DELETE',
              headers: {
                'access_token': asaasApiKey,
                'Content-Type': 'application/json'
              }
            });

            if (!cancelRes.ok) {
              const errText = await cancelRes.text();
              console.warn(`⚠️ Asaas pending payment cancel failed (may have been deleted already): ${errText}`);
            } else {
              console.log(`✅ Asaas pending payment ${paymentId} cancelled successfully.`);
            }
          }
        } else {
          // Installment Flow
          if (isPaid) {
            console.log(`[Asaas Installment Refund] Refunding installment ${installmentId}`);
            const refundRes = await fetch(`${asaasApiUrl}/installments/${installmentId}/refund`, {
              method: 'POST',
              headers: {
                'access_token': asaasApiKey,
                'Content-Type': 'application/json'
              }
            });

            if (!refundRes.ok) {
              const errText = await refundRes.text();
              console.error(`❌ Asaas installment refund failed for installment ${installmentId}: ${errText}`);
              throw new Error(`Asaas installment refund failed: ${errText}`);
            }
            console.log(`✅ Asaas installment ${installmentId} refunded successfully.`);
          } else {
            console.log(`[Asaas Installment Cancel] Cancelling pending installment ${installmentId}`);
            const cancelRes = await fetch(`${asaasApiUrl}/installments/${installmentId}`, {
              method: 'DELETE',
              headers: {
                'access_token': asaasApiKey,
                'Content-Type': 'application/json'
              }
            });

            if (!cancelRes.ok) {
              const errText = await cancelRes.text();
              console.error(`❌ Asaas installment cancellation failed for installment ${installmentId}: ${errText}`);
              throw new Error(`Asaas installment cancel failed: ${errText}`);
            }
            console.log(`✅ Asaas installment ${installmentId} cancelled successfully.`);
          }
        }
      } else if (providerName === 'stripe') {
        if (isPaid) {
          console.log(`[Stripe Refund] Refunding payment ${paymentId} with partial value ${appointment.price}`);
          await stripe.refunds.create({
            payment_intent: paymentId,
            amount: appointment.price,
            metadata: { cancellation_reason: 'student_cancelled_partial', appointment_id: appointment.id }
          });
          console.log(`✅ Stripe payment ${paymentId} partially refunded successfully.`);
        } else {
          console.log(`[Stripe Cancel] Cancelling pending PaymentIntent ${paymentId}`);
          await stripe.paymentIntents.cancel(paymentId, {
            idempotencyKey: `cancel_intent_${appointment.id}`
          });
          console.log(`✅ Stripe PaymentIntent ${paymentId} cancelled successfully.`);
        }
      }
    }

    // 5. Update appointment in DB
    const { error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: isPaid ? 'refunded' : 'released',
        cancelled_by: 'student',
        cancelled_reason: 'user_cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', appointment_id);

    if (updateError) {
      console.error(`❌ Error updating database for cancelled appointment ${appointment_id}:`, updateError.message);
      throw updateError;
    }

    // 6. Create refund transaction if paid
    if (isPaid) {
      try {
        const gross_amount = appointment.price || 0;
        const platform_fee = Math.floor(gross_amount * 0.1);
        const net_amount = gross_amount - platform_fee;

        const { error: refundTxErr } = await adminClient
          .from('transactions')
          .upsert({
            appointment_id: appointment.id,
            student_id: appointment.student_id,
            instructor_id: appointment.instructor_id,
            type: 'refund',
            amount: -gross_amount,
            gross_amount: -gross_amount,
            platform_fee: -platform_fee,
            net_amount: -net_amount,
            status: 'completed',
            provider_name: providerName,
            provider_payment_id: paymentId || null,
            event_date: new Date().toISOString(),
            description: 'Estorno de Aula via ' + (providerName === 'asaas' ? 'Asaas' : 'Stripe'),
            metadata: { provider: providerName, note: 'student_cancelled' }
          }, { onConflict: 'appointment_id,type' });

        if (refundTxErr) {
          console.error(`❌ [Cancel Booking] Error creating refund transaction:`, refundTxErr.message);
        } else {
          console.log(`✅ [Cancel Booking] Logged refund transaction for appointment ${appointment.id}`);
        }
      } catch (txErr) {
        console.error(`⚠️ [Cancel Booking] Unexpected error processing financial records:`, txErr);
      }
    }

    // 7. Send Notification
    if (appointment.instructor_id) {
      try {
        await NotificationService.sendBookingCancelled({
          userId: appointment.instructor_id,
          isInstructor: true,
          comboCount: 1,
          groupId: appointment.group_id || appointment.id
        });
      } catch (notifErr) {
        console.error(`⚠️ Error creating notification for cancelled booking:`, notifErr);
      }
    }

    return new Response(
      JSON.stringify({ 
        message: 'Cancelamento e estorno processados com sucesso.', 
        status: 'cancelled',
        appointment: { ...appointment, status: 'cancelled', payment_status: isPaid ? 'refunded' : 'released' }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error in cancel-booking:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
