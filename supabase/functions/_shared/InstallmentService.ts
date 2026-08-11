import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface RecordScheduleDTO {
  providerPaymentId: string;
  providerPaymentIdMap?: Map<number, string> | Record<number, string>;
  totalInstallments: number;
  grossAmountCents: number;
  netAmountCents: number;
  platformFeeCents: number;
  feeAmountCents?: number;
  groupId?: string | null;
  appointmentId?: string | null;
  transactionId?: string | null;
  studentId?: string | null;
  instructorId?: string | null;
  dueDate?: string | null;
}

export interface RecordSettlementDTO {
  providerPaymentId: string;
  installmentNumber: number;
  totalInstallments: number;
  grossAmountCents: number;
  netAmountCents: number;
  platformFeeCents: number;
  feeAmountCents?: number;
  paymentDate?: string | null;
  groupId?: string | null;
  appointmentId?: string | null;
  transactionId?: string | null;
  studentId?: string | null;
  instructorId?: string | null;
  providerSettlementId?: string | null;
}

export interface RecordRefundDTO {
  providerPaymentId: string;
  groupId?: string | null;
  installmentNumber?: number;
  refundAmountCents: number;
  providerSettlementId?: string | null;
  refundDate?: string | null;
}

export class InstallmentService {

  /**
   * Refund settlement for a payment / installment (SSOT)
   */
  static async recordRefundSettlement(
    supabase: SupabaseClient,
    dto: RecordRefundDTO
  ): Promise<void> {
    const refundDate = dto.refundDate || new Date().toISOString();

    // Fetch existing installments for this group_id or provider_payment_id
    let query = supabase
      .from('payment_installments')
      .select('id, installment_number, gross_amount, platform_fee, instructor_amount, instructor_id, student_id');

    if (dto.groupId && dto.providerPaymentId) {
      query = query.or(`group_id.eq.${dto.groupId},provider_payment_id.eq.${dto.providerPaymentId}`);
    } else if (dto.groupId) {
      query = query.eq('group_id', dto.groupId);
    } else {
      query = query.eq('provider_payment_id', dto.providerPaymentId);
    }

    if (dto.installmentNumber) {
      query = query.eq('installment_number', dto.installmentNumber);
    }

    const { data: instList, error: fetchErr } = await query;

    if (fetchErr) {
      console.error(`❌ [InstallmentService] Error fetching installments for refund:`, fetchErr.message);
    }

    if (instList && instList.length > 0) {
      for (const inst of instList) {
        // Mark installment as REFUNDED
        await supabase
          .from('payment_installments')
          .update({ status: 'REFUNDED', updated_at: new Date().toISOString() })
          .eq('id', inst.id);

        const instNum = inst.installment_number || dto.installmentNumber || 1;
        const settlementId = dto.providerSettlementId || `${dto.providerPaymentId}_refund_${instNum}`;

        // Insert refund cash flow settlement
        await supabase
          .from('payment_settlements')
          .upsert({
            installment_id: inst.id,
            provider_payment_id: dto.providerPaymentId,
            provider_settlement_id: settlementId,
            settlement_type: 'REFUND',
            gross_amount: -Math.abs(inst.gross_amount),
            net_amount: -Math.abs(inst.gross_amount - inst.platform_fee),
            fee_amount: 0,
            platform_fee: -Math.abs(inst.platform_fee),
            instructor_amount: -Math.abs(inst.instructor_amount),
            settled_at: refundDate,
            instructor_id: inst.instructor_id,
            student_id: inst.student_id,
          }, { onConflict: 'provider_payment_id,settlement_type,provider_settlement_id' });
      }
      console.log(`✅ [InstallmentService] Successfully recorded refund settlement for payment ${dto.providerPaymentId}`);
    } else {
      console.warn(`⚠️ [InstallmentService] No installment found for refund on payment ${dto.providerPaymentId}. Creating standalone refund settlement.`);
      const instNum = dto.installmentNumber || 1;
      const settlementId = dto.providerSettlementId || `${dto.providerPaymentId}_refund_${instNum}`;
      const gross = Math.abs(dto.refundAmountCents);
      const platformFee = Math.round(gross * 0.10);
      const net = gross - platformFee;

      await supabase
        .from('payment_settlements')
        .upsert({
          provider_payment_id: dto.providerPaymentId,
          provider_settlement_id: settlementId,
          settlement_type: 'REFUND',
          gross_amount: -gross,
          net_amount: -net,
          fee_amount: 0,
          platform_fee: -platformFee,
          instructor_amount: -net,
          settled_at: refundDate
        }, { onConflict: 'provider_payment_id,settlement_type,provider_settlement_id' });
    }
  }
}
