import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check"

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
      .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, student_id')
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
        .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, student_id')
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

          const isPaid = appointment.payment_status === 'paid';

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

          // Create notification for the student
          if (appointment.student_id) {
            try {
              await adminClient.from('notifications').upsert({
                user_id: appointment.student_id,
                title: 'Aula cancelada',
                message: 'Seu agendamento foi cancelado pelo instrutor e o valor correspondente foi reembolsado automaticamente.',
                type: 'booking_rejected',
                metadata: { group_id: appointment.group_id, payment_intent_id: paymentId },
                idempotency_key: `booking_rejected:asaas:${appointment.group_id}`
              }, { onConflict: 'idempotency_key' });
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
