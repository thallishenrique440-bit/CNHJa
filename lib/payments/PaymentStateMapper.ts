/**
 * Asaas Event Mapper - CNHJá Financial Architecture v1.0
 * Maps raw Asaas webhook event string to internal PaymentInstallmentStatus target.
 */

import { PaymentInstallmentStatus } from './PaymentStateTypes.js';

export type AsaasRefundState = 'NONE' | 'PENDING' | 'COMPLETED' | 'DENIED' | 'UNKNOWN';

export class PaymentStateMapper {
  /**
   * Helper to inspect Asaas paymentData payload and return a unified refund state:
   * NONE, PENDING, COMPLETED, DENIED, or UNKNOWN.
   */
  public static getAsaasRefundState(paymentData: any): AsaasRefundState {
    if (!paymentData || typeof paymentData !== 'object') {
      return 'UNKNOWN';
    }

    const asaasStatus = (paymentData.status || '').toUpperCase();

    // 1. Top-level status check
    if (asaasStatus === 'REFUNDED' || asaasStatus === 'PARTIALLY_REFUNDED') {
      return 'COMPLETED';
    }

    if (asaasStatus === 'REFUND_REQUESTED') {
      return 'PENDING';
    }

    // 2. Refunds array check
    const refunds = Array.isArray(paymentData.refunds) ? paymentData.refunds : [];

    if (refunds.length > 0) {
      let hasCompleted = false;
      let hasPending = false;
      let hasDenied = false;

      for (const r of refunds) {
        if (!r) continue;
        const rStatus = (r.status || '').toUpperCase();

        if (['DONE', 'REFUNDED', 'COMPLETED'].includes(rStatus)) {
          hasCompleted = true;
        } else if ([
          'PENDING',
          'AWAITING_CRITICAL_ACTION_AUTHORIZATION',
          'IN_PROGRESS',
          'REFUND_REQUESTED',
          'WAITING_AUTHORIZATION'
        ].includes(rStatus)) {
          hasPending = true;
        } else if ([
          'DENIED',
          'REFUND_DENIED',
          'CANCELLED',
          'FAILED',
          'REJECTED'
        ].includes(rStatus)) {
          hasDenied = true;
        }
      }

      if (hasCompleted) return 'COMPLETED';
      if (hasPending) return 'PENDING';
      if (hasDenied) return 'DENIED';
    }

    // 3. No active, completed or denied refund in array (or refunds array empty)
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PENDING', 'AWAITING_RISK_ANALYSIS'].includes(asaasStatus)) {
      return 'NONE';
    }

    return 'UNKNOWN';
  }

  /**
   * Maps an Asaas webhook event type string to target PaymentInstallmentStatus.
   * Returns null if the event does not trigger a state transition (e.g. NO_OP or informational events).
   */
  public static mapAsaasEventToInstallmentStatus(eventType: string): PaymentInstallmentStatus | null {
    if (!eventType) return null;

    const normalized = eventType.trim().toUpperCase();

    switch (normalized) {
      case 'PAYMENT_CREATED':
      case 'PAYMENT_AWAITING_RISK_ANALYSIS':
      case 'PAYMENT_APPROVED_BY_RISK_ANALYSIS':
        return 'PENDING';

      case 'PAYMENT_AUTHORIZED':
        return 'AUTHORIZED';

      case 'PAYMENT_CONFIRMED':
        return 'CONFIRMED';

      case 'PAYMENT_RECEIVED':
      case 'PAYMENT_DUNNING_RECEIVED':
        return 'RECEIVED';

      case 'PAYMENT_OVERDUE':
        return 'OVERDUE';

      case 'PAYMENT_REFUNDED':
        return 'REFUNDED';

      case 'PAYMENT_REFUND_IN_PROGRESS':
        // Informational phase prior to completed refund; no state change on installment itself
        return null;

      case 'PAYMENT_REFUND_DENIED':
        // Refund was denied by gateway; installment remains in its current state (e.g. RECEIVED)
        return null;

      case 'PAYMENT_CHARGEBACK_REQUESTED':
      case 'PAYMENT_CHARGEBACK_DISPUTE':
        return 'CHARGEBACK';

      case 'PAYMENT_CHARGEBACK_REVERSED':
        return 'RECEIVED';

      case 'PAYMENT_DELETED':
        return 'CANCELLED';

      case 'PAYMENT_RESTORED':
        return 'PENDING';

      case 'PAYMENT_CHECKOUT_VIEWED':
      case 'PAYMENT_BANK_SLIP_VIEWED':
      case 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED':
      case 'ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED':
        return null;

      default:
        return null;
    }
  }
}
