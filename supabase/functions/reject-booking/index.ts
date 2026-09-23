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

    // D5/RR2 — a mensagem de sucesso era HARDCODED e afirmava
    // "Cancelamento e estorno processados com sucesso." qualquer que fosse o
    // resultado. Com `pending_refund` isso e' falso: o estorno nao atingiu
    // COMPLETED e o agendamento foi deliberadamente deixado intacto.
    //
    // Mesmo contrato do `cancel-booking` (D2): 409 + REFUND_PENDING, com
    // `error` preenchido para o wrapper de `lib/functions.ts` montar a mensagem.
    if (result.status === 'pending_refund') {
      return new Response(
        JSON.stringify({
          error: result.message,
          code: 'REFUND_PENDING',
          status: result.status,
          refund_status: result.refundStatus || null,
          payment_status: result.paymentStatus,
          count: result.processedCount,
          appointment: { id: appointment_id, status: result.status, payment_status: result.paymentStatus }
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Sucesso: a mensagem passa a vir do Core em vez de ser afirmada aqui. Para
    // um estorno COMPLETED o Core devolve exatamente
    // "Cancelamento e estorno processados com sucesso.", entao o texto atual e'
    // preservado; para os casos `alreadyProcessed` ela passa a ser verdadeira.
    return new Response(
      JSON.stringify({ 
        message: result.message, 
        status: result.paymentStatus,
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

