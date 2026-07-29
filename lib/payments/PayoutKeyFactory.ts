/**
 * PayoutKeyFactory.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * Single source of truth for deterministic payout key generation.
 * Guarantees idempotency and prevent key generation divergence across services.
 */

import { InvalidPayoutKeyException } from './PayoutErrors.js';

export class PayoutKeyFactory {
  /**
   * Generates a deterministic payout key based on instructor ID and settlement ID.
   * Format: payout_inst_{instructorId}_set_{settlementId}
   */
  public static generateKey(instructorId: string, settlementId: string): string {
    if (!instructorId || !instructorId.trim()) {
      throw new InvalidPayoutKeyException('instructorId is required to generate payout_key');
    }
    if (!settlementId || !settlementId.trim()) {
      throw new InvalidPayoutKeyException('settlementId is required to generate payout_key');
    }

    return `payout_inst_${instructorId.trim()}_set_${settlementId.trim()}`;
  }
}
