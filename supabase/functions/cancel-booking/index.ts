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

    const body = await req.json().catch(() => ({}))
    const { appointment_id, actor = 'student', cancel_reason } = body
    if (!appointment_id) {
      throw new Error('Missing appointment_id')
    }

    // 3. Fetch Appointment
    const { data: appointment, error: fetchError } = await adminClient
      .from('appointments')
      .select('id, status, instructor_id, student_id, start_time, date')
      .eq('id', appointment_id)
      .single()

    if (fetchError || !appointment) {
      throw new Error('Appointment not found')
    }

    // Validate permission: must be student or instructor depending on actor
    if (actor === 'student') {
      if (appointment.student_id !== user.id) {
        return new Response(
          JSON.stringify({ error: 'Forbidden: You are not the student who booked this appointment' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    } else if (actor === 'instructor') {
      if (appointment.instructor_id !== user.id) {
        return new Response(
          JSON.stringify({ error: 'Forbidden: You are not the instructor for this appointment' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    } else {
      throw new Error('Invalid actor')
    }

    // Validation: 24h rule (student only). After P-1.20.1B this can only be
    // reached for a NOT-YET-ACCEPTED lesson; the accepted case is refused above.
    if (actor === 'student') {
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
    }

    // 4. Delegate to BookingCancellationCore SSOT with explicit SINGLE_APPOINTMENT scope
    // P-1.20.1B — R2: once the instructor has accepted, the lesson can only be
    // RESCHEDULED. Neither actor may cancel it. Checked here for a clear
    // business message; the Core enforces it again for callers that skip this
    // function. `cancel_reason` is accepted but not yet persisted (P-1.20.6).
    if (['confirmed', 'scheduled'].includes(appointment.status)) {
      return new Response(
        JSON.stringify({
          error: 'Esta aula ja foi aceita pelo instrutor e nao pode mais ser cancelada. Utilize a remarcacao.',
          code: 'LESSON_ALREADY_ACCEPTED',
          status: appointment.status
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const result = await BookingCancellationCore.processCancellation({
      appointmentId: appointment_id,
      reason: actor === 'instructor' ? 'instructor_rejected' : 'student_cancelled',
      scope: 'SINGLE_APPOINTMENT',
      initiatedBy: user.id,
      adminClient,
      httpFetch: asaasFetch
    });

    // D2 — `pending_refund` NAO PODE SAIR COMO 2xx.
    //
    // `pending_refund` significa: o estorno nao atingiu COMPLETED e o
    // agendamento foi DELIBERADAMENTE deixado intacto. Respondendo 200, o
    // `invokeSecureFunction` de `lib/functions.ts` nao preenche `error`, e
    // `pages/student/Lessons.tsx:1047-1058` -- que nao le `status` -- removia a
    // aula da lista e exibia "Aula cancelada e horario liberado.". Falso
    // sucesso, com o dinheiro ainda retido.
    //
    // Devolvendo 409 o front entra no caminho de erro que JA EXISTE, sem
    // qualquer alteracao em `Lessons.tsx`. O campo `error` e' o que o wrapper
    // le para montar a mensagem; os demais campos ficam para diagnostico.
    if (result.status === 'pending_refund') {
      return new Response(
        JSON.stringify({
          error: result.message,
          code: 'REFUND_PENDING',
          status: result.status,
          refund_status: result.refundStatus || null,
          payment_status: result.paymentStatus,
          count: result.processedCount
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        message: result.message,
        status: result.status,
        payment_status: result.paymentStatus,
        count: result.processedCount
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error in cancel-booking:', error)
    const isBusinessRefusal = error?.name === 'CancellationNotAllowedError';
    return new Response(
      JSON.stringify({ error: error.message, code: isBusinessRefusal ? 'CANCELLATION_NOT_ALLOWED' : undefined }),
      { status: isBusinessRefusal ? 409 : 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
