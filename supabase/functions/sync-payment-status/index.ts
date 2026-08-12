import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { asaasFetch } from '../_shared/asaasClient.ts'
import { InstallmentService } from '../_shared/InstallmentService.ts'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

function calculateApprovalExpiresAt(dateStr?: string, startTimeStr?: string, createdAtStr?: string): string {
  if (!dateStr || !startTimeStr) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  // Construct lesson start time in Brazil timezone (UTC-3)
  const lessonStart = new Date(`${dateStr}T${startTimeStr}:00-03:00`);
  const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

  // 30 minutes before lesson start
  const thirtyMinBefore = new Date(lessonStart.getTime() - 30 * 60 * 1000);

  // Normal purchase: created > 30 mins before lesson start -> expires at (start - 30m)
  // Last minute purchase: created <= 30 mins before lesson start -> expires at start time
  if (createdAt < thirtyMinBefore) {
    return thirtyMinBefore.toISOString();
  } else {
    return lessonStart.toISOString();
  }
}

Deno.serve(async (req) => {
  try {
    console.log("🔄 Starting sync-payment-status job...")

    // Find appointments that are stuck in checkout/approval or have pending refund reconciliations
    const { data: stuckAppointments, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, provider_payment_id, group_id, status, provider_name, student_id, instructor_id, date, start_time, created_at, payment_status')
      .or('status.in.(reserved,pending_approval,awaiting_payment,cancelling),and(status.in.(cancelled,expired),payment_status.in.(paid,refund_requested))')

    if (fetchError) {
      throw fetchError
    }

    console.log(`Found ${stuckAppointments?.length || 0} potentially stuck or pending refund appointments.`)

    if (!stuckAppointments || stuckAppointments.length === 0) {
      return new Response(JSON.stringify({ message: 'No stuck or pending refund appointments found.' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Group by group_id
    const groups = stuckAppointments.reduce((acc, apt) => {
      const gid = apt.group_id || `single_${apt.id}`;
      if (!acc[gid]) acc[gid] = [];
      acc[gid].push(apt);
      return acc;
    }, {} as Record<string, typeof stuckAppointments>);

    const results = await Promise.allSettled(Object.entries(groups).map(async ([groupId, groupApts]) => {
      const firstApt = groupApts[0];
      const paymentId = firstApt.provider_payment_id || firstApt.payment_intent_id;

      if (!paymentId) {
        return { groupId, status: 'skipped', reason: 'missing_payment_id' };
      }

      let updates = {};
      let action = 'none';

      // Verify all appointments in this group
      const { data: allGroupApts, error: verifyError } = await supabaseAdmin
        .from('appointments')
        .select('id, status, payment_status')
        .eq('group_id', groupId);

      if (verifyError) {
        console.error(`❌ Error verifying status for group ${groupId}:`, verifyError.message);
        return { groupId, status: 'error_verifying_group', details: verifyError.message };
      }

      // Check Asaas payment status
      const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
      const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

      if (!asaasApiKey) {
        console.error(`❌ ASAAS_API_KEY is not defined in Edge Function. Skipping Asaas sync for group ${groupId}.`);
        return { groupId, status: 'skipped', reason: 'missing_asaas_api_key' };
      }

      const url = `${asaasApiUrl}/payments/${paymentId}`;
      const response = await asaasFetch(url, { method: 'GET' });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Asaas API error retrieving payment ${paymentId} for group ${groupId}:`, errText);
        return { groupId, status: 'error_fetching_asaas', details: errText };
      }

      const paymentData = await response.json();
      const asaasStatus = paymentData?.status?.toUpperCase();

      // Check if refund is completed in Asaas (top-level status OR inside paymentData.refunds collection)
      const hasCompletedRefund = Array.isArray(paymentData?.refunds) && paymentData.refunds.some(
        (r: any) => ['DONE', 'REFUNDED'].includes(r?.status?.toUpperCase())
      );
      const isRefunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(asaasStatus) || hasCompletedRefund;

      if (isRefunded) {
        console.log(`✅ Reconciling Group ${groupId}: Asaas is refunded (status: ${asaasStatus}, hasCompletedRefund: ${hasCompletedRefund}).`);
        action = 'repaired_refunded';

        // Update appointments payment_status to 'refunded' and transition 'cancelling' -> 'cancelled' if needed
        const { data: aptsToUpdate } = await supabaseAdmin
          .from('appointments')
          .select('id, status')
          .eq('group_id', groupId);

        const targetApts = (aptsToUpdate && aptsToUpdate.length > 0) ? aptsToUpdate : groupApts;

        for (const apt of targetApts) {
          const newStatus = apt.status === 'cancelling' ? 'cancelled' : apt.status;
          await supabaseAdmin
            .from('appointments')
            .update({
              status: newStatus,
              payment_status: 'refunded',
              updated_at: new Date().toISOString()
            })
            .eq('id', apt.id);
        }

        // Update transaction statuses
        try {
          await supabaseAdmin
            .from('transactions')
            .update({ status: 'completed' })
            .eq('provider_payment_id', paymentId)
            .eq('type', 'refund');

          await supabaseAdmin
            .from('transactions')
            .update({ status: 'failed' })
            .eq('provider_payment_id', paymentId)
            .eq('type', 'lesson_payment');
        } catch (txErr) {
          console.warn('⚠️ [Sync job] Error updating transaction statuses for refund:', txErr);
        }

        // Reconcile payment_installments & payment_settlements for refund via InstallmentService
        try {
          const instNum = paymentData?.installmentNumber || 1;
          const grossVal = Math.round((paymentData?.value || 0) * 100);
          const providerSettlementId = `${paymentId}_refund_${instNum}`;

          await InstallmentService.recordRefundSettlement(supabaseAdmin, {
            providerPaymentId: paymentId,
            groupId: groupId,
            installmentNumber: instNum,
            refundAmountCents: grossVal,
            providerSettlementId: providerSettlementId,
            refundDate: new Date().toISOString()
          });
        } catch (refSyncErr) {
          console.error('⚠️ [Sync job] Error syncing refund installment/settlement:', refSyncErr);
        }
      } else if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
        const hasInvalidStatus = allGroupApts?.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
        if (hasInvalidStatus) {
          console.log(`ℹ️ Group ${groupId} is paid on Asaas but already expired/cancelled in database. Skipping pending_approval transition.`);
          return { groupId, status: 'skipped', reason: 'group_already_cancelled_or_expired' };
        }

        console.log(`✅ Repairing Group ${groupId}: Asaas is paid (${asaasStatus}).`);
        action = 'repaired_succeeded';

        // Notify Instructor (Idempotent)
        const instructor_id = firstApt.instructor_id;
        if (instructor_id) {
          try {
            let studentName = 'Um aluno';
            if (firstApt.student_id) {
              const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('full_name')
                .eq('id', firstApt.student_id)
                .maybeSingle();
              if (profile?.full_name) {
                studentName = profile.full_name;
              }
            }

            let comboCount = 1;
            const { count } = await supabaseAdmin
              .from('appointments')
              .select('id', { count: 'exact', head: true })
              .eq('group_id', groupId);
            if (count) comboCount = count;

            await NotificationService.sendBookingRequest({
              instructorId: instructor_id,
              studentName,
              comboCount,
              groupId
            });
          } catch (notifErr) {
            console.error('⚠️ [Sync job] Error notifying instructor:', notifErr);
          }
        }

        // Fetch full appointment details for the group to recalculate expires_at per lesson
        const { data: groupAptsToUpdate } = await supabaseAdmin
          .from('appointments')
          .select('id, date, start_time, created_at')
          .eq('group_id', groupId)
          .in('status', ['reserved', 'pending_approval', 'awaiting_payment']);

        const targetApts = (groupAptsToUpdate && groupAptsToUpdate.length > 0) ? groupAptsToUpdate : groupApts;

        for (const apt of targetApts) {
          const calculatedExpiresAt = calculateApprovalExpiresAt(apt.date, apt.start_time, apt.created_at);
          const { error: updateError } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'pending_approval',
              payment_status: 'paid',
              expires_at: calculatedExpiresAt,
              updated_at: new Date().toISOString()
            })
            .eq('id', apt.id)
            .in('status', ['reserved', 'pending_approval', 'awaiting_payment']);

          if (updateError) throw updateError;
        }

        // Reconcile payment_installments & payment_settlements
        try {
          const grossVal = Math.round((paymentData?.value || 0) * 100);
          const netVal = paymentData?.netValue !== undefined 
            ? Math.round(paymentData.netValue * 100) 
            : Math.round(grossVal * 0.90);
          const platformFeeVal = grossVal - netVal;
          const instNum = paymentData?.installmentNumber || 1;
          const totalInst = paymentData?.installmentCount || 1;
          const payDate = paymentData?.paymentDate || paymentData?.clientPaymentDate || new Date().toISOString();
          const instructorAmount = grossVal - platformFeeVal;

          const conflictTarget = groupId ? 'group_id,installment_number' : 'provider_payment_id,installment_number';
          const { data: instData } = await supabaseAdmin
            .from('payment_installments')
            .upsert({
              provider_payment_id: paymentId,
              installment_number: instNum,
              total_installments: totalInst,
              gross_amount: grossVal,
              net_amount: netVal,
              fee_amount: 0,
              platform_fee: platformFeeVal,
              instructor_amount: instructorAmount,
              status: 'PAID',
              payment_date: payDate,
              group_id: groupId,
              appointment_id: firstApt.id,
              student_id: firstApt.student_id,
              instructor_id: firstApt.instructor_id,
              updated_at: new Date().toISOString()
            }, { onConflict: conflictTarget })
            .select('id')
            .single();

          if (['RECEIVED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
            const settlementId = paymentData?.id || paymentId;
            await supabaseAdmin
              .from('payment_settlements')
              .upsert({
                installment_id: instData?.id || null,
                provider_payment_id: paymentId,
                provider_settlement_id: settlementId,
                settlement_type: 'PAYMENT',
                gross_amount: grossVal,
                net_amount: netVal,
                fee_amount: 0,
                platform_fee: platformFeeVal,
                instructor_amount: instructorAmount,
                settled_at: payDate,
              }, { onConflict: 'provider_payment_id,settlement_type,provider_settlement_id' });
          } else {
            console.log(`ℹ️ [Sync job] Skipping payment_settlements upsert for asaasStatus: ${asaasStatus} (settlement recorded only on RECEIVED / RECEIVED_IN_CASH).`);
          }
        } catch (instSyncErr) {
          console.error('⚠️ [Sync job] Error syncing installment/settlement:', instSyncErr);
        }
      } else {
        console.log(`ℹ️ Group ${groupId}: Asaas status is ${asaasStatus}. No action taken.`);
        return { groupId, status: 'skipped', asaas_status: asaasStatus };
      }

      return { groupId, status: 'success', action };
    }));

    const successCount = results.filter(r => r.status === 'fulfilled').length;

    return new Response(
      JSON.stringify({ 
        message: 'Sync job completed', 
        processed: stuckAppointments.length,
        success: successCount,
        results 
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Sync Job Error:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
