import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { asaasFetch } from '../_shared/asaasClient.ts'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  try {
    console.log("🔄 Starting sync-payment-status job...")

    // Find 'reserved' or 'pending_approval' or 'awaiting_payment' or 'cancelling' appointments
    const { data: stuckAppointments, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, provider_payment_id, group_id, status, provider_name, student_id, instructor_id')
      .in('status', ['reserved', 'pending_approval', 'awaiting_payment', 'cancelling'])

    if (fetchError) {
      throw fetchError
    }

    console.log(`Found ${stuckAppointments?.length || 0} potentially stuck appointments.`)

    if (!stuckAppointments || stuckAppointments.length === 0) {
      return new Response(JSON.stringify({ message: 'No stuck appointments found.' }), {
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

      // Check if any appointment in this group is already expired, cancelled, or rejected
      const { data: allGroupApts, error: verifyError } = await supabaseAdmin
        .from('appointments')
        .select('status')
        .eq('group_id', groupId);

      if (verifyError) {
        console.error(`❌ Error verifying status for group ${groupId}:`, verifyError.message);
        return { groupId, status: 'error_verifying_group', details: verifyError.message };
      }

      const hasInvalidStatus = allGroupApts?.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
      if (hasInvalidStatus) {
        console.log(`ℹ️ Group ${groupId} contains expired/cancelled/rejected appointments. Skipping Asaas payment reconciliation to prevent overbooking.`);
        return { groupId, status: 'skipped', reason: 'group_has_invalid_status' };
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

      if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
        console.log(`✅ Repairing Group ${groupId}: Asaas is paid (${asaasStatus}).`);
        updates = {
          status: 'pending_approval',
          payment_status: 'paid'
        };
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

        const { error: updateError } = await supabaseAdmin
          .from('appointments')
          .update(updates)
          .eq('group_id', groupId)
          .in('status', ['reserved', 'pending_approval', 'awaiting_payment']);

        if (updateError) throw updateError;

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
        } catch (instSyncErr) {
          console.error('⚠️ [Sync job] Error syncing installment/settlement:', instSyncErr);
        }
      } else if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(asaasStatus)) {
        console.log(`✅ Repairing Group ${groupId}: Asaas is refunded (${asaasStatus}). Updating cancelling -> cancelled.`);
        updates = {
          status: 'cancelled',
          payment_status: 'refunded',
          updated_at: new Date().toISOString()
        };
        action = 'repaired_refunded';

        const { error: updateError } = await supabaseAdmin
          .from('appointments')
          .update(updates)
          .eq('group_id', groupId)
          .eq('status', 'cancelling');

        if (updateError) throw updateError;

        // Reconcile payment_installments & payment_settlements for refund
        try {
          const grossVal = Math.round((paymentData?.value || 0) * 100);
          await supabaseAdmin
            .from('payment_installments')
            .update({ status: 'REFUNDED', updated_at: new Date().toISOString() })
            .or(`group_id.eq.${groupId},provider_payment_id.eq.${paymentId}`);

          const settlementId = `${paymentId}_sync_refund`;
          await supabaseAdmin
            .from('payment_settlements')
            .upsert({
              provider_payment_id: paymentId,
              provider_settlement_id: settlementId,
              settlement_type: 'REFUND',
              gross_amount: -Math.abs(grossVal),
              net_amount: -Math.abs(Math.round(grossVal * 0.90)),
              fee_amount: 0,
              platform_fee: -Math.abs(Math.round(grossVal * 0.10)),
              instructor_amount: -Math.abs(Math.round(grossVal * 0.90)),
              settled_at: new Date().toISOString(),
            }, { onConflict: 'provider_payment_id,settlement_type,provider_settlement_id' });
        } catch (refSyncErr) {
          console.error('⚠️ [Sync job] Error syncing refund installment/settlement:', refSyncErr);
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
