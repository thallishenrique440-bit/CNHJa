export type RefundState = 'NONE' | 'REQUESTED' | 'PENDING' | 'UNKNOWN' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'DENIED' | 'CONFLICT';
export type RefundEvidence = {
  source: 'provider_refunds' | 'payment' | 'webhook' | 'local' | 'reconciliation';
  complete: boolean; status?: string; amountCents?: number; eventId?: string | null; observedAt?: string;
  /**
   * Correcao de uma conclusao NAO confirmada pelo gateway (legado: POST 2xx
   * gravava COMPLETED sem ler o estado). So' o repositorio seta, e so' quando
   * `acknowledged_at` da operacao e' nulo. Conclusao confirmada nunca regride.
   */
  revertsUnconfirmedCompletion?: boolean;
  /** Reabertura explicita e controlada de uma operacao DENIED (nunca automatica). */
  explicitRetry?: boolean;
};
const terminal = new Set<RefundState>(['COMPLETED', 'DENIED', 'CONFLICT']);
export const stateClass = (state: RefundState) => state === 'REQUESTED' ? 'INITIAL' : state === 'UNKNOWN' ? 'AMBIGUOUS' : terminal.has(state) ? 'TERMINAL' : 'TRANSIENT';
export function canTransitionRefund(from: RefundState, to: RefundState, evidence?: RefundEvidence): boolean {
  if (from === to) return true;
  if (from === 'CONFLICT') return false;
  // Unica saida de COMPLETED: evidencia EXTERNA de recusa/inexistencia sobre uma
  // conclusao que o gateway nunca confirmou.
  if (from === 'COMPLETED') {
    return to === 'DENIED' && evidence?.revertsUnconfirmedCompletion === true && evidence.source !== 'local';
  }
  // DENIED -> REQUESTED somente por nova tentativa explicita (ver Core.explicitRetry).
  if (from === 'DENIED' && to === 'REQUESTED') return evidence?.explicitRetry === true;
  if (from === 'DENIED') return to === 'CONFLICT' && evidence?.source !== 'local';
  if (to === 'UNKNOWN') return ['REQUESTED', 'PENDING', 'PARTIALLY_COMPLETED'].includes(from);
  if (from === 'UNKNOWN') return !!evidence && evidence.source !== 'local' && ['PENDING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'DENIED', 'CONFLICT'].includes(to);
  if (from === 'NONE') return ['REQUESTED', 'PENDING', 'UNKNOWN', 'DENIED', 'CONFLICT'].includes(to);
  if (from === 'REQUESTED') return ['PENDING', 'UNKNOWN', 'COMPLETED', 'PARTIALLY_COMPLETED', 'DENIED', 'CONFLICT'].includes(to);
  if (from === 'PENDING') return ['COMPLETED', 'PARTIALLY_COMPLETED', 'DENIED', 'UNKNOWN', 'CONFLICT'].includes(to);
  if (from === 'PARTIALLY_COMPLETED') return (to === 'COMPLETED' && evidence?.complete === true && evidence.source !== 'local') || to === 'CONFLICT';
  return false;
}
export function applyRefundTransition(from: RefundState, to: RefundState, evidence?: RefundEvidence) {
  const allowed = canTransitionRefund(from, to, evidence);
  return { state: allowed ? to : from === 'CONFLICT' ? from : 'CONFLICT' as RefundState, applied: allowed && from !== to, conflict: !allowed };
}
