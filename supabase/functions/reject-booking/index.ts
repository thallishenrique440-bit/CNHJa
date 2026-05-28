import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
  telemetry: false,
})

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
      .select('id, status, instructor_id, payment_intent_id, payment_status, cancelled_reason, group_id')
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
        .select('id, status, instructor_id, payment_intent_id, payment_status, cancelled_reason, group_id')
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
      const piIds = new Set(groupAppointments.map(a => a.payment_intent_id));
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

    console.log(JSON.stringify({
      event: "reject_group_start",
      group_id: appointment.group_id,
      status: appointment.status,
      group_size: appointmentsToReject.length,
      payment_intent_id: appointment.payment_intent_id
    }));

    // 4. Act (Stripe): Cancel Payment Intent (if exists)
    if (appointment.payment_intent_id) {
      try {
        // Update metadata before cancelling so the webhook knows the reason
        await stripe.paymentIntents.update(appointment.payment_intent_id, {
          metadata: { cancellation_reason: 'instructor_rejected' }
        });

        await stripe.paymentIntents.cancel(
          appointment.payment_intent_id,
          {
            idempotencyKey: `cancel_group_${appointment.group_id || appointment.id}`,
          }
        )
      } catch (stripeError: any) {
        console.error('Stripe Cancel Error:', stripeError)

        // Robust Error Handling
        if (stripeError.code === 'payment_intent_unexpected_state') {
          const retrievedIntent = await stripe.paymentIntents.retrieve(appointment.payment_intent_id)

          if (retrievedIntent.status === 'canceled') {
            // Already canceled. Proceed.
            console.log('PaymentIntent was already canceled. Proceeding.')
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
      console.log('No PaymentIntent ID found. Skipping Stripe cancellation.')
    }

    // 5. Return Success (Cancellation Initiated)
    // We NO LONGER update the database here to avoid race conditions with the Stripe Webhook.
    // The Webhook (payment_intent.canceled) is now the single source of truth for cancellation.
    console.log(JSON.stringify({
      event: "reject_group_initiated",
      group_id: appointment.group_id,
      payment_intent_id: appointment.payment_intent_id,
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
