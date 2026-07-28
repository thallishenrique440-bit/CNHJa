/**
 * ProjectionService.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Projection Service)
 *
 * Facade & Main Entry Point for the CQRS Read Side.
 *
 * INVARIANTS:
 * - READ MODEL ONLY.
 * - NEVER updates payment_installments, payment_settlements, transactions, appointments, event_ledger.
 * - Projection failures MUST NEVER rollback or cancel PaymentState, Settlement, or Webhook workflows.
 */

import { SupabaseClient, createClient } from '@supabase/supabase-js';
import {
  ProjectionEventPayload,
  ProjectionResult,
  ProjectionOutcome,
  InstructorDashboardProjectionDTO,
  PlatformDashboardProjectionDTO,
  MonthlyForecastDTO,
  RebuildSummaryDTO,
  CashFlowEntityType,
  CashFlowProjectionRecord,
  ProjectionSourceEventType
} from './ProjectionTypes.js';
import { ProjectionRepository } from './ProjectionRepository.js';
import { ProjectionDispatcher } from './ProjectionDispatcher.js';
import { ProjectionLogger } from './ProjectionLogger.js';

export class ProjectionService {
  /**
   * Main entry point to update projections from financial events or settlements.
   */
  public static async update(
    payload: ProjectionEventPayload,
    supabaseClient?: SupabaseClient
  ): Promise<ProjectionResult> {
    const supabase = supabaseClient || this.getSupabaseClient();

    try {
      const result = await ProjectionDispatcher.dispatch(supabase, payload);

      if (result.outcome === ProjectionOutcome.PROJECTION_UPDATED) {
        ProjectionLogger.info('ProjectionService', `Projection Updated: paymentId=${payload.providerPaymentId}, eventType=${payload.eventType}`, {
          eventType: 'Projection Updated',
          identifier: payload.providerPaymentId,
          metadata: { eventType: payload.eventType }
        });
      } else if (result.outcome === ProjectionOutcome.NO_OP_ALREADY_PROJECTED) {
        ProjectionLogger.info('ProjectionService', `Duplicate Projection: paymentId=${payload.providerPaymentId} already processed`, {
          eventType: 'Duplicate Projection',
          identifier: payload.providerPaymentId
        });
      } else if (result.outcome === ProjectionOutcome.ERROR) {
        ProjectionLogger.error('ProjectionService', `Projection Failed: paymentId=${payload.providerPaymentId}, error=${result.error}`, {
          eventType: 'Projection Failed',
          identifier: payload.providerPaymentId,
          metadata: { error: result.error }
        });
      } else {
        ProjectionLogger.info('ProjectionService', `Projection Ignored: paymentId=${payload.providerPaymentId}`, {
          eventType: 'Projection Ignored',
          identifier: payload.providerPaymentId
        });
      }

      return result;
    } catch (err: any) {
      ProjectionLogger.error('ProjectionService', `Projection Failed: ${err?.message || err}`, {
        eventType: 'Projection Failed',
        identifier: payload.providerPaymentId || 'UNKNOWN',
        metadata: { error: String(err) }
      });
      return {
        outcome: ProjectionOutcome.ERROR,
        error: err?.message || String(err)
      };
    }
  }

  /**
   * O(1) direct dashboard read for Instructor Projections.
   */
  public static async getInstructorProjection(
    supabaseClient: SupabaseClient,
    instructorId: string
  ): Promise<InstructorDashboardProjectionDTO | null> {
    const rec = await ProjectionRepository.getInstructorProjection(supabaseClient, instructorId);
    if (!rec) return null;

    return {
      instructorId: rec.instructor_id,
      futureReceivablesCents: rec.future_receivables,
      pendingReleaseCents: rec.pending_release,
      settledAvailableCents: rec.settled_available,
      totalGrossCents: rec.total_gross,
      totalPlatformFeeCents: rec.total_platform_fee,
      totalNetCents: rec.total_net,
      totalRefundsCents: rec.total_refunds,
      totalChargebacksCents: rec.total_chargebacks,
      totalOverdueCents: rec.total_overdue,
      projectionVersion: rec.projection_version,
      rebuildVersion: rec.rebuild_version,
      updatedAt: rec.updated_at || new Date().toISOString()
    };
  }

  /**
   * O(1) direct dashboard read for Platform Projections.
   */
  public static async getPlatformProjection(
    supabaseClient: SupabaseClient,
    platformKey: string = 'GLOBAL'
  ): Promise<PlatformDashboardProjectionDTO | null> {
    const rec = await ProjectionRepository.getPlatformProjection(supabaseClient, platformKey);
    if (!rec) return null;

    return {
      platformKey: rec.platform_key,
      gmvCents: rec.gmv,
      totalRevenueCents: rec.total_revenue,
      totalFeeCollectedCents: rec.total_fee_collected,
      totalInstructorPayoutsCents: rec.total_instructor_payouts,
      totalRefundsCents: rec.total_refunds,
      totalChargebacksCents: rec.total_chargebacks,
      projectionVersion: rec.projection_version,
      rebuildVersion: rec.rebuild_version,
      updatedAt: rec.updated_at || new Date().toISOString()
    };
  }

