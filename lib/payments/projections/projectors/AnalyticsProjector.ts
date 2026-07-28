/**
 * AnalyticsProjector.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7 - Projection Service)
 *
 * Prepared structure for future advanced analytics, metrics, cohorts, and ML insights.
 * Structural skeleton adhering to CQRS non-breaking evolution rules.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { ProjectionEventPayload, ProjectionOutcome, ProjectionResult } from '../ProjectionTypes.js';

export class AnalyticsProjector {
  /**
   * Prepared projection entrypoint for future analytics dimensions.
   */
  public static async project(
    _supabase: SupabaseClient,
    payload: ProjectionEventPayload
  ): Promise<ProjectionResult> {
    // Structure ready for future expansion
    return {
      outcome: ProjectionOutcome.NO_OP_IGNORED_EVENT,
      lastProcessedEventId: payload.eventId || null,
      lastProcessedSettlementId: payload.settlementId || null
    };
  }
}
