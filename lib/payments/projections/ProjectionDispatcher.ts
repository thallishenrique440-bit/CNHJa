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
   * A-8.2: cap for metadata.projection_failures, mirroring the webhook's retry_history
   * ring buffer (also 10). Beyond this the oldest entries are dropped and the most
   * recent are kept, so the JSONB column cannot grow without bound.
   */
  private static readonly PROJECTION_FAILURE_HISTORY_LIMIT = 10;

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

      // Hardening 2: persist a projection failure audit entry on the event ledger row.
      //
      // A-1: this block previously targeted `payload.eventId`, which is NOT a database id.
      // Callers set it to synthetic strings ("sched_<paymentId>", "state_tr_<paymentId>_<state>")
      // or omit it entirely, so the write either matched no row or failed casting to uuid.
      // It now uses `payload.ledgerId`, the real public.transactions row id, propagated by
      // PaymentStateService (params.ledgerId) and SettlementService (input.eventLedgerId).
      // Flows with no webhook ledger (booking confirmation, schedule creation, Edge Function
      // sync) legitimately have none: no write is attempted and the reason is logged.
      //
      // A-8.2: projection_failures is capped at PROJECTION_FAILURE_HISTORY_LIMIT entries,
      // mirroring the webhook's retry_history ring buffer, so the JSONB cannot grow without
      // bound. The most recent entries are kept.
      //
      // A-8.1 (NOT fixed here): this is a read-modify-write on a JSONB column and is not
      // atomic. Concurrent projections on the same ledger row can lose one another's entry.
      // Resolving it requires an architectural decision (jsonb_set via RPC, or a dedicated
      // audit table) and is deliberately out of scope.
      if (failures.length > 0 && payload.ledgerId) {
        const auditEntry = {
          failures,
          provider_payment_id: payload.providerPaymentId,
          event_type: payload.eventType,
          correlation_id: payload.eventId || null,
          timestamp: new Date().toISOString()
        };

        const { data: ledgerRow, error: readError } = await supabase
          .from('transactions')
          .select('metadata')
          .eq('id', payload.ledgerId)
          .maybeSingle();

        if (readError) {
          ProjectionLogger.error('ProjectionDispatcher', `Could not read ledger ${payload.ledgerId} to record projection failure: ${readError.message}`, {
            eventType: 'Projection Audit Write Failed',
            identifier: String(payload.providerPaymentId),
            metadata: { reason: readError.message }
          });
        } else if (!ledgerRow) {
          // A-8.5: no matching row. Without this branch the UPDATE below would report
          // error === null while affecting zero rows, and the failure would look persisted.
          ProjectionLogger.error('ProjectionDispatcher', `Ledger row ${payload.ledgerId} not found; projection failure not persisted.`, {
            eventType: 'Projection Audit Row Missing',
            identifier: String(payload.providerPaymentId),
            metadata: { ledgerId: payload.ledgerId }
          });
        } else {
          const existingMetadata = (ledgerRow.metadata && typeof ledgerRow.metadata === 'object')
            ? ledgerRow.metadata as Record<string, any>
            : {};
          const history = Array.isArray(existingMetadata.projection_failures)
            ? existingMetadata.projection_failures
            : [];

          // A-8.2: keep the most recent entries only.
          const cappedFailures = [...history, auditEntry].slice(-ProjectionDispatcher.PROJECTION_FAILURE_HISTORY_LIMIT);

          // Every pre-existing metadata property is preserved (retry_history included);
          // only reason_code and projection_failures are set.
          const { data: updatedRows, error: writeError } = await supabase
            .from('transactions')
            .update({
              metadata: {
                ...existingMetadata,
                reason_code: 'PROJECTION_FAILED',
                projection_failures: cappedFailures
              }
            })
            .eq('id', payload.ledgerId)
            .select('id');

          // P-1-F: the Supabase client resolves with { error } instead of throwing, so the
          // result is inspected explicitly and never discarded.
          if (writeError) {
            ProjectionLogger.error('ProjectionDispatcher', `Could not persist projection failure on ledger ${payload.ledgerId}: ${writeError.message}`, {
              eventType: 'Projection Audit Write Failed',
              identifier: String(payload.providerPaymentId),
              metadata: { reason: writeError.message }
            });
          } else if (!updatedRows || updatedRows.length === 0) {
            // A-8.5: zero rows affected is not success.
            ProjectionLogger.error('ProjectionDispatcher', `Projection failure UPDATE affected 0 rows for ledger ${payload.ledgerId}; nothing was persisted.`, {
              eventType: 'Projection Audit Zero Rows',
              identifier: String(payload.providerPaymentId),
              metadata: { ledgerId: payload.ledgerId }
            });
          }
        }
      } else if (failures.length > 0) {
        // No ledger id: expected for non-webhook flows. Logs are the only durable trace.
        ProjectionLogger.error('ProjectionDispatcher', 'Projection failures occurred without an event ledger id; audit trail limited to logs.', {
          eventType: 'Projection Audit Skipped',
          identifier: String(payload.providerPaymentId || 'UNKNOWN'),
          metadata: { failures: failures.length, reason: 'NO_LEDGER_ID' }
        });
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
