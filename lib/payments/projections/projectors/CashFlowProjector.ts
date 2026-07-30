/**
 * CashFlowProjector.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Projection Service)
 *
 * Responsible EXCLUSIVELY for cash flow timeline projection:
 * - expected_inflow / expected_outflow
 * - settled_inflow / settled_outflow
 * Indexed by entity (INSTRUCTOR | PLATFORM) and date (YYYY-MM-DD).
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  ProjectionEventPayload,
  ProjectionOutcome,
  ProjectionResult,
  CashFlowProjectionRecord,
  CashFlowEntityType,
  ProjectionSourceEventType
} from '../ProjectionTypes.js';
import { ProjectionRepository } from '../ProjectionRepository.js';
import { ProjectionLogger } from '../ProjectionLogger.js';

export class CashFlowProjector {
  /**
   * Project event into cash_flow_projections for both INSTRUCTOR and PLATFORM entities
   */
  public static async project(
    supabase: SupabaseClient,
    payload: ProjectionEventPayload
  ): Promise<ProjectionResult> {
    const rawDateStr = payload.releaseDate || payload.dueDate || payload.settledAt || payload.paymentDate || new Date().toISOString();
    const parsedDate = new Date(rawDateStr);
    const validDate = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    const projectionDate = validDate.toISOString().split('T')[0];

    const results: CashFlowProjectionRecord[] = [];
    let isDuplicate = true;

    let instructorId = payload.instructorId;

    if (!instructorId && payload.providerPaymentId) {
      const { data: inst } = await supabase
        .from('payment_installments')
        .select('instructor_id')
        .eq('provider_payment_id', payload.providerPaymentId)
        .limit(1)
        .maybeSingle();

      if (inst?.instructor_id) {
        instructorId = inst.instructor_id;
      } else {
        const { data: apt } = await supabase
          .from('appointments')
          .select('instructor_id')
          .eq('provider_payment_id', payload.providerPaymentId)
          .limit(1)
          .maybeSingle();
        if (apt?.instructor_id) {
          instructorId = apt.instructor_id;
        }
      }
    }

    // 1. Instructor Cash Flow
    if (instructorId) {
      const { record: instCf, updated } = await this.updateCashFlowEntry(
        supabase,
        'INSTRUCTOR',
        instructorId,
        projectionDate,
        payload
      );
      if (instCf) results.push(instCf);
      if (updated) isDuplicate = false;
    }

    // 2. Platform Cash Flow
    const { record: platCf, updated } = await this.updateCashFlowEntry(
      supabase,
      'PLATFORM',
      'GLOBAL',
      projectionDate,
      payload
    );
    if (platCf) results.push(platCf);
    if (updated) isDuplicate = false;

    const latest = results[0];

    if (isDuplicate) {
      return {
        outcome: ProjectionOutcome.NO_OP_ALREADY_PROJECTED,
        cashFlowProjection: latest,
        projectionVersion: latest?.projection_version || 1,
        rebuildVersion: latest?.rebuild_version || 1
      };
    }

    ProjectionLogger.info(
      'CashFlowProjector',
      `Cash Flow Projected for date=${projectionDate}`,
      {
        eventType: 'Projection Updated',
        identifier: projectionDate,
        metadata: { date: projectionDate }
      }
    );

    return {
      outcome: ProjectionOutcome.PROJECTION_UPDATED,
      cashFlowProjection: latest,
      projectionVersion: latest?.projection_version || 1,
      rebuildVersion: latest?.rebuild_version || 1,
      lastProcessedEventId: latest?.last_processed_event_id || payload.eventId || null,
      lastProcessedSettlementId: latest?.last_processed_settlement_id || payload.settlementId || null
    };
  }

  private static async updateCashFlowEntry(
    supabase: SupabaseClient,
    entityType: CashFlowEntityType,
    entityId: string,
    projectionDate: string,
    payload: ProjectionEventPayload
  ): Promise<{ record: CashFlowProjectionRecord | null; updated: boolean }> {
    const current = await ProjectionRepository.getCashFlowProjection(
      supabase,
      entityType,
      entityId,
      projectionDate
    );

    if (
      (payload.eventId && current?.last_processed_event_id === payload.eventId) ||
      (payload.settlementId && current?.last_processed_settlement_id === payload.settlementId)
    ) {
      ProjectionLogger.info(
        'CashFlowProjector',
        `Duplicate event ignored: eventId=${payload.eventId}, settlementId=${payload.settlementId}`,
        {
          eventType: 'Duplicate Projection',
          identifier: `${entityType}:${entityId}`,
          metadata: { eventId: payload.eventId, settlementId: payload.settlementId }
        }
      );
      return { record: current, updated: false };
    }

    const record: CashFlowProjectionRecord = current
      ? { ...current }
      : {
          entity_type: entityType,
          entity_id: entityId,
          projection_date: projectionDate,
          expected_inflow: 0,
          expected_outflow: 0,
          settled_inflow: 0,
          settled_outflow: 0,
          projection_version: 0,
          last_processed_event_id: null,
          last_processed_settlement_id: null,
          rebuild_version: payload.rebuildVersion || 1
        };

    const amount = entityType === 'INSTRUCTOR'
      ? (payload.instructorAmount || payload.netAmount || 0)
      : (payload.platformFee || payload.grossAmount || 0);

    if (
      payload.eventType === ProjectionSourceEventType.FINANCIAL_SCHEDULE_CREATED ||
      payload.eventType === ProjectionSourceEventType.STATE_TRANSITION
    ) {
      const status = (payload.status || 'PENDING').toUpperCase();
      if (status === 'PENDING' || status === 'AUTHORIZED') {
        record.expected_inflow += amount;
      }
    } else if (
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_CREATED ||
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_EXECUTED
    ) {
      record.expected_inflow = Math.max(0, record.expected_inflow - amount);
      record.settled_inflow += amount;
    } else if (
      payload.eventType === ProjectionSourceEventType.REFUND_CREATED ||
      payload.eventType === ProjectionSourceEventType.CHARGEBACK_CREATED ||
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_REFUND ||
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_CHARGEBACK
    ) {
      record.settled_outflow += amount;
    }

    record.projection_version = (current?.projection_version || 0) + 1;
    if (payload.eventId) record.last_processed_event_id = payload.eventId;
    if (payload.settlementId) record.last_processed_settlement_id = payload.settlementId;
    if (payload.rebuildVersion) record.rebuild_version = payload.rebuildVersion;

    const saved = await ProjectionRepository.saveCashFlowProjection(supabase, record);
    return { record: saved, updated: true };
  }
}
