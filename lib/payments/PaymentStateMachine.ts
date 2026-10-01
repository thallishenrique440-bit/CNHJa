/**
 * Deterministic Payment State Machine - CNHJá Financial Architecture v1.0
 * 
 * Official States:
 * PENDING, AUTHORIZED, CONFIRMED, RECEIVED, OVERDUE, REFUNDED, CHARGEBACK, CANCELLED, FAILED
 */

import {
  PaymentInstallmentStatus,
  AppointmentPaymentStatusProjection
} from './PaymentStateTypes.js';

// Transition Matrix: Map of Current State -> Allowed Target States
const ALLOWED_TRANSITIONS: Record<PaymentInstallmentStatus, readonly PaymentInstallmentStatus[]> = {
  PENDING: ['AUTHORIZED', 'CONFIRMED', 'RECEIVED', 'OVERDUE', 'CANCELLED', 'FAILED', 'REFUNDED'],
  AUTHORIZED: ['CONFIRMED', 'RECEIVED', 'FAILED', 'CANCELLED', 'OVERDUE'],
  CONFIRMED: ['RECEIVED', 'REFUNDED', 'CHARGEBACK', 'FAILED', 'CANCELLED'],
  RECEIVED: ['REFUNDED', 'CHARGEBACK'],
  OVERDUE: ['RECEIVED', 'CONFIRMED', 'CANCELLED', 'FAILED', 'REFUNDED'],
  REFUNDED: [], // Terminal
  CHARGEBACK: ['RECEIVED', 'REFUNDED'],
  CANCELLED: ['PENDING'], // Via PAYMENT_RESTORED
  FAILED: ['PENDING']
};

// State Rank Hierarchy for Out-Of-Order Detection
const STATE_RANK: Record<PaymentInstallmentStatus, number> = {
  PENDING: 10,
  AUTHORIZED: 20,
  CONFIRMED: 30,
  OVERDUE: 35,
  RECEIVED: 40,
  CHARGEBACK: 50,
  REFUNDED: 60,
  CANCELLED: 70,
  FAILED: 70
};

export class PaymentStateMachine {
  /**
   * Validates whether a state transition from currentState to targetState is allowed.
   */
  public static isValidTransition(
    currentState: PaymentInstallmentStatus,
    targetState: PaymentInstallmentStatus
  ): boolean {
    if (currentState === targetState) return false;
    const allowed = ALLOWED_TRANSITIONS[currentState] || [];
    return allowed.includes(targetState);
  }

  /**
   * Checks if an event/transition is out-of-order (e.g. event attempting to regress state).
   */
  public static isOutOfOrder(
    currentState: PaymentInstallmentStatus,
    targetState: PaymentInstallmentStatus
  ): boolean {
    const currentRank = STATE_RANK[currentState] ?? 0;
    const targetRank = STATE_RANK[targetState] ?? 0;
    return targetRank < currentRank;
  }

  /**
   * Computes the projection for appointments.payment_status based on all installments of a group/appointment.
   */
  public static calculateAppointmentProjection(
    installments: Array<{ status: string }>
  ): AppointmentPaymentStatusProjection {
    if (!installments || installments.length === 0) {
      return 'pending';
    }

    const statuses = installments.map(i => (i.status || 'PENDING').toUpperCase() as PaymentInstallmentStatus);

    const allPaidOrConfirmed = statuses.every(s => s === 'RECEIVED' || s === 'CONFIRMED');
    if (allPaidOrConfirmed) {
      return 'paid';
    }

    const anyPaidOrConfirmed = statuses.some(s => s === 'RECEIVED' || s === 'CONFIRMED');
    if (anyPaidOrConfirmed) {
      return 'partially_paid';
    }

    const allRefunded = statuses.every(s => s === 'REFUNDED');
    if (allRefunded) {
      return 'refunded';
    }

    const anyOverdue = statuses.some(s => s === 'OVERDUE');
    if (anyOverdue) {
      return 'overdue';
    }

    const anyFailed = statuses.some(s => s === 'FAILED');
    if (anyFailed) {
      return 'failed';
    }

    return 'pending';
  }

  /**
   * Estados de REEMBOLSO de `appointments.payment_status`. Sao gravados por aula
   * pelo BookingCancellationCore a partir da operacao de estorno e NAO sao
   * derivaveis das parcelas — a projecao das parcelas nao pode apaga-los.
   */
  public static readonly REFUND_PAYMENT_STATUSES: readonly string[] = ['refund_requested', 'refund_denied', 'refunded'];

  /**
   * A projecao das parcelas pode sobrescrever o `payment_status` atual da aula?
   *  - aula sem estado de reembolso: sim (processamento normal das parcelas);
   *  - aula com estado de reembolso: somente quando a projecao e' `refunded`
   *    (todas as parcelas REFUNDED pelo gateway). Uma parcela recebida nunca
   *    transforma reembolso solicitado/recusado/confirmado em `paid`.
   */
  public static shouldProjectionOverwrite(
    currentPaymentStatus: string | null | undefined,
    projection: AppointmentPaymentStatusProjection
  ): boolean {
    if (projection === 'refunded') return true;
    return !PaymentStateMachine.REFUND_PAYMENT_STATUSES.includes(String(currentPaymentStatus ?? ''));
  }

  /**
   * A mesma regra de `shouldProjectionOverwrite`, como filtro PostgREST (`or`)
   * para ir na propria instrucao UPDATE. `null` = sem filtro.
   */
  public static projectionOverwriteFilter(projection: AppointmentPaymentStatusProjection): string | null {
    if (projection === 'refunded') return null;
    return `payment_status.is.null,payment_status.not.in.(${PaymentStateMachine.REFUND_PAYMENT_STATUSES.join(',')})`;
  }
}
