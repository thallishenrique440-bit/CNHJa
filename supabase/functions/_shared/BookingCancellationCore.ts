// =============================================================================
// ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR
//
// Fonte: lib/payments/BookingCancellationCore.ts
// Gerador: scripts/sync-shared.ts  (P-1.20.1B)
//
// Edite a fonte e rode `npx tsx scripts/sync-shared.ts`.
// `npx tsx scripts/sync-shared.ts --check` falha se este arquivo divergir.
// =============================================================================

declare const Deno: any;

import { NotificationService } from './NotificationService.ts';
import { RefundOperationRepository, RefundAudit } from './RefundOperationRepository.ts';
import { buildRefundObligationKey, RefundOperationKeyInput } from './RefundOperationKey.ts';
import { RefundOperationRecord } from './RefundOperationTypes.ts';
import { resolveAsaasEnvironment } from './AsaasEnvironment.ts';
import { interpretRefundState, RefundInterpretation, sanitizeProviderMessage } from './RefundConfirmation.ts';

export type CancellationReason = 'instructor_rejected' | 'auto_expired' | 'student_cancelled';

/** Minimal shape of `fetch`, so this module stays runtime agnostic. */
export type HttpFetch = (url: string, init?: any) => Promise<any>;

export interface CancellationParams {
  appointmentId: string;
  reason: CancellationReason;
  scope?: 'SINGLE_APPOINTMENT' | 'FULL_GROUP';
  initiatedBy?: string;
  adminClient: any;
  asaasApiKey?: string;
  asaasApiUrl?: string;
  /**
   * P-1.20.1B: HTTP client used to reach Asaas. Edge Functions inject
   * `asaasFetch` (timeout + backoff, retries disabled for POST /refund).
   * Omitted, the platform `fetch` is used. This keeps the Core identical in
   * both runtimes without dragging `asaasClient.ts` into the generated copy.
   */
  httpFetch?: HttpFetch;
  /**
   * Nova tentativa EXPLICITA de uma operacao DENIED. Nunca e' ligada por
   * cron, webhook ou reconciliacao. Antes de reabrir, o estado do pagamento
   * no Asaas e' consultado: havendo estorno pendente ou concluido para o
   * mesmo valor, nao ha' novo POST.
   */
  explicitRetry?: boolean;
}

/** Dependencias da reconciliacao (somente leitura no gateway). */
export interface RefundReconcileDeps {
  httpFetch: HttpFetch;
  asaasApiUrl: string;
  asaasApiKey: string;
  /** PENDING/UNKNOWN mais antigas que isto podem ser fechadas por "nenhum estorno no gateway". */
  staleAfterMs?: number;
}

/**
 * Estado FINANCEIRO do estorno, separado do estado operacional da aula.
 *  - `confirmed`: o gateway confirmou o estorno;
 *  - `in_review`: estorno solicitado, ambiguo ou em conflito — ainda sem desfecho;
 *  - `denied`: o gateway recusou o estorno (revisao manual);
 *  - `none`: nao ha' estorno (aula nao paga).
 */
export type RefundFinancialState = 'confirmed' | 'in_review' | 'denied' | 'none';

/** Mensagem unica para "aula encerrada, estorno ainda sem confirmacao". */
export const REFUND_IN_REVIEW_MESSAGE = 'O reembolso está em análise e pode ser acompanhado na área Financeiro.';

export function refundStateFromPaymentStatus(paymentStatus: string | null | undefined): RefundFinancialState {
  if (paymentStatus === 'refunded') return 'confirmed';
  if (paymentStatus === 'refund_requested') return 'in_review';
  if (paymentStatus === 'refund_denied') return 'denied';
  return 'none';
}

/**
 * Classificacao de um resultado para contagem/telemetria (cron) — separa "aula
 * encerrada" de "estorno concluido". So' `refund_confirmed` e' estorno feito.
 */
export type CancellationOutcomeKind = 'refund_confirmed' | 'refund_in_review' | 'refund_denied' | 'no_refund' | 'already_processed';

export function classifyCancellationResult(result: Pick<CancellationResult, 'alreadyProcessed' | 'refundState'>): CancellationOutcomeKind {
  if (result.alreadyProcessed) return 'already_processed';
  if (result.refundState === 'confirmed') return 'refund_confirmed';
  if (result.refundState === 'denied') return 'refund_denied';
  if (result.refundState === 'in_review') return 'refund_in_review';
  return 'no_refund';
}

export interface CancellationResult {
  success: boolean;
  alreadyProcessed: boolean;
  reason: CancellationReason;
  /**
   * Estado OPERACIONAL da aula. O encerramento nao depende do desfecho do
   * estorno: uma aula paga e' encerrada mesmo com o estorno pendente ou
   * recusado, e o estado financeiro segue em `paymentStatus`/`refundState`.
   */
  status: 'cancelled' | 'expired';
  paymentStatus: 'refunded' | 'released' | 'failed' | 'refund_requested' | 'refund_denied' | 'paid';
  /** `true` SOMENTE quando o gateway confirmou o estorno. */
  refundConfirmed: boolean;
  refundState: RefundFinancialState;
  isPaid: boolean;
  processedCount: number;
  groupId?: string;
  refundStatus?: string;
  message: string;
}

/**
 * P-1.20.1B — ELIGIBILITY MATRIX `reason x status`.
 *
 * Business rule R2: once the instructor has accepted (`confirmed`/`scheduled`)
 * the lesson can only be RESCHEDULED. Neither the student nor the instructor
 * may cancel it, and no refund exists for that case. Enforced here, in the
 * Core, because the Core is the single point every entrypoint goes through
 * (cancel-booking, reject-booking x2, approve-booking, check-expired-bookings).
 * The UI is ergonomics, not security.
 */
export const REASON_ALLOWED_STATUSES: Record<CancellationReason, string[]> = {
  instructor_rejected: ['pending', 'pending_approval', 'awaiting_payment', 'reserved'],
  student_cancelled: ['pending', 'pending_approval', 'awaiting_payment', 'reserved'],
  auto_expired: ['pending', 'pending_approval', 'awaiting_payment', 'reserved']
};

/** Estados operacionais terminais escritos por este Core. */
export const CLOSED_STATUSES = ['cancelled', 'expired'];

/** Statuses that mean "the instructor already accepted". Never cancellable. */
export const ACCEPTED_STATUSES = ['confirmed', 'scheduled'];

/**
 * Business-level refusal, distinct from a technical failure. Entrypoints map it
 * to HTTP 409 so the caller sees a rule, not a stack trace.
 */
export class CancellationNotAllowedError extends Error {
  public readonly appointmentStatus: string;
  public readonly reason: CancellationReason;

  constructor(reason: CancellationReason, appointmentStatus: string, message: string) {
    super(message);
    this.name = 'CancellationNotAllowedError';
    this.reason = reason;
    this.appointmentStatus = appointmentStatus;
  }
}

/** Reads an env var under Deno or Node without assuming either exists. */
function getEnvVar(name: string): string {
  try {
    if (typeof Deno !== 'undefined' && (Deno as any).env) return (Deno as any).env.get(name) || '';
  } catch (_) { /* not Deno */ }
  try {
    if (typeof process !== 'undefined' && process.env) return process.env[name] || '';
  } catch (_) { /* not Node */ }
  return '';
}

/**
 * Lease granted to the worker that claims a refund operation. Long enough to
 * cover the Asaas round trip (asaasFetch: 15s timeout, backoff), short enough
 * that a dead worker is reaped quickly.
 */
const REFUND_LEASE_MS = 120_000;

/**
 * Best-effort, per-isolate short circuit against a double click. It is NOT the
 * financial lock: `refund_operations` is, and it is the only one. This set is
 * in-memory, released in `finally`, and never touches the database.
 */
const activeCancellationLocks = new Set<string>();