  /**
   * Query cash flow projections over a date range.
   */
  public static async getCashFlow(
    supabaseClient: SupabaseClient,
    entityType: CashFlowEntityType,
    entityId: string,
    startDate: string,
    endDate: string
  ): Promise<CashFlowProjectionRecord[]> {
    return await ProjectionRepository.listCashFlowProjections(
      supabaseClient,
      entityType,
      entityId,
      startDate,
      endDate
    );
  }

  /**
   * Query aggregated monthly forecast for a specific yearMonth (YYYY-MM).
   */
  public static async getMonthlyForecast(
    supabaseClient: SupabaseClient,
    entityType: CashFlowEntityType,
    entityId: string,
    yearMonth: string
  ): Promise<MonthlyForecastDTO> {
    return await ProjectionRepository.getMonthlyForecast(
      supabaseClient,
      entityType,
      entityId,
      yearMonth
    );
  }

  /**
   * Complete Replay & Rebuild of all projections from source data.
   */
  public static async rebuildAllProjections(
    supabaseClient: SupabaseClient,
    targetRebuildVersion?: number
  ): Promise<RebuildSummaryDTO> {
    const startTime = Date.now();
    const nextRebuildVersion = targetRebuildVersion || Date.now();

    ProjectionLogger.info('ProjectionService', `Replay Started: targetVersion=${nextRebuildVersion}`, {
      eventType: 'Replay Started',
      identifier: `version_${nextRebuildVersion}`,
      metadata: { targetRebuildVersion: nextRebuildVersion }
    });

    // 1. Reset projection read model tables
    await ProjectionRepository.resetAllProjectionsForRebuild(supabaseClient, nextRebuildVersion);

    // 2. Read all installments (Source 1)
    const { data: installments } = await supabaseClient
      .from('payment_installments')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    let installmentsProcessed = 0;
    if (installments && installments.length > 0) {
      for (const inst of installments) {
        if (!inst.instructor_id) continue;
        installmentsProcessed++;

        await this.update(
          {
            eventType: ProjectionSourceEventType.STATE_TRANSITION,
            eventId: `rebuild_inst_${inst.id}`,
            providerPaymentId: inst.provider_payment_id,
            installmentId: inst.id,
            instructorId: inst.instructor_id,
            studentId: inst.student_id,
            grossAmount: inst.gross_amount || 0,
            netAmount: inst.net_amount || inst.instructor_amount || 0,
            platformFee: inst.platform_fee || 0,
            feeAmount: inst.fee_amount || 0,
            instructorAmount: inst.instructor_amount || 0,
            status: inst.status,
            dueDate: inst.due_date,
            paymentDate: inst.payment_date,
            rebuildVersion: nextRebuildVersion
          },
          supabaseClient
        );
      }
    }

    // 3. Read all settlements (Source 2)
    const { data: settlements } = await supabaseClient
      .from('payment_settlements')
      .select('*')
      .order('settled_at', { ascending: true })
      .order('id', { ascending: true });

    let settlementsProcessed = 0;
    if (settlements && settlements.length > 0) {
      for (const st of settlements) {
        settlementsProcessed++;
        const instructorId = st.instructor_id || st.metadata?.instructor_id;

        const sType = st.settlement_type === 'CHARGEBACK'
          ? ProjectionSourceEventType.SETTLEMENT_CHARGEBACK
          : st.settlement_type === 'REFUND'
          ? ProjectionSourceEventType.SETTLEMENT_REFUND
          : ProjectionSourceEventType.SETTLEMENT_EXECUTED;

        await this.update(
          {
            eventType: sType,
            settlementId: st.id,
            providerPaymentId: st.provider_payment_id,
            installmentId: st.installment_id,
            instructorId: instructorId,
            studentId: st.student_id || st.metadata?.student_id,
            grossAmount: st.gross_amount || 0,
            netAmount: st.net_amount || 0,
            platformFee: st.platform_fee || 0,
            feeAmount: st.fee_amount || 0,
            instructorAmount: st.instructor_amount || 0,
            settlementType: st.settlement_type,
            settledAt: st.settled_at,
            releaseDate: st.settled_at,
            rebuildVersion: nextRebuildVersion
          },
          supabaseClient
        );
      }
    }

    // 4. Count final projection records
    const { count: instCount } = await supabaseClient
      .from('instructor_financial_projections')
      .select('*', { count: 'exact', head: true });

    const { count: cfCount } = await supabaseClient
      .from('cash_flow_projections')
      .select('*', { count: 'exact', head: true });

    const durationMs = Date.now() - startTime;

    ProjectionLogger.info('ProjectionService', `Replay Finished: duration=${durationMs}ms, rebuildVersion=${nextRebuildVersion}`, {
      eventType: 'Replay Finished',
      identifier: `version_${nextRebuildVersion}`,
      metadata: { durationMs, rebuildVersion: nextRebuildVersion }
    });

    return {
      outcome: ProjectionOutcome.REBUILD_SUCCESS,
      rebuildVersion: nextRebuildVersion,
      totalInstallmentsProcessed: installmentsProcessed,
      totalSettlementsProcessed: settlementsProcessed,
      instructorsProjectedCount: instCount || 0,
      cashFlowEntriesCount: cfCount || 0,
      durationMs
    };
  }

  private static getSupabaseClient(): SupabaseClient {
    return createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
}
