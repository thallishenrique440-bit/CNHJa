import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { BookingCancellationCore } from '../_shared/BookingCancellationCore.ts'
import { asaasFetch } from '../_shared/asaasClient.ts'

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

    // 3. Ownership Validation
    const { data: appointment, error: fetchError } = await adminClient
      .from('appointments')
      .select('id, instructor_id')
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

    // 4. Delegate to BookingCancellationCore SSOT
    const result = await BookingCancellationCore.processCancellation({
      appointmentId: appointment_id,
      reason: 'instructor_rejected',
      initiatedBy: user.id,
      adminClient,
      httpFetch: asaasFetch
    });

    // A aula e' encerrada pelo Core qualquer que seja o estado do estorno. A
    // resposta diz o que de fato aconteceu: `refund_confirmed` so' e' true com
    // confirmacao do gateway, e a mensagem vem do Core (nunca afirma estorno
    // concluido sem essa confirmacao).
    return new Response(
      JSON.stringify({ 
        message: result.message, 
        status: result.paymentStatus,
        refund_confirmed: result.refundConfirmed,
        refund_state: result.refundState,
        refund_status: result.refundStatus || null,
        count: result.processedCount,
        appointment: { id: appointment_id, status: result.status, payment_status: result.paymentStatus }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error in reject-booking:', error)
    // P-1.20.1B: R2 refusal (lesson already accepted) is a business rule, not a fault.
    if (error?.name === 'CancellationNotAllowedError') {
      return new Response(
        JSON.stringify({ error: error.message, code: 'CANCELLATION_NOT_ALLOWED' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

