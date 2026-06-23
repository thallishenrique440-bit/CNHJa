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

    // Auth Client: Validates user identity and RLS for reads
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    // Admin Client: Guarantees critical writes (bypassing RLS)
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
    // We fetch the appointment and its group_id to handle grouping
    const { data: appointment, error: fetchError } = await authClient
      .from('appointments')
      .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, date, start_time, group_id, student_id')
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
    // If this appointment belongs to a purchase group, we should approve ALL appointments in that group.
    let appointmentsToApprove = [appointment];
    if (appointment.group_id) {
      const { data: groupAppointments, error: groupError } = await adminClient
        .from('appointments')
        .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, date, start_time, group_id, student_id')
        .eq('group_id', appointment.group_id);
      
      if (groupError) throw new Error(`Error fetching group: ${groupError.message}`);
      if (!groupAppointments || groupAppointments.length === 0) throw new Error('Group not found');

      // VALIDATION: All must be in an approvable state
      const allowedStatuses = ['pending_approval', 'pending', 'awaiting_payment'];
      const nonPending = groupAppointments.filter(a => !allowedStatuses.includes(a.status));
      if (nonPending.length > 0) {
        console.warn(`Group ${appointment.group_id} has inconsistent statuses:`, nonPending.map(a => `${a.id}:${a.status}`));
        throw new Error('Este combo não pode mais ser aceito pois um ou mais horários foram alterados ou já processados.');
      }

      // VALIDATION: All must share the same PaymentIntent
      const piIds = new Set(groupAppointments.map(a => a.provider_payment_id || a.payment_intent_id));
      if (piIds.size > 1) {
        console.error('CRITICAL: Group has multiple PaymentIntents:', Array.from(piIds));
        throw new Error('Erro de integridade: O combo possui múltiplos IDs de pagamento.');
      }

      appointmentsToApprove = groupAppointments;
    }

    // Idempotency: If the main appointment is already approved, return success
    if (appointment.status === 'confirmed' && appointment.payment_status === 'paid') {
      return new Response(
        JSON.stringify({ message: 'Appointment already approved', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const allowedStatuses = ['pending_approval', 'pending', 'awaiting_payment'];
    if (!allowedStatuses.includes(appointment.status)) {
      throw new Error(`Invalid status change: Cannot approve appointment with status '${appointment.status}'`)
    }

    const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

    if (!paymentId) {
      console.error(JSON.stringify({
        event: "approve_error_missing_payment_id",
        appointment_id: appointment.id,
        status: appointment.status,
        group_id: appointment.group_id
      }));
      throw new Error('Critical: Appointment has no Payment reference ID')
    }

    // Check if ANY lesson in the group has already started
    for (const apt of appointmentsToApprove) {
      // Combine date and start_time to get a Date object with explicit Brazil offset (UTC-3)
      const lessonStart = new Date(`${apt.date}T${apt.start_time}:00-03:00`);
      const now = new Date();

      if (now >= lessonStart) {
        console.log(JSON.stringify({
          event: "auto_expire_group",
          group_id: appointment.group_id,
          appointment_id: apt.id,
          reason: "start_time_passed"
        }));
        
        // Resolve provider dynamically
        const providerName = appointment.provider_name || PaymentProviderResolver.resolveProviderForAppointment(appointment.id);

        // 1. Cancel PaymentIntent with metadata for reason
        try {
          if (providerName === 'stripe') {
            await stripe.paymentIntents.update(paymentId, {
              metadata: { cancellation_reason: 'auto_expired_start_time' }
            });

            await stripe.paymentIntents.cancel(paymentId, {
              idempotencyKey: `auto_expire_group_${appointment.group_id || appointment.id}`
            });
          } else {
             console.log(`Auto expire for non-Stripe provider ${providerName}`);
          }
        } catch (stripeError: any) {
          if (stripeError.code !== 'payment_intent_unexpected_state') {
            console.error('Failed to cancel payment during auto-expiration:', stripeError)
          }
        }

        return new Response(
          JSON.stringify({ error: 'Uma ou mais aulas deste combo já expiraram e não podem mais ser aceitas.', code: 'AUTH_EXPIRED' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    const providerName = appointment.provider_name || PaymentProviderResolver.resolveProviderForAppointment(appointment.id);

    if (providerName === 'asaas') {
      console.log(`[Asaas Approve] Direct DB update for group: ${appointment.group_id || appointment.id}`);
      
      const groupId = appointment.group_id;

      let updateResult;
      if (groupId) {
        updateResult = await adminClient
          .from('appointments')
          .update({
            status: 'confirmed',
            payment_status: 'paid',
            updated_at: new Date().toISOString()
          })
          .eq('group_id', groupId)
          .in('status', ['pending_approval', 'pending', 'awaiting_payment'])
          .select('id, student_id');
      } else {
        updateResult = await adminClient
          .from('appointments')
          .update({
            status: 'confirmed',
            payment_status: 'paid',
            updated_at: new Date().toISOString()
          })
          .eq('id', appointment.id)
          .in('status', ['pending_approval', 'pending', 'awaiting_payment'])
          .select('id, student_id');
      }

      if (updateResult.error) {
        console.error(`❌ Error confirming Asaas appointments:`, updateResult.error.message);
        throw updateResult.error;
      }

      // Create notification for the student
      if (appointment.student_id) {
        try {
          await adminClient.from('notifications').upsert({
            user_id: appointment.student_id,
            title: 'Aula Confirmada!',
            message: 'Sua aula foi aceita pelo instrutor e está confirmada.',
            type: 'booking_accepted',
            metadata: { group_id: appointment.group_id, payment_intent_id: paymentId },
            idempotency_key: `booking_accepted:asaas:${appointment.group_id || appointment.id}`
          }, { onConflict: 'idempotency_key' });
        } catch (notifErr) {
          console.error(`⚠️ Error creating confirmation notification:`, notifErr);
        }
      }

      return new Response(
        JSON.stringify({ 
          message: 'Aula confirmada com sucesso.', 
          status: 'confirmed',
          count: appointmentsToApprove.length,
          appointment: { ...appointment, status: 'confirmed', payment_status: 'paid' }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(JSON.stringify({
      event: "approve_group_start",
      provider_name: providerName,
      group_id: appointment.group_id,
      status: appointment.status,
      group_size: appointmentsToApprove.length,
      payment_id: paymentId
    }));

    // 4. Act: Capture Funds
    let capturedIntent
    try {
      if (providerName === 'stripe') {
        capturedIntent = await stripe.paymentIntents.capture(
          paymentId,
          {
            idempotencyKey: `capture_group_${appointment.group_id || appointment.id}`,
          }
        )
      } else {
        // Safe placeholder for modular integration of alternative providers
        capturedIntent = { status: 'succeeded' };
      }
    } catch (stripeError: any) {
      console.error('Payment Capture Error:', stripeError)

      // Robust Error Handling: Retrieve status explicitly
      if (stripeError.code === 'payment_intent_unexpected_state') {
        const retrievedIntent = await stripe.paymentIntents.retrieve(paymentId)
        
        if (retrievedIntent.status === 'succeeded') {
          // Already captured (race condition or previous retry). Proceed.
          capturedIntent = retrievedIntent
          console.log('Payment was already succeeded. Proceeding.')
        } else if (retrievedIntent.status === 'canceled') {
           // Auth expired. 
           // We NO LONGER update the database here. The Webhook will handle it.
           // But we can ensure the metadata is correct if it wasn't already.
           try {
             await stripe.paymentIntents.update(paymentId, {
               metadata: { cancellation_reason: 'auth_expired' }
             });
           } catch (e) {
             console.warn('Could not update metadata for expired PI:', e);
           }
           
           return new Response(
            JSON.stringify({ 
              error: 'Payment authorization expired. Appointments will be cancelled.',
              code: 'AUTH_EXPIRED'
            }),
            { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        } else {
          // Other states (e.g. requires_payment_method)
          throw stripeError
        }
      } else {
        throw stripeError
      }
    }

    // 5. Return Success (Capture Initiated)
    // We NO LONGER update the database here to avoid race conditions with the Webhook.
    // The Webhook (payment_intent.succeeded) is now the single source of truth for confirmation.
    console.log(JSON.stringify({
      event: "approve_group_capture_initiated",
      provider_name: providerName,
      group_id: appointment.group_id,
      payment_id: paymentId,
      count: appointmentsToApprove.length
    }));

    return new Response(
      JSON.stringify({ 
        message: 'Captura de pagamento iniciada. A confirmação será processada em instantes.', 
        status: 'processing',
        count: appointmentsToApprove.length
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error in approve-booking:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
