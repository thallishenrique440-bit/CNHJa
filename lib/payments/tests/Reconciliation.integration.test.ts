/**
 * Reconciliation.integration.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 9.0
 *
 * Full Integration Test:
 * ReconciliationService -> Database Query -> IntegrityChecker -> ReconciliationReport.
 *
 * Tests historical audit against database queries across the complete financial pipeline:
 * Stripe / Provider -> Payment Installment -> Settlement -> Event Ledger -> Projection -> Payout.
 */

import { ReconciliationService } from '../ReconciliationService.js';

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

/**
 * Creates mock Supabase Client loaded with database records across all financial tables.
 */
function createMockSupabaseReconciliationClient(mockDb: {
  settlements: any[];
  payouts: any[];
  transactions: any[];
  projections: any[];
  installments: any[];
}) {
  return {
    from: (table: string) => {
      let data: any[] = [];
      if (table === 'payment_settlements') data = mockDb.settlements;
      if (table === 'payouts') data = mockDb.payouts;
      if (table === 'transactions') data = mockDb.transactions;
      if (table === 'instructor_balance_projections') data = mockDb.projections;
      if (table === 'payment_installments') data = mockDb.installments;

      return {
        select: () => ({
          limit: () => Promise.resolve({ data, error: null })
        })
      };
    }
  } as any;
}

async function runReconciliationIntegrationTests() {
  console.log('\n======================================================');
  console.log('🧪 Reconciliation Integration Tests');
  console.log('======================================================\n');

  // Database mock state with 2 settled records (1 consistent, 1 inconsistent with value mismatch and missing ledger)
  const mockDbData = {
    settlements: [
      {
        id: 'set_int_001',
        installment_id: 'inst_int_001',
        instructor_id: 'inst_A',
        settlement_type: 'PAYMENT',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        settled_at: '2026-07-29T10:00:00Z'
      },
      {
        id: 'set_int_002',
        installment_id: 'inst_int_002',
        instructor_id: 'inst_B',
        settlement_type: 'PAYMENT',
        gross_amount: 20000,
        net_amount: 18000,
        platform_fee: 2000,
        settled_at: '2026-07-29T10:30:00Z'
      }
    ],
    installments: [
      { id: 'inst_int_001', instructor_id: 'inst_A' },
      { id: 'inst_int_002', instructor_id: 'inst_B' }
    ],
    payouts: [
      {
        id: 'payout_int_001',
        settlement_id: 'set_int_001',
        instructor_id: 'inst_A',
        gross_amount: 10000,
        net_amount: 9000,
        platform_fee: 1000,
        status: 'READY'
      },
      {
        id: 'payout_int_002',
        settlement_id: 'set_int_002',
        instructor_id: 'inst_B',
        gross_amount: 20000,
        net_amount: 15000, // Value mismatch! Expected 18000
        platform_fee: 2000,
        status: 'READY'
      }
    ],
    transactions: [
      { id: 'tx_int_001', settlement_id: 'set_int_001' }
      // Missing transaction for set_int_002!
    ],
    projections: [
      { id: 'proj_int_A', instructor_id: 'inst_A' },
      { id: 'proj_int_B', instructor_id: 'inst_B' }
    ]
  };

  const mockClient = createMockSupabaseReconciliationClient(mockDbData);
  const service = new ReconciliationService(mockClient);

  console.log('--- Running Full Reconciliation Audit Against DB Tables ---');
  const report = await service.reconcile();

  assert(report.totalAnalyzed === 9, 'Analyzed 9 total database records');
  assert(report.totalInconsistent > 0, 'Detected inconsistencies in database dataset');
  assert(
    report.items.some(i => i.settlementId === 'set_int_002' && i.type === 'VALUE_MISMATCH'),
    'Identified VALUE_MISMATCH for set_int_002'
  );
  assert(
    report.items.some(i => i.settlementId === 'set_int_002' && i.type === 'MISSING_LEDGER'),
    'Identified MISSING_LEDGER for set_int_002'
  );
  assert(
    !report.items.some(i => i.settlementId === 'set_int_001' && i.type === 'VALUE_MISMATCH'),
    'set_int_001 is completely consistent'
  );

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runReconciliationIntegrationTests().catch(err => {
  console.error('Fatal reconciliation integration test error:', err);
  process.exit(1);
});
