/**
 * Settlement Error Hierarchy
 * CNHJá Financial Architecture v1.0 (Etapa 6 - Settlement Service)
 */

export class SettlementBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementBaseError';
  }
}

export class DuplicateSettlementError extends SettlementBaseError {
  public readonly settlementKey: string;
  constructor(settlementKey: string) {
    super(`Settlement with key '${settlementKey}' has already been processed.`);
    this.name = 'DuplicateSettlementError';
    this.settlementKey = settlementKey;
  }
}

export class InstallmentForSettlementNotFoundError extends SettlementBaseError {
  public readonly providerPaymentId: string;
  public readonly installmentNumber?: number | null;

  constructor(providerPaymentId: string, installmentNumber?: number | null) {
    super(`Payment installment not found for providerPaymentId '${providerPaymentId}' (installment: ${installmentNumber ?? 1}).`);
    this.name = 'InstallmentForSettlementNotFoundError';
    this.providerPaymentId = providerPaymentId;
    this.installmentNumber = installmentNumber;
  }
}

export class InvalidSettlementAmountError extends SettlementBaseError {
  public readonly amount: number;
  constructor(message: string, amount: number) {
    super(message);
    this.name = 'InvalidSettlementAmountError';
    this.amount = amount;
  }
}

export class SettlementPersistenceError extends SettlementBaseError {
  public readonly originalError?: any;
  constructor(message: string, originalError?: any) {
    super(`${message}${originalError ? `: ${typeof originalError === 'object' ? JSON.stringify(originalError) : originalError}` : ''}`);
    this.name = 'SettlementPersistenceError';
    this.originalError = originalError;
  }
}
