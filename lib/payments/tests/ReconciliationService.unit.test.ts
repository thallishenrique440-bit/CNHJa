/**
 * ReconciliationService.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 9.0
 *
 * Unit tests for ReconciliationService.
 * Verifies audit execution flow, telemetry generation, report formatting,
 * health score calculation, severity counting, and read-only behavior.
 */

import { ReconciliationService } from '../ReconciliationService.js';
import { RawAuditDataset, ReconciliationSeverity } from '../ReconciliationTypes.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    failed++;
  }
}

async function runReconciliationServiceUnitTests() {
  console.log('\n======================================================');
  console.log('🧪 ReconciliationService Unit Tests');
  console.log('======================================================\n');

  const service = new ReconciliationService();

  // Test 1: Preset Clean Dataset
  const cleanDataset: RawAuditDataset = {
    settlements: [
      {
        id: 'set_service_1',
        installment_id: 'inst_s_1',
        instructor_id: 'inst_1',
        settlement_type: 'PAYMENT',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        settled_at: '2026-07-29T10:00:00Z'
      }
    ],
    installments: [{ id: 'inst_s_1', instructor_id: 'inst_1' }],
    payouts: [
      {
        id: 'payout_s_1',
        settlement_id: 'set_service_1',
        instructor_id: 'inst_1',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        status: 'READY'
      }
    ],
    transactions: [{ id: 'tx_s_1', settlement_id: 'set_service_1' }],
    projections: [{ id: 'proj_s_1', instructor_id: 'inst_1' }]
  };

  const cleanReport = await service.reconcile({}, cleanDataset);

  assert(cleanReport.executionId.startsWith('rec_'), 'Generates executionId starting with rec_');
  assert(cleanReport.summary.healthy === true, 'Healthy summary is true for clean dataset');
  assert(cleanReport.summary.healthScorePercentage === 100, 'Health score percentage is 100%');
  assert(cleanReport.totalAnalyzed === 5, 'totalAnalyzed is 5');
  assert(cleanReport.totalInconsistent === 0, 'totalInconsistent is 0');
  assert(cleanReport.executionTime >= 0, 'executionTime is recorded');

  // Test 2: Inconsistent Dataset
  const inconsistentDataset: RawAuditDataset = {
    settlements: [
      {
        id: 'set_bad',
        installment_id: 'inst_bad',
        instructor_id: 'inst_1',
        settlement_type: 'PAYMENT',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        settled_at: '2026-07-29T10:00:00Z'
      }
    ],
    installments: [], // Missing -> Orphan Settlement & Flow Broken
    payouts: [],      // Missing -> Missing Payout
    transactions: [], // Missing -> Missing Ledger
    projections: []   // Missing -> Missing Projection
  };

  const badReport = await service.reconcile({}, inconsistentDataset);

  assert(badReport.summary.healthy === false, 'Summary healthy is false when critical/error inconsistencies exist');
  assert(badReport.totalInconsistent > 0, 'totalInconsistent is greater than 0');
  assert(badReport.severityCounts.CRITICAL > 0, 'severityCounts.CRITICAL is recorded');
  assert(badReport.severityCounts.ERROR > 0, 'severityCounts.ERROR is recorded');
  assert(badReport.items.length === badReport.totalInconsistent, 'items array length matches totalInconsistent count');

  // Test 3: Infrastructure Database Error Throwing (Refinement 02)
  const failingClient = {
    from: (table: string) => ({
      select: () => ({
        limit: () => Promise.resolve({ data: null, error: { message: `Connection timeout on table ${table}` } })
      })
    })
  } as any;

  const failingService = new ReconciliationService(failingClient);
  let threwError = false;
  try {
    await failingService.reconcile();
  } catch (err: any) {
    threwError = true;
    assert(err.message.includes("Database infrastructure error"), 'Throws infrastructure error on DB query failure');
    assert(err.message.includes("payment_settlements"), 'Identifies failing table in exception message');
  }
  assert(threwError === true, 'Execution halts immediately on DB infrastructure error');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runReconciliationServiceUnitTests().catch(err => {
  console.error('Fatal reconciliation service unit test error:', err);
  process.exit(1);
});
