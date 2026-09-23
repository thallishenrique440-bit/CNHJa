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

/**
 * P-1.20.1B: distinguishes a CAS failure caused by a STALE VERSION from a CAS
 * failure caused by a DIFFERENT OWNER. Before this phase both surfaced as
 * RefundOperationClaimLostError, which produced the false message
 * "owned by another worker" when the owner was in fact correct and only the
 * expected version was wrong. Real concurrency must never be masked, and a
 * programming error must never be reported as concurrency.
 */
export class RefundOperationVersionConflictError extends Error {
  public readonly expectedVersion: number;
  public readonly actualVersion: number;

  constructor(operationId: string, expectedVersion: number, actualVersion: number) {
    super(`Refund operation version conflict on ${operationId}: expected ${expectedVersion}, found ${actualVersion}`);
    this.name = 'RefundOperationVersionConflictError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class RefundOperationTransitionError extends Error {
  constructor(message: string) { super(message); this.name = 'RefundOperationTransitionError'; }
}

export class RefundOperationNotFoundError extends Error {
  constructor(operationId: string) { super(`Refund operation not found: ${operationId}`); this.name = 'RefundOperationNotFoundError'; }
}