export class BookingCancellationCore {
  /**
   * SSOT for Booking Cancellations (Student Cancellation, Instructor Rejection, Auto Expiration).
   */
  static async processCancellation(params: CancellationParams): Promise<CancellationResult> {
    const { appointmentId, reason, initiatedBy, adminClient } = params;

    const asaasApiKey = params.asaasApiKey || getEnvVar('ASAAS_API_KEY') || '';
    // AP-04: sem fallback. `params.asaasApiUrl` e' injecao explicita (testes);
    // caso contrario o ambiente e' resolvido e validado (lanca se incoerente).
    const asaasApiUrl = params.asaasApiUrl || resolveAsaasEnvironment((name) => getEnvVar(name)).apiUrl;
    const httpFetch: HttpFetch = params.httpFetch || ((globalThis as any).fetch as HttpFetch);

    // 1. Fetch target appointment
    const { data: appointment, error: fetchError } = await adminClient
      .from('appointments')
      .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
      .eq('id', appointmentId)
      .single();

    if (fetchError || !appointment) {
      throw new Error(`Appointment not found: ${appointmentId}`);
    }

    // P0-02: Scope contract resolution
    const effectiveScope: 'SINGLE_APPOINTMENT' | 'FULL_GROUP' = params.scope ||
      (reason === 'student_cancelled' ? 'SINGLE_APPOINTMENT' : (appointment.group_id ? 'FULL_GROUP' : 'SINGLE_APPOINTMENT'));

    const lockKey = effectiveScope === 'FULL_GROUP' && appointment.group_id
      ? `group:${appointment.group_id}`
      : `apt:${appointment.id}`;

    // 2. Concurrency Lock Check
    if (activeCancellationLocks.has(lockKey)) {
      console.warn(`[BookingCancellationCore] Concurrent execution detected for ${lockKey}. Skipping.`);
      return {
        success: true,
        alreadyProcessed: true,
        reason,
        status: reason === 'instructor_rejected' ? 'cancelled' : (reason === 'auto_expired' ? 'expired' : 'cancelled'),
        paymentStatus: appointment.payment_status || 'released',
        refundConfirmed: appointment.payment_status === 'refunded',
        refundState: refundStateFromPaymentStatus(appointment.payment_status),
        isPaid: appointment.payment_status === 'refunded',
        processedCount: 0,
        groupId: appointment.group_id || appointment.id,
        message: 'Cancellation currently in progress by another task.'
      };
    }

    activeCancellationLocks.add(lockKey);

    try {
      // Nova tentativa EXPLICITA do estorno de uma aula JA' ENCERRADA com o
      // estorno recusado. E' uma operacao somente financeira: reabre a operacao
      // DENIED (mesmas regras de `explicitRetry`), nunca altera o `status` da
      // aula e nunca e' ligada por cron, webhook ou reconciliacao.
      const isFinancialRetry = params.explicitRetry === true
        && CLOSED_STATUSES.includes(appointment.status)
        && appointment.payment_status === 'refund_denied';

      // 3. Idempotency & Eligibility Validation
      if (isFinancialRetry) {
        // segue para o fluxo do gateway; a aula permanece encerrada.
      } else if (reason === 'instructor_rejected') {
        if (appointment.status === 'cancelled' && appointment.cancelled_reason === 'instructor_rejected') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'cancelled',
            paymentStatus: appointment.payment_status || 'released',
            refundConfirmed: appointment.payment_status === 'refunded',
            refundState: refundStateFromPaymentStatus(appointment.payment_status),
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already rejected'
          };
        }
      } else if (reason === 'auto_expired') {
        if (appointment.status === 'expired') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'expired',
            paymentStatus: appointment.payment_status || 'released',
            refundConfirmed: appointment.payment_status === 'refunded',
            refundState: refundStateFromPaymentStatus(appointment.payment_status),
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already expired'
          };
        }
      } else if (reason === 'student_cancelled') {
        if (appointment.status === 'cancelled' || appointment.status === 'expired') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'cancelled',
            paymentStatus: appointment.payment_status || 'released',
            refundConfirmed: appointment.payment_status === 'refunded',
            refundState: refundStateFromPaymentStatus(appointment.payment_status),
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already cancelled'
          };
        }
      }

      // P-1.20.1B: eligibility is a function of the reason, not a flat list.
      const allowedStatuses = REASON_ALLOWED_STATUSES[reason] || [];
      if (!isFinancialRetry && !allowedStatuses.includes(appointment.status)) {
        if (ACCEPTED_STATUSES.includes(appointment.status)) {
          throw new CancellationNotAllowedError(
            reason,
            appointment.status,
            'Esta aula ja foi aceita pelo instrutor e nao pode mais ser cancelada. Use a remarcacao.'
          );
        }
        throw new CancellationNotAllowedError(
          reason,
          appointment.status,
          `Agendamento em estado nao cancelavel (status atual: ${appointment.status}).`
        );
      }

      // 4. Fetch Appointments To Cancel (P0-02 Scope Strict Enforcement)
      let appointmentsToCancel = [appointment];
      if (effectiveScope === 'FULL_GROUP' && appointment.group_id) {
        const { data: groupAppointments, error: groupError } = await adminClient
          .from('appointments')
          .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
          .eq('group_id', appointment.group_id);

        if (groupError) throw new Error(`Error fetching group: ${groupError.message}`);
        if (!groupAppointments || groupAppointments.length === 0) throw new Error('Group not found');

        const activeNonCancelable = groupAppointments.filter((a: any) => !allowedStatuses.includes(a.status) && a.status !== 'cancelled' && a.status !== 'expired');
        if (!isFinancialRetry && activeNonCancelable.length > 0) {
          throw new Error('Este combo não pode ser cancelado pois um ou mais horários já foram processados.');
        }

        appointmentsToCancel = isFinancialRetry
          ? groupAppointments.filter((a: any) => CLOSED_STATUSES.includes(a.status) && a.payment_status === 'refund_denied')
          : groupAppointments.filter((a: any) => allowedStatuses.includes(a.status));
        if (appointmentsToCancel.length === 0) {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: reason === 'instructor_rejected' ? 'cancelled' : (reason === 'auto_expired' ? 'expired' : 'cancelled'),
            paymentStatus: appointment.payment_status || 'released',
            refundConfirmed: appointment.payment_status === 'refunded',
            refundState: refundStateFromPaymentStatus(appointment.payment_status),
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 0,
            groupId: appointment.group_id,
            message: 'All appointments in group are already processed'
          };
        }
      }

      const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

      // 4.5. P-1.20.1B — THE `cancelling` LOCK IS GONE.
      //
      // The appointment used to be flipped to `status = 'cancelling'` here,
      // BEFORE any gateway call, as an improvised distributed lock held across
      // network I/O with no owner, no lease and no release. Any failure after
      // this point stranded the row forever: `cancelling` is excluded from no
      // unique index, is unknown to `getDerivedStatus`, and nothing reverts it.
      //
      // `refund_operations` is now the only financial lock. Its `operation_key`
      // is unique and deterministic and its claim carries owner + lease, which
      // is everything this block was trying to approximate. The appointment
      // goes straight from its real business status to a terminal one.
      //
      // The unpaid path has no refund operation, so its terminal write in step 8
      // carries its own CAS (`.in('status', allowedStatuses)`), which is atomic
      // and idempotent on its own.

      // 5. Asaas Gateway Integration with Durable RefundOperation & Integer Cents Math
      let isPaid = false;
      let isRefundRequestedOrConfirmed = false;
      let isRefundConfirmed = false;
      let refundOperation: RefundOperationRecord | null = null;
      /**
       * P-1.20.1B: true only once the gateway has actually told us what this
       * payment is. Before, a failed `GET /payments/{id}` left `isPaid = false`
       * and the booking was cancelled as if it had never been paid -- silently
       * keeping the student's money. Not knowing is not the same as not paid.
       */
      let gatewayStateKnown = false;

      if (paymentId && asaasApiKey) {
        console.log(`[BookingCancellationCore] Consulting Asaas payment details for ${paymentId} (reason: ${reason})`);
        const paymentUrl = `${asaasApiUrl}/payments/${paymentId}`;
        
        try {
          const paymentRes = await httpFetch(paymentUrl, {
            method: 'GET',
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (paymentRes.ok) {
            const paymentData = await paymentRes.json();
            const installmentId = paymentData.installment;
            const asaasStatus = (paymentData.status || '').toUpperCase();

            isPaid = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'].includes(asaasStatus);
            gatewayStateKnown = true;

            if (isPaid) {
              // P1-01: Calculate requested amount strictly in integer cents using appointment.price
              const requestedAmountCents = Math.round(
                appointmentsToCancel.reduce((sum: number, a: any) => sum + Number(a.price || 0), 0)
              );

              // Calculate total group nominal price in cents for ratio calculations
              let totalGroupNominalPriceCents = 0;
              if (appointment.group_id) {
                const { data: gApts } = await adminClient
                  .from('appointments')
                  .select('price')
                  .eq('group_id', appointment.group_id);
                if (gApts && gApts.length > 0) {
                  totalGroupNominalPriceCents = gApts.reduce((sum: number, a: any) => sum + Math.round(Number(a.price || 0)), 0);
                }
              }
              if (!totalGroupNominalPriceCents || totalGroupNominalPriceCents <= 0) {
                totalGroupNominalPriceCents = requestedAmountCents;
              }

              // P1-01: Process splits strictly in integer cents
              const splits = Array.isArray(paymentData.split) ? paymentData.split : [];
              const splitRefundsPayload: Array<{ id: string; value: number }> = [];
              // Retrato dos splits no momento da decisao. E' INFORMACAO da operacao
              // (metadata.split_snapshot), nunca parte da sua identidade.
              const splitSnapshot: Array<{ id: string; amountCents: number }> = [];

              if (splits.length > 0) {
                for (const s of splits) {
                  if (!s || s.status === 'CANCELED' || s.status === 'REFUNDED') continue;
                  const splitId = s.id || s.walletId || s.wallet_id;
                  if (!splitId) continue;

                  let splitRefundCents = 0;
                  let fixedValueCents = 0;

                  if (s.fixedValue !== undefined && s.fixedValue !== null) {
                    fixedValueCents = Math.round(Number(s.fixedValue) * 100);
                    const ratio = totalGroupNominalPriceCents > 0
                      ? Math.min(1, requestedAmountCents / totalGroupNominalPriceCents)
                      : 1;
                    splitRefundCents = Math.round(fixedValueCents * ratio);
                    splitRefundCents = Math.min(splitRefundCents, fixedValueCents);
                  } else if (s.percentualValue !== undefined && s.percentualValue !== null) {
                    const pct = Number(s.percentualValue);
                    splitRefundCents = Math.round((requestedAmountCents * pct) / 100);
                  }

                  splitRefundCents = Math.min(splitRefundCents, requestedAmountCents);

                  if (splitRefundCents > 0) {
                    splitSnapshot.push({ id: String(splitId), amountCents: splitRefundCents });
                    splitRefundsPayload.push({
                      id: String(splitId),
                      value: Number((splitRefundCents / 100).toFixed(2))
                    });
                  }
                }
              }

              // Chave ESTAVEL da obrigacao (v2): pagamento + escopo + aulas + valor.
              // Os splits NAO entram: o estado deles muda no gateway quando o Asaas
              // os reverte, e isso fazia a chave mudar e uma nova operacao nascer
              // a cada ciclo do cron.
              const cancelAppointmentIds: string[] = appointmentsToCancel.map((a: any) => a.id);
              const operationKeyInput: RefundOperationKeyInput = {
                provider: 'asaas',
                providerPaymentId: paymentId,
                providerInstallmentId: installmentId || null,
                refundScope: effectiveScope,
                items: appointmentsToCancel.map((a: any) => ({ id: a.id, amountCents: Math.round(Number(a.price || 0)) })),
                requestedAmountCents,
                allocationVersion: 'v2'
              };
              const stableOperationKey = buildRefundObligationKey(operationKeyInput);

              // Operacao ja' existente para ESTA obrigacao, em qualquer versao de
              // chave. Se existir — inclusive DENIED ou CONFLICT — e' ela que vale:
              // nenhuma operacao nova e' criada e nenhum POST automatico acontece.
              const existingOp = await RefundOperationRepository.findByObligation(
                adminClient, 'asaas', paymentId, effectiveScope, cancelAppointmentIds, requestedAmountCents
              );
              const operationKey = existingOp ? existingOp.operation_key : stableOperationKey;

              // Check Cumulative Ceiling (AvailableBalanceCents)
              const eligiblePaymentCents = Math.round(Number(paymentData.value || 0) * 100);
              const retainedCents = await RefundOperationRepository.getRetainedAmountCents(adminClient, paymentId, operationKey);
              const availableBalanceCents = Math.max(0, eligiblePaymentCents - retainedCents);

              if (requestedAmountCents > availableBalanceCents) {
                throw new Error(`Requested refund amount (${requestedAmountCents} cents) exceeds available balance (${availableBalanceCents} cents) for payment ${paymentId}`);
              }

              // Create or Get durable RefundOperation. A chave estavel + UNIQUE
              // (provider, operation_key) garante uma unica linha mesmo com dois
              // workers simultaneos; `createOrGet` nunca reinicia uma existente.
              let op = existingOp || await RefundOperationRepository.createOrGet(adminClient, {
                operationKey,
                providerPaymentId: paymentId,
                scope: effectiveScope,
                requestedAmountCents,
                metadata: {
                  appointmentIds: cancelAppointmentIds,
                  reason,
                  key_version: 'v2',
                  split_snapshot: splitSnapshot
                }
              });

              // P0-01: Handle PENDING lease expiration & UNKNOWN state
              op = await RefundOperationRepository.handleExpiredPending(adminClient, op);

              // Estado real ANTES de qualquer decisao: o GET acima ja' trouxe o
              // pagamento. Operacoes ambiguas, pendentes ou concluidas sem
              // confirmacao sao resolvidas pela evidencia do gateway — nunca por
              // um novo POST.
              const gatewayView = interpretRefundState(paymentData, {
                paymentId,
                requestedAmountCents: op.requested_amount_cents,
                knownProviderRefundId: op.provider_refund_id
              });
              if (op.status === 'UNKNOWN' || op.status === 'PENDING'
                  || (op.status === 'COMPLETED' && !op.acknowledged_at)) {
                op = await BookingCancellationCore.applyProviderEvidence(
                  adminClient, op, gatewayView, { source: 'payment_lookup' }, { finalize: false }
                );
              }

              // Nova tentativa de DENIED: so' explicita e so' se o gateway nao
              // mostra estorno pendente/concluido para este valor.
              if (op.status === 'DENIED' && params.explicitRetry === true) {
                if (gatewayView.outcome === 'COMPLETED' || gatewayView.outcome === 'PENDING') {
                  op = await BookingCancellationCore.applyProviderEvidence(
                    adminClient, op, gatewayView, { source: 'payment_lookup' }, { finalize: false }
                  );
                } else {
                  op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'REQUESTED', {
                    owner_id: null,
                    lease_until: null,
                    denial_reason: null,
                    metadata: {
                      ...(op.metadata || {}),
                      previous_denial_reason: op.denial_reason,
                      explicit_retry_at: new Date().toISOString()
                    }
                  }, { source: 'manual_retry', reason: sanitizeProviderMessage(op.denial_reason), decision: 'explicit_retry' },
                  { explicitRetry: true });
                }
              }

              if (op.status === 'UNKNOWN') {
                // Ambiguous: the gateway may already have refunded. Only external
                // evidence may close it. Never POST again.
                console.warn(`[BookingCancellationCore] Operation ${op.id} is UNKNOWN. POST /refund BLOCKED, awaiting reconciliation.`);
                isRefundRequestedOrConfirmed = true;
              } else if (op.status === 'COMPLETED' || op.status === 'PARTIALLY_COMPLETED') {
                console.log(`[BookingCancellationCore] Operation ${op.id} already completed.`);
                isRefundRequestedOrConfirmed = true;
                // So' conta como estornado o que o gateway CONFIRMOU.
                isRefundConfirmed = op.status === 'COMPLETED' && !!op.acknowledged_at;
              } else if (op.status === 'DENIED' || op.status === 'CONFLICT') {
                console.warn(`[BookingCancellationCore] Operation ${op.id} is ${op.status}. Skipping POST retry.`);
                isRefundRequestedOrConfirmed = true;
              } else if (op.status === 'REQUESTED') {
                // P-1.20.1B: the claim IS the transition REQUESTED -> PENDING and
                // it stamps `sent_at`. There is no second transition to PENDING
                // and therefore no stale version to get wrong.
                const ownerId = `worker-${crypto.randomUUID()}`;
                const leaseUntil = new Date(Date.now() + REFUND_LEASE_MS).toISOString();
                const claimRes = await RefundOperationRepository.claim(adminClient, op.id, ownerId, leaseUntil);

                if (!claimRes.claimed) {
                  console.log(`[BookingCancellationCore] Operation ${op.id} claim lost. Handled by a concurrent worker.`);
                  isRefundRequestedOrConfirmed = true;
                  op = claimRes.operation;
                  isRefundConfirmed = op.status === 'COMPLETED' && !!op.acknowledged_at;
                } else {
                  // VERSION RULE: `op` always holds the record returned by the
                  // LAST successful operation. Nothing is ever computed as
                  // `version + 1` from here on.
                  op = claimRes.operation;

                  const refundUrl = `${asaasApiUrl}/payments/${paymentId}/refund`;
                  const refundPayload: Record<string, any> = {
                    value: Number((requestedAmountCents / 100).toFixed(2)),
                    description: reason === 'instructor_rejected' ? 'Cancelamento por recusa do instrutor' : (reason === 'student_cancelled' ? 'Cancelamento de aula pelo aluno' : 'Cancelamento por expiracao de solicitacao')
                  };
                  if (splitRefundsPayload.length > 0) {
                    refundPayload.splitRefunds = splitRefundsPayload;
                  }

                  try {
                    const refundRes = await httpFetch(refundUrl, {
                      method: 'POST',
                      headers: {
                        'access_token': asaasApiKey,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify(refundPayload)
                    });

                    if (refundRes.ok) {
                      // HTTP 2xx NAO e' confirmacao. O corpo e' o objeto do
                      // PAGAMENTO (seu `id` e' o do pagamento, nunca do estorno);
                      // o estado real vem do item de estorno casado pelo valor.
                      const refundResData = await refundRes.json().catch(() => null);
                      const view = interpretRefundState(refundResData, {
                        paymentId,
                        requestedAmountCents
                      });
                      const nowIso = new Date().toISOString();
                      const audit: RefundAudit = {
                        source: 'post',
                        httpStatus: refundRes.status,
                        asaasPaymentStatus: view.asaasPaymentStatus,
                        refundItemStatus: view.refundItemStatus,
                        providerRefundId: view.providerRefundId,
                        decision: view.decision
                      };
                      const evidenceMeta = {
                        ...(op.metadata || {}),
                        post_response: { payment_status: view.asaasPaymentStatus, refund_item_status: view.refundItemStatus, decision: view.decision },
                        ...(view.endToEndIdentifier ? { end_to_end_identifier: view.endToEndIdentifier } : {})
                      };

                      if (view.outcome === 'COMPLETED') {
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'COMPLETED', {
                          completed_amount_cents: view.matchedAmountCents ?? requestedAmountCents,
                          provider_refund_id: view.providerRefundId,
                          completed_at: nowIso,
                          acknowledged_at: nowIso,
                          owner_id: null,
                          lease_until: null,
                          metadata: { ...evidenceMeta, completion_evidence: 'post_response' }
                        }, audit);
                        isRefundConfirmed = true;
                        isRefundRequestedOrConfirmed = true;
                      } else if (view.outcome === 'PENDING') {
                        // Aceito pelo gateway, ainda em processamento: reconhecido,
                        // lease liberada (o reaper nao o rebaixa a UNKNOWN). Fecha
                        // por webhook ou reconciliacao — nunca por novo POST.
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'PENDING', {
                          acknowledged_at: nowIso,
                          provider_refund_id: view.providerRefundId,
                          owner_id: null,
                          lease_until: null,
                          metadata: evidenceMeta
                        }, audit);
                        isRefundRequestedOrConfirmed = true;
                      } else if (view.outcome === 'DENIED') {
                        const reason = sanitizeProviderMessage(`refund item ${view.refundItemStatus}`) || 'refund_denied';
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'DENIED', {
                          denial_reason: reason,
                          owner_id: null,
                          lease_until: null,
                          metadata: { ...evidenceMeta, requires_manual_review: true }
                        }, { ...audit, reason });
                        // Recusa definitiva: a aula e' encerrada mesmo assim, com
                        // o estado financeiro `refund_denied` (revisao manual).
                        console.warn(`[BookingCancellationCore] Asaas refund denied for payment ${paymentId} (${view.refundItemStatus}).`);
                        isRefundRequestedOrConfirmed = true;
                      } else {
                        // Resposta sem prova do estado: o estorno PODE existir.
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'UNKNOWN', {
                          unknown_since: nowIso,
                          owner_id: null,
                          lease_until: null,
                          metadata: evidenceMeta
                        }, audit);
                        isRefundRequestedOrConfirmed = true;
                      }
                    } else {
                      const errText = await refundRes.text();
                      const reason = sanitizeProviderMessage(errText);
                      // 408 = timeout do lado do gateway: o pedido pode ter sido aplicado.
                      const isDefinitiveRefusal = refundRes.status >= 400 && refundRes.status < 500 && refundRes.status !== 408;
                      if (isDefinitiveRefusal) {
                        // The gateway refused. Deterministic, terminal.
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'DENIED', {
                          denial_reason: reason,
                          metadata: { ...(op.metadata || {}), requires_manual_review: true }
                        }, { source: 'post', httpStatus: refundRes.status, reason, decision: 'http_refusal' });
                        // Mesma regra da recusa por item: encerra a aula, estorno `refund_denied`.
                        console.warn(`[BookingCancellationCore] Asaas refund failed (HTTP ${refundRes.status}) for payment ${paymentId}: ${reason}`);
                        isRefundRequestedOrConfirmed = true;
                      } else {
                        // 5xx/408: the refund MAY have been applied. Never assume it was not.
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'UNKNOWN', {
                          unknown_since: new Date().toISOString()
                        }, { source: 'post', httpStatus: refundRes.status, reason, decision: 'http_ambiguous' });
                        throw new Error(`Asaas gateway server error (HTTP ${refundRes.status}): ${reason}`);
                      }
                    }
                  } catch (netErr: any) {
                    // Timeout / socket error: also ambiguous. Re-read before writing,
                    // because the reaper may already have moved the row to UNKNOWN.
                    const currentOp = await RefundOperationRepository.get(adminClient, op.id);
                    if (currentOp.status === 'PENDING' && currentOp.owner_id === ownerId) {
                      op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, currentOp.version, 'UNKNOWN', {
                        unknown_since: new Date().toISOString()
                      }, { source: 'post', decision: 'network_error_after_send', reason: sanitizeProviderMessage(netErr?.message) });
                    } else {
                      op = currentOp;
                    }
                    throw netErr;
                  }
                }
              }

              refundOperation = op;
            } else {
              // UNPAID payment cancellation
              console.log(`[BookingCancellationCore] Deleting pending Asaas payment ${paymentId}`);
              const cancelUrl = `${asaasApiUrl}/payments/${paymentId}`;
              const cancelRes = await httpFetch(cancelUrl, {
                method: 'DELETE',
                headers: {
                  'access_token': asaasApiKey,
                  'Content-Type': 'application/json'
                }
              });
              if (!cancelRes.ok) {
                const errText = await cancelRes.text();
                console.warn(`⚠️ Asaas pending payment cancel returned non-OK: ${errText}`);
              }
            }
          }
        } catch (gatewayErr: any) {
          console.error(`⚠️ Gateway operation warning for payment ${paymentId}:`, gatewayErr?.message || gatewayErr);
          if (isPaid && !isRefundRequestedOrConfirmed) throw gatewayErr;
        }
      }

      // ======================================================================
      // ENCERRAMENTO OPERACIONAL x DESFECHO FINANCEIRO
      //
      // O estado operacional da aula (`status`) NAO depende do estorno. Uma aula
      // paga que expirou, foi recusada ou cancelada e' encerrada aqui qualquer
      // que seja o estado da operacao de estorno. O que o estorno decide e'
      // SOMENTE o estado financeiro:
      //   - COMPLETED confirmado ............. `refunded`
      //   - REQUESTED/PENDING/UNKNOWN/CONFLICT `refund_requested` (em analise)
      //   - DENIED ........................... `refund_denied` (revisao manual)
      // `refunded` nunca e' gravado sem confirmacao do gateway, as parcelas so'
      // viram REFUNDED com confirmacao, e nenhum POST novo nasce daqui.
      //
      // Antes, a aula paga ficava intacta ate' o estorno atingir COMPLETED: com
      // o estorno recusado ela permanecia `pending_approval` para sempre e o
      // cron a reprocessava a cada minuto.
      // ======================================================================
      // D3 — SEM CONFIRMACAO DO GATEWAY, NADA E' ESCRITO.
      //
      // A condicao anterior exigia `asaasApiKey` e, por isso, deixava aberta
      // exatamente a falha que este guard deveria fechar: com a secret ausente
      // ou vazia, o bloco do gateway acima nem executa, `isPaid` fica `false`,
      // este guard nao dispara e o fluxo seguia como se a aula nunca tivesse
      // sido paga -- cancelando o agendamento, marcando as parcelas como
      // CANCELLED e gravando `payment_status: 'released'`, com o dinheiro do
      // aluno retido no gateway.
      //
      // Agora basta existir `paymentId`: se o estado do pagamento nao foi
      // confirmado, falha explicita. Nao se inventa estado de pagamento, e
      // "nao saber" nunca e' tratado como "nao foi pago".
      if (paymentId && !gatewayStateKnown) {
        throw new Error(
          `Nao foi possivel confirmar o estado do pagamento ${paymentId} no gateway` +
          `${asaasApiKey ? '' : ' (ASAAS_API_KEY ausente ou vazia)'}. ` +
          `Nenhuma alteracao foi feita no agendamento.`
        );
      }

      // ----------------------------------------------------------------------
      // VISAO ATUAL DA OPERACAO
      //
      // Entre o POST e as escritas abaixo, outro ator pode mover a operacao: o
      // webhook (estorno concluido ou recusado) ou outro worker que detinha a
      // lease. Decidir com a copia em memoria gravava um estado ja' superado.
      // A operacao e' relida no banco imediatamente ANTES das escritas e de
      // novo DEPOIS delas (`settleWithCurrentOperation`), e so' a linha lida
      // do banco define `refunded` / `refund_denied`.
      // ----------------------------------------------------------------------
      let isRefundDenied = false;
      let refundState = 'none' as RefundFinancialState;
      const refreshRefundView = async (): Promise<void> => {
        if (isPaid && refundOperation) {
          refundOperation = await RefundOperationRepository.get(adminClient, refundOperation.id);
          isRefundConfirmed = refundOperation.status === 'COMPLETED' && !!refundOperation.acknowledged_at;
        }
        isRefundDenied = isPaid && !isRefundConfirmed && refundOperation?.status === 'DENIED';
        refundState = !isPaid ? 'none'
          : (isRefundConfirmed ? 'confirmed' : (isRefundDenied ? 'denied' : 'in_review'));
      };
      const financialStatus = (): 'refunded' | 'refund_requested' | 'refund_denied' | 'released' => !isPaid ? 'released'
        : (isRefundConfirmed ? 'refunded' : (isRefundDenied ? 'refund_denied' : 'refund_requested'));
      /**
       * Depois das escritas: rele a operacao e, se ela mudou ou se a aula foi
       * encerrada por outro ator com um estado mais antigo, alinha ledger,
       * parcelas e `payment_status` ao estado ATUAL. So' promove (em analise ->
       * confirmado/recusado); nunca rebaixa o que outro ator ja' confirmou.
       */
      const settleWithCurrentOperation = async (ids: string[]): Promise<void> => {
        if (!isPaid || !refundOperation || !paymentId) return;
        const written = refundState;
        await refreshRefundView();
        if (refundState !== written && (isRefundConfirmed || isRefundDenied)) {
          console.warn(`[BookingCancellationCore] Refund operation ${refundOperation.id} moved to ${refundOperation.status} during the write; realigning ledger (${written} -> ${refundState}).`);
          if (isRefundConfirmed) {
            await BookingCancellationCore.applyInstallmentOutcome(adminClient, {
              isPaid, isRefundConfirmed, scope: effectiveScope, paymentId, groupId: appointment.group_id
            });
          }
          await BookingCancellationCore.writeRefundTransactions(adminClient, {
            paymentId, appointments: appointmentsToCancel, reason, isRefundConfirmed, isRefundDenied
          });
        }
        await BookingCancellationCore.alignClosedAppointments(adminClient, ids, refundState);
      };

      await refreshRefundView();
      if (isPaid && !isRefundConfirmed) {
        console.warn(`[BookingCancellationCore] Refund for ${paymentId} is not COMPLETED (state: ${refundOperation?.status || 'UNKNOWN'}). Closing the appointment operationally; financial state: ${refundState}.`);
      }

      // 6. Update payment_installments table (SSOT)
      if (paymentId || appointment.group_id) {
        await BookingCancellationCore.applyInstallmentOutcome(adminClient, {
          isPaid, isRefundConfirmed, scope: effectiveScope, paymentId, groupId: appointment.group_id
        });
      }

      // 7. Update Financial Transactions
      if (isPaid && paymentId) {
        await BookingCancellationCore.writeRefundTransactions(adminClient, {
          paymentId, appointments: appointmentsToCancel, reason, isRefundConfirmed, isRefundDenied
        });
      }

      // 8. Update Appointments Table
      const cancelIds = appointmentsToCancel.map((a: any) => a.id);
      if (isFinancialRetry) {
        // Somente o estado financeiro muda; a aula continua encerrada.
        const { error: retryError } = await adminClient
          .from('appointments')
          .update({ payment_status: financialStatus(), updated_at: new Date().toISOString() })
          .in('id', cancelIds)
          .in('status', CLOSED_STATUSES);
        if (retryError) throw retryError;
        await settleWithCurrentOperation(cancelIds);
        const retryPaymentStatus = financialStatus();
        return {
          success: true,
          alreadyProcessed: false,
          reason,
          status: appointment.status === 'expired' ? 'expired' : 'cancelled',
          paymentStatus: retryPaymentStatus,
          refundConfirmed: isRefundConfirmed,
          refundState,
          isPaid,
          processedCount: cancelIds.length,
          groupId: appointment.group_id || appointment.id,
          refundStatus: refundOperation?.status,
          message: isRefundConfirmed
            ? 'Estorno confirmado pelo gateway.'
            : `Nova tentativa de estorno registrada. ${REFUND_IN_REVIEW_MESSAGE}`
        };
      }
      // P-1.20.1B: the terminal write carries its own CAS. This single statement
      // is atomic and idempotent, which is all the `cancelling` lock ever
      // provided — without the corruptible intermediate state.
      const { targetStatus, effectivelyCancelled } = await BookingCancellationCore.applyAppointmentOutcome(adminClient, {
        ids: cancelIds, allowedStatuses, reason, isPaid, isRefundConfirmed, isRefundDenied, initiatedBy
      });
      // Vale tambem quando o CAS nao encerrou nada (outro worker encerrou
      // antes, possivelmente com um estado financeiro mais antigo).
      await settleWithCurrentOperation(cancelIds);
      const paymentStatus = financialStatus();
      if (effectivelyCancelled === 0) {
        // Another worker closed the appointment first: success, not failure.
        console.log(`[BookingCancellationCore] Appointments already in a terminal state for ${lockKey}.`);
        return {
          success: true,
          alreadyProcessed: true,
          reason,
          status: targetStatus,
          paymentStatus,
          refundConfirmed: isRefundConfirmed,
          refundState,
          isPaid,
          processedCount: 0,
          groupId: appointment.group_id || appointment.id,
          refundStatus: refundOperation?.status,
          message: 'Cancelamento ja processado por outro worker.'
        };
      }

      // 9. Send Notifications
      const comboCount = appointmentsToCancel.length || 1;
      const groupId = appointment.group_id || appointment.id;
      await BookingCancellationCore.sendCancellationNotifications(reason, appointment, comboCount, groupId, refundState);

      return {
        success: true,
        alreadyProcessed: false,
        reason,
        status: targetStatus,
        paymentStatus,
        refundConfirmed: isRefundConfirmed,
        refundState,
        isPaid,
        processedCount: effectivelyCancelled,
        groupId,
        refundStatus: refundOperation?.status,
        // So' afirma estorno concluido com confirmacao do gateway.
        message: refundState === 'confirmed'
          ? 'Cancelamento e estorno processados com sucesso.'
          : (refundState === 'none'
            ? 'Cancelamento processado com sucesso.'
            : `Aula encerrada. ${REFUND_IN_REVIEW_MESSAGE}`)
      };

    } finally {
      activeCancellationLocks.delete(lockKey);
    }
  }

  // ==========================================================================
  // DESFECHO FINANCEIRO — unico codigo, usado pelo fechamento sincrono (acima)
  // e pelo assincrono (webhook / reconciliacao, `finalizeConfirmedRefund`).
  // ==========================================================================

  /** Passo 6 — parcelas: CANCELLED (nao pago) ou REFUNDED (estorno CONFIRMADO). */
  static async applyInstallmentOutcome(adminClient: any, p: {
    isPaid: boolean; isRefundConfirmed: boolean; scope: string; paymentId: string | null; groupId: string | null;
  }): Promise<void> {
    const { isPaid, isRefundConfirmed, scope, paymentId, groupId } = p;
    try {
      if (!isPaid || isRefundConfirmed) {
        let piQuery = adminClient.from('payment_installments').update({
          status: isPaid ? 'REFUNDED' : 'CANCELLED',
          updated_at: new Date().toISOString()
        });
        piQuery = BookingCancellationCore.scopeInstallments(piQuery, scope, paymentId, groupId);
        await piQuery;
      }
    } catch (piEx) {
      console.warn(`⚠️ Exception updating payment_installments:`, piEx);
    }
  }

  /** Filtro de escopo das parcelas (identico nos dois sentidos: marcar e reverter). */
  private static scopeInstallments(piQuery: any, scope: string, paymentId: string | null, groupId: string | null): any {
    if (scope === 'SINGLE_APPOINTMENT') return piQuery.eq('provider_payment_id', paymentId);
    if (groupId && paymentId) return piQuery.or(`group_id.eq.${groupId},provider_payment_id.eq.${paymentId}`);
    if (groupId) return piQuery.eq('group_id', groupId);
    return piQuery.eq('provider_payment_id', paymentId);
  }

  /**
   * Passo 7 — ledger. Regra financeira: o estorno devolve o PRECO DO SERVICO
   * (`appointment.price`); a taxa do Asaas nao entra nestes valores.
   */
  static async writeRefundTransactions(adminClient: any, p: {
    paymentId: string; appointments: any[]; reason: CancellationReason; isRefundConfirmed: boolean; isRefundDenied?: boolean;
  }): Promise<void> {
    const { paymentId, appointments, reason, isRefundConfirmed } = p;
    const isRefundDenied = !isRefundConfirmed && p.isRefundDenied === true;
    try {
      if (isRefundConfirmed) {
        await adminClient
          .from('transactions')
          .update({ status: 'failed' })
          .eq('provider_payment_id', paymentId)
          .eq('type', 'lesson_payment');
      }

      const refundTxStatus = isRefundConfirmed ? 'completed' : (isRefundDenied ? 'failed' : 'pending');
      for (const apt of appointments) {
        const gross = Math.round(Number(apt.price || 0));
        const fee = Math.floor(gross * 0.1);
        const net = gross - fee;

        // Um estorno ja' CONFIRMADO no ledger nunca e' rebaixado por uma visao
        // nao confirmada (worker concorrente ou webhook que chegou antes).
        if (!isRefundConfirmed) {
          const { data: existingRefundTx } = await adminClient
            .from('transactions')
            .select('id, status')
            .eq('appointment_id', apt.id)
            .eq('type', 'refund')
            .maybeSingle();
          if (existingRefundTx?.status === 'completed') continue;
        }

        const { error: refundTxError } = await adminClient
          .from('transactions')
          .upsert({
            appointment_id: apt.id,
            student_id: apt.student_id,
            instructor_id: apt.instructor_id,
            type: 'refund',
            amount: -gross,
            gross_amount: -gross,
            platform_fee: -fee,
            net_amount: -net,
            status: refundTxStatus,
            provider_name: 'asaas',
            provider_payment_id: paymentId,
            event_date: new Date().toISOString(),
            description: reason === 'instructor_rejected' ? 'Estorno de Aula via Asaas' : (reason === 'student_cancelled' ? 'Estorno de Aula pelo Aluno' : 'Estorno por Expiração de Solicitação'),
            metadata: {
              provider: 'asaas',
              note: reason,
              refund_requested_at: new Date().toISOString(),
              asaas_refund_status: isRefundConfirmed ? 'REFUNDED' : (isRefundDenied ? 'REFUND_DENIED' : 'REFUND_REQUESTED')
            }
          }, { onConflict: 'appointment_id,type' });
        if (refundTxError) {
          console.error(`⚠️ Refund ledger write failed for appointment ${apt.id} (payment ${paymentId}):`, refundTxError.message || refundTxError);
        }
      }
    } catch (txErr) {
      console.error(`⚠️ Error updating financial transactions:`, txErr);
    }
  }

  /**
   * Alinha `payment_status` das aulas JA' ENCERRADAS ao estado atual do
   * estorno. Somente promocoes, cada uma com CAS no valor anterior:
   *  - confirmado: qualquer valor -> `refunded`;
   *  - recusado: `refund_requested` -> `refund_denied`;
   *  - em analise: nada (nao rebaixa `refunded` nem `refund_denied`).
   * Nunca altera `status`. Idempotente.
   */
  static async alignClosedAppointments(adminClient: any, ids: string[], refundState: RefundFinancialState): Promise<void> {
    if (ids.length === 0) return;
    const nowIso = new Date().toISOString();
    if (refundState === 'confirmed') {
      const { error } = await adminClient.from('appointments')
        .update({ payment_status: 'refunded', updated_at: nowIso })
        .in('id', ids)
        .in('status', CLOSED_STATUSES)
        .neq('payment_status', 'refunded');
      if (error) throw error;
    } else if (refundState === 'denied') {
      const { error } = await adminClient.from('appointments')
        .update({ payment_status: 'refund_denied', updated_at: nowIso })
        .in('id', ids)
        .in('status', CLOSED_STATUSES)
        .eq('payment_status', 'refund_requested');
      if (error) throw error;
    }
  }

  /** Passo 8 — escrita terminal da aula, com CAS pelo status de negocio. */
  static async applyAppointmentOutcome(adminClient: any, p: {
    ids: string[]; allowedStatuses: string[]; reason: CancellationReason; isPaid: boolean; isRefundConfirmed: boolean; isRefundDenied?: boolean; initiatedBy?: string;
  }): Promise<{ targetStatus: 'cancelled' | 'expired'; paymentStatus: 'refunded' | 'refund_requested' | 'refund_denied' | 'released'; effectivelyCancelled: number }> {
    const { ids, allowedStatuses, reason, isPaid, isRefundConfirmed, initiatedBy } = p;
    const isRefundDenied = !isRefundConfirmed && p.isRefundDenied === true;
    const targetStatus: 'cancelled' | 'expired' = (reason === 'instructor_rejected' || reason === 'student_cancelled') ? 'cancelled' : 'expired';
    const paymentStatus = isPaid
      ? (isRefundConfirmed ? 'refunded' : (isRefundDenied ? 'refund_denied' : 'refund_requested'))
      : 'released';

    const updateData: Record<string, any> = {
      status: targetStatus,
      payment_status: paymentStatus,
      cancelled_reason: reason,
      updated_at: new Date().toISOString()
    };
    if (initiatedBy) {
      updateData.updated_by = initiatedBy;
    }

    const { data: cancelledApts, error: updateError } = await adminClient
      .from('appointments')
      .update(updateData)
      .in('id', ids)
      .in('status', allowedStatuses)
      .select('id');

    if (updateError) {
      console.error(`Error updating appointments table:`, updateError.message);
      throw updateError;
    }

    const effectivelyCancelled = Array.isArray(cancelledApts) ? cancelledApts.length : 0;
    return { targetStatus, paymentStatus, effectivelyCancelled };
  }

  /** Passo 9 — notificacoes (mesmas do fluxo sincrono). */
  static async sendCancellationNotifications(reason: CancellationReason, appointment: any, comboCount: number, groupId: string, refundState: RefundFinancialState = 'none'): Promise<void> {
    // Para o aluno, estorno recusado tambem e' "em analise": so' `confirmed`
    // autoriza dizer que o valor foi reembolsado.
    const refundNotice: 'confirmed' | 'in_review' | 'none' = refundState === 'confirmed' ? 'confirmed' : (refundState === 'none' ? 'none' : 'in_review');
    if (reason === 'instructor_rejected') {
      if (appointment.student_id) {
        try {
          await NotificationService.sendBookingRejected({
            studentId: appointment.student_id,
            comboCount,
            groupId,
            refundState: refundNotice
          });
        } catch (notifErr) {
          console.error(`⚠️ Error sending rejection notification:`, notifErr);
        }
      }
    } else if (reason === 'auto_expired') {
      try {
        if (appointment.student_id) {
          await NotificationService.sendBookingExpired({
            userId: appointment.student_id,
            isInstructor: false,
            comboCount,
            groupId,
            refundState: refundNotice
          });
        }
        if (appointment.instructor_id) {
          await NotificationService.sendBookingExpired({
            userId: appointment.instructor_id,
            isInstructor: true,
            comboCount,
            groupId
          });
        }
      } catch (notifErr) {
        console.error(`⚠️ Error sending expiry notifications:`, notifErr);
      }
    }
  }

  // ==========================================================================
  // CONFIRMACAO ASSINCRONA (webhook / reconciliacao)
  // ==========================================================================

  private static opContext(op: RefundOperationRecord): { ids: string[]; reason: CancellationReason | null } {
    const meta: any = op.metadata || {};
    const ids = Array.isArray(meta.appointmentIds) ? meta.appointmentIds.filter((x: any) => typeof x === 'string') : [];
    const reason = (['instructor_rejected', 'auto_expired', 'student_cancelled'] as const).includes(meta.reason) ? meta.reason as CancellationReason : null;
    return { ids, reason };
  }

  /**
   * Aplica o desfecho de um estorno CONFIRMADO pelo gateway as aulas da
   * operacao: parcelas, ledger e status da aula, pelo mesmo codigo do fluxo
   * sincrono. Idempotente: o CAS da aula impede reescrita, e aulas ja' no
   * desfecho final nao sao tocadas.
   */
  static async finalizeConfirmedRefund(adminClient: any, op: RefundOperationRecord): Promise<{ finalized: boolean; cancelled: number; reason: string }> {
    if (op.status !== 'COMPLETED' || !op.acknowledged_at) return { finalized: false, cancelled: 0, reason: 'not_confirmed' };
    const { ids, reason } = BookingCancellationCore.opContext(op);
    if (ids.length === 0 || !reason) return { finalized: false, cancelled: 0, reason: 'missing_operation_context' };

    const { data: apts, error } = await adminClient
      .from('appointments')
      .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
      .in('id', ids);
    if (error || !Array.isArray(apts) || apts.length === 0) return { finalized: false, cancelled: 0, reason: 'appointments_not_found' };

    const alreadyFinal = apts.every((a: any) => ['cancelled', 'expired'].includes(a.status) && a.payment_status === 'refunded');
    if (alreadyFinal) return { finalized: true, cancelled: 0, reason: 'already_finalized' };

    const allowedStatuses = REASON_ALLOWED_STATUSES[reason] || [];
    const groupId = apts[0].group_id || null;

    await BookingCancellationCore.applyInstallmentOutcome(adminClient, {
      isPaid: true, isRefundConfirmed: true, scope: op.scope, paymentId: op.provider_payment_id, groupId
    });
    await BookingCancellationCore.writeRefundTransactions(adminClient, {
      paymentId: op.provider_payment_id, appointments: apts, reason, isRefundConfirmed: true
    });
    const outcome = await BookingCancellationCore.applyAppointmentOutcome(adminClient, {
      ids, allowedStatuses, reason, isPaid: true, isRefundConfirmed: true
    });
    // Aulas ja' terminais (legado) so' recebem a verdade financeira.
    await adminClient
      .from('appointments')
      .update({ payment_status: 'refunded', updated_at: new Date().toISOString() })
      .in('id', ids)
      .in('status', ['cancelled', 'expired'])
      .neq('payment_status', 'refunded');

    if (outcome.effectivelyCancelled > 0) {
      await BookingCancellationCore.sendCancellationNotifications(reason, apts[0], apts.length, groupId || apts[0].id, 'confirmed');
    }
    return { finalized: true, cancelled: outcome.effectivelyCancelled, reason: 'finalized' };
  }

  /**
   * Recusa de uma operacao que NUNCA marcou nada como estornado. O pagamento
   * original continua pago — uma recusa de estorno nunca vira pagamento falho.
   *  - aula ja' ENCERRADA: `refund_requested` -> `refund_denied` (o dinheiro
   *    segue com a plataforma; revisao manual). A aula nao e' reaberta;
   *  - aula ainda aberta (legado): `refund_requested` -> `paid`.
   */
  static async releaseAfterDenial(adminClient: any, op: RefundOperationRecord, denialReason: string | null): Promise<void> {
    const { ids } = BookingCancellationCore.opContext(op);
    if (ids.length === 0) return;
    const nowIso = new Date().toISOString();
    try {
      await adminClient.from('appointments')
        .update({ payment_status: 'refund_denied', updated_at: nowIso })
        .in('id', ids)
        .in('status', CLOSED_STATUSES)
        .eq('payment_status', 'refund_requested');
      await adminClient.from('appointments')
        .update({ payment_status: 'paid', updated_at: nowIso })
        .in('id', ids)
        .eq('payment_status', 'refund_requested');
      await adminClient.from('transactions')
        .update({ status: 'failed', metadata: { denial_reason: denialReason, denied_at: nowIso, refund_operation_id: op.id } })
        .in('appointment_id', ids)
        .eq('type', 'refund')
        .neq('status', 'completed');
    } catch (err) {
      console.error(`⚠️ releaseAfterDenial failed for op ${op.id}:`, err);
    }
  }

  /** `refund_denied` -> `refund_requested` nas aulas da operacao (estorno voltou a estar em analise). */
  static async markRefundUnderReview(adminClient: any, op: RefundOperationRecord): Promise<void> {
    const { ids } = BookingCancellationCore.opContext(op);
    if (ids.length === 0) return;
    try {
      await adminClient.from('appointments')
        .update({ payment_status: 'refund_requested', updated_at: new Date().toISOString() })
        .in('id', ids)
        .eq('payment_status', 'refund_denied');
    } catch (err) {
      console.error(`⚠️ markRefundUnderReview failed for op ${op.id}:`, err);
    }
  }

  /**
   * Corrige uma conclusao que o gateway NUNCA confirmou e que o gateway agora
   * recusa (webhook PAYMENT_REFUND_DENIED) ou mostra inexistente (reconciliacao).
   * Desfaz exatamente o que a conclusao falsa gravou e sinaliza revisao manual:
   * a aula pode ja' ter liberado o horario e nao e' "descancelada" aqui.
   */
  static async revertUnconfirmedCompletion(adminClient: any, op: RefundOperationRecord, audit: RefundAudit, denialReason: string | null): Promise<RefundOperationRecord> {
    const nowIso = new Date().toISOString();
    const reverted = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'DENIED', {
      denial_reason: denialReason,
      metadata: {
        ...(op.metadata || {}),
        false_completion_reverted_at: nowIso,
        requires_manual_review: true,
        revert_source: audit.source
      }
    }, { ...audit, reason: denialReason }, { revertsUnconfirmedCompletion: true });

    const { ids } = BookingCancellationCore.opContext(op);
    try {
      let groupId: string | null = null;
      if (ids.length > 0) {
        const { data: apts } = await adminClient.from('appointments').select('id, group_id').in('id', ids);
        groupId = Array.isArray(apts) && apts[0] ? apts[0].group_id || null : null;
      }
      let piQuery = adminClient.from('payment_installments')
        .update({ status: 'RECEIVED', updated_at: nowIso });
      piQuery = BookingCancellationCore.scopeInstallments(piQuery, op.scope, op.provider_payment_id, groupId);
      await piQuery.eq('status', 'REFUNDED');

      // lesson_payment: antes do aceite o status normal e' 'pending'.
      await adminClient.from('transactions')
        .update({ status: 'pending' })
        .eq('provider_payment_id', op.provider_payment_id)
        .eq('type', 'lesson_payment')
        .eq('status', 'failed');

      if (ids.length > 0) {
        await adminClient.from('transactions')
          .update({ status: 'failed', metadata: { denial_reason: denialReason, denied_at: nowIso, refund_operation_id: op.id, false_completion_reverted: true } })
          .in('appointment_id', ids)
          .eq('type', 'refund');
        // Aula encerrada nao volta a `paid` (seria "encerrada e paga", sem
        // rastro da recusa): fica `refund_denied`.
        await adminClient.from('appointments')
          .update({ payment_status: 'refund_denied', updated_at: nowIso })
          .in('id', ids)
          .in('status', CLOSED_STATUSES)
          .in('payment_status', ['refunded', 'refund_requested']);
        await adminClient.from('appointments')
          .update({ payment_status: 'paid', updated_at: nowIso })
          .in('id', ids)
          .in('payment_status', ['refunded', 'refund_requested']);
      }
    } catch (err) {
      console.error(`⚠️ revertUnconfirmedCompletion side effects failed for op ${op.id}:`, err);
    }
    return reverted;
  }

  /**
   * Aplica a evidencia do gateway a UMA operacao. Unica porta de entrada para
   * webhook, reconciliacao e consulta do Core. Nunca emite POST.
   *  - conclusao confirmada nunca regride (recusa tardia e' registrada e ignorada);
   *  - conclusao nao confirmada so' e' desfeita por recusa/inexistencia EXTERNA;
   *  - `NONE` (gateway afirma que nao ha' estorno) so' fecha operacao parada
   *    quando `allowNoneResolution` (reconciliacao com operacao antiga).
   * Perdas de CAS (concorrencia) devolvem a linha atual: outro ator ja' decidiu.
   */
  static async applyProviderEvidence(
    adminClient: any,
    op: RefundOperationRecord,
    view: RefundInterpretation,
    audit: RefundAudit,
    opts: { finalize?: boolean; allowNoneResolution?: boolean; denialReason?: string | null } = {}
  ): Promise<RefundOperationRecord> {
    const finalize = opts.finalize !== false;
    const nowIso = new Date().toISOString();
    const fullAudit: RefundAudit = {
      ...audit,
      asaasPaymentStatus: audit.asaasPaymentStatus ?? view.asaasPaymentStatus,
      refundItemStatus: audit.refundItemStatus ?? view.refundItemStatus,
      providerRefundId: audit.providerRefundId ?? view.providerRefundId,
      decision: audit.decision ?? view.decision
    };
    const confirmed = op.status === 'COMPLETED' && !!op.acknowledged_at;

    try {
      switch (view.outcome) {
        case 'COMPLETED': {
          if (op.status === 'CONFLICT' || confirmed) break;
          if (op.status === 'DENIED') {
            op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'CONFLICT', {
              metadata: { ...(op.metadata || {}), conflict_reason: 'gateway_shows_refund_done_after_denial', requires_manual_review: true }
            }, fullAudit);
            // O gateway mostra um estorno feito depois da recusa: a aula deixa
            // de dizer "negado" e volta a "em analise". Nunca vira `refunded`
            // por aqui — CONFLICT exige revisao.
            await BookingCancellationCore.markRefundUnderReview(adminClient, op);
            break;
          }
          op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'COMPLETED', {
            completed_amount_cents: view.matchedAmountCents ?? op.requested_amount_cents,
            provider_refund_id: view.providerRefundId ?? op.provider_refund_id,
            completed_at: op.completed_at || nowIso,
            acknowledged_at: nowIso,
            owner_id: null,
            lease_until: null,
            metadata: {
              ...(op.metadata || {}),
              completion_evidence: audit.source,
              ...(view.endToEndIdentifier ? { end_to_end_identifier: view.endToEndIdentifier } : {})
            }
          }, fullAudit);
          break;
        }
        case 'PENDING': {
          if (op.status === 'REQUESTED' || op.status === 'UNKNOWN') {
            op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'PENDING', {
              acknowledged_at: nowIso,
              provider_refund_id: view.providerRefundId ?? op.provider_refund_id,
              owner_id: null,
              lease_until: null
            }, fullAudit);
          } else if (op.status === 'PENDING' && !op.acknowledged_at) {
            // Nao mexe em owner/lease: pode haver um worker vivo no meio do POST.
            op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'PENDING', {
              acknowledged_at: nowIso,
              provider_refund_id: view.providerRefundId ?? op.provider_refund_id
            }, fullAudit);
          }
          break;
        }
        case 'DENIED': {
          const reason = opts.denialReason ?? sanitizeProviderMessage(`refund item ${view.refundItemStatus || 'denied'}`);
          if (confirmed) {
            await RefundOperationRepository.recordEvent(adminClient, op.id, op.status, op.status, {
              ...fullAudit, decision: 'ignored_denial_on_confirmed_completion', reason
            });
            break;
          }
          if (op.status === 'COMPLETED') {
            op = await BookingCancellationCore.revertUnconfirmedCompletion(adminClient, op, fullAudit, reason);
            break;
          }
          if (['REQUESTED', 'PENDING', 'UNKNOWN', 'PARTIALLY_COMPLETED'].includes(op.status)) {
            op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'DENIED', {
              denial_reason: reason,
              owner_id: null,
              lease_until: null,
              metadata: { ...(op.metadata || {}), denied_at: nowIso, requires_manual_review: true }
            }, { ...fullAudit, reason });
            await BookingCancellationCore.releaseAfterDenial(adminClient, op, reason);
          }
          break;
        }
        case 'NONE': {
          if (!opts.allowNoneResolution) break;
          const reason = 'no_refund_found_on_gateway';
          if (op.status === 'COMPLETED' && !op.acknowledged_at) {
            op = await BookingCancellationCore.revertUnconfirmedCompletion(adminClient, op, { ...fullAudit, decision: reason }, reason);
          } else if (op.status === 'PENDING' || op.status === 'UNKNOWN') {
            op = await RefundOperationRepository.reconcileTransition(adminClient, op.id, op.version, 'DENIED', {
              denial_reason: reason,
              owner_id: null,
              lease_until: null,
              metadata: { ...(op.metadata || {}), denied_at: nowIso, requires_manual_review: true }
            }, { ...fullAudit, reason, decision: reason });
            await BookingCancellationCore.releaseAfterDenial(adminClient, op, reason);
          }
          break;
        }
        default:
          break;
      }
    } catch (err: any) {
      // Concorrencia (CAS) ou transicao ja' feita por outro ator: vale a linha atual.
      console.warn(`[BookingCancellationCore] applyProviderEvidence on op ${op.id}: ${err?.name || 'Error'} ${err?.message || ''}`);
      op = await RefundOperationRepository.get(adminClient, op.id);
    }

    if (finalize && op.status === 'COMPLETED' && op.acknowledged_at) {
      await BookingCancellationCore.finalizeConfirmedRefund(adminClient, op);
    }
    return op;
  }

  /**
   * Operacoes de estorno de um pagamento que a evidencia do gateway pode mover:
   * ativas + COMPLETED nunca confirmadas. COMPLETED confirmadas so' entram para
   * registrar evento tardio de recusa (nunca regridem).
   */
  static async loadRefundOperationsForEvidence(adminClient: any, paymentId: string): Promise<{ all: RefundOperationRecord[]; actionable: RefundOperationRecord[] }> {
    const { data, error } = await adminClient
      .from('refund_operations')
      .select('*')
      .eq('provider', 'asaas')
      .eq('provider_payment_id', paymentId);
    if (error) throw new Error(`refund_operations lookup failed: ${error.message}`);
    const all = (data || []) as RefundOperationRecord[];
    const actionable = all.filter((op) =>
      ['REQUESTED', 'PENDING', 'UNKNOWN', 'PARTIALLY_COMPLETED'].includes(op.status)
      || (op.status === 'COMPLETED' && !op.acknowledged_at)
    );
    return { all, actionable };
  }

  /**
   * Aplica um evento de estorno do webhook a cada operacao do pagamento.
   * Cada operacao e' casada pelo seu item de estorno (id ou valor); sem itens
   * no payload e com UMA unica operacao candidata, o proprio evento e' a
   * confirmacao do gateway para ela. Com varias candidatas e nenhum item, nada
   * e' aplicado (ambiguo): a reconciliacao resolve via GET.
   */
  static async applyRefundEvent(
    adminClient: any,
    paymentId: string,
    payment: any,
    eventOutcome: 'COMPLETED' | 'PENDING' | 'DENIED',
    providerEventId: string | null,
    denialReason: string | null
  ): Promise<{ applied: number; ambiguous: number; ignored: number }> {
    const { all, actionable } = await BookingCancellationCore.loadRefundOperationsForEvidence(adminClient, paymentId);
    const hasItems = Array.isArray(payment?.refunds) && payment.refunds.length > 0;
    let applied = 0, ambiguous = 0, ignored = 0;

    // Recusa tardia sobre conclusao CONFIRMADA: so' registra (nunca regride).
    // Estorno concluido DEPOIS de uma recusa (ex.: refeito pelo painel do
    // Asaas), sem nenhuma conclusao confirmada: a evidencia vai para as
    // operacoes DENIED, que passam a CONFLICT (revisao) — nunca a COMPLETED.
    const confirmedOps = all.filter((op) => op.status === 'COMPLETED' && !!op.acknowledged_at);
    const targets = actionable.length > 0 ? actionable
      : (eventOutcome === 'DENIED' ? confirmedOps
        : (eventOutcome === 'COMPLETED' && confirmedOps.length === 0 ? all.filter((op) => op.status === 'DENIED') : []));

    for (const op of targets) {
      const exclude = all.filter((o) => o.id !== op.id).map((o) => o.provider_refund_id).filter(Boolean) as string[];
      let view = interpretRefundState(payment, {
        paymentId,
        requestedAmountCents: op.requested_amount_cents,
        knownProviderRefundId: op.provider_refund_id,
        excludeProviderRefundIds: exclude
      });

      if (view.outcome === 'UNKNOWN' || view.outcome === 'NONE') {
        if (!hasItems && targets.length === 1) {
          view = {
            ...view,
            outcome: eventOutcome,
            matchedAmountCents: eventOutcome === 'COMPLETED' ? op.requested_amount_cents : null,
            decision: 'single_operation_event_confirmation'
          };
        } else {
          ambiguous++;
          await RefundOperationRepository.recordEvent(adminClient, op.id, op.status, op.status, {
            source: 'webhook', providerEventId, asaasPaymentStatus: view.asaasPaymentStatus,
            decision: `ambiguous_${eventOutcome.toLowerCase()}_event`
          });
          continue;
        }
      }

      const before = `${op.status}:${op.version}`;
      const after = await BookingCancellationCore.applyProviderEvidence(
        adminClient, op, view, { source: 'webhook', providerEventId }, { denialReason }
      );
      if (`${after.status}:${after.version}` === before) ignored++; else applied++;
    }
    return { applied, ambiguous, ignored };
  }

  /**
   * Reconciliacao de UMA operacao: consulta o pagamento no Asaas (GET, somente
   * leitura) e aplica a evidencia. Jamais cria cobranca ou estorno.
   */
  static async reconcileRefundOperation(
    adminClient: any,
    op: RefundOperationRecord,
    deps: RefundReconcileDeps
  ): Promise<{ operationId: string; before: string; after: string; outcome: string }> {
    const before = op.status;
    let res: any;
    try {
      res = await deps.httpFetch(`${deps.asaasApiUrl}/payments/${op.provider_payment_id}`, {
        method: 'GET',
        headers: { 'access_token': deps.asaasApiKey, 'Content-Type': 'application/json' }
      });
    } catch (_err) {
      return { operationId: op.id, before, after: op.status, outcome: 'gateway_unreachable' };
    }
    if (!res || !res.ok) return { operationId: op.id, before, after: op.status, outcome: 'gateway_unavailable' };
    const payment = await res.json().catch(() => null);

    const { data: siblings } = await adminClient
      .from('refund_operations')
      .select('id, provider_refund_id')
      .eq('provider_payment_id', op.provider_payment_id)
      .neq('id', op.id);
    const exclude = (Array.isArray(siblings) ? siblings : []).map((x: any) => x.provider_refund_id).filter(Boolean);

    const view = interpretRefundState(payment, {
      paymentId: op.provider_payment_id,
      requestedAmountCents: op.requested_amount_cents,
      knownProviderRefundId: op.provider_refund_id,
      excludeProviderRefundIds: exclude
    });
    const staleAfterMs = deps.staleAfterMs ?? 30 * 60 * 1000;
    const isStale = Date.now() - new Date(op.updated_at).getTime() >= staleAfterMs;

    let after = op;
    if (op.status === 'COMPLETED' && op.acknowledged_at) {
      // Consistencia: estorno confirmado cujas aulas ainda divergem.
      await BookingCancellationCore.finalizeConfirmedRefund(adminClient, op);
    } else {
      after = await BookingCancellationCore.applyProviderEvidence(adminClient, op, view, { source: 'reconciliation' }, {
        allowNoneResolution: isStale || (op.status === 'COMPLETED' && !op.acknowledged_at)
      });
    }
    return { operationId: op.id, before, after: after.status, outcome: view.outcome };
  }
}
