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
    const { data: appointment, error: fetchError } = await authClient
      .from('appointments')
      .select('id, status, instructor_id, payment_intent_id, payment_status, date, start_time')
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

    // Idempotency: If already approved, return success
    if (appointment.status === 'confirmed' && appointment.payment_status === 'captured') {
      return new Response(
        JSON.stringify({ message: 'Appointment already approved', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (appointment.status !== 'pending_approval') {
      throw new Error(`Invalid status change: Cannot approve appointment with status '${appointment.status}'`)
    }

    if (!appointment.payment_intent_id) {
      throw new Error('Critical: Appointment has no PaymentIntent ID')
    }

    // Check if the lesson start time has already passed
    const [year, month, day] = appointment.date.split('-').map(Number)
    const [hours, minutes] = appointment.start_time.split(':').map(Number)
    // Assume Brazil time (UTC-3) for the lesson start time
    const lessonStartUTC = new Date(Date.UTC(year, month - 1, day, hours + 3, minutes))
    const nowUTC = new Date()

    if (nowUTC >= lessonStartUTC) {
      console.log(`Lesson ${appointment.id} has already started. Auto-expiring...`)
      
      // 1. Cancel Stripe PaymentIntent
      try {
        await stripe.paymentIntents.cancel(appointment.payment_intent_id, {
          idempotencyKey: `auto_expire_start_${appointment.id}`
        })
      } catch (stripeError: any) {
        if (stripeError.code !== 'payment_intent_unexpected_state') {
          console.error('Failed to cancel Stripe PaymentIntent during auto-expiration:', stripeError)
        }
      }

      // 2. Update DB
      await adminClient
        .from('appointments')
        .update({
          status: 'expired',
          payment_status: 'released',
          cancelled_reason: 'auto_expired_start_time',
          updated_at: new Date().toISOString()
        })
        .eq('id', appointment.id)

      return new Response(
        JSON.stringify({ error: 'Esta aula já expirou e não pode mais ser aceita.', code: 'AUTH_EXPIRED' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Act (Stripe): Capture Funds
    let capturedIntent
    try {
      capturedIntent = await stripe.paymentIntents.capture(
        appointment.payment_intent_id,
        {
          idempotencyKey: `capture_${appointment.id}`,
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
           // Auth expired. Fail safely.
           await adminClient.from('appointments').update({
             status: 'cancelled',
             payment_status: 'failed',
             cancelled_reason: 'auth_expired'
           }).eq('id', appointment.id)
           
           return new Response(
            JSON.stringify({ 
              error: 'Payment authorization expired. Appointment cancelled.',
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

    // 5. Persist (DB): Update Status with Optimistic Locking
    const { data: updatedAppointment, error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'confirmed',
        payment_status: 'captured',
        updated_at: new Date().toISOString()
      })
      .eq('id', appointment.id)
      .eq('status', 'pending_approval') // Optimistic Lock: Only update if still pending
      .select()
      .single()

    if (updateError || !updatedAppointment) {
      // Update failed. Check if it was because of race condition (webhook beat us)
      const { data: check } = await adminClient
        .from('appointments')
        .select('*')
        .eq('id', appointment.id)
        .single()
      
      if (check?.status === 'confirmed' && check?.payment_status === 'captured') {
        return new Response(
          JSON.stringify({ message: 'Booking approved successfully (synced)', appointment: check }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.error('CRITICAL: Payment captured but DB update failed:', updateError)
      throw new Error('Database update failed after payment capture')
    }

    return new Response(
      JSON.stringify({ message: 'Booking approved successfully', appointment: updatedAppointment }),
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
