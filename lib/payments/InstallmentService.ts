import { SupabaseClient } from '@supabase/supabase-js';

export interface RecordScheduleDTO {
  providerPaymentId: string;
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
  installmentNumber?: number;
  refundAmountCents: number;
  providerSettlementId?: string | null;
  refundDate?: string | null;
}

export class InstallmentService {

  /**
   * Records or updates the expected schedule of payment installments (PENDING status)
   */
  static async recordInitialSchedule(
    supabase: SupabaseClient,
    dto: RecordScheduleDTO
  ): Promise<void> {
    const count = dto.totalInstallments > 0 ? dto.totalInstallments : 1;
    const installmentsToInsert = [];

    let allocatedGross = 0;
    let allocatedNet = 0;
    let allocatedPlatformFee = 0;
    let allocatedFee = 0;

    for (let i = 1; i <= count; i++) {
      let instGross = 0;
      let instNet = 0;
      let instPlatformFee = 0;
      let instFee = 0;

      if (i === count) {
        instGross = dto.grossAmountCents - allocatedGross;
        instNet = dto.netAmountCents - allocatedNet;
        instPlatformFee = dto.platformFeeCents - allocatedPlatformFee;
        instFee = (dto.feeAmountCents || 0) - allocatedFee;
      } else {
        instGross = Math.floor(dto.grossAmountCents / count);
        instNet = Math.floor(dto.netAmountCents / count);
        instPlatformFee = Math.floor(dto.platformFeeCents / count);
        instFee = Math.floor((dto.feeAmountCents || 0) / count);

        allocatedGross += instGross;
        allocatedNet += instNet;
        allocatedPlatformFee += instPlatformFee;
        allocatedFee += instFee;
      }

      const instInstructorAmount = instGross - instPlatformFee;

      // Calculate monthly due date offset if totalInstallments > 1
      let computedDueDate: string | null = dto.dueDate || null;
      if (!computedDueDate && dto.dueDate === undefined) {
        const d = new Date();
        d.setMonth(d.getMonth() + (i - 1));
        computedDueDate = d.toISOString();
      }

      installmentsToInsert.push({
        provider_payment_id: dto.providerPaymentId,
        installment_number: i,
        total_installments: count,
        gross_amount: instGross,
        net_amount: instNet,
        fee_amount: instFee,
        platform_fee: instPlatformFee,
        instructor_amount: instInstructorAmount,
        status: 'PENDING',
        due_date: computedDueDate,
        group_id: dto.groupId || null,
        appointment_id: dto.appointmentId || null,
        transaction_id: dto.transactionId || null,
        student_id: dto.studentId || null,
        instructor_id: dto.instructorId || null,
        updated_at: new Date().toISOString()
      });
    }

    for (const inst of installmentsToInsert) {
      const { error } = await supabase
        .from('payment_installments')
        .upsert(inst, { onConflict: 'provider_payment_id,installment_number' });

      if (error) {
        console.error(`❌ [InstallmentService] Error recording schedule for installment ${inst.installment_number}:`, error.message);
      }
    }
  }

  /**
   * Liquidation / Payment settlement for a specific installment
   */
  static async recordPaymentSettlement(
    supabase: SupabaseClient,
    dto: RecordSettlementDTO
  ): Promise<void> {
    const instNumber = dto.installmentNumber > 0 ? dto.installmentNumber : 1;
    const totalInst = dto.totalInstallments > 0 ? dto.totalInstallments : 1;
    const paymentDate = dto.paymentDate || new Date().toISOString();
    const instructorAmount = dto.grossAmountCents - dto.platformFeeCents;

    // 1. Upsert payment_installments to PAID
    const { data: instData, error: instError } = await supabase
      .from('payment_installments')
      .upsert({
        provider_payment_id: dto.providerPaymentId,
        installment_number: instNumber,
        total_installments: totalInst,
        gross_amount: dto.grossAmountCents,
        net_amount: dto.netAmountCents,
        fee_amount: dto.feeAmountCents || 0,
        platform_fee: dto.platformFeeCents,
        instructor_amount: instructorAmount,
        status: 'PAID',
        payment_date: paymentDate,
        group_id: dto.groupId || null,
        appointment_id: dto.appointmentId || null,
        transaction_id: dto.transactionId || null,
        student_id: dto.studentId || null,
        instructor_id: dto.instructorId || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'provider_payment_id,installment_number' })
      .select('id')
      .single();

    if (instError) {
      console.error(`❌ [InstallmentService] Error upserting installment ${instNumber} for payment ${dto.providerPaymentId}:`, instError.message);
    }

    const installmentId = instData?.id;
    const settlementId = dto.providerSettlementId || `${dto.providerPaymentId}_inst${instNumber}`;

    // 2. Insert cash flow settlement record into payment_settlements (idempotent)
    const { error: settlementError } = await supabase
      .from('payment_settlements')
      .upsert({
        installment_id: installmentId || null,
        provider_payment_id: dto.providerPaymentId,
        provider_settlement_id: settlementId,
        settlement_type: 'PAYMENT',
        gross_amount: dto.grossAmountCents,
        net_amount: dto.netAmountCents,
        fee_amount: dto.feeAmountCents || 0,
        platform_fee: dto.platformFeeCents,
        instructor_amount: instructorAmount,
        settled_at: paymentDate,
      }, { onConflict: 'provider_payment_id,settlement_type,provider_settlement_id' });

    if (settlementError) {
      console.error(`❌ [InstallmentService] Error inserting payment settlement for ${dto.providerPaymentId}:`, settlementError.message);
    } else {
      console.log(`✅ [InstallmentService] Successfully recorded cash flow settlement for payment ${dto.providerPaymentId} (installment ${instNumber}/${totalInst})`);
    }
  }

  /**
   * Refund settlement for a payment / installment
   */
  static async recordRefundSettlement(
    supabase: SupabaseClient,
    dto: RecordRefundDTO
  ): Promise<void> {
    const refundDate = dto.refundDate || new Date().toISOString();

    // Fetch existing installments for this provider_payment_id
    let query = supabase
      .from('payment_installments')
      .select('id, installment_number, gross_amount, platform_fee, instructor_amount')
      .eq('provider_payment_id', dto.providerPaymentId);

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

        const settlementId = dto.providerSettlementId || `${dto.providerPaymentId}_refund_${inst.installment_number}`;

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
          }, { onConflict: 'provider_payment_id,settlement_type,provider_settlement_id' });
      }
      console.log(`✅ [InstallmentService] Successfully recorded refund settlement for payment ${dto.providerPaymentId}`);
    } else {
      console.warn(`⚠️ [InstallmentService] No installment found for refund on payment ${dto.providerPaymentId}`);
    }
  }
}
