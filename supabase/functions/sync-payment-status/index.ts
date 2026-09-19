import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { asaasFetch, getAsaasRefundState } from '../_shared/asaasClient.ts'
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
      const isFullRefund = asaasStatus === 'REFUNDED';
      const isPartialRefund = asaasStatus === 'PARTIALLY_REFUNDED';

      if (isFullRefund) {
        console.log(`✅ Reconciling Group ${groupId}: Asaas is refunded (status: ${asaasStatus}).`);
        action = 'repaired_refunded';

        // Update appointments payment_status to 'refunded' and transition 'cancelling' -> 'cancelled' if needed
        const { data: aptsToUpdate } = await supabaseAdmin
          .from('appointments')
          .select('id, status')
          .eq('group_id', groupId);

        const targetApts = (aptsToUpdate && aptsToUpdate.length > 0) ? aptsToUpdate : groupApts;

        for (const apt of targetApts) {
          // Inviolable rule: completed appointments represent consumed service and must not be mutated
          if (apt.status === 'completed') {
            continue;
          }
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

        // Reconcile payment_installments for refund via InstallmentService
        try {
          const grossVal = Math.round((paymentData?.value || 0) * 100);

          await InstallmentService.recordRefundSettlement(supabaseAdmin, {
            providerPaymentId: paymentId,
            groupId: groupId,
            refundAmountCents: grossVal,
            refundDate: new Date().toISOString()
          });
        } catch (refSyncErr) {
          console.error('⚠️ [Sync job] Error syncing refund installment:', refSyncErr);
        }
      } else if (isPartialRefund) {
        console.log(`ℹ️ [Sync job] Group ${groupId} has partial refund in Asaas (status: PARTIALLY_REFUNDED). Preserving active installments/appointments.`);
        return { groupId, status: 'skipped', reason: 'partial_refund_retained' };
      } else if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
        const hasInvalidStatus = allGroupApts?.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
        if (hasInvalidStatus) {
          const refundState = getAsaasRefundState(paymentData);

          // Check if DB has a pending refund transaction for this payment
          const { data: pendingRefundTxs } = await supabaseAdmin
            .from('transactions')
            .select('id, metadata, status')
            .eq('provider_payment_id', paymentId)
            .eq('type', 'refund')
            .eq('status', 'pending');

          if (pendingRefundTxs && pendingRefundTxs.length > 0) {
            if (refundState === 'DENIED') {
              // Explicit evidence of DENIED returned by gateway
              console.log(`⚠️ [Sync job] Payment ${paymentId} has explicit refund DENIED on gateway. Reconciling refund tx to 'failed'.`);
              for (const tx of pendingRefundTxs) {
                const existingMeta = (tx.metadata && typeof tx.metadata === 'object') ? tx.metadata : {};
                await supabaseAdmin
                  .from('transactions')
                  .update({
                    status: 'failed',
                    metadata: {
                      ...existingMeta,
                      sync_reconciliation: 'explicit_refund_denied_on_gateway',
                      sync_reconciled_at: new Date().toISOString()
                    }
                  })
                  .eq('id', tx.id);
              }

              for (const apt of (allGroupApts || groupApts)) {
                if (apt.payment_status === 'refund_requested') {
                  await supabaseAdmin
                    .from('appointments')
                    .update({
                      payment_status: 'failed',
                      updated_at: new Date().toISOString()
                    })
                    .eq('id', apt.id);
                }
              }

              return { groupId, status: 'success', action: 'reconciled_refund_explicitly_denied' };
            } else if (refundState === 'COMPLETED') {
              console.log(`✅ [Sync job] Payment ${paymentId} refund confirmed as COMPLETED on gateway. Reconciling refund to completed.`);
              // Reconcile as refunded
              for (const apt of (allGroupApts || groupApts)) {
                if (apt.status === 'completed') {
                  continue;
                }
                await supabaseAdmin
                  .from('appointments')
                  .update({
                    payment_status: 'refunded',
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', apt.id);
              }

              await supabaseAdmin
                .from('transactions')
                .update({ status: 'completed' })
                .eq('provider_payment_id', paymentId)
                .eq('type', 'refund');

              return { groupId, status: 'success', action: 'reconciled_refund_completed' };
            } else {
              // refundState is PENDING, NONE, or UNKNOWN
              // CRITICAL: Absence of refund evidence is NOT evidence of refund denied!
              // Preserve pending state in DB.
              console.log(`ℹ️ Group ${groupId} is ${asaasStatus} on gateway, refundState is ${refundState}. Preserving pending refund state in DB.`);
              return { groupId, status: 'skipped', reason: `refund_state_is_${refundState.toLowerCase()}_preserving_pending` };
            }
          }

          console.log(`ℹ️ Group ${groupId} is paid on Asaas but already expired/cancelled in database. Skipping pending_approval transition.`);
          return { groupId, status: 'skipped', reason: 'group_already_cancelled_or_expired' };
        }

        // P-1.18P2.6: CONFIRMED significa cartao autorizado com credito AINDA
        // FUTURO. Nao liquida, nao marca parcela e nao repara appointment.
        // Mesma regra de api/asaas-webhook.ts:691.
        const isEffectivelyReceived = ['RECEIVED', 'RECEIVED_IN_CASH'].includes(asaasStatus);

        if (!isEffectivelyReceived) {
          console.log(`ℹ️ [Sync job] Group ${groupId}: Asaas esta ${asaasStatus} (autorizado, ainda nao recebido). Nenhuma acao financeira nem reparo de appointment.`);
          return { groupId, status: 'skipped', asaas_status: asaasStatus, reason: 'not_received_yet' };
        }

        // P-1.18P2.6: a reconciliacao e' DELEGADA ao fluxo financeiro oficial.
        //
        // Esta Edge Function deixou de calcular qualquer valor. Ela envia
        // SOMENTE o identificador do pagamento; o endpoint na Vercel consulta o
        // Asaas por conta propria e chama o SettlementService, que continua
        // sendo a autoridade financeira unica. Nenhum valor trafega daqui.
        let reconciled = false;
        try {
          const { data: baseUrlRow } = await supabaseAdmin
            .from('notification_config')
            .select('value')
            .eq('key', 'app_base_url')
            .maybeSingle();

          const appBaseUrl = String(baseUrlRow?.value || '').replace(/\/+$/, '');
          const cronSecret = Deno.env.get('CRON_SECRET') || '';

          if (!appBaseUrl) {
            console.error(`❌ [Sync job] app_base_url ausente em notification_config. Reconciliacao de ${groupId} nao executada.`);
          } else if (!cronSecret) {
            console.error(`❌ [Sync job] CRON_SECRET ausente no ambiente. Reconciliacao de ${groupId} nao executada.`);
          } else {
            const reconcileRes = await fetch(`${appBaseUrl}/api/reconcile-payment`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cronSecret}`
              },
              body: JSON.stringify({ providerPaymentId: paymentId })
            });

            const reconcileBody = await reconcileRes.json().catch(() => ({}));

            if (!reconcileRes.ok) {
              console.error(`❌ [Sync job] Reconciliacao recusada para ${groupId} (HTTP ${reconcileRes.status}, code=${reconcileBody?.code ?? 'n/a'}).`);
            } else {
              reconciled = reconcileBody?.settled === true;
              console.log(`ℹ️ [Sync job] Reconciliacao de ${groupId}: outcome=${reconcileBody?.outcome ?? 'n/a'} settled=${reconciled}.`);
            }
          }
        } catch (reconcileErr) {
          console.error(`⚠️ [Sync job] Erro ao chamar a reconciliacao para ${groupId}:`, reconcileErr);
        }

        if (!reconciled) {
          console.log(`ℹ️ [Sync job] Group ${groupId}: liquidacao oficial nao confirmada. Appointment preservado como esta.`);
          return { groupId, status: 'reconcile_pending', asaas_status: asaasStatus };
        }

        console.log(`✅ Repairing Group ${groupId}: liquidacao oficial confirmada (${asaasStatus}).`);
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

        // P-1.18P2.6: a aritmetica financeira que existia aqui foi REMOVIDA.
        //
        // Ela era uma segunda implementacao da regra, divergente do contrato
        // oficial: tratava a tarifa do Asaas como comissao da CNHJa
        // (platform_fee = gross - netValue), devolvia ao instrutor
        // gross - platform_fee (= netValue, ou seja, os 90% MAIS a comissao),
        // gravava fee_amount = 0, marcava a parcela como 'PAID' e escrevia
        // direto em payment_settlements, sem ledger, sem projecao e sem
        // idempotencia.
        //
        // Tudo isso agora acontece no fluxo oficial, atraves de
        // POST /api/reconcile-payment -> SettlementService, acima.
        // A parcela e' marcada como RECEIVED (nunca 'PAID') pelo
        // InstallmentService, e o appointment so' e' reparado depois de a
        // liquidacao oficial ser confirmada.
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
