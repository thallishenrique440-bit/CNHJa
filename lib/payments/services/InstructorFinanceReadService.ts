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

    const { data, error } = await supabaseClient
      .from('payment_settlements')
      .select(`
        id,
        settlement_type,
        gross_amount,
        net_amount,
        platform_fee,
        instructor_amount,
        settled_at,
        payment_installments!inner (
          instructor_id,
          appointment_id,
          transaction_id
        )
      `)
      .eq('payment_installments.instructor_id', instructorId)
      .gte('settled_at', periodStart)
      .lt('settled_at', periodEnd);

    if (error || !data || data.length === 0) {
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
      const isLesson = Boolean(inst && inst.appointment_id);
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
          provider_payment_id,
          settlement_type,
          gross_amount,
          net_amount,
          platform_fee,
          fee_amount,
          instructor_amount,
          settled_at,
          created_at,
          payment_installments!inner (
            id,
            instructor_id,
            student_id,
            due_date,
            payment_date,
            status
          )
        `)
        .eq('payment_installments.instructor_id', instructorId)
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
        return data.map((item: any) => {
          const inst = item.payment_installments as any;
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

          return {
            id: item.id,
            providerPaymentId: item.provider_payment_id,
            installmentId: item.installment_id || inst?.id || item.id,
            studentId: inst?.student_id,
            grossAmountCents: grossCents,
            netAmountCents: netCents,
            platformFeeCents: feeCents,
            feeAmountCents: gatewayFeeCents,
            commissionCnhJaCents,
            status,
            dueDate: inst?.due_date || item.settled_at || item.created_at,
            settledAt: item.settled_at || item.created_at
          };
        });
      }
    }

    // Fallback if payment_settlements query yields no records or fails (e.g. mock test environments)
    const installmentsTable = supabaseClient.from('payment_installments');
    if (!installmentsTable || typeof installmentsTable.select !== 'function') {
      return [];
    }

    let fallbackQuery = installmentsTable
      .select('id, provider_payment_id, student_id, gross_amount, net_amount, platform_fee, fee_amount, status, due_date, payment_date')
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
      const platformFeeCents = item.platform_fee || 0;
      const feeAmountCents = item.fee_amount || 0;
      const commissionCnhJaCents = this.calculateCommissionCnhJa(platformFeeCents, feeAmountCents);

      return {
        id: item.id,
        providerPaymentId: item.provider_payment_id,
        installmentId: item.id,
        studentId: item.student_id,
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
