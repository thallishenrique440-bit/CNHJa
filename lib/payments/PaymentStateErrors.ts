/**
 * Payment State Error Hierarchy - CNHJá Financial Architecture v1.0
 */

export class PaymentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentStateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InstallmentNotFoundError extends PaymentStateError {
  public readonly providerPaymentId: string;
  public readonly installmentNumber?: number | null;

  constructor(providerPaymentId: string, installmentNumber?: number | null) {
    const instStr = installmentNumber ? ` (installment #${installmentNumber})` : '';
    super(`Payment installment not found for provider_payment_id '${providerPaymentId}'${instStr}`);
    this.name = 'InstallmentNotFoundError';
    this.providerPaymentId = providerPaymentId;
    this.installmentNumber = installmentNumber;
  }
}

export class InvalidTransitionError extends PaymentStateError {
  public readonly currentState: string;
  public readonly targetState: string;

  constructor(currentState: string, targetState: string) {
    super(`Invalid state transition attempted from '${currentState}' to '${targetState}'`);
    this.name = 'InvalidTransitionError';
    this.currentState = currentState;
    this.targetState = targetState;
  }
}

export class StatePersistenceError extends PaymentStateError {
  public readonly originalError: string;

  constructor(message: string, originalError: string) {
    super(`${message}: ${originalError}`);
    this.name = 'StatePersistenceError';
    this.originalError = originalError;
  }
}
