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

    // Fetch existing installments for this provider_payment_id or group_id
    let query = supabase
      .from('payment_installments')
      .select('id, installment_number, gross_amount, platform_fee, instructor_amount, instructor_id, student_id');

    if (dto.providerPaymentId) {
      query = query.eq('provider_payment_id', dto.providerPaymentId);
    } else if (dto.groupId) {
      query = query.eq('group_id', dto.groupId);
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
        const { error: updateErr } = await supabase
          .from('payment_installments')
          .update({ status: 'REFUNDED', updated_at: new Date().toISOString() })
          .eq('id', inst.id);

        if (updateErr) {
          console.error(`❌ [InstallmentService] Error updating installment ${inst.id} to REFUNDED:`, updateErr.message);
        }
      }
      console.log(`✅ [InstallmentService] Successfully updated installment refund status for payment ${dto.providerPaymentId}`);
    } else {
      console.log(`ℹ️ [InstallmentService] No installment found for payment ${dto.providerPaymentId} to reconcile refund.`);
    }
  }
}
