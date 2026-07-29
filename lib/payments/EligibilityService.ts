/**
 * EligibilityService.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * Validates official documented financial eligibility rules for payout creation.
 * Audit Traceability (Fase 5 - Correção 1):
 * - Rule 1: [DOCUMENTADO: Especificação Oficial da Arquitetura Financeira & Adendo Oficial]
 * - Rule 2: [DOCUMENTADO: Especificação Oficial & Constraint PostgreSQL CHECK (net_amount > 0)]
 * - Rule 3: [DOCUMENTADO: Especificação Oficial & Settlement Service]
 * - Rule 4: [DECISÃO DE IMPLEMENTAÇÃO / DEFESA EM PROFUNDIDADE]
 */

import { EligibleSettlementDTO, EligibilityCheckResult } from './PayoutTypes.js';
import { EligibilityException } from './PayoutErrors.js';

export class EligibilityService {
  /**
   * Evaluates eligibility criteria for a given settlement record.
   */
  public checkEligibility(settlement: EligibleSettlementDTO): EligibilityCheckResult {
    if (!settlement) {
      return {
        eligible: false,
        reason: 'Settlement record is null or undefined'
      };
    }

    // Rule 1 [DOCUMENTADO: Especificação Oficial]: Settlement type must be PAYMENT
    if (settlement.settlementType !== 'PAYMENT') {
      return {
        eligible: false,
        reason: `Ineligible settlement type: '${settlement.settlementType}'. Only PAYMENT settlements are eligible for payouts.`,
        settlement
      };
    }

    // Rule 2 [DOCUMENTADO: Especificação Oficial & DB CHECK (net_amount > 0)]: Net amount must be > 0
    if (typeof settlement.netAmount !== 'number' || settlement.netAmount <= 0) {
      return {
        eligible: false,
        reason: `Invalid net amount: ${settlement.netAmount}. Net payout amount must be strictly greater than zero.`,
        settlement
      };
    }

    // Rule 3 [DOCUMENTADO: Especificação Oficial & Settlement Service]: Settled timestamp must be present
    if (!settlement.settledAt || !settlement.settledAt.trim()) {
      return {
        eligible: false,
        reason: 'Settlement settledAt timestamp is missing or empty.',
        settlement
      };
    }

    // Rule 4 [DECISÃO DE IMPLEMENTAÇÃO / DEFESA EM PROFUNDIDADE]: Installment status (if present) must be PAID or RECEIVED
    if (settlement.installmentStatus !== undefined && settlement.installmentStatus !== null) {
      const normalizedStatus = settlement.installmentStatus.toUpperCase().trim();
      if (!['PAID', 'RECEIVED'].includes(normalizedStatus)) {
        return {
          eligible: false,
          reason: `Installment status '${settlement.installmentStatus}' is not settled (must be PAID or RECEIVED).`,
          settlement
        };
      }
    }

    return {
      eligible: true,
      settlement
    };
  }

  /**
   * Helper method to assert eligibility and throw domain exception if ineligible.
   */
  public validateEligibilityOrThrow(settlement: EligibleSettlementDTO): void {
    const result = this.checkEligibility(settlement);
    if (!result.eligible) {
      throw new EligibilityException(result.reason || 'Settlement is not eligible for payout');
    }
  }
}
