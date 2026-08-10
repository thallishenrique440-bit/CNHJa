import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { BookingCancellationCore } from '../_shared/BookingCancellationCore.ts'

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

      // VALIDATION: All must share the same Payment ID
      const piIds = new Set(groupAppointments.map(a => a.provider_payment_id || a.payment_intent_id));
      if (piIds.size > 1) {
        console.error('CRITICAL: Group has multiple Payment IDs:', Array.from(piIds));
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

        try {
          console.log(`⏰ [approve-booking] Lesson ${apt.id} start time passed. Delegating auto-expiration to BookingCancellationCore...`);
          await BookingCancellationCore.processCancellation({
            appointmentId: appointment.id,
            reason: 'auto_expired',
            adminClient
          });
        } catch (cancelErr) {
          console.error('❌ Error executing auto_expired in approve-booking via Core:', cancelErr);
        }

        return new Response(
          JSON.stringify({ 
            error: 'Esta aula expirou pois o horário de início foi atingido sem confirmação. O reembolso foi processado automaticamente.', 
            code: 'LESSON_EXPIRED' 
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

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

    const approvedIds = updateResult.data ? updateResult.data.map((apt: any) => apt.id) : [];

    if (approvedIds.length === 0) {
      console.warn(`⚠️ [Asaas Approve] Race condition detected or status changed. 0 appointments updated for appointment ${appointment.id} / group ${groupId}`);
      return new Response(
        JSON.stringify({ 
          error: 'O estado do agendamento foi alterado por outra operação durante o processamento. Nenhuma alteração foi realizada.', 
          code: 'STATE_CONFLICT' 
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update the transaction status from pending to completed
    try {
      const { error: updateTxErr } = await adminClient
        .from('transactions')
        .update({ status: 'completed' })
        .in('appointment_id', approvedIds)
        .eq('type', 'lesson_payment');

      if (updateTxErr) {
        console.error(`❌ Error completing Asaas transactions for approvedIds ${approvedIds.join(', ')}:`, updateTxErr.message);
      } else {
        console.log(`✅ [Asaas Approve] Successfully completed pending transactions for approvedIds: ${approvedIds.join(', ')}`);
      }
    } catch (txErr) {
      console.error(`⚠️ [Asaas Approve] Unexpected error updating transactions:`, txErr);
    }

    // Create notification for the student
    if (appointment.student_id) {
      try {
        await NotificationService.sendBookingAccepted({
          studentId: appointment.student_id,
          comboCount: appointmentsToApprove.length || 1,
          groupId: appointment.group_id || appointment.id
        });
      } catch (notifErr: any) {
        console.error('[FORENSIC] Notification Exception');
        console.error(notifErr);
        if (notifErr instanceof Error || (notifErr && typeof notifErr === 'object' && ('message' in notifErr || 'name' in notifErr))) {
          console.error({
            name: notifErr.name,
            message: notifErr.message,
            stack: notifErr.stack
          });
        }
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

  } catch (error: any) {
    console.error('Error in approve-booking:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
