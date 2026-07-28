/**
 * Asaas Event Mapper - CNHJá Financial Architecture v1.0
 * Maps raw Asaas webhook event string to internal PaymentInstallmentStatus target.
 */

import { PaymentInstallmentStatus } from './PaymentStateTypes.js';

export class PaymentStateMapper {
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
