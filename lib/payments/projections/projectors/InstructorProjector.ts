/**
 * InstructorProjector.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Projection Service)
 *
 * Responsible EXCLUSIVELY for projection of instructor finances:
 * - future_receivables
 * - pending_release
 * - settled_available
 * - total_gross
 * - total_platform_fee
 * - total_net
 * - total_refunds
 * - total_chargebacks
 * - total_overdue
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  ProjectionEventPayload,
  ProjectionOutcome,
  ProjectionResult,
  InstructorProjectionRecord,
  ProjectionSourceEventType
} from '../ProjectionTypes.js';
import { ProjectionRepository } from '../ProjectionRepository.js';
import { ProjectionLogger } from '../ProjectionLogger.js';

export class InstructorProjector {
  /**
   * Project event into instructor_financial_projections
   */
  public static async project(
    supabase: SupabaseClient,
    payload: ProjectionEventPayload
  ): Promise<ProjectionResult> {
    const instructorId = payload.instructorId;
    if (!instructorId) {
      ProjectionLogger.info('InstructorProjector', 'Event ignored: missing instructorId', {
        eventType: 'Projection Ignored',
        identifier: payload.eventId || payload.settlementId || 'UNKNOWN'
      });
      return { outcome: ProjectionOutcome.NO_OP_IGNORED_EVENT };
    }

    // 1. Fetch current projection state
    const current = await ProjectionRepository.getInstructorProjection(supabase, instructorId);

    // 2. Idempotency check against eventId or settlementId
    if (current) {
      if (
        (payload.eventId && current.last_processed_event_id === payload.eventId) ||
        (payload.settlementId && current.last_processed_settlement_id === payload.settlementId)
      ) {
        ProjectionLogger.info(
          'InstructorProjector',
          `Duplicate event ignored: eventId=${payload.eventId}, settlementId=${payload.settlementId}`,
          {
            eventType: 'Duplicate Projection',
            identifier: instructorId,
            metadata: { eventId: payload.eventId, settlementId: payload.settlementId }
          }
        );
        return {
          outcome: ProjectionOutcome.NO_OP_ALREADY_PROJECTED,
          instructorProjection: current,
          projectionVersion: current.projection_version,
          rebuildVersion: current.rebuild_version,
          lastProcessedEventId: current.last_processed_event_id,
          lastProcessedSettlementId: current.last_processed_settlement_id
        };
      }
    }

    // Initialize base projection record if absent
    const record: InstructorProjectionRecord = current
      ? { ...current }
      : {
          instructor_id: instructorId,
          future_receivables: 0,
          pending_release: 0,
          settled_available: 0,
          total_gross: 0,
          total_platform_fee: 0,
          total_net: 0,
          total_refunds: 0,
          total_chargebacks: 0,
          total_overdue: 0,
          projection_version: 0,
          last_processed_event_id: null,
          last_processed_settlement_id: null,
          rebuild_version: payload.rebuildVersion || 1
        };

    const gross = payload.grossAmount || 0;
    const net = payload.netAmount || payload.instructorAmount || 0;
    const platformFee = payload.platformFee || 0;

    // 3. Process event according to source type
    if (payload.eventType === ProjectionSourceEventType.STATE_TRANSITION) {
      const status = (payload.status || 'PENDING').toUpperCase();

      if (status === 'PENDING' || status === 'AUTHORIZED') {
        record.future_receivables += net;
      } else if (status === 'OVERDUE') {
        record.future_receivables = Math.max(0, record.future_receivables - net);
        record.total_overdue += net;
      } else if (status === 'CANCELLED' || status === 'FAILED') {
        record.future_receivables = Math.max(0, record.future_receivables - net);
      }
    } else if (payload.eventType === ProjectionSourceEventType.SETTLEMENT_EXECUTED) {
      record.future_receivables = Math.max(0, record.future_receivables - net);
      record.total_gross += gross;
      record.total_platform_fee += platformFee;
      record.total_net += net;

      // Determine release maturity based on Date object comparisons (Hardening 3)
      const releaseDateStr = payload.releaseDate || payload.settledAt || new Date().toISOString();
      const releaseTime = new Date(releaseDateStr).getTime();
      const currentTime = Date.now();

      if (releaseTime <= currentTime) {
        record.settled_available += net;
      } else {
        record.pending_release += net;
      }
    } else if (payload.eventType === ProjectionSourceEventType.SETTLEMENT_REFUND) {
      record.total_refunds += net;
      record.settled_available = Math.max(0, record.settled_available - net);
    } else if (payload.eventType === ProjectionSourceEventType.SETTLEMENT_CHARGEBACK) {
      record.total_chargebacks += net;
      record.settled_available = Math.max(0, record.settled_available - net);
    }

    // 4. Increment versioning metadata
    record.projection_version = (current?.projection_version || 0) + 1;
    if (payload.eventId) record.last_processed_event_id = payload.eventId;
    if (payload.settlementId) record.last_processed_settlement_id = payload.settlementId;
    if (payload.rebuildVersion) record.rebuild_version = payload.rebuildVersion;

    // 5. Save updated read model
    const saved = await ProjectionRepository.saveInstructorProjection(supabase, record);

    ProjectionLogger.info(
      'InstructorProjector',
      `Projection Updated: instructorId=${instructorId}, version=${saved.projection_version}`,
      {
        eventType: 'Projection Updated',
        identifier: instructorId,
        metadata: { version: saved.projection_version, rebuildVersion: saved.rebuild_version }
      }
    );

    return {
      outcome: ProjectionOutcome.PROJECTION_UPDATED,
      instructorProjection: saved,
      projectionVersion: saved.projection_version,
      rebuildVersion: saved.rebuild_version,
      lastProcessedEventId: saved.last_processed_event_id,
      lastProcessedSettlementId: saved.last_processed_settlement_id
    };
  }
}
