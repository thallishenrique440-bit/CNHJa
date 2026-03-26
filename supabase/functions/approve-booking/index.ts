import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Setup Clients
    // Auth Client: Validates user identity and RLS for reads
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
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
      .select('id, status, instructor_id, payment_intent_id, payment_status, date, start_time, start_time_utc, group_id')
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
        .select('id, status, instructor_id, payment_intent_id, payment_status, date, start_time, start_time_utc, group_id')
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
      const piIds = new Set(groupAppointments.map(a => a.payment_intent_id));
      if (piIds.size > 1) {
        console.error('CRITICAL: Group has multiple PaymentIntents:', Array.from(piIds));
        throw new Error('Erro de integridade: O combo possui múltiplos IDs de pagamento.');
      }

      appointmentsToApprove = groupAppointments;
    }

    // Idempotency: If the main appointment is already approved, return success
    if (appointment.status === 'confirmed' && appointment.payment_status === 'captured') {
      return new Response(
        JSON.stringify({ message: 'Appointment already approved', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const allowedStatuses = ['pending_approval', 'pending', 'awaiting_payment'];
    if (!allowedStatuses.includes(appointment.status)) {
      throw new Error(`Invalid status change: Cannot approve appointment with status '${appointment.status}'`)
    }

    if (!appointment.payment_intent_id) {
      console.error(JSON.stringify({
        event: "approve_error_missing_pi",
        appointment_id: appointment.id,
        status: appointment.status,
        group_id: appointment.group_id
      }));
      throw new Error('Critical: Appointment has no PaymentIntent ID')
    }

    // Check if ANY lesson in the group has already started
    for (const apt of appointmentsToApprove) {
      let lessonStartUTC;
      
      if (apt.start_time_utc) {
        lessonStartUTC = new Date(apt.start_time_utc);
      } else {
        // Fallback: Calculate UTC from date and start_time (Brazil UTC-3)
        console.warn(`⚠️ Appointment ${apt.id} missing start_time_utc. Calculating fallback.`);
        const [year, month, day] = apt.date.split('-').map(Number);
        const [hour, minute] = apt.start_time.split(':').map(Number);
        // Add 3 hours to convert from Brazil (UTC-3) to UTC
        lessonStartUTC = new Date(Date.UTC(year, month - 1, day, hour + 3, minute));
      }

      const nowUTC = new Date()

      if (nowUTC >= lessonStartUTC) {
        console.log(JSON.stringify({
          event: "auto_expire_group",
          group_id: appointment.group_id,
          appointment_id: apt.id,
          reason: "start_time_passed"
        }));
        
        // 1. Cancel Stripe PaymentIntent
        try {
          await stripe.paymentIntents.cancel(appointment.payment_intent_id, {
            idempotencyKey: `auto_expire_group_${appointment.group_id || appointment.id}`
          })
        } catch (stripeError: any) {
          if (stripeError.code !== 'payment_intent_unexpected_state') {
            console.error('Failed to cancel Stripe PaymentIntent during auto-expiration:', stripeError)
          }
        }

        // 2. Update DB for ALL pending appointments in the group
        const idsToExpire = appointmentsToApprove.map(a => a.id);
        await adminClient
          .from('appointments')
          .update({
            status: 'expired',
            payment_status: 'released',
            cancelled_reason: 'auto_expired_start_time',
            updated_at: new Date().toISOString()
          })
          .in('id', idsToExpire)

        return new Response(
          JSON.stringify({ error: 'Uma ou mais aulas deste combo já expiraram e não podem mais ser aceitas.', code: 'AUTH_EXPIRED' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    console.log(JSON.stringify({
      event: "approve_group_start",
      group_id: appointment.group_id,
      status: appointment.status,
      group_size: appointmentsToApprove.length,
      payment_intent_id: appointment.payment_intent_id
    }));

    // 4. Act (Stripe): Capture Funds
    let capturedIntent
    try {
      capturedIntent = await stripe.paymentIntents.capture(
        appointment.payment_intent_id,
        {
          idempotencyKey: `capture_group_${appointment.group_id || appointment.id}`,
        }
      )
    } catch (stripeError: any) {
      console.error('Stripe Capture Error:', stripeError)

      // Robust Error Handling: Retrieve status explicitly
      if (stripeError.code === 'payment_intent_unexpected_state') {
        const retrievedIntent = await stripe.paymentIntents.retrieve(appointment.payment_intent_id)
        
        if (retrievedIntent.status === 'succeeded') {
          // Already captured (race condition or previous retry). Proceed.
          capturedIntent = retrievedIntent
          console.log('PaymentIntent was already succeeded. Proceeding.')
        } else if (retrievedIntent.status === 'canceled') {
           // Auth expired. Fail safely for the whole group.
           const idsToCancel = appointmentsToApprove.map(a => a.id);
           await adminClient.from('appointments').update({
             status: 'cancelled',
             payment_status: 'failed',
             cancelled_reason: 'auth_expired'
           }).in('id', idsToCancel)
           
           return new Response(
            JSON.stringify({ 
              error: 'Payment authorization expired. Appointments cancelled.',
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

    // 5. Persist (DB): Update Status for ALL appointments in the group
    const idsToConfirm = appointmentsToApprove.map(a => a.id);
    const { data: updatedAppointments, error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'confirmed',
        payment_status: 'captured',
        updated_at: new Date().toISOString()
      })
      .in('id', idsToConfirm)
      .in('status', ['pending_approval', 'pending', 'awaiting_payment']) // Optimistic Lock
      .select()

    if (updateError || !updatedAppointments || updatedAppointments.length !== idsToConfirm.length) {
      // Update failed or was partial. Check if it was because of race condition (webhook beat us)
      const { data: checkGroup } = await adminClient
        .from('appointments')
        .select('id, status, payment_status')
        .in('id', idsToConfirm);
      
      const allConfirmed = checkGroup?.every(a => a.status === 'confirmed' && a.payment_status === 'captured');
      
      if (allConfirmed) {
        console.log(JSON.stringify({
          event: "approve_group_sync_success",
          group_id: appointment.group_id,
          message: "Group already confirmed (likely race condition with webhook)"
        }));
        return new Response(
          JSON.stringify({ message: 'Booking approved successfully (synced)', count: idsToConfirm.length }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // If we are here, some appointments are NOT confirmed but payment WAS captured.
      console.error(JSON.stringify({
        event: "CRITICAL_PAYMENT_SYNC_ERROR",
        group_id: appointment.group_id,
        payment_intent_id: appointment.payment_intent_id,
        error: updateError?.message || "Partial update or status mismatch",
        expected_ids: idsToConfirm,
        actual_status: checkGroup?.map(a => `${a.id}:${a.status}`)
      }));

      throw new Error('Falha crítica: O pagamento foi capturado mas o banco de dados não pôde ser atualizado totalmente. Nossa equipe foi notificada para reconciliação manual.');
    }

    console.log(JSON.stringify({
      event: "approve_group_success",
      group_id: appointment.group_id,
      count: updatedAppointments.length
    }));

    return new Response(
      JSON.stringify({ 
        message: 'Booking group approved successfully', 
        count: updatedAppointments.length,
        appointments: updatedAppointments 
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
