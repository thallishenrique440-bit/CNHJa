/**
 * PayoutStateMachine.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * In-Memory State Machine Validation for Payout Lifecycle.
 * Serves as defense-in-depth prior to PostgreSQL RPC execution.
 *
 * Allowed States:
 * - BLOCKED, READY, PENDING, PROCESSING, PAID, FAILED, CANCELLED
 */

import { PayoutStatus } from './PayoutTypes.js';
import { InvalidStateTransitionException } from './PayoutErrors.js';

export class PayoutStateMachine {
  private static readonly INITIAL_STATES: PayoutStatus[] = ['BLOCKED', 'PENDING', 'READY'];

  private static readonly ALLOWED_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
    BLOCKED: ['READY'],
    READY: ['PROCESSING', 'BLOCKED', 'CANCELLED'],
    PENDING: ['PROCESSING', 'CANCELLED'],
    PROCESSING: ['PAID', 'FAILED'],
    FAILED: ['READY', 'CANCELLED'],
    PAID: [],
    CANCELLED: []
  };

  /**
   * Checks whether a state transition from currentStatus to targetStatus is allowed.
   */
  public static canTransition(currentStatus: PayoutStatus | null, targetStatus: PayoutStatus): boolean {
    if (!currentStatus) {
      return this.INITIAL_STATES.includes(targetStatus);
    }
    if (currentStatus === targetStatus) {
      return true; // Allowed metadata update
    }
    const allowed = this.ALLOWED_TRANSITIONS[currentStatus] || [];
    return allowed.includes(targetStatus);
  }

  /**
   * Validates a state transition and throws a detailed Error if invalid or illegal.
   */
  public static validateTransition(currentStatus: PayoutStatus | null, targetStatus: PayoutStatus): void {
    if (!currentStatus) {
      if (!this.INITIAL_STATES.includes(targetStatus)) {
        throw new InvalidStateTransitionException(
          `Cannot create payout with initial status '${targetStatus}'. Allowed initial statuses: ${this.INITIAL_STATES.join(', ')}`,
          'INVALID_INITIAL_STATE'
        );
      }
      return;
    }

    if (currentStatus === targetStatus) {
      return; // Allowed metadata update
    }

    if (['PAID', 'CANCELLED'].includes(currentStatus)) {
      throw new InvalidStateTransitionException(
        `Payout is in terminal state '${currentStatus}' and cannot transition to '${targetStatus}'.`,
        'TERMINAL_STATE_REACHED'
      );
    }

    const allowed = this.ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new InvalidStateTransitionException(
        `Cannot transition payout from '${currentStatus}' to '${targetStatus}'. Allowed target states: ${allowed.length > 0 ? allowed.join(', ') : 'None (Terminal state)'}`,
        'INVALID_STATE_TRANSITION'
      );
    }
  }
}
