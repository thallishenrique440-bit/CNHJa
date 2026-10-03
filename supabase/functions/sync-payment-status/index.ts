import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { asaasFetch, getAsaasRefundState } from '../_shared/asaasClient.ts'
import { getAsaasEnvironment } from '../_shared/AsaasEnvironment.ts'
import { InstallmentService } from '../_shared/InstallmentService.ts'
import { BookingCancellationCore } from '../_shared/BookingCancellationCore.ts'
import { RefundOperationRepository } from '../_shared/RefundOperationRepository.ts'
import { requireCronAuth } from '../_shared/cronAuth.ts'
import {
  classifySyncGroup, classifyClosedGroupRefund, paymentStatusAfterRefundDenial,
  resolveSyncEligibilityConfig, isOperationallyCurrent
} from '../_shared/syncPaymentDecision.ts'
import { PaymentExceptionService } from '../_shared/PaymentExceptionService.ts'
import { BookingRequestService, BOOKING_FLOW_REQUEST, isBookingConfirmingStatus } from '../_shared/BookingRequestService.ts'

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

/** PENDING/UNKNOWN sem movimento ha' este tempo entram na reconciliacao. */
const REFUND_RECONCILE_IDLE_MS = 10 * 60 * 1000
/** So' operacoes paradas ha' este tempo podem ser fechadas por "nenhum estorno no gateway". */
const REFUND_RECONCILE_STALE_MS = 30 * 60 * 1000
const REFUND_RECONCILE_BATCH = 25

/**
 * FASE 0 — reconciliacao das operacoes de estorno.
 * Consulta o pagamento no Asaas (GET, somente leitura) e aplica a evidencia a
 * cada operacao PENDING/UNKNOWN parada e a cada COMPLETED nunca confirmada.
 * Nunca emite POST: nenhuma cobranca e nenhum estorno novo nascem aqui.
 */
async function reconcileRefundOperations() {
  const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || ''
  if (!asaasApiKey) return { skipped: 'missing_asaas_api_key', checked: 0, results: [] }
  let asaasApiUrl: string
  try {
    asaasApiUrl = getAsaasEnvironment().apiUrl
  } catch (_envErr) {
    return { skipped: 'asaas_environment_invalid', checked: 0, results: [] }
  }

  const olderThan = new Date(Date.now() - REFUND_RECONCILE_IDLE_MS).toISOString()
  // Busca uma janela maior que o lote e filtra: operacoes de aulas passadas
  // (historico) sao ignoradas e NAO podem ocupar o lote das operacoes validas.
  const candidates = await RefundOperationRepository.findStaleForReconciliation(supabaseAdmin, olderThan, REFUND_RECONCILE_BATCH * 4)
  const eligibility = resolveSyncEligibilityConfig((name) => Deno.env.get(name))
  const nowMs = Date.now()
  const opAppointmentIds = (op: any): string[] =>
    Array.isArray(op?.metadata?.appointmentIds) ? op.metadata.appointmentIds.filter((x: any) => typeof x === 'string') : []
  const allIds = Array.from(new Set(candidates.flatMap(opAppointmentIds)))
  const lessonById = new Map<string, any>()
  if (allIds.length > 0) {
    const { data: lessonRows, error: lessonError } = await supabaseAdmin
      .from('appointments')
      .select('id, date, start_time, end_time')
      .in('id', allIds)
    // Sem as aulas nao ha' como comprovar a elegibilidade: nenhuma operacao e'
    // processada neste ciclo (fail-closed) e a falha fica registrada.
    if (lessonError) console.error(`[Sync job] Refund reconciliation: lesson lookup failed: ${lessonError.message}`)
    for (const row of lessonRows || []) lessonById.set(row.id, row)
  }
  const eligibleOps = candidates.filter((op: any) =>
    isOperationallyCurrent(opAppointmentIds(op).map((id) => lessonById.get(id)).filter(Boolean), nowMs, eligibility))
  const skippedHistorical = candidates.length - eligibleOps.length
  const ops = eligibleOps.slice(0, REFUND_RECONCILE_BATCH)
  const results: any[] = []
  for (const op of ops) {
    try {
      results.push(await BookingCancellationCore.reconcileRefundOperation(supabaseAdmin, op, {
        httpFetch: asaasFetch,
        asaasApiUrl,
        asaasApiKey,
        staleAfterMs: REFUND_RECONCILE_STALE_MS
      }))
    } catch (err: any) {
      results.push({ operationId: op.id, before: op.status, after: op.status, outcome: 'error', error: err?.message })
    }
  }
  console.log(`[Sync job] Refund reconciliation: checked=${ops.length} skipped_historical=${skippedHistorical}`)
  return { checked: ops.length, skipped_historical: skippedHistorical, results }
}

/** Janela da varredura de pagamentos sem reserva valida (horas). */
const PAYMENT_EXCEPTION_LOOKBACK_HOURS = 72

