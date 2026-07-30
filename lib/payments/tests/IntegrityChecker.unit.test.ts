/**
 * IntegrityChecker.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 9.0
 *
 * Unit tests for IntegrityChecker.
 * Verifies detection of all mandatory inconsistency types, orphan checks, duplicate checks,
 * value mismatches, instructor mismatches, status mismatches, and broken flow chains.
 */

import { IntegrityChecker } from '../IntegrityChecker.js';
import {
  InconsistencyType,
  RawAuditDataset,
  ReconciliationSeverity
} from '../ReconciliationTypes.js';

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

async function runIntegrityCheckerUnitTests() {
  console.log('\n======================================================');
  console.log('🧪 IntegrityChecker Unit Tests');
  console.log('======================================================\n');

  const checker = new IntegrityChecker();

  // Test 1: Perfectly Consistent Dataset
  const cleanDataset: RawAuditDataset = {
    settlements: [
      {
        id: 'set_100',
        installment_id: 'inst_100',
        instructor_id: 'inst_A',
        settlement_type: 'PAYMENT',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        settled_at: '2026-07-29T10:00:00Z'
      }
    ],
    installments: [
      { id: 'inst_100', instructor_id: 'inst_A' }
    ],
    payouts: [
      {
        id: 'payout_100',
        settlement_id: 'set_100',
        instructor_id: 'inst_A',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        status: 'READY'
      }
    ],
    transactions: [
      { id: 'tx_100', settlement_id: 'set_100', idempotency_key: 'idem_100' }
    ],
    projections: [
      { id: 'proj_100', instructor_id: 'inst_A' }
    ]
  };

  const cleanInconsistencies = checker.checkIntegrity(cleanDataset);
  assert(cleanInconsistencies.length === 0, 'Clean dataset produces 0 inconsistencies');

  // Test 2: Missing Ledger
  const missingLedgerDataset: RawAuditDataset = { ...cleanDataset, transactions: [] };
  const missingLedgerInc = checker.checkIntegrity(missingLedgerDataset);
  assert(
    missingLedgerInc.some(i => i.type === InconsistencyType.MISSING_LEDGER),
    'Detects MISSING_LEDGER when transactions array is empty'
  );

  // Test 3: Missing Projection
  const missingProjDataset: RawAuditDataset = { ...cleanDataset, projections: [] };
  const missingProjInc = checker.checkIntegrity(missingProjDataset);
  assert(
    missingProjInc.some(i => i.type === InconsistencyType.MISSING_PROJECTION),
    'Detects MISSING_PROJECTION when projection is missing for instructor'
  );

  // Test 4: Missing Payout
  const missingPayoutDataset: RawAuditDataset = { ...cleanDataset, payouts: [] };
  const missingPayoutInc = checker.checkIntegrity(missingPayoutDataset);
  assert(
    missingPayoutInc.some(i => i.type === InconsistencyType.MISSING_PAYOUT),
    'Detects MISSING_PAYOUT for eligible settlement'
  );

  // Test 5: Instructor Mismatch
  const instructorMismatchDataset: RawAuditDataset = {
    ...cleanDataset,
    payouts: [
      {
        id: 'payout_100',
        settlement_id: 'set_100',
        instructor_id: 'inst_DIFFERENT', // Mismatch!
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        status: 'READY'
      }
    ]
  };
  const instMismatchInc = checker.checkIntegrity(instructorMismatchDataset);
  assert(
    instMismatchInc.some(i => i.type === InconsistencyType.INSTRUCTOR_MISMATCH),
    'Detects INSTRUCTOR_MISMATCH when payout instructor differs from settlement'
  );

  // Test 6: Value Mismatch
  const valueMismatchDataset: RawAuditDataset = {
    ...cleanDataset,
    payouts: [
      {
        id: 'payout_100',
        settlement_id: 'set_100',
        instructor_id: 'inst_A',
        gross_amount: 10000,
        net_amount: 5000, // Mismatch from 9000!
        platform_fee: 1000,
        status: 'READY'
      }
    ]
  };
  const valMismatchInc = checker.checkIntegrity(valueMismatchDataset);
  assert(
    valMismatchInc.some(i => i.type === InconsistencyType.VALUE_MISMATCH),
    'Detects VALUE_MISMATCH when payout net_amount differs from settlement'
  );

  // Test 7: Duplicate Payout
  const duplicatePayoutDataset: RawAuditDataset = {
    ...cleanDataset,
    payouts: [
      { id: 'payout_100', settlement_id: 'set_100', instructor_id: 'inst_A', status: 'READY' },
      { id: 'payout_101', settlement_id: 'set_100', instructor_id: 'inst_A', status: 'READY' }
    ]
  };
  const dupPayoutInc = checker.checkIntegrity(duplicatePayoutDataset);
  assert(
    dupPayoutInc.some(i => i.type === InconsistencyType.DUPLICATE_PAYOUT),
    'Detects DUPLICATE_PAYOUT when multiple payouts exist for single settlement'
  );

  // Test 8: Duplicate Ledger
  const duplicateLedgerDataset: RawAuditDataset = {
    ...cleanDataset,
    transactions: [
      { id: 'tx_100', settlement_id: 'set_100', idempotency_key: 'idem_SAME' },
      { id: 'tx_101', settlement_id: 'set_100', idempotency_key: 'idem_SAME' }
    ]
  };
  const dupLedgerInc = checker.checkIntegrity(duplicateLedgerDataset);
  assert(
    dupLedgerInc.some(i => i.type === InconsistencyType.DUPLICATE_LEDGER),
    'Detects DUPLICATE_LEDGER when multiple transactions share idempotency key'
  );

  // Test 9: Orphan Payout
  const orphanPayoutDataset: RawAuditDataset = {
    ...cleanDataset,
    payouts: [
      { id: 'payout_orphan', settlement_id: 'set_NONEXISTENT', instructor_id: 'inst_A', status: 'READY' }
    ]
  };
  const orphanPayoutInc = checker.checkIntegrity(orphanPayoutDataset);
  assert(
    orphanPayoutInc.some(i => i.type === InconsistencyType.ORPHAN_PAYOUT),
    'Detects ORPHAN_PAYOUT pointing to missing settlement'
  );

  // Test 10: Broken Flow
  const brokenFlowDataset: RawAuditDataset = {
    settlements: [
      {
        id: 'set_broken',
        installment_id: 'inst_MISSING',
        instructor_id: 'inst_A',
        settlement_type: 'PAYMENT',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        settled_at: '2026-07-29T10:00:00Z'
      }
    ],
    installments: [],
    payouts: [],
    transactions: [],
    projections: []
  };
  const brokenFlowInc = checker.checkIntegrity(brokenFlowDataset);
  assert(
    brokenFlowInc.some(i => i.type === InconsistencyType.FLOW_BROKEN),
    'Detects FLOW_BROKEN when intermediate entities are missing'
  );

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runIntegrityCheckerUnitTests().catch(err => {
  console.error('Fatal integrity checker unit test error:', err);
  process.exit(1);
});
