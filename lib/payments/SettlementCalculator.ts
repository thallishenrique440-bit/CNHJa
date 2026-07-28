/**
 * Settlement Calculator (Pure Functions)
 * CNHJá Financial Architecture v1.0 (Etapa 6 - Settlement Service)
 *
 * PURE FUNCTIONS ONLY:
 * - No DB / Supabase access
 * - No environment variable access
 * - Deterministic output based on inputs
 */

import {
  ProcessSettlementInput,
  SettlementCalculationResult,
  SettlementType
} from './SettlementTypes.js';
import { InvalidSettlementAmountError } from './SettlementErrors.js';

export class SettlementCalculator {
  /**
   * Generates unique idempotency key for a settlement event
   */
  public static generateSettlementKey(
    providerPaymentId: string,
    settlementType: SettlementType,
    providerSettlementId?: string | null
  ): string {
    const pSettlementId = providerSettlementId && providerSettlementId.trim() !== '' 
      ? providerSettlementId 
      : 'std';
    return `${providerPaymentId}:${settlementType}:${pSettlementId}`;
  }

  /**
   * Pure calculation of settlement monetary values and release date
   */
  public static calculate(
    input: ProcessSettlementInput,
    referenceTimestamp?: string
  ): SettlementCalculationResult {
    if (input.grossAmount < 0 && input.settlementType === SettlementType.PAYMENT) {
      throw new InvalidSettlementAmountError(
        `Gross amount cannot be negative for PAYMENT settlement, got ${input.grossAmount}`,
        input.grossAmount
      );
    }

    const grossAmount = Math.round(input.grossAmount);

    // Calculate Platform Fee (Default 10% if not specified)
    const platformFee = input.platformFee !== undefined
      ? Math.round(input.platformFee)
      : Math.round(grossAmount * 0.10);

    // Provider Fee (Default 0 if not specified)
    const feeAmount = input.feeAmount !== undefined
      ? Math.round(input.feeAmount)
      : 0;

    // Calculated Net Amount and Instructor Amount
    const calculatedNet = grossAmount - platformFee - feeAmount;
    const netAmount = input.netAmount !== undefined
      ? Math.round(input.netAmount)
      : calculatedNet;

    const instructorAmount = input.instructorAmount !== undefined
      ? Math.round(input.instructorAmount)
      : netAmount;

    // Settlement Date & Release Date logic
    const settledAt = input.settledAt || referenceTimestamp || new Date().toISOString();
    const releaseDate = this.calculateReleaseDate(
      settledAt,
      input.paymentMethod,
      input.installmentNumber || 1
    );

    // Settlement Key
    const settlementKey = this.generateSettlementKey(
      input.providerPaymentId,
      input.settlementType,
      input.providerSettlementId
    );

    return {
      grossAmount,
      netAmount,
      feeAmount,
      platformFee,
      instructorAmount,
      settlementKey,
      settledAt,
      releaseDate
    };
  }

  /**
   * Calculates cash release date based on payment method and installment
   */
  public static calculateReleaseDate(
    settledAtIso: string,
    paymentMethod?: string,
    installmentNumber: number = 1
  ): string {
    const baseDate = new Date(settledAtIso);
    if (isNaN(baseDate.getTime())) {
      return new Date().toISOString();
    }

    const method = (paymentMethod || 'PIX').toUpperCase();

    if (method === 'CREDIT_CARD') {
      // D+30 per installment
      const daysToAdd = 30 * installmentNumber;
      baseDate.setDate(baseDate.getDate() + daysToAdd);
    } else {
      // PIX / BOLETO: D+0 / D+1
      baseDate.setDate(baseDate.getDate() + 1);
    }

    return baseDate.toISOString();
  }
}
