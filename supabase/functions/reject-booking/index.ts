import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check"
import { NotificationService } from '../_shared/NotificationService.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
  telemetry: false,
})

// Abstração local do orchestrator compatível com as restrições de Deno Edge Functions
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

    // 3. Check (DB): Validate Ownership & Status
    const { data: appointment, error: fetchError } = await authClient
      .from('appointments')
      .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, student_id, price')
      .eq('id', appointment_id)
      .single()

    if (fetchError || !appointment) {
      throw new Error('Appointment not found')
    }

    if (appointment.instructor_id !== user.id) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: You are not the instructor for this appointment' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // --- GROUPING LOGIC ---
    // If this appointment belongs to a purchase group, we should reject ALL appointments in that group.
    let appointmentsToReject = [appointment];
    if (appointment.group_id) {
      const { data: groupAppointments, error: groupError } = await adminClient
        .from('appointments')
        .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, student_id, price')
        .eq('group_id', appointment.group_id);
      
      if (groupError) throw new Error(`Error fetching group: ${groupError.message}`);
      if (!groupAppointments || groupAppointments.length === 0) throw new Error('Group not found');

      // VALIDATION: All must be in a rejectable state
      const allowedStatuses = ['pending_approval', 'pending', 'awaiting_payment'];
      const invalidStatus = groupAppointments.filter(a => !allowedStatuses.includes(a.status));
      if (invalidStatus.length > 0) {
        console.warn(`Group ${appointment.group_id} has inconsistent statuses for rejection:`, invalidStatus.map(a => `${a.id}:${a.status}`));
        throw new Error('Este combo não pode mais ser recusado pois um ou mais horários já foram processados.');
      }

      // VALIDATION: All must share the same PaymentIntent
      const piIds = new Set(groupAppointments.map(a => a.provider_payment_id || a.payment_intent_id));
      if (piIds.size > 1) {
        console.error('CRITICAL: Group has multiple PaymentIntents:', Array.from(piIds));
        throw new Error('Erro de integridade: O combo possui múltiplos IDs de pagamento.');
      }

      appointmentsToReject = groupAppointments;
    }

    // Idempotency: If already rejected, return success
    if (appointment.status === 'cancelled' && appointment.cancelled_reason === 'instructor_rejected') {
      return new Response(
        JSON.stringify({ message: 'Appointment already rejected', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const allowedStatuses = ['pending_approval', 'pending', 'awaiting_payment'];
    if (!allowedStatuses.includes(appointment.status)) {
      throw new Error(`Invalid status change: Cannot reject appointment with status '${appointment.status}'`)
    }

    const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;
    const providerName = appointment.provider_name || PaymentProviderResolver.resolveProviderForAppointment(appointment.id);

    console.log(JSON.stringify({
      event: "reject_group_start",
      provider_name: providerName,
      group_id: appointment.group_id,
      status: appointment.status,
      group_size: appointmentsToReject.length,
      payment_id: paymentId
    }));

    // 4. Act: Cancel Payment Intent (if exists)
    if (paymentId) {
      try {
        if (providerName === 'stripe') {
          // Update metadata before cancelling so the webhook knows the reason
          await stripe.paymentIntents.update(paymentId, {
            metadata: { cancellation_reason: 'instructor_rejected' }
          });

          await stripe.paymentIntents.cancel(
            paymentId,
            {
              idempotencyKey: `cancel_group_${appointment.group_id || appointment.id}`,
            }
          )
        } else if (providerName === 'asaas') {
          const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
          const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

          if (!asaasApiKey) {
            console.error('❌ ASAAS_API_KEY is not defined. Cannot reject/refund Asaas payment.');
            throw new Error('CONFIG_ERROR: Missing ASAAS_API_KEY');
          }

          // Fetch payment status and check for installments directly from Asaas
          console.log(`[Asaas] Fetching payment details for ${paymentId}`);
          const paymentUrl = `${asaasApiUrl}/payments/${paymentId}`;
          const paymentRes = await fetch(paymentUrl, {
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
          const isPaid = paymentData.status === 'RECEIVED' || paymentData.status === 'CONFIRMED';

          console.log(`[Asaas] Retrieved payment details. Status: ${paymentData.status}, Installment: ${installmentId || 'none'}, isPaid: ${isPaid}`);

          if (!installmentId) {
            // Flow for simple/no-installment payments
            if (isPaid) {
              console.log(`[Asaas Refund] Refunding payment ${paymentId} for group ${appointment.group_id}`);
              const refundUrl = `${asaasApiUrl}/payments/${paymentId}/refund`;
              const refundRes = await fetch(refundUrl, {
                method: 'POST',
                headers: {
                  'access_token': asaasApiKey,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  description: 'instructor_rejected'
                })
              });

              if (!refundRes.ok) {
                const errText = await refundRes.text();
                console.error(`❌ Asaas refund failed for payment ${paymentId}: ${errText}`);
                throw new Error(`Asaas refund failed: ${errText}`);
              }

              console.log(`✅ Asaas payment ${paymentId} refunded successfully.`);
            } else {
              console.log(`[Asaas Cancel] Cancelling pending payment ${paymentId} for group ${appointment.group_id}`);
              const cancelUrl = `${asaasApiUrl}/payments/${paymentId}`;
              const cancelRes = await fetch(cancelUrl, {
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
            // Flow for installment payments
            if (isPaid) {
              console.log(`[Asaas Installment Refund] Refunding installment ${installmentId} (linked to payment ${paymentId}) for group ${appointment.group_id}`);
              const refundUrl = `${asaasApiUrl}/installments/${installmentId}/refund`;
              const refundRes = await fetch(refundUrl, {
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
              console.log(`[Asaas Installment Cancel] Cancelling pending installment ${installmentId} (linked to payment ${paymentId}) for group ${appointment.group_id}`);
              const cancelUrl = `${asaasApiUrl}/installments/${installmentId}`;
              const cancelRes = await fetch(cancelUrl, {
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

          // Direct database update for Asaas flow since there is no cancel webhook handler
          const { error: updateError } = await adminClient
            .from('appointments')
            .update({
              status: 'cancelled',
              payment_status: isPaid ? 'refunded' : 'released',
              cancelled_reason: 'instructor_rejected',
              updated_at: new Date().toISOString()
            })
            .eq('group_id', appointment.group_id);

          if (updateError) {
            console.error(`❌ Error updating database for rejected group ${appointment.group_id}:`, updateError.message);
            throw updateError;
          }

          if (isPaid) {
            // Update the original lesson_payment transaction to 'failed'
            try {
              const { error: failTxErr } = await adminClient
                .from('transactions')
                .update({ status: 'failed' })
                .eq('provider_payment_id', paymentId)
                .eq('type', 'lesson_payment')
                .eq('provider_name', 'asaas');

              if (failTxErr) {
                console.error(`❌ [Asaas Reject] Error marking original transactions as failed:`, failTxErr.message);
              } else {
                console.log(`✅ [Asaas Reject] Marked original lesson_payment transactions as failed.`);
              }

              // Create refund transactions with negative values
              for (const apt of appointmentsToReject) {
                const gross_amount = apt.price || 0;
                const platform_fee = Math.floor(gross_amount * 0.1);
                const net_amount = gross_amount - platform_fee;

                const { error: refundTxErr } = await adminClient
                  .from('transactions')
                  .upsert({
                    appointment_id: apt.id,
                    student_id: apt.student_id,
                    instructor_id: apt.instructor_id,
                    type: 'refund',
                    amount: -gross_amount,
                    gross_amount: -gross_amount,
                    platform_fee: -platform_fee,
                    net_amount: -net_amount,
                    status: 'completed',
                    provider_name: 'asaas',
                    provider_payment_id: paymentId,
                    event_date: new Date().toISOString(),
                    description: 'Estorno de Aula via Asaas',
                    metadata: { provider: 'asaas', note: 'instructor_rejected' }
                  }, { onConflict: 'appointment_id,type' });

                if (refundTxErr) {
                  console.error(`❌ [Asaas Reject] Error creating refund transaction for appointment ${apt.id}:`, refundTxErr.message);
                } else {
                  console.log(`✅ [Asaas Reject] Logged refund transaction for appointment ${apt.id}`);
                }
              }
            } catch (txErr) {
              console.error(`⚠️ [Asaas Reject] Unexpected error processing financial records:`, txErr);
            }
          }

          // Create notification for the student
          if (appointment.student_id) {
            try {
              await NotificationService.sendBookingRejected({
                studentId: appointment.student_id,
                comboCount: appointmentsToReject.length || 1,
                groupId: appointment.group_id || appointment.id
              });
            } catch (notifErr) {
              console.error(`⚠️ Error creating notification for rejected booking:`, notifErr);
            }
          }

          // Return immediately for Asaas
          return new Response(
            JSON.stringify({ 
              message: 'Cancelamento e estorno processados com sucesso.', 
              status: 'refunded',
              count: appointmentsToReject.length,
              appointment: { ...appointment, status: 'cancelled', payment_status: isPaid ? 'refunded' : 'released' }
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        } else {
          // Safe modular placeholder
          console.log(`Rejecting non-Stripe provider ${providerName} transaction ${paymentId}`);
        }
      } catch (stripeError: any) {
        console.error('Payment Cancel Error:', stripeError)

        // Robust Error Handling for Stripe
        if (stripeError.code === 'payment_intent_unexpected_state') {
          const retrievedIntent = await stripe.paymentIntents.retrieve(paymentId)

          if (retrievedIntent.status === 'canceled') {
            // Already canceled. Proceed.
            console.log('Payment was already canceled. Proceeding.')
          } else if (retrievedIntent.status === 'succeeded') {
            // CRITICAL: Money already captured. Cannot reject.
            throw new Error('Payment already captured. Cannot reject. Please use refund flow.')
          } else {
             throw stripeError
          }
        } else {
          throw stripeError
        }
      }
    } else {
      console.log('No Payment ID found. Skipping cancellation.')
    }

    // 5. Return Success (Cancellation Initiated)
    // We NO LONGER update the database here to avoid race conditions with the Webhook.
    // The Webhook (payment_intent.canceled) is now the single source of truth for cancellation.
    console.log(JSON.stringify({
      event: "reject_group_initiated",
      provider_name: providerName,
      group_id: appointment.group_id,
      payment_id: paymentId,
      count: appointmentsToReject.length
    }));

    return new Response(
      JSON.stringify({ 
        message: 'Cancelamento iniciado. A reserva será liberada em instantes.', 
        status: 'processing',
        count: appointmentsToReject.length
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error in reject-booking:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
