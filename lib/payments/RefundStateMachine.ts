export type RefundState = 'NONE' | 'REQUESTED' | 'PENDING' | 'UNKNOWN' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'DENIED' | 'CONFLICT';
export type RefundEvidence = { source: 'provider_refunds' | 'payment' | 'webhook' | 'local'; complete: boolean; status?: string; amountCents?: number; eventId?: string | null; observedAt?: string };
const terminal = new Set<RefundState>(['COMPLETED', 'DENIED', 'CONFLICT']);
export const stateClass = (state: RefundState) => state === 'REQUESTED' ? 'INITIAL' : state === 'UNKNOWN' ? 'AMBIGUOUS' : terminal.has(state) ? 'TERMINAL' : 'TRANSIENT';
export function canTransitionRefund(from: RefundState, to: RefundState, evidence?: RefundEvidence): boolean {
  if (from === to) return true;
  if (from === 'CONFLICT' || from === 'COMPLETED') return false;
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
