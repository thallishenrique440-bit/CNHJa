/**
 * ProjectionRepository.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Projection Service)
 *
 * OWNER OF READ MODEL TABLES:
 * - instructor_financial_projections
 * - platform_financial_projections
 * - cash_flow_projections
 *
 * STRICT CQRS READ MODEL PERSISTENCE.
 * EXCLUSIVELY USES DATABASE PERSISTENCE. NO IN-MEMORY FALLBACKS.
 * NEVER WRITES TO: payment_installments, payment_settlements, transactions, appointments.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  InstructorProjectionRecord,
  PlatformProjectionRecord,
  CashFlowProjectionRecord,
  CashFlowEntityType,
  MonthlyForecastDTO
} from './ProjectionTypes.js';
import { ProjectionPersistenceError, ProjectionOptimisticLockError } from './ProjectionErrors.js';
import { ProjectionLogger } from './ProjectionLogger.js';

export class ProjectionRepository {
  /**
   * Get instructor financial projection by instructor UUID
   */
  public static async getInstructorProjection(
    supabase: SupabaseClient,
    instructorId: string
  ): Promise<InstructorProjectionRecord | null> {
    const { data, error } = await supabase
      .from('instructor_financial_projections')
      .select('*')
      .eq('instructor_id', instructorId)
      .maybeSingle();

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed fetching instructor projection for ${instructorId}: ${error.message}`, {
        identifier: instructorId,
        metadata: { code: error.code }
      });
      throw new ProjectionPersistenceError(`Error fetching instructor projection: ${error.message}`, error);
    }

    return (data as InstructorProjectionRecord | null) || null;
  }

  /**
   * Save or update instructor projection record with atomic single-statement update & optimistic locking
   */
  public static async saveInstructorProjection(
    supabase: SupabaseClient,
    record: InstructorProjectionRecord
  ): Promise<InstructorProjectionRecord> {
    const payload = {
      instructor_id: record.instructor_id,
      future_receivables: Math.max(0, record.future_receivables),
      pending_release: Math.max(0, record.pending_release),
      settled_available: Math.max(0, record.settled_available),
      total_gross: Math.max(0, record.total_gross),
      total_platform_fee: Math.max(0, record.total_platform_fee),
      total_net: Math.max(0, record.total_net),
      total_refunds: Math.max(0, record.total_refunds),
      total_chargebacks: Math.max(0, record.total_chargebacks),
      total_overdue: Math.max(0, record.total_overdue),
      projection_version: record.projection_version,
      last_processed_event_id: record.last_processed_event_id,
      last_processed_settlement_id: record.last_processed_settlement_id,
      rebuild_version: record.rebuild_version,
      updated_at: new Date().toISOString()
    };

    // If updating an existing version (version > 1), enforce optimistic locking on projection_version
    if (record.projection_version > 1) {
      const expectedOldVersion = record.projection_version - 1;
      const { data, error } = await supabase
        .from('instructor_financial_projections')
        .update(payload)
        .eq('instructor_id', record.instructor_id)
        .eq('projection_version', expectedOldVersion)
        .select('*')
        .maybeSingle();

      if (error) {
        ProjectionLogger.error('ProjectionRepository', `Failed updating instructor projection for ${record.instructor_id}: ${error.message}`, {
          identifier: record.instructor_id,
          metadata: { code: error.code }
        });
        throw new ProjectionPersistenceError(`Failed updating instructor projection: ${error.message}`, error);
      }

      if (!data) {
        // Optimistic locking conflict: version changed concurrently
        throw new ProjectionOptimisticLockError(
          `Concurrent modification on instructor projection for ${record.instructor_id}. Expected version ${expectedOldVersion}`,
          record.instructor_id,
          expectedOldVersion
        );
      }

      return data as InstructorProjectionRecord;
    }

    // Initial insert or version 1 upsert
    const { data, error } = await supabase
      .from('instructor_financial_projections')
      .upsert(payload, { onConflict: 'instructor_id' })
      .select('*')
      .single();

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed saving instructor projection for ${record.instructor_id}: ${error.message}`, {
        identifier: record.instructor_id,
        metadata: { code: error.code }
      });
      throw new ProjectionPersistenceError(`Failed saving instructor projection: ${error.message}`, error);
    }

    return data as InstructorProjectionRecord;
  }

  /**
   * Get platform financial projection
   */
  public static async getPlatformProjection(
    supabase: SupabaseClient,
    platformKey: string = 'GLOBAL'
  ): Promise<PlatformProjectionRecord | null> {
    const { data, error } = await supabase
      .from('platform_financial_projections')
      .select('*')
      .eq('platform_key', platformKey)
      .maybeSingle();

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed fetching platform projection for ${platformKey}: ${error.message}`, {
        identifier: platformKey,
        metadata: { code: error.code }
      });
      throw new ProjectionPersistenceError(`Error fetching platform projection: ${error.message}`, error);
    }

    return (data as PlatformProjectionRecord | null) || null;
  }

  /**
   * Save or update platform projection record
   */
  public static async savePlatformProjection(
    supabase: SupabaseClient,
    record: PlatformProjectionRecord
  ): Promise<PlatformProjectionRecord> {
    const key = record.platform_key || 'GLOBAL';
    const payload = {
      platform_key: key,
      gmv: Math.max(0, record.gmv),
      total_revenue: Math.max(0, record.total_revenue),
      total_fee_collected: Math.max(0, record.total_fee_collected),
      total_instructor_payouts: Math.max(0, record.total_instructor_payouts),
      total_refunds: Math.max(0, record.total_refunds),
      total_chargebacks: Math.max(0, record.total_chargebacks),
      projection_version: record.projection_version,
      last_processed_event_id: record.last_processed_event_id,
      last_processed_settlement_id: record.last_processed_settlement_id,
      rebuild_version: record.rebuild_version,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('platform_financial_projections')
      .upsert(payload, { onConflict: 'platform_key' })
      .select('*')
      .single();

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed saving platform projection for ${key}: ${error.message}`, {
        identifier: key,
        metadata: { code: error.code }
      });
      throw new ProjectionPersistenceError(`Failed saving platform projection: ${error.message}`, error);
    }

    return data as PlatformProjectionRecord;
  }

  /**
   * Get cash flow projection entry for date
   */
  public static async getCashFlowProjection(
    supabase: SupabaseClient,
    entityType: CashFlowEntityType,
    entityId: string,
    projectionDate: string
  ): Promise<CashFlowProjectionRecord | null> {
    const { data, error } = await supabase
      .from('cash_flow_projections')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .eq('projection_date', projectionDate)
      .maybeSingle();

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed fetching cash flow projection for ${entityType}:${entityId}:${projectionDate}: ${error.message}`, {
        identifier: `${entityType}:${entityId}`,
        metadata: { code: error.code }
      });
      throw new ProjectionPersistenceError(`Error fetching cash flow projection: ${error.message}`, error);
    }

    return (data as CashFlowProjectionRecord | null) || null;
  }

  /**
   * Save or update cash flow projection record
   */
  public static async saveCashFlowProjection(
    supabase: SupabaseClient,
    record: CashFlowProjectionRecord
  ): Promise<CashFlowProjectionRecord> {
    const payload = {
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      projection_date: record.projection_date,
      expected_inflow: Math.max(0, record.expected_inflow),
      expected_outflow: Math.max(0, record.expected_outflow),
      settled_inflow: Math.max(0, record.settled_inflow),
      settled_outflow: Math.max(0, record.settled_outflow),
      projection_version: record.projection_version,
      last_processed_event_id: record.last_processed_event_id,
      last_processed_settlement_id: record.last_processed_settlement_id,
      rebuild_version: record.rebuild_version,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('cash_flow_projections')
      .upsert(payload, { onConflict: 'entity_type,entity_id,projection_date' })
      .select('*')
      .single();

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed saving cash flow projection for ${record.entity_type}:${record.entity_id}:${record.projection_date}: ${error.message}`, {
        identifier: `${record.entity_type}:${record.entity_id}`,
        metadata: { code: error.code }
      });
      throw new ProjectionPersistenceError(`Failed saving cash flow projection: ${error.message}`, error);
    }

    return data as CashFlowProjectionRecord;
  }

  /**
   * List cash flow entries for a date range
   */
  public static async listCashFlowProjections(
    supabase: SupabaseClient,
    entityType: CashFlowEntityType,
    entityId: string,
    startDate: string,
    endDate: string
  ): Promise<CashFlowProjectionRecord[]> {
    const { data, error } = await supabase
      .from('cash_flow_projections')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .gte('projection_date', startDate)
      .lte('projection_date', endDate)
      .order('projection_date', { ascending: true });

    if (error) {
      ProjectionLogger.error('ProjectionRepository', `Failed listing cash flow projections for ${entityType}:${entityId}: ${error.message}`, {
        identifier: `${entityType}:${entityId}`
      });
      throw new ProjectionPersistenceError(`Error listing cash flow projections: ${error.message}`, error);
    }

    return (data as CashFlowProjectionRecord[]) || [];
  }

  /**
   * Get aggregated monthly forecast for a specific yearMonth (YYYY-MM)
   */
  public static async getMonthlyForecast(
    supabase: SupabaseClient,
    entityType: CashFlowEntityType,
    entityId: string,
    yearMonth: string
  ): Promise<MonthlyForecastDTO> {
    const startDate = `${yearMonth}-01`;
    const endDate = `${yearMonth}-31`;

    const entries = await this.listCashFlowProjections(supabase, entityType, entityId, startDate, endDate);

    let expectedInflow = 0;
    let expectedOutflow = 0;
    let settledInflow = 0;
    let settledOutflow = 0;

    for (const item of entries) {
      expectedInflow += item.expected_inflow || 0;
      expectedOutflow += item.expected_outflow || 0;
      settledInflow += item.settled_inflow || 0;
      settledOutflow += item.settled_outflow || 0;
    }

    const netForecast = (expectedInflow + settledInflow) - (expectedOutflow + settledOutflow);

    return {
      month: yearMonth,
      entityType,
      entityId,
      expectedInflowCents: expectedInflow,
      expectedOutflowCents: expectedOutflow,
      settledInflowCents: settledInflow,
      settledOutflowCents: settledOutflow,
      netForecastCents: netForecast
    };
  }

  /**
   * Reset projections for a global rebuild replay.
   */
  public static async resetAllProjectionsForRebuild(
    supabase: SupabaseClient,
    _newRebuildVersion: number
  ): Promise<void> {
    const { error: err1 } = await supabase.from('instructor_financial_projections').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: err2 } = await supabase.from('platform_financial_projections').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: err3 } = await supabase.from('cash_flow_projections').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    if (err1 || err2 || err3) {
      const msg = err1?.message || err2?.message || err3?.message;
      ProjectionLogger.error('ProjectionRepository', `Failed resetting read models during rebuild: ${msg}`);
      throw new ProjectionPersistenceError(`Failed resetting read models during rebuild: ${msg}`);
    }
  }
}
