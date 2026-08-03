/**
 * InstructorFinanceReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Concrete implementation of IInstructorFinanceReadService.
 * Reads exclusively from ProjectionService (instructor_financial_projections, cash_flow_projections)
 * and payment_installments table for statements.
 *
 * READ MODEL ONLY - NO MONETARY RECALCULATIONS OR STATE INFERENCES.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { IInstructorFinanceReadService } from '../interfaces/IInstructorFinanceReadService.js';
import {
  InstructorFinanceSummaryDTO,
  InstructorStatementEntryDTO,
  InstructorCashFlowDTO,
  InstructorMonthlyMetricsDTO
} from '../dtos/InstructorFinanceDTO.js';
import { ProjectionService } from '../projections/ProjectionService.js';

export class InstructorFinanceReadService implements IInstructorFinanceReadService {
  /**
   * Reads instructor projection summary directly from ProjectionService.
   */
  public async getSummary(
    supabaseClient: SupabaseClient,
    instructorId: string
  ): Promise<InstructorFinanceSummaryDTO | null> {
    const proj = await ProjectionService.getInstructorProjection(supabaseClient, instructorId);
    
    // Fetch payouts totals if present
    let pendingPayoutCents = 0;
    let totalPaidOutCents = 0;

    try {
      const { data: payouts } = await supabaseClient
        .from('payouts')
        .select('amount, status')
        .eq('instructor_id', instructorId);

      if (payouts && payouts.length > 0) {
        for (const p of payouts) {
          if (p.status === 'PROCESSING' || p.status === 'SCHEDULED' || p.status === 'PENDING') {
            pendingPayoutCents += p.amount || 0;
          } else if (p.status === 'PAID' || p.status === 'COMPLETED') {
            totalPaidOutCents += p.amount || 0;
          }
        }
      }
    } catch {
      // Payouts table query non-fatal fallback
    }

    if (!proj) {
      return {
        instructorId,
        availableBalanceCents: 0,
        futureReceivablesCents: 0,
        totalNetSettledCents: 0,
        totalGrossCents: 0,
        totalFeesCents: 0,
        pendingReleaseCents: 0,
        pendingPayoutCents,
        totalPaidOutCents,
        totalRefundsCents: 0,
        totalChargebacksCents: 0,
        totalOverdueCents: 0,
        projectionVersion: 0,
        updatedAt: new Date().toISOString()
      };
    }

    return {
      instructorId: proj.instructorId,
      availableBalanceCents: proj.settledAvailableCents,
      futureReceivablesCents: proj.futureReceivablesCents,
      totalNetSettledCents: proj.totalNetCents,
      totalGrossCents: proj.totalGrossCents,
      totalFeesCents: proj.totalPlatformFeeCents,
      pendingReleaseCents: proj.pendingReleaseCents,
      pendingPayoutCents,
      totalPaidOutCents,
      totalRefundsCents: proj.totalRefundsCents,
      totalChargebacksCents: proj.totalChargebacksCents,
      totalOverdueCents: proj.totalOverdueCents,
      projectionVersion: proj.projectionVersion,
      updatedAt: proj.updatedAt
    };
  }

  /**
   * Reads monthly financial metrics directly from payment_settlements (SSOT).
   */
  public async getMonthlyMetrics(
    supabaseClient: SupabaseClient,
    instructorId: string,
    year?: number,
    month?: number
  ): Promise<InstructorMonthlyMetricsDTO> {
    const now = new Date();
    const currentYear = year && year > 2000 ? year : now.getUTCFullYear();
    const currentMonth = month && month >= 1 && month <= 12 ? month : (now.getUTCMonth() + 1);

    const periodStart = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 0, 0, 0, 0)).toISOString();
    const periodEnd = new Date(Date.UTC(currentYear, currentMonth, 1, 0, 0, 0, 0)).toISOString();

    // Fetch all settlements (lessons, tips, refunds, chargebacks) directly from payment_settlements SSOT
    const { data } = await supabaseClient
      .from('payment_settlements')
      .select(`
        id,
        installment_id,
        appointment_id,
        settlement_type,
        gross_amount,
        net_amount,
        platform_fee,
        instructor_amount,
        settled_at,
        payment_installments (
          instructor_id,
          appointment_id
        )
      `)
      .or(`instructor_id.eq.${instructorId},payment_installments.instructor_id.eq.${instructorId}`)
      .gte('settled_at', periodStart)
      .lt('settled_at', periodEnd);

    if (!data || data.length === 0) {
      return {
        instructorId,
        year: currentYear,
        month: currentMonth,
        periodStart,
        periodEnd,
        monthlyGrossCents: 0,
        monthlyNetCents: 0,
        monthlyPlatformFeeCents: 0,
        monthlyLessonNetCents: 0,
        monthlyTipNetCents: 0,
        settlementsCount: 0,
        updatedAt: new Date().toISOString()
      };
    }

    let monthlyGrossCents = 0;
    let monthlyNetCents = 0;
    let monthlyPlatformFeeCents = 0;
    let monthlyLessonNetCents = 0;
    let monthlyTipNetCents = 0;
    let settlementsCount = 0;

    for (const item of data) {
      const isRefundOrChargeback = item.settlement_type === 'REFUND' || item.settlement_type === 'CHARGEBACK';
      const multiplier = isRefundOrChargeback ? -1 : 1;

      const gross = (item.gross_amount || 0) * multiplier;
      const net = (item.net_amount !== undefined ? item.net_amount : (item.instructor_amount || 0)) * multiplier;
      const fee = (item.platform_fee || 0) * multiplier;

      monthlyGrossCents += gross;
      monthlyNetCents += net;
      monthlyPlatformFeeCents += fee;

      const inst = item.payment_installments as any;
      const isLesson = Boolean(item.appointment_id || (inst && inst.appointment_id) || item.installment_id);
      if (isLesson) {
        monthlyLessonNetCents += net;
      } else {
        monthlyTipNetCents += net;
      }
      settlementsCount += 1;
    }

    return {
      instructorId,
      year: currentYear,
      month: currentMonth,
      periodStart,
      periodEnd,
      monthlyGrossCents,
      monthlyNetCents,
      monthlyPlatformFeeCents,
      monthlyLessonNetCents,
      monthlyTipNetCents,
      settlementsCount,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Reads instructor financial statement directly from payment_settlements (SSOT for Cash Flow Movements).
   */
  public async getStatement(
    supabaseClient: SupabaseClient,
    instructorId: string,
    options?: { limit?: number; offset?: number; status?: string }
  ): Promise<InstructorStatementEntryDTO[]> {
    const settlementsTable = supabaseClient.from('payment_settlements');
    
    if (settlementsTable && typeof settlementsTable.select === 'function') {
      let query = settlementsTable
        .select(`
          id,
          installment_id,
          instructor_id,
          student_id,
          appointment_id,
          provider_payment_id,
          settlement_type,
          gross_amount,
          net_amount,
          platform_fee,
          fee_amount,
          instructor_amount,
          settled_at,
          created_at,
          payment_installments (
            id,
            instructor_id,
            student_id,
            group_id,
            installment_number,
            total_installments,
            due_date,
            payment_date,
            status,
            profiles ( full_name )
          ),
          student_profile:profiles!payment_settlements_student_id_fkey ( full_name )
        `)
        .or(`instructor_id.eq.${instructorId},payment_installments.instructor_id.eq.${instructorId}`)
        .order('settled_at', { ascending: false });

      if (options?.status) {
        query = query.eq('payment_installments.status', options.status);
      }
      if (options?.limit) {
        query = query.limit(options.limit);
      }
      if (options?.offset) {
        query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
      }

      const { data, error } = await query;

      if (!error && data && data.length > 0) {
        const groupsMap = new Map<string, {
          id: string;
          providerPaymentId: string;
          installmentId: string;
          studentId: string;
          studentName?: string;
          grossAmountCents: number;
          netAmountCents: number;
          platformFeeCents: number;
          feeAmountCents: number;
          commissionCnhJaCents: number;
          status: string;
          dueDate: string;
          settledAt: string;
          groupId?: string;
          totalInstallments?: number;
          settlementsCount: number;
          isTip?: boolean;
        }>();

        for (const item of data) {
          const inst = item.payment_installments as any;
          const instProfile = Array.isArray(inst?.profiles) ? inst?.profiles[0] : inst?.profiles;
          const directProfile = Array.isArray((item as any).student_profile) ? (item as any).student_profile[0] : (item as any).student_profile;
          const studentName = instProfile?.full_name || directProfile?.full_name || undefined;

          const isTip = !item.installment_id;

          const isRefundOrChargeback = item.settlement_type === 'REFUND' || item.settlement_type === 'CHARGEBACK';
          const multiplier = isRefundOrChargeback ? -1 : 1;
          const netCents = (item.net_amount !== undefined ? item.net_amount : (item.instructor_amount || 0)) * multiplier;
          const grossCents = (item.gross_amount || 0) * multiplier;
          const feeCents = (item.platform_fee || 0) * multiplier;
          const gatewayFeeCents = (item.fee_amount || 0) * multiplier;
          const commissionCnhJaCents = this.calculateCommissionCnhJa(feeCents, gatewayFeeCents);

          let status = inst?.status || 'RECEIVED';
          if (item.settlement_type === 'REFUND') status = 'REFUNDED';
          if (item.settlement_type === 'CHARGEBACK') status = 'CHARGEBACK';
          if (isTip) status = 'RECEIVED';

          const groupKey = inst?.group_id || item.provider_payment_id || item.installment_id || item.id;
          const itemSettledAt = item.settled_at || item.created_at;

          if (!groupsMap.has(groupKey)) {
            groupsMap.set(groupKey, {
              id: item.id,
              providerPaymentId: item.provider_payment_id,
              installmentId: item.installment_id || inst?.id || item.id,
              studentId: item.student_id || inst?.student_id,
              studentName,
              grossAmountCents: grossCents,
              netAmountCents: netCents,
              platformFeeCents: feeCents,
              feeAmountCents: gatewayFeeCents,
              commissionCnhJaCents,
              status,
              dueDate: inst?.due_date || itemSettledAt,
              settledAt: itemSettledAt,
              groupId: inst?.group_id || undefined,
              totalInstallments: inst?.total_installments || 1,
              settlementsCount: 1,
              isTip
            });
          } else {
            const existing = groupsMap.get(groupKey)!;
            existing.grossAmountCents += grossCents;
            existing.netAmountCents += netCents;
            existing.platformFeeCents += feeCents;
            existing.feeAmountCents += gatewayFeeCents;
            existing.commissionCnhJaCents += commissionCnhJaCents;
            existing.settlementsCount += 1;

            if (status === 'CHARGEBACK') {
              existing.status = 'CHARGEBACK';
            } else if (status === 'REFUNDED' && existing.status !== 'CHARGEBACK') {
              existing.status = 'REFUNDED';
            }

            if (new Date(itemSettledAt) > new Date(existing.settledAt)) {
              existing.settledAt = itemSettledAt;
            }
          }
        }

        const aggregated: InstructorStatementEntryDTO[] = Array.from(groupsMap.values()).map(g => ({
          id: g.id,
          providerPaymentId: g.providerPaymentId,
          installmentId: g.installmentId,
          studentId: g.studentId,
          studentName: g.studentName,
          grossAmountCents: g.grossAmountCents,
          netAmountCents: g.netAmountCents,
          platformFeeCents: g.platformFeeCents,
          feeAmountCents: g.feeAmountCents,
          commissionCnhJaCents: g.commissionCnhJaCents,
          status: g.isTip ? 'TIP' : g.status,
          dueDate: g.dueDate,
          settledAt: g.settledAt,
          groupId: g.groupId,
          installmentNumber: g.settlementsCount,
          totalInstallments: g.totalInstallments,
          settlementsCount: g.settlementsCount,
          receivedInstallments: g.settlementsCount,
          lastSettlementDate: g.settledAt,
          isTip: g.isTip
        }));

        return aggregated.sort((a, b) => new Date(b.settledAt || 0).getTime() - new Date(a.settledAt || 0).getTime());
      }
    }

    // Fallback if payment_settlements query yields no records or fails (e.g. mock test environments)
    const installmentsTable = supabaseClient.from('payment_installments');
    if (!installmentsTable || typeof installmentsTable.select !== 'function') {
      return [];
    }

    let fallbackQuery = installmentsTable
      .select('id, provider_payment_id, student_id, gross_amount, net_amount, platform_fee, fee_amount, status, due_date, payment_date, profiles ( full_name )')
      .eq('instructor_id', instructorId)
      .order('due_date', { ascending: false });

    if (options?.status) {
      fallbackQuery = fallbackQuery.eq('status', options.status);
    }
    if (options?.limit) {
      fallbackQuery = fallbackQuery.limit(options.limit);
    }
    if (options?.offset) {
      fallbackQuery = fallbackQuery.range(options.offset, options.offset + (options.limit || 10) - 1);
    }

    const { data: fbData } = await fallbackQuery;
    if (!fbData || fbData.length === 0) {
      return [];
    }

    return fbData.map((item: any) => {
      const profileObj = Array.isArray(item?.profiles) ? item?.profiles[0] : item?.profiles;
      const studentName = profileObj?.full_name || undefined;

      const platformFeeCents = item.platform_fee || 0;
      const feeAmountCents = item.fee_amount || 0;
      const commissionCnhJaCents = this.calculateCommissionCnhJa(platformFeeCents, feeAmountCents);

      return {
        id: item.id,
        providerPaymentId: item.provider_payment_id,
        installmentId: item.id,
        studentId: item.student_id,
        studentName,
        grossAmountCents: item.gross_amount || 0,
        netAmountCents: item.net_amount || 0,
        platformFeeCents,
        feeAmountCents,
        commissionCnhJaCents,
        status: item.status,
        dueDate: item.due_date,
        settledAt: item.payment_date || undefined
      };
    });
  }

  /**
   * Centralized pure calculation for CNHJá commission in Read Model:
   * commissionCnhJaCents = platform_fee - fee_amount
   */
  private calculateCommissionCnhJa(platformFeeCents: number, gatewayFeeCents: number): number {
    return platformFeeCents - gatewayFeeCents;
  }

  /**
   * Reads cash flow projections directly from ProjectionService.
   */
  public async getCashFlow(
    supabaseClient: SupabaseClient,
    instructorId: string,
    startDate: string,
    endDate: string
  ): Promise<InstructorCashFlowDTO[]> {
    const records = await ProjectionService.getCashFlow(
      supabaseClient,
      'INSTRUCTOR',
      instructorId,
      startDate,
      endDate
    );

    return records.map((rec) => ({
      month: rec.projection_date,
      expectedInflowCents: rec.expected_inflow,
      settledInflowCents: rec.settled_inflow,
      netForecastCents: rec.expected_inflow - rec.expected_outflow
    }));
  }
}
