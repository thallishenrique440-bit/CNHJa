/**
 * ProjectionErrors.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7 - Projection Service)
 *
 * Domain error hierarchy for Projection Service and Read Model layer.
 */

export abstract class ProjectionBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProjectionPersistenceError extends ProjectionBaseError {
  public readonly originalError?: any;

  constructor(message: string, originalError?: any) {
    super(message);
    this.originalError = originalError;
  }
}

export class InvalidProjectionEventError extends ProjectionBaseError {
  public readonly eventData: any;

  constructor(message: string, eventData: any) {
    super(message);
    this.eventData = eventData;
  }
}

export class ProjectionRebuildError extends ProjectionBaseError {
  public readonly rebuildVersion: number;
  public readonly cause?: any;

  constructor(message: string, rebuildVersion: number, cause?: any) {
    super(message);
    this.rebuildVersion = rebuildVersion;
    this.cause = cause;
  }
}

export class ProjectionOptimisticLockError extends ProjectionBaseError {
  public readonly entityId: string;
  public readonly expectedVersion: number;

  constructor(message: string, entityId: string, expectedVersion: number) {
    super(message);
    this.entityId = entityId;
    this.expectedVersion = expectedVersion;
  }
}