/**
 * FASE 1 — pagamentos sem reserva valida.
 * Varre SOMENTE o banco (ledger de eventos, parcelas e aulas) e registra em
 * `payment_exceptions` o que o webhook nao registrou. Nao consulta o Asaas, nao
 * altera aulas e nao pede estorno. Uma falha aqui nao interrompe o restante da
 * conciliacao: fica no relatorio e a proxima execucao tenta de novo.
 */
async function reconcilePaymentExceptions() {
  try {
    const hours = Number(Deno.env.get('PAYMENT_EXCEPTION_LOOKBACK_HOURS')) || PAYMENT_EXCEPTION_LOOKBACK_HOURS
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    const result = await PaymentExceptionService.scanFromDatabase(supabaseAdmin as any, { sinceIso })
    console.log(`[Sync job] Payment exceptions: candidates=${result.candidates} created=${result.created} advanced=${result.advanced}`)
    return result
  } catch (err: any) {
    console.error(`[Sync job] Payment exceptions scan failed: ${err?.message ?? err}`)
    return { error: String(err?.message ?? err) }
  }
}

Deno.serve(async (req) => {
  // R2: reconcilia DINHEIRO (le o Asaas e muda estado de estorno/aula). `verify_jwt`
  // nao basta (a chave anon publica e' um JWT valido). Exige `Authorization:
  // Bearer <CRON_SECRET>`, fail-closed e em tempo constante, ANTES de qualquer
  // leitura ou escrita. Invocacao manual (R1) usa o mesmo segredo.
  const denied = await requireCronAuth(req, 'sync-payment-status')
  if (denied) return denied

  try {
    console.log("🔄 Starting sync-payment-status job...")

    const refundReconciliation = await reconcileRefundOperations()
    const paymentExceptions = await reconcilePaymentExceptions()

    // Find appointments that are stuck in checkout/approval or have pending refund reconciliations
    //
    // Aulas ENCERRADAS so' entram com `paid` (legado) ou `refund_requested`
    // (estorno em analise). `refund_denied` e `refunded` ficam de fora de
    // proposito: sao estados finais para este job — uma aula com estorno
    // recusado nao e' reprocessada a cada execucao nem tem o estado
    // sobrescrito. Este job nunca altera `status` de aula encerrada.
    //
    // Aulas PASSADAS (historico) ficam fora: so' entra o que ainda tem
    // obrigacao operacional vigente (ver _shared/syncPaymentDecision.ts). A
    // regra e' aplicada por GRUPO, abaixo, antes de qualquer consulta ao
    // gateway — nao por linha, porque em um combo vale a ultima aula.
    const eligibility = resolveSyncEligibilityConfig((name) => Deno.env.get(name))
    const nowMs = Date.now()
    const { data: stuckAppointments, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, provider_payment_id, group_id, status, provider_name, student_id, instructor_id, date, start_time, end_time, created_at, payment_status')
      .or('status.in.(reserved,pending_approval,awaiting_payment),and(status.in.(cancelled,expired),payment_status.in.(paid,refund_requested))')

    if (fetchError) {
      throw fetchError
    }

    console.log(`Found ${stuckAppointments?.length || 0} potentially stuck or pending refund appointments.`)

    if (!stuckAppointments || stuckAppointments.length === 0) {
      return new Response(JSON.stringify({ message: 'No stuck or pending refund appointments found.', refund_reconciliation: refundReconciliation, payment_exceptions: paymentExceptions }), {
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
        .select('id, status, payment_status, date, start_time, end_time, booking_flow')
        .eq('group_id', groupId);

      if (verifyError) {
        console.error(`❌ Error verifying status for group ${groupId}:`, verifyError.message);
        return { groupId, status: 'error_verifying_group', details: verifyError.message };
      }

      // Historico: todas as aulas do grupo terminaram alem da tolerancia. Nada
      // e' consultado no gateway e nada e' escrito.
      if (!isOperationallyCurrent((allGroupApts && allGroupApts.length > 0) ? allGroupApts : groupApts, nowMs, eligibility)) {
        return { groupId, status: 'skipped', reason: 'historical_lessons' };
      }

      // Check Asaas payment status
      const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
      // AP-04: ambiente explicito e coerente; sem fallback para sandbox.
      let asaasApiUrl: string;
      try {
        asaasApiUrl = getAsaasEnvironment().apiUrl;
      } catch (envErr: any) {
        console.error(`❌ ${envErr?.message ?? envErr} Asaas sync aborted for group ${groupId}.`);
        return { groupId, status: 'error_asaas_environment', details: String(envErr?.message ?? envErr) };
      }

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
      // FASE 0: a decisao vem de _shared/syncPaymentDecision.ts (mesmas regras
      // de antes, agora testaveis fora do Deno).
      const decision = classifySyncGroup(asaasStatus, (allGroupApts || []).map(apt => apt.status));
      // FASE 3 — novo fluxo: o pedido ja' foi aceito; o pagamento confirmado
      // confirma a aula pela funcao atomica do banco (nunca `pending_approval`).
      const isRequestGroup = (allGroupApts || []).some((apt: any) => apt.booking_flow === BOOKING_FLOW_REQUEST);
      const confirmRequestGroup = async () => {
        const r = await BookingRequestService.confirmPayment(supabaseAdmin as any, groupId, paymentId);
        console.log(`[Sync job] Request flow group ${groupId}: confirm_payment=${r.outcome}`);
        return { groupId, status: r.ok ? 'success' : 'skipped', action: 'request_confirm_payment', outcome: r.outcome };
      };
      if (isRequestGroup && decision === 'skip_not_received' && isBookingConfirmingStatus(asaasStatus)) {
        // Cartao aprovado (CONFIRMED): confirma a aula, sem liquidacao (como o webhook).
        return await confirmRequestGroup();
      }
      const isFullRefund = decision === 'repair_refunded';
      const isPartialRefund = decision === 'skip_partial_refund';

      if (isFullRefund) {
        console.log(`✅ Reconciling Group ${groupId}: Asaas is refunded (status: ${asaasStatus}).`);
        action = 'repaired_refunded';

        // P-1.20.1B: only `payment_status` is reconciled here. The appointment's
        // business status is owned by BookingCancellationCore, which now writes a
        // terminal status only after the refund is COMPLETED. The old
        // `cancelling -> cancelled` repair is gone with the `cancelling` state.
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
          await supabaseAdmin
            .from('appointments')
            .update({
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
      } else if (decision === 'closed_group' || decision === 'skip_not_received' || decision === 'reconcile_payment') {
        const hasInvalidStatus = decision === 'closed_group';
        if (hasInvalidStatus) {
          const refundState = getAsaasRefundState(paymentData);

          // Check if DB has a pending refund transaction for this payment
          const { data: pendingRefundTxs } = await supabaseAdmin
            .from('transactions')
            .select('id, metadata, status')
            .eq('provider_payment_id', paymentId)
            .eq('type', 'refund')
            .eq('status', 'pending');

          const refundAction = classifyClosedGroupRefund(refundState, pendingRefundTxs?.length || 0);
          if (pendingRefundTxs && refundAction !== 'skip_closed') {
            if (refundAction === 'mark_denied') {
              // Explicit evidence of DENIED returned by gateway
              console.log(`⚠️ [Sync job] Payment ${paymentId} has explicit refund DENIED on gateway. Reconciling refund tx to 'failed'.`);
              // ORDEM: aulas primeiro, transacao por ultimo. A transacao
              // `pending` e' o que faz este grupo voltar a ser tratado na
              // proxima execucao; se ela fosse fechada antes e a execucao
              // parasse aqui, a aula ficaria em `refund_requested` para sempre.
              //
              // Recusa de estorno NUNCA vira pagamento falho (`failed`): o
              // pagamento original continua valido. Aula encerrada passa a
              // `refund_denied`; aula ainda aberta volta a `paid` (mesma regra
              // de BookingCancellationCore.releaseAfterDenial). O CAS em
              // `payment_status` evita sobrescrever um estado mais novo.
              for (const apt of (allGroupApts || groupApts)) {
                if (apt.payment_status === 'refund_requested') {
                  const { error: aptDeniedError } = await supabaseAdmin
                    .from('appointments')
                    .update({
                      payment_status: paymentStatusAfterRefundDenial(apt.status),
                      updated_at: new Date().toISOString()
                    })
                    .eq('id', apt.id)
                    .eq('payment_status', 'refund_requested');
                  if (aptDeniedError) throw aptDeniedError;
                }
              }

              for (const tx of pendingRefundTxs) {
                const existingMeta = (tx.metadata && typeof tx.metadata === 'object') ? tx.metadata : {};
                const { error: txDeniedError } = await supabaseAdmin
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
                if (txDeniedError) throw txDeniedError;
              }

              return { groupId, status: 'success', action: 'reconciled_refund_explicitly_denied' };
            } else if (refundAction === 'mark_refunded') {
              console.log(`✅ [Sync job] Payment ${paymentId} refund confirmed as COMPLETED on gateway. Reconciling refund to completed.`);
              // Reconcile as refunded
              for (const apt of (allGroupApts || groupApts)) {
                if (apt.status === 'completed') {
                  continue;
                }
                const { error: aptRefundedError } = await supabaseAdmin
                  .from('appointments')
                  .update({
                    payment_status: 'refunded',
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', apt.id);
                // Falha aqui interrompe ANTES de fechar a transacao pendente,
                // para o grupo voltar a ser tratado na proxima execucao.
                if (aptRefundedError) throw aptRefundedError;
              }

              const { error: txRefundedError } = await supabaseAdmin
                .from('transactions')
                .update({ status: 'completed' })
                .eq('provider_payment_id', paymentId)
                .eq('type', 'refund');
              if (txRefundedError) throw txRefundedError;

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
        const isEffectivelyReceived = decision === 'reconcile_payment';

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

        if (isRequestGroup) {
          return await confirmRequestGroup();
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
        refund_reconciliation: refundReconciliation,
        payment_exceptions: paymentExceptions,
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
