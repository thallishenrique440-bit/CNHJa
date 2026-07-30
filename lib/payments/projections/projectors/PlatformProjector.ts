/**
 * PlatformProjector.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Projection Service)
 *
 * Responsible EXCLUSIVELY for platform-level financial projection:
 * - GMV (Gross Merchandise Value)
 * - total_revenue (Platform fee)
 * - total_fee_collected (Provider fee)
 * - total_instructor_payouts
 * - total_refunds
 * - total_chargebacks
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  ProjectionEventPayload,
  ProjectionOutcome,
  ProjectionResult,
  PlatformProjectionRecord,
  ProjectionSourceEventType
} from '../ProjectionTypes.js';
import { ProjectionRepository } from '../ProjectionRepository.js';
import { ProjectionLogger } from '../ProjectionLogger.js';

export class PlatformProjector {
  /**
   * Project event into platform_financial_projections
   */
  public static async project(
    supabase: SupabaseClient,
    payload: ProjectionEventPayload
  ): Promise<ProjectionResult> {
    const platformKey = 'GLOBAL';

    // 1. Fetch current platform projection
    const current = await ProjectionRepository.getPlatformProjection(supabase, platformKey);

    // 2. Idempotency check against eventId or settlementId
    if (current) {
      if (
        (payload.eventId && current.last_processed_event_id === payload.eventId) ||
        (payload.settlementId && current.last_processed_settlement_id === payload.settlementId)
      ) {
        ProjectionLogger.info(
          'PlatformProjector',
          `Duplicate event ignored: eventId=${payload.eventId}, settlementId=${payload.settlementId}`,
          {
            eventType: 'Duplicate Projection',
            identifier: platformKey,
            metadata: { eventId: payload.eventId, settlementId: payload.settlementId }
          }
        );
        return {
          outcome: ProjectionOutcome.NO_OP_ALREADY_PROJECTED,
          platformProjection: current,
          projectionVersion: current.projection_version,
          rebuildVersion: current.rebuild_version,
          lastProcessedEventId: current.last_processed_event_id,
          lastProcessedSettlementId: current.last_processed_settlement_id
        };
      }
    }

    // Initialize base projection record if absent
    const record: PlatformProjectionRecord = current
      ? { ...current }
      : {
          platform_key: platformKey,
          gmv: 0,
          total_revenue: 0,
          total_fee_collected: 0,
          total_instructor_payouts: 0,
          total_refunds: 0,
          total_chargebacks: 0,
          projection_version: 0,
          last_processed_event_id: null,
          last_processed_settlement_id: null,
          rebuild_version: payload.rebuildVersion || 1
        };

    const gross = payload.grossAmount || 0;
    const platformFee = payload.platformFee || 0;
    const providerFee = payload.feeAmount || 0;
    const netInstructor = payload.instructorAmount || payload.netAmount || 0;

    // 3. Process event according to source type
    if (
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_CREATED ||
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_EXECUTED
    ) {
      record.gmv += gross;
      record.total_revenue += platformFee;
      record.total_fee_collected += providerFee;
      record.total_instructor_payouts += netInstructor;
    } else if (
      payload.eventType === ProjectionSourceEventType.REFUND_CREATED ||
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_REFUND
    ) {
      record.total_refunds += gross;
    } else if (
      payload.eventType === ProjectionSourceEventType.CHARGEBACK_CREATED ||
      payload.eventType === ProjectionSourceEventType.SETTLEMENT_CHARGEBACK
    ) {
      record.total_chargebacks += gross;
    }

    // 4. Increment versioning metadata
    record.projection_version = (current?.projection_version || 0) + 1;
    if (payload.eventId) record.last_processed_event_id = payload.eventId;
    if (payload.settlementId) record.last_processed_settlement_id = payload.settlementId;
    if (payload.rebuildVersion) record.rebuild_version = payload.rebuildVersion;

    // 5. Save updated read model
    const saved = await ProjectionRepository.savePlatformProjection(supabase, record);

    ProjectionLogger.info(
      'PlatformProjector',
      `Projection Updated: platformKey=${platformKey}, version=${saved.projection_version}`,
      {
        eventType: 'Projection Updated',
        identifier: platformKey,
        metadata: { version: saved.projection_version, rebuildVersion: saved.rebuild_version }
      }
    );

    return {
      outcome: ProjectionOutcome.PROJECTION_UPDATED,
      platformProjection: saved,
      projectionVersion: saved.projection_version,
      rebuildVersion: saved.rebuild_version,
      lastProcessedEventId: saved.last_processed_event_id,
      lastProcessedSettlementId: saved.last_processed_settlement_id
    };
  }
}
