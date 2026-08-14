import { RefundEvidence, RefundState } from './RefundStateMachine.js';

export interface CanonicalRefund {
  status: RefundState;
  providerStatus?: string;
  valueCents: number;
  splitValuesCents: number[];
  completedValueCents: number;
  pendingValueCents: number;
  deniedValueCents: number;
  endToEndIdentifiers: Array<string | null>;
  evidence: RefundEvidence;
}

const cents = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

export function adaptAsaasRefunds(
  payment: any,
  options: { source?: RefundEvidence['source']; refundsComplete?: boolean; eventId?: string | null } = {}
): CanonicalRefund {
  const source = options.source || 'payment';
  const rawRefunds = payment && Object.prototype.hasOwnProperty.call(payment, 'refunds')
    ? payment.refunds
    : undefined;
  const isArray = Array.isArray(rawRefunds);
  const refunds = isArray ? rawRefunds : [];
  const complete = options.refundsComplete === true;
  const explicitStatus = String(payment?.status || '').toUpperCase();
  const splitValuesCents: number[] = [];
  let completedValueCents = 0;
  let pendingValueCents = 0;
  let deniedValueCents = 0;
  let providerStatus: string | undefined;
  const endToEndIdentifiers: Array<string | null> = [];

  for (const refund of refunds) {
    if (!refund || typeof refund !== 'object') continue;
    const status = String(refund.status || '').toUpperCase();
    providerStatus = status || providerStatus;
    const value = cents(refund.value);
    if ('endToEndIdentifier' in refund) endToEndIdentifiers.push(refund.endToEndIdentifier ?? null);
    for (const split of Array.isArray(refund.refundedSplits) ? refund.refundedSplits : []) {
      if (split && typeof split === 'object') splitValuesCents.push(cents(split.value));
    }
    if (['DONE', 'REFUNDED', 'COMPLETED'].includes(status)) completedValueCents += value;
    else if (['PENDING', 'IN_PROGRESS', 'REFUND_REQUESTED', 'AWAITING_CRITICAL_ACTION_AUTHORIZATION'].includes(status)) pendingValueCents += value;
    else if (['DENIED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(status)) deniedValueCents += value;
  }

  let status: RefundState = 'UNKNOWN';
  if (completedValueCents > 0) {
    status = explicitStatus === 'PARTIALLY_REFUNDED' || pendingValueCents > 0 ? 'PARTIALLY_COMPLETED' : 'COMPLETED';
  } else if (pendingValueCents > 0 || ['REFUND_REQUESTED', 'REFUND_IN_PROGRESS'].includes(explicitStatus)) status = 'PENDING';
  else if (deniedValueCents > 0) status = 'DENIED';
  else if (isArray && complete && refunds.length === 0) status = 'NONE';
  else if (rawRefunds === undefined || rawRefunds === null || !complete) status = 'UNKNOWN';
  else if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(explicitStatus)) status = 'NONE';

  const evidence: RefundEvidence = {
    source,
    complete,
    status: providerStatus || explicitStatus,
    amountCents: completedValueCents,
    eventId: options.eventId,
    observedAt: new Date().toISOString()
  };
  return {
    status,
    providerStatus,
    valueCents: cents(payment?.value),
    splitValuesCents,
    completedValueCents,
    pendingValueCents,
    deniedValueCents,
    endToEndIdentifiers,
    evidence
  };
}

