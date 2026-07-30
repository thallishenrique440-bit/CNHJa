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
  InstructorCashFlowDTO
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
    if (!proj) {
      return null;
    }

    return {
      instructorId: proj.instructorId,
      futureReceivablesCents: proj.futureReceivablesCents,
      pendingReleaseCents: proj.pendingReleaseCents,
      settledAvailableCents: proj.settledAvailableCents,
      totalGrossCents: proj.totalGrossCents,
      totalPlatformFeeCents: proj.totalPlatformFeeCents,
      totalNetCents: proj.totalNetCents,
      totalRefundsCents: proj.totalRefundsCents,
      totalChargebacksCents: proj.totalChargebacksCents,
      totalOverdueCents: proj.totalOverdueCents,
      projectionVersion: proj.projectionVersion,
      updatedAt: proj.updatedAt
    };
  }

  /**
   * Reads instructor financial statement directly from payment_installments.
   */
  public async getStatement(
    supabaseClient: SupabaseClient,
    instructorId: string,
    options?: { limit?: number; offset?: number; status?: string }
  ): Promise<InstructorStatementEntryDTO[]> {
    let query = supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, student_id, gross_amount, net_amount, platform_fee, status, due_date, payment_date')
      .eq('instructor_id', instructorId)
      .order('due_date', { ascending: false });

    if (options?.status) {
      query = query.eq('status', options.status);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
    }

    const { data, error } = await query;
    if (error || !data) {
      return [];
    }

    return data.map((item: any) => ({
      id: item.id,
      providerPaymentId: item.provider_payment_id,
      installmentId: item.id,
      studentId: item.student_id,
      grossAmountCents: item.gross_amount || 0,
      netAmountCents: item.net_amount || 0,
      platformFeeCents: item.platform_fee || 0,
      status: item.status,
      dueDate: item.due_date,
      settledAt: item.payment_date || undefined
    }));
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
