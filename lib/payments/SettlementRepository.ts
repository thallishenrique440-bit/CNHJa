/**
 * Settlement Repository
 * CNHJá Financial Architecture v1.0 (Etapa 6 - Settlement Service)
 *
 * DB IO ONLY:
 * - Handles payment_settlements and financial transactions table persistence
 * - Does NOT perform calculations
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  PaymentSettlementRecord,
  ProcessSettlementInput,
  SettlementCalculationResult,
  SettlementType
} from './SettlementTypes.js';
import { SettlementPersistenceError } from './SettlementErrors.js';

export class SettlementRepository {
  /**
   * Checks if a settlement already exists (Idempotency Check)
   */
  public static async findExistingSettlement(
    supabase: SupabaseClient,
    providerPaymentId: string,
    settlementType: SettlementType,
    providerSettlementId?: string | null
  ): Promise<PaymentSettlementRecord | null> {
    const pSettlementId = providerSettlementId && providerSettlementId.trim() !== '' 
      ? providerSettlementId 
      : null;

    let query = supabase
      .from('payment_settlements')
      .select('*')
      .eq('provider_payment_id', providerPaymentId)
      .eq('settlement_type', settlementType);

    if (pSettlementId) {
      query = query.eq('provider_settlement_id', pSettlementId);
    } else {
      query = query.is('provider_settlement_id', null);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new SettlementPersistenceError('Failed to query payment_settlements', error);
    }

    return data as PaymentSettlementRecord | null;
  }

  /**
   * Fetches payment installment by providerPaymentId and installmentNumber
   */
  public static async findInstallment(
    supabase: SupabaseClient,
    providerPaymentId: string,
    installmentNumber: number = 1
  ) {
    const { data, error } = await supabase
      .from('payment_installments')
      .select('id, student_id, instructor_id, group_id, appointment_id, gross_amount, net_amount, platform_fee, status')
      .eq('provider_payment_id', providerPaymentId)
      .eq('installment_number', installmentNumber)
      .maybeSingle();

    if (error) {
      throw new SettlementPersistenceError('Failed to query payment_installments', error);
    }

    return data;
  }

  /**
   * Creates a settlement record in payment_settlements
   */
  public static async createSettlementRecord(
    supabase: SupabaseClient,
    installmentId: string | null,
    input: ProcessSettlementInput,
    calcResult: SettlementCalculationResult
  ): Promise<PaymentSettlementRecord> {
    const insertPayload = {
      installment_id: installmentId,
      provider_payment_id: input.providerPaymentId,
      provider_settlement_id: input.providerSettlementId || null,
      settlement_type: input.settlementType,
      gross_amount: calcResult.grossAmount,
      net_amount: calcResult.netAmount,
      fee_amount: calcResult.feeAmount,
      platform_fee: calcResult.platformFee,
      instructor_amount: calcResult.instructorAmount,
      settled_at: calcResult.settledAt
    };

    const { data, error } = await supabase
      .from('payment_settlements')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) {
      throw new SettlementPersistenceError('Failed to insert into payment_settlements', error);
    }

    return data as PaymentSettlementRecord;
  }

  /**
   * Creates a financial transaction entry in transactions table
   * Ownership: SettlementService owns settlement_credit, settlement_refund, settlement_chargeback
   */
  public static async createFinancialTransaction(
    supabase: SupabaseClient,
    params: {
      studentId: string | null;
      instructorId: string | null;
      settlementId: string;
      installmentId: string | null;
      providerPaymentId: string;
      settlementType: SettlementType;
      calcResult: SettlementCalculationResult;
      eventLedgerId?: string | null;
      origin?: 'LESSON' | 'TIP';
    }
  ) {
    if (params.origin === 'TIP') {
      // Find existing tip transaction by provider_payment_id
      const { data: existingTip } = await supabase
        .from('transactions')
        .select('id, metadata')
        .eq('provider_payment_id', params.providerPaymentId)
        .maybeSingle();

      if (existingTip) {
        const meta = existingTip.metadata && typeof existingTip.metadata === 'object' ? existingTip.metadata : {};
        await supabase
          .from('transactions')
          .update({
            metadata: {
              ...meta,
              settlement_id: params.settlementId,
              settlement_key: params.calcResult.settlementKey,
              fee_amount: params.calcResult.feeAmount,
              instructor_amount: params.calcResult.instructorAmount,
              settled_at: params.calcResult.settledAt,
              release_date: params.calcResult.releaseDate
            }
          })
          .eq('id', existingTip.id);

        return existingTip.id;
      }
    }

    let txType: 'settlement_credit' | 'settlement_refund' | 'settlement_chargeback' = 'settlement_credit';
    let description = `Liquidação de pagamento (${params.providerPaymentId})`;

    if (params.settlementType === SettlementType.REFUND) {
      txType = 'settlement_refund';
      description = `Estorno de liquidação (${params.providerPaymentId})`;
    } else if (params.settlementType === SettlementType.CHARGEBACK) {
      txType = 'settlement_chargeback';
      description = `Chargeback de liquidação (${params.providerPaymentId})`;
    }

    const txPayload = {
      type: txType,
      student_id: params.studentId,
      instructor_id: params.instructorId,
      amount: params.calcResult.netAmount,
      gross_amount: params.calcResult.grossAmount,
      platform_fee: params.calcResult.platformFee,
      net_amount: params.calcResult.netAmount,
      event_date: params.calcResult.settledAt,
      description: description,
      provider: 'asaas',
      provider_event_id: params.eventLedgerId || null,
      idempotency_key: params.calcResult.settlementKey,
      metadata: {
        settlement_id: params.settlementId,
        installment_id: params.installmentId,
        provider_payment_id: params.providerPaymentId,
        settlement_type: params.settlementType,
        settlement_key: params.calcResult.settlementKey,
        fee_amount: params.calcResult.feeAmount,
        instructor_amount: params.calcResult.instructorAmount,
        settled_at: params.calcResult.settledAt,
        release_date: params.calcResult.releaseDate
      }
    };

    const { data, error } = await supabase
      .from('transactions')
      .insert(txPayload)
      .select('id')
      .single();

    if (error) {
      throw new SettlementPersistenceError('Failed to insert financial transaction into transactions table', error);
    }

    return data?.id || null;
  }
}
