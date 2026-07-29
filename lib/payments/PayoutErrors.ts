/**
 * PayoutErrors.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * Domain-specific exception hierarchy for the Payout Engine module.
 */

export class PayoutDomainException extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'PAYOUT_DOMAIN_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EligibilityException extends PayoutDomainException {
  constructor(message: string, code: string = 'ELIGIBILITY_ERROR') {
    super(message, code);
  }
}

export class InvalidPayoutKeyException extends PayoutDomainException {
  constructor(message: string, code: string = 'INVALID_PAYOUT_KEY_INPUT') {
    super(message, code);
  }
}

export class InvalidStateTransitionException extends PayoutDomainException {
  constructor(message: string, code: string = 'INVALID_STATE_TRANSITION') {
    super(message, code);
  }
}

export class PayoutRepositoryException extends PayoutDomainException {
  constructor(message: string, code: string = 'PAYOUT_REPOSITORY_ERROR') {
    super(message, code);
  }
}
