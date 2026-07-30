/**
 * Settlement Service
 * CNHJá Financial Architecture v1.0 (Etapa 6 - Settlement Service)
 *
 * OWNER OF:
 * - payment_settlements
 * - transactions with type in ('settlement_credit', 'settlement_refund', 'settlement_chargeback')
 *
 * STRICT INVARIANTS:
 * - NEVER updates payment_installments
 * - NEVER updates appointments.status or appointments.payment_status
 * - NEVER updates processing_status of Event Ledger
 * - NEVER creates webhook_event transactions
 * - NEVER executes Payouts
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  ProcessSettlementInput,
  SettlementOutcome,
  SettlementProcessResult,
  SettlementType,
  SettlementWarning,
  SettlementWarningCode
} from './SettlementTypes.js';
import { SettlementCalculator } from './SettlementCalculator.js';
import { SettlementRepository } from './SettlementRepository.js';
import {
  InstallmentForSettlementNotFoundError
} from './SettlementErrors.js';
import { ProjectionDispatcher } from './projections/ProjectionDispatcher.js';
import { ProjectionSourceEventType } from './projections/ProjectionTypes.js';

export class SettlementService {
  /**
   * Main entry point for processing payment settlements (PAYMENT type)
   */
  public static async processSettlement(
    input: ProcessSettlementInput,
    supabase: SupabaseClient
  ): Promise<SettlementProcessResult> {
    return this.executeSettlement(
      { ...input, settlementType: SettlementType.PAYMENT },
      supabase
    );
  }

  /**
   * Main entry point for processing refund / chargeback settlements
   */
  public static async processRefundSettlement(
    input: ProcessSettlementInput,
    supabase: SupabaseClient
  ): Promise<SettlementProcessResult> {
    const sType = input.settlementType === SettlementType.CHARGEBACK
      ? SettlementType.CHARGEBACK
      : SettlementType.REFUND;

    return this.executeSettlement(
      { ...input, settlementType: sType },
      supabase
    );
  }

  /**
   * Core private execution logic for settlements
   */
  private static async executeSettlement(
    input: ProcessSettlementInput,
    supabase: SupabaseClient
  ): Promise<SettlementProcessResult> {
    const warnings: SettlementWarning[] = [];
    const installmentNumber = input.installmentNumber || 1;

    try {
      // 1. Idempotency check: look up existing settlement
      const existingSettlement = await SettlementRepository.findExistingSettlement(
        supabase,
        input.providerPaymentId,
        input.settlementType,
        input.providerSettlementId
      );

      const settlementKey = SettlementCalculator.generateSettlementKey(
        input.providerPaymentId,
        input.settlementType,
        input.providerSettlementId
      );

      if (existingSettlement) {
        warnings.push({
          code: SettlementWarningCode.ALREADY_SETTLED,
          message: `Settlement key '${settlementKey}' already executed at ${existingSettlement.settled_at}.`
        });

        return {
          outcome: SettlementOutcome.NO_OP_DUPLICATE,
          settlementId: existingSettlement.id,
          installmentId: existingSettlement.installment_id,
          settlementType: input.settlementType,
          settlementKey,
          grossAmount: existingSettlement.gross_amount,
          netAmount: existingSettlement.net_amount,
          feeAmount: existingSettlement.fee_amount,
          platformFee: existingSettlement.platform_fee,
          instructorAmount: existingSettlement.instructor_amount,
          settledAt: existingSettlement.settled_at,
          warnings
        };
      }

      // 2. Fetch corresponding installment
      const installment = await SettlementRepository.findInstallment(
        supabase,
        input.providerPaymentId,
        installmentNumber
      );

      if (!installment) {
        throw new InstallmentForSettlementNotFoundError(
          input.providerPaymentId,
          installmentNumber
        );
      }

      // 3. Calculate monetary values & release dates using pure calculator
      const calcResult = SettlementCalculator.calculate({
        ...input,
        grossAmount: input.grossAmount || installment.gross_amount,
        platformFee: input.platformFee !== undefined ? input.platformFee : installment.platform_fee,
        netAmount: input.netAmount !== undefined ? input.netAmount : installment.net_amount
      });

      if (calcResult.netAmount === 0) {
        warnings.push({
          code: SettlementWarningCode.ZERO_NET_AMOUNT,
          message: `Settlement net amount calculated as 0 for payment ${input.providerPaymentId}.`
        });
      }

      // 4. Create settlement record in payment_settlements
      const settlementRecord = await SettlementRepository.createSettlementRecord(
        supabase,
        installment.id,
        input,
        calcResult
      );

      // 5. Create financial transaction in transactions table
      const transactionId = await SettlementRepository.createFinancialTransaction(
        supabase,
        {
          studentId: installment.student_id,
          instructorId: installment.instructor_id,
          settlementId: settlementRecord.id,
          installmentId: installment.id,
          providerPaymentId: input.providerPaymentId,
          settlementType: input.settlementType,
          calcResult,
          eventLedgerId: input.eventLedgerId
        }
      );

      // 6. Dispatch Settlement event to ProjectionDispatcher (Official Wave 2 Pipeline)
      try {
        const sType = input.settlementType === SettlementType.CHARGEBACK
          ? ProjectionSourceEventType.CHARGEBACK_CREATED
          : input.settlementType === SettlementType.REFUND
          ? ProjectionSourceEventType.REFUND_CREATED
          : ProjectionSourceEventType.SETTLEMENT_CREATED;

        await ProjectionDispatcher.dispatch(
          supabase,
          {
            eventType: sType,
            settlementId: settlementRecord.id,
            providerPaymentId: input.providerPaymentId,
            installmentId: installment.id,
            instructorId: installment.instructor_id,
            studentId: installment.student_id,
            grossAmount: calcResult.grossAmount,
            netAmount: calcResult.netAmount,
            platformFee: calcResult.platformFee,
            feeAmount: calcResult.feeAmount,
            instructorAmount: calcResult.instructorAmount,
            settlementType: input.settlementType,
            settledAt: calcResult.settledAt,
            releaseDate: calcResult.settledAt
          }
        );
      } catch (projErr) {
        console.warn('⚠️ [SettlementService] Failed to dispatch projection event:', projErr);
      }

      return {
        outcome: SettlementOutcome.SETTLEMENT_EXECUTED,
        settlementId: settlementRecord.id,
        transactionId: transactionId || undefined,
        installmentId: installment.id,
        settlementType: input.settlementType,
        settlementKey,
        grossAmount: calcResult.grossAmount,
        netAmount: calcResult.netAmount,
        feeAmount: calcResult.feeAmount,
        platformFee: calcResult.platformFee,
        instructorAmount: calcResult.instructorAmount,
        settledAt: calcResult.settledAt,
        warnings
      };

    } catch (err: any) {
      console.error(`❌ [SettlementService] Settlement processing failed for ${input.providerPaymentId}:`, err);

      return {
        outcome: SettlementOutcome.ERROR,
        settlementType: input.settlementType,
        settlementKey: SettlementCalculator.generateSettlementKey(
          input.providerPaymentId,
          input.settlementType,
          input.providerSettlementId
        ),
        grossAmount: input.grossAmount || 0,
        netAmount: input.netAmount || 0,
        feeAmount: input.feeAmount || 0,
        platformFee: input.platformFee || 0,
        instructorAmount: input.instructorAmount || 0,
        settledAt: new Date().toISOString(),
        warnings,
        error: err?.message || String(err)
      };
    }
  }
}
