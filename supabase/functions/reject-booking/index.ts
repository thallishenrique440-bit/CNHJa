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
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
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
      .select('id, status, instructor_id, payment_intent_id, payment_status, cancelled_reason')
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

    // Idempotency: If already rejected, return success
    if (appointment.status === 'cancelled' && appointment.cancelled_reason === 'instructor_rejected') {
      return new Response(
        JSON.stringify({ message: 'Appointment already rejected', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (appointment.status !== 'pending_approval' && appointment.status !== 'pending') {
      throw new Error(`Invalid status change: Cannot reject appointment with status '${appointment.status}'`)
    }

    // 4. Act (Stripe): Cancel Payment Intent (if exists)
    if (appointment.payment_intent_id) {
      try {
        await stripe.paymentIntents.cancel(
          appointment.payment_intent_id,
          {
            idempotencyKey: `cancel_${appointment.id}`,
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

    // 5. Persist (DB): Update Status with Optimistic Locking
    const { data: updatedAppointment, error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: 'released',
        cancelled_reason: 'instructor_rejected',
        updated_at: new Date().toISOString()
      })
      .eq('id', appointment.id)
      .in('status', ['pending_approval', 'pending']) // Optimistic Lock
      .select()
      .single()

    if (updateError || !updatedAppointment) {
       // Check for sync
       const { data: check } = await adminClient
        .from('appointments')
        .select('*')
        .eq('id', appointment.id)
        .single()
      
      if (check?.status === 'cancelled' && check?.cancelled_reason === 'instructor_rejected') {
        return new Response(
          JSON.stringify({ message: 'Booking rejected successfully (synced)', appointment: check }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.error('CRITICAL: Payment canceled but DB update failed:', updateError)
      throw new Error('Database update failed after payment cancellation')
    }

    return new Response(
      JSON.stringify({ message: 'Booking rejected successfully', appointment: updatedAppointment }),
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
