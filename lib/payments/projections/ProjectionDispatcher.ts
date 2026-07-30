/**
 * ProjectionDispatcher.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Projection Service)
 *
 * Dispatcher responsible for:
 * - Receiving events
 * - Validating context
 * - Dispatching to each specialized Projector cleanly while preserving strict isolation
 * - Guarantees projector failures do NOT cascade
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  ProjectionEventPayload,
  ProjectionOutcome,
  ProjectionResult
} from './ProjectionTypes.js';
import { InstructorProjector } from './projectors/InstructorProjector.js';
import { PlatformProjector } from './projectors/PlatformProjector.js';
import { CashFlowProjector } from './projectors/CashFlowProjector.js';
import { AnalyticsProjector } from './projectors/AnalyticsProjector.js';
import { ProjectionLogger } from './ProjectionLogger.js';

export class ProjectionDispatcher {
  /**
   * Dispatch payload to all registered projectors safely.
   */
  public static async dispatch(
    supabase: SupabaseClient,
    payload: ProjectionEventPayload
  ): Promise<ProjectionResult> {
    try {
      if (!payload || !payload.providerPaymentId) {
        ProjectionLogger.warn('ProjectionDispatcher', 'Missing providerPaymentId in event payload', {
          eventType: 'Projection Ignored',
          identifier: payload?.eventId || payload?.settlementId || 'UNKNOWN'
        });
        return {
          outcome: ProjectionOutcome.NO_OP_IGNORED_EVENT,
          error: 'Missing providerPaymentId in event payload'
        };
      }

      // Execute projectors independently with error isolation
      const [instRes, platRes, cashRes, _analyticsRes] = await Promise.allSettled([
        InstructorProjector.project(supabase, payload),
        PlatformProjector.project(supabase, payload),
        CashFlowProjector.project(supabase, payload),
        AnalyticsProjector.project(supabase, payload)
      ]);

      const inst = instRes.status === 'fulfilled' ? instRes.value : null;
      const plat = platRes.status === 'fulfilled' ? platRes.value : null;
      const cash = cashRes.status === 'fulfilled' ? cashRes.value : null;

      // Audit & Record any projector failures in Event Ledger / metadata
      const failures: string[] = [];
      if (instRes.status === 'rejected') {
        const msg = `InstructorProjector failed: ${instRes.reason?.message || instRes.reason}`;
        failures.push(msg);
        ProjectionLogger.error('ProjectionDispatcher', msg, {
          eventType: 'Projection Failed',
          identifier: payload.instructorId || 'INSTRUCTOR',
          metadata: { reason: String(instRes.reason) }
        });
      }
      if (platRes.status === 'rejected') {
        const msg = `PlatformProjector failed: ${platRes.reason?.message || platRes.reason}`;
        failures.push(msg);
        ProjectionLogger.error('ProjectionDispatcher', msg, {
          eventType: 'Projection Failed',
          identifier: 'PLATFORM',
          metadata: { reason: String(platRes.reason) }
        });
      }
      if (cashRes.status === 'rejected') {
        const msg = `CashFlowProjector failed: ${cashRes.reason?.message || cashRes.reason}`;
        failures.push(msg);
        ProjectionLogger.error('ProjectionDispatcher', msg, {
          eventType: 'Projection Failed',
          identifier: 'CASH_FLOW',
          metadata: { reason: String(cashRes.reason) }
        });
      }

      // Hardening 2: Persist failure audit log in event ledger if failures occurred
      if (failures.length > 0 && payload.providerPaymentId) {
        try {
          await supabase.from('transactions').insert({
            payment_provider_id: payload.providerPaymentId,
            event_type: 'PROJECTION_DISPATCH_FAILURE',
            payload: {
              failures,
              payload,
              timestamp: new Date().toISOString()
            },
            processing_status: 'PROJECTION_FAILED'
          });
        } catch {
          // Fallback audit log write non-blocking
        }
      }

      // Check if any projector executed an update or duplicate
      const outcomes = [inst?.outcome, plat?.outcome, cash?.outcome].filter(Boolean);
      const isUpdated = outcomes.includes(ProjectionOutcome.PROJECTION_UPDATED);
      const isDuplicate = outcomes.length > 0 && outcomes.every(o => o === ProjectionOutcome.NO_OP_ALREADY_PROJECTED);

      const finalOutcome = failures.length > 0 && !isUpdated
        ? ProjectionOutcome.ERROR
        : isUpdated
        ? ProjectionOutcome.PROJECTION_UPDATED
        : isDuplicate
        ? ProjectionOutcome.NO_OP_ALREADY_PROJECTED
        : ProjectionOutcome.NO_OP_IGNORED_EVENT;

      return {
        outcome: finalOutcome,
        instructorProjection: inst?.instructorProjection,
        platformProjection: plat?.platformProjection,
        cashFlowProjection: cash?.cashFlowProjection,
        projectionVersion: inst?.projectionVersion || plat?.projectionVersion || 1,
        rebuildVersion: payload.rebuildVersion || 1,
        lastProcessedEventId: payload.eventId || null,
        lastProcessedSettlementId: payload.settlementId || null,
        error: failures.length > 0 ? failures.join('; ') : undefined
      };


    } catch (err: any) {
      ProjectionLogger.error('ProjectionDispatcher', `Unexpected error during dispatch: ${err?.message || String(err)}`, {
        eventType: 'Dispatcher Error',
        identifier: payload?.providerPaymentId || 'UNKNOWN',
        metadata: { error: String(err) }
      });
      return {
        outcome: ProjectionOutcome.ERROR,
        error: err?.message || String(err)
      };
    }
  }
}
