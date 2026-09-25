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
import { RefundOperationRepository } from './RefundOperationRepository.ts';
import { buildRefundOperationKey, RefundOperationKeyInput } from './RefundOperationKey.ts';
import { RefundOperationRecord } from './RefundOperationTypes.ts';
import { resolveAsaasEnvironment } from './AsaasEnvironment.ts';

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
}

export interface CancellationResult {
  success: boolean;
  alreadyProcessed: boolean;
  reason: CancellationReason;
  /**
   * P-1.20.1B: `pending_refund` means the appointment was DELIBERATELY left
   * untouched because the refund has not reached a terminal COMPLETED state.
   * The appointment is never parked in an intermediate status.
   */
  status: 'cancelled' | 'expired' | 'pending_refund';
  paymentStatus: 'refunded' | 'released' | 'failed' | 'refund_requested';
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
        isPaid: appointment.payment_status === 'refunded',
        processedCount: 0,
        groupId: appointment.group_id || appointment.id,
        message: 'Cancellation currently in progress by another task.'
      };
    }

    activeCancellationLocks.add(lockKey);

    try {
      // 3. Idempotency & Eligibility Validation
      if (reason === 'instructor_rejected') {
        if (appointment.status === 'cancelled' && appointment.cancelled_reason === 'instructor_rejected') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'cancelled',
            paymentStatus: appointment.payment_status || 'released',
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
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already cancelled'
          };
        }
      }

      // P-1.20.1B: eligibility is a function of the reason, not a flat list.
      const allowedStatuses = REASON_ALLOWED_STATUSES[reason] || [];
      if (!allowedStatuses.includes(appointment.status)) {
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
        if (activeNonCancelable.length > 0) {
          throw new Error('Este combo não pode ser cancelado pois um ou mais horários já foram processados.');
        }

        appointmentsToCancel = groupAppointments.filter((a: any) => allowedStatuses.includes(a.status));
        if (appointmentsToCancel.length === 0) {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: reason === 'instructor_rejected' ? 'cancelled' : (reason === 'auto_expired' ? 'expired' : 'cancelled'),
            paymentStatus: appointment.payment_status || 'released',
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
      // keeps its real business status until the refund is COMPLETED.
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
              const splitsForOpKey: Array<{ id: string; amountCents: number }> = [];

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
                    splitsForOpKey.push({ id: String(splitId), amountCents: splitRefundCents });
                    splitRefundsPayload.push({
                      id: String(splitId),
                      value: Number((splitRefundCents / 100).toFixed(2))
                    });
                  }
                }
              }

              // Build canonical operation key
              const operationKeyInput: RefundOperationKeyInput = {
                provider: 'asaas',
                providerPaymentId: paymentId,
                providerInstallmentId: installmentId || null,
                refundScope: effectiveScope,
                items: appointmentsToCancel.map((a: any) => ({ id: a.id, amountCents: Math.round(Number(a.price || 0)) })),
                splits: splitsForOpKey,
                requestedAmountCents,
                allocationVersion: 'v1'
              };
              const operationKey = buildRefundOperationKey(operationKeyInput);

              // Check Cumulative Ceiling (AvailableBalanceCents)
              const eligiblePaymentCents = Math.round(Number(paymentData.value || 0) * 100);
              const retainedCents = await RefundOperationRepository.getRetainedAmountCents(adminClient, paymentId, operationKey);
              const availableBalanceCents = Math.max(0, eligiblePaymentCents - retainedCents);

              if (requestedAmountCents > availableBalanceCents) {
                throw new Error(`Requested refund amount (${requestedAmountCents} cents) exceeds available balance (${availableBalanceCents} cents) for payment ${paymentId}`);
              }

              // Create or Get durable RefundOperation
              let op = await RefundOperationRepository.createOrGet(adminClient, {
                operationKey,
                providerPaymentId: paymentId,
                scope: effectiveScope,
                requestedAmountCents,
                metadata: { appointmentIds: appointmentsToCancel.map((a: any) => a.id), reason }
              });

              // P0-01: Handle PENDING lease expiration & UNKNOWN state
              op = await RefundOperationRepository.handleExpiredPending(adminClient, op);

              if (op.status === 'UNKNOWN') {
                // Ambiguous: the gateway may already have refunded. Only external
                // evidence may close it. Never POST again.
                console.warn(`[BookingCancellationCore] Operation ${op.id} is UNKNOWN. POST /refund BLOCKED, awaiting reconciliation.`);
                isRefundRequestedOrConfirmed = true;
              } else if (op.status === 'COMPLETED' || op.status === 'PARTIALLY_COMPLETED') {
                console.log(`[BookingCancellationCore] Operation ${op.id} already completed.`);
                isRefundRequestedOrConfirmed = true;
                isRefundConfirmed = op.status === 'COMPLETED';
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
                  isRefundConfirmed = op.status === 'COMPLETED';
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
                      const refundResData = await refundRes.json().catch(() => ({}));
                      op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'COMPLETED', {
                        completed_amount_cents: requestedAmountCents,
                        provider_refund_id: refundResData.id || null,
                        completed_at: new Date().toISOString()
                      });
                      isRefundConfirmed = true;
                      isRefundRequestedOrConfirmed = true;
                    } else {
                      const errText = await refundRes.text();
                      const is4xx = refundRes.status >= 400 && refundRes.status < 500;
                      if (is4xx) {
                        // The gateway refused. Deterministic, terminal.
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'DENIED', {
                          denial_reason: errText
                        });
                        throw new Error(`Asaas refund failed (HTTP ${refundRes.status}): ${errText}`);
                      } else {
                        // 5xx: the refund MAY have been applied. Never assume it was not.
                        op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'UNKNOWN', {
                          unknown_since: new Date().toISOString()
                        });
                        throw new Error(`Asaas gateway server error (HTTP ${refundRes.status}): ${errText}`);
                      }
                    }
                  } catch (netErr: any) {
                    // Timeout / socket error: also ambiguous. Re-read before writing,
                    // because the reaper may already have moved the row to UNKNOWN.
                    const currentOp = await RefundOperationRepository.get(adminClient, op.id);
                    if (currentOp.status === 'PENDING') {
                      op = await RefundOperationRepository.transition(adminClient, op.id, ownerId, currentOp.version, 'UNKNOWN', {
                        unknown_since: new Date().toISOString()
                      });
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
      // P-1.20.1B — TERMINAL GATE
      //
      // For a PAID booking, nothing downstream (installments, ledger, the
      // appointment itself) is written until the refund operation has reached
      // COMPLETED. Before this phase the appointment was flipped to `cancelled`
      // whatever the gateway said, which allowed "cancelled with the money
      // never returned" and, worse, left rows stranded in `cancelling`.
      //
      // The appointment is NEVER parked in an intermediate state: it either
      // keeps its real business status, or it reaches a terminal one.
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

      if (isPaid && refundOperation && (refundOperation.status === 'DENIED' || refundOperation.status === 'CONFLICT')) {
        throw new Error(`Estorno recusado pelo gateway (${refundOperation.status}) para o pagamento ${paymentId}. O agendamento permanece inalterado.`);
      }

      if (isPaid && !isRefundConfirmed) {
        const refundStatus = refundOperation?.status || 'UNKNOWN';
        console.warn(`[BookingCancellationCore] Refund for ${paymentId} is not COMPLETED (state: ${refundStatus}). Appointment left untouched.`);
        return {
          success: false,
          alreadyProcessed: false,
          reason,
          status: 'pending_refund',
          paymentStatus: 'refund_requested',
          isPaid: true,
          processedCount: 0,
          groupId: appointment.group_id || appointment.id,
          refundStatus,
          message: 'Estorno em processamento. O agendamento permanece inalterado ate a confirmacao do gateway.'
        };
      }

      // 6. Update payment_installments table (SSOT)
      if (paymentId || appointment.group_id) {
        try {
          if (!isPaid) {
            let piQuery = adminClient.from('payment_installments').update({
              status: 'CANCELLED',
              updated_at: new Date().toISOString()
            });

            if (effectiveScope === 'SINGLE_APPOINTMENT') {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            } else if (appointment.group_id && paymentId) {
              piQuery = piQuery.or(`group_id.eq.${appointment.group_id},provider_payment_id.eq.${paymentId}`);
            } else if (appointment.group_id) {
              piQuery = piQuery.eq('group_id', appointment.group_id);
            } else {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            }

            await piQuery;
          } else if (isRefundConfirmed) {
            let piQuery = adminClient.from('payment_installments').update({
              status: 'REFUNDED',
              updated_at: new Date().toISOString()
            });

            if (effectiveScope === 'SINGLE_APPOINTMENT') {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            } else if (appointment.group_id && paymentId) {
              piQuery = piQuery.or(`group_id.eq.${appointment.group_id},provider_payment_id.eq.${paymentId}`);
            } else if (appointment.group_id) {
              piQuery = piQuery.eq('group_id', appointment.group_id);
            } else {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            }

            await piQuery;
          }
        } catch (piEx) {
          console.warn(`⚠️ Exception updating payment_installments:`, piEx);
        }
      }

      // 7. Update Financial Transactions
      if (isPaid && paymentId) {
        try {
          if (isRefundConfirmed) {
            await adminClient
              .from('transactions')
              .update({ status: 'failed' })
              .eq('provider_payment_id', paymentId)
              .eq('type', 'lesson_payment');
          }

          const refundTxStatus = isRefundConfirmed ? 'completed' : 'pending';
          for (const apt of appointmentsToCancel) {
            const gross = Math.round(Number(apt.price || 0));
            const fee = Math.floor(gross * 0.1);
            const net = gross - fee;

            await adminClient
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
                  asaas_refund_status: isRefundConfirmed ? 'REFUNDED' : 'REFUND_REQUESTED'
                }
              }, { onConflict: 'appointment_id,type' });
          }
        } catch (txErr) {
          console.error(`⚠️ Error updating financial transactions:`, txErr);
        }
      }

      // 8. Update Appointments Table
      const targetStatus: 'cancelled' | 'expired' = (reason === 'instructor_rejected' || reason === 'student_cancelled') ? 'cancelled' : 'expired';
      const paymentStatus = isPaid ? (isRefundConfirmed ? 'refunded' : 'refund_requested') : 'released';

      const updateData: Record<string, any> = {
        status: targetStatus,
        payment_status: paymentStatus,
        cancelled_reason: reason,
        updated_at: new Date().toISOString()
      };
      if (initiatedBy) {
        updateData.updated_by = initiatedBy;
      }

      const cancelIds = appointmentsToCancel.map((a: any) => a.id);
      // P-1.20.1B: the terminal write carries its own CAS. This single statement
      // is atomic and idempotent, which is all the `cancelling` lock ever
      // provided — without the corruptible intermediate state.
      const { data: cancelledApts, error: updateError } = await adminClient
        .from('appointments')
        .update(updateData)
        .in('id', cancelIds)
        .in('status', allowedStatuses)
        .select('id');

      if (updateError) {
        console.error(`Error updating appointments table:`, updateError.message);
        throw updateError;
      }

      const effectivelyCancelled = Array.isArray(cancelledApts) ? cancelledApts.length : 0;
      if (effectivelyCancelled === 0) {
        // Another worker finished first. The refund is already terminal, so this
        // is success, not failure.
        console.log(`[BookingCancellationCore] Appointments already in a terminal state for ${lockKey}.`);
        return {
          success: true,
          alreadyProcessed: true,
          reason,
          status: targetStatus,
          paymentStatus,
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

      if (reason === 'instructor_rejected') {
        if (appointment.student_id) {
          try {
            await NotificationService.sendBookingRejected({
              studentId: appointment.student_id,
              comboCount,
              groupId
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
              groupId
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

      return {
        success: true,
        alreadyProcessed: false,
        reason,
        status: targetStatus,
        paymentStatus,
        isPaid,
        processedCount: effectivelyCancelled,
        groupId,
        refundStatus: refundOperation?.status,
        message: 'Cancelamento e estorno processados com sucesso.'
      };

    } finally {
      activeCancellationLocks.delete(lockKey);
    }
  }
}
