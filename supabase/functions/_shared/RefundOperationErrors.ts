export class RefundOperationPersistenceError extends Error {
  public readonly originalError: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = 'RefundOperationPersistenceError';
    this.originalError = originalError;
  }
}

export class RefundOperationClaimLostError extends Error {
  constructor(operationKey: string) {
    super(`Refund operation claim is owned by another worker: ${operationKey}`);
    this.name = 'RefundOperationClaimLostError';
  }
}

export class RefundOperationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundOperationTransitionError';
  }
}

export class RefundOperationNotFoundError extends Error {
  constructor(operationId: string) {
    super(`Refund operation not found: ${operationId}`);
    this.name = 'RefundOperationNotFoundError';
  }
}
