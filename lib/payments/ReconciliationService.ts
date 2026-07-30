/**
 * ReconciliationService.ts
 * CNHJá Financial Architecture v1.0 - Stage 9.0
 *
 * Operational Service responsible for running historical audit reconciliation.
 *
 * ABSOLUTELY READ-ONLY:
 * Performs zero DB updates, inserts, or deletes.
 * Queries financial tables and invokes IntegrityChecker.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { IntegrityChecker } from './IntegrityChecker.js';
import {
  InconsistencyType,
  RawAuditDataset,
  ReconciliationInconsistency,
  ReconciliationOptions,
  ReconciliationReport,
  ReconciliationSeverity,
  ReconciliationSeverityCounts,
  InconsistencyTypeCounts
} from './ReconciliationTypes.js';

export class ReconciliationService {
  private client?: SupabaseClient;
  private integrityChecker: IntegrityChecker;

  constructor(client?: SupabaseClient, integrityChecker?: IntegrityChecker) {
    this.client = client;
    this.integrityChecker = integrityChecker || new IntegrityChecker();
  }

  /**
   * Executes a full historical reconciliation audit.
   *
   * 1. Fetches raw data from DB (or accepts pre-loaded dataset).
   * 2. Runs IntegrityChecker.
   * 3. Calculates metrics, counts, and health score.
   * 4. Produces structured telemetry logs.
   * 5. Returns ReconciliationReport.
   */
  public async reconcile(
    options: ReconciliationOptions = {},
    presetDataset?: RawAuditDataset
  ): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const executionId = `rec_${startTime}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = new Date(startTime).toISOString();

    console.log(`[ReconciliationService][${executionId}] Audit Started at ${timestamp}`);

    // Fetch or use preset dataset
    const dataset = presetDataset || (await this.fetchAuditDataset(options));

    // Execute audit via IntegrityChecker
    const inconsistencies = this.integrityChecker.checkIntegrity(dataset);

    const completionTime = Date.now();
    const durationMs = completionTime - startTime;

    const totalAnalyzed =
      dataset.settlements.length +
      dataset.payouts.length +
      dataset.transactions.length +
      dataset.projections.length +
      dataset.installments.length;

    const totalInconsistent = inconsistencies.length;
    const totalConsistent = Math.max(0, totalAnalyzed - totalInconsistent);

    // Calculate severity counts
    const severityCounts: ReconciliationSeverityCounts = {
      INFO: 0,
      WARNING: 0,
      ERROR: 0,
      CRITICAL: 0
    };

    // Calculate inconsistency type counts
    const inconsistencyTypeCounts: InconsistencyTypeCounts = {
      [InconsistencyType.MISSING_LEDGER]: 0,
      [InconsistencyType.MISSING_PROJECTION]: 0,
      [InconsistencyType.MISSING_PAYOUT]: 0,
      [InconsistencyType.DUPLICATE_LEDGER]: 0,
      [InconsistencyType.DUPLICATE_PAYOUT]: 0,
      [InconsistencyType.DUPLICATE_PROJECTION]: 0,
      [InconsistencyType.ORPHAN_SETTLEMENT]: 0,
      [InconsistencyType.ORPHAN_LEDGER]: 0,
      [InconsistencyType.ORPHAN_PAYOUT]: 0,
      [InconsistencyType.ORPHAN_PROJECTION]: 0,
      [InconsistencyType.INSTRUCTOR_MISMATCH]: 0,
      [InconsistencyType.VALUE_MISMATCH]: 0,
      [InconsistencyType.STATUS_MISMATCH]: 0,
      [InconsistencyType.FLOW_BROKEN]: 0
    };

    for (const item of inconsistencies) {
      if (severityCounts[item.severity] !== undefined) {
        severityCounts[item.severity]++;
      }
      if (inconsistencyTypeCounts[item.type] !== undefined) {
        inconsistencyTypeCounts[item.type]++;
      }
    }

    const healthy = severityCounts.CRITICAL === 0 && severityCounts.ERROR === 0;
    const healthScorePercentage =
      totalAnalyzed > 0
        ? Math.round((totalConsistent / totalAnalyzed) * 100 * 100) / 100
        : 100;

    const summaryMessage = healthy
      ? `Audit PASSED with ${totalConsistent}/${totalAnalyzed} consistent records.`
      : `Audit DETECTED ${totalInconsistent} inconsistencies (${severityCounts.CRITICAL} Critical, ${severityCounts.ERROR} Error).`;

    console.log(
      `[ReconciliationService][${executionId}] Audit Completed in ${durationMs}ms. Analyzed: ${totalAnalyzed}, Consistent: ${totalConsistent}, Inconsistent: ${totalInconsistent}, Health: ${healthScorePercentage}%.`
    );

    return {
      executionId,
      timestamp,
      executionTime: durationMs,
      totalAnalyzed,
      totalConsistent,
      totalInconsistent,
      severityCounts,
      inconsistencyTypeCounts,
      items: inconsistencies,
      summary: {
        healthy,
        message: summaryMessage,
        healthScorePercentage
      }
    };
  }

  /**
   * READ-ONLY dataset fetcher from Supabase database tables.
   *
   * CAPACITY & VOLUMETRY TECHNICAL NOTE (Stage 9.0 Refinement 03):
   * The default limit (1,000 records per table) is structured and appropriate for the current scope.
   * For future enterprise deployments with massive historical datasets (>10,000+ records),
   * future architecture iterations should adopt cursor-based pagination (e.g. keyset pagination)
   * or batch chunking workers. Single-pass memory loading with O(1) indexing remains optimal for the current scope.
   */
  private async fetchAuditDataset(options: ReconciliationOptions): Promise<RawAuditDataset> {
    if (!this.client) {
      return {
        settlements: [],
        payouts: [],
        transactions: [],
        projections: [],
        installments: []
      };
    }

    const limit = options.limit || 1000;

    const [settlementsRes, payoutsRes, transactionsRes, projectionsRes, installmentsRes] =
      await Promise.all([
        this.client.from('payment_settlements').select('*').limit(limit),
        this.client.from('payouts').select('*').limit(limit),
        this.client.from('transactions').select('*').limit(limit),
        this.client.from('instructor_balance_projections').select('*').limit(limit),
        this.client.from('payment_installments').select('*').limit(limit)
      ]);

    // Explicit Infrastructure Error Handling (Stage 9.0 Refinement 02)
    if (settlementsRes.error) {
      throw new Error(
        `[ReconciliationService] Database infrastructure error when querying table 'payment_settlements': ${
          settlementsRes.error.message || JSON.stringify(settlementsRes.error)
        }`
      );
    }
    if (payoutsRes.error) {
      throw new Error(
        `[ReconciliationService] Database infrastructure error when querying table 'payouts': ${
          payoutsRes.error.message || JSON.stringify(payoutsRes.error)
        }`
      );
    }
    if (transactionsRes.error) {
      throw new Error(
        `[ReconciliationService] Database infrastructure error when querying table 'transactions': ${
          transactionsRes.error.message || JSON.stringify(transactionsRes.error)
        }`
      );
    }
    if (projectionsRes.error) {
      throw new Error(
        `[ReconciliationService] Database infrastructure error when querying table 'instructor_balance_projections': ${
          projectionsRes.error.message || JSON.stringify(projectionsRes.error)
        }`
      );
    }
    if (installmentsRes.error) {
      throw new Error(
        `[ReconciliationService] Database infrastructure error when querying table 'payment_installments': ${
          installmentsRes.error.message || JSON.stringify(installmentsRes.error)
        }`
      );
    }

    return {
      settlements: settlementsRes.data || [],
      payouts: payoutsRes.data || [],
      transactions: transactionsRes.data || [],
      projections: projectionsRes.data || [],
      installments: installmentsRes.data || []
    };
  }
}
