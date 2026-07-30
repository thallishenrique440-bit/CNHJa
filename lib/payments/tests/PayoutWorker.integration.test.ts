/**
 * PayoutWorker.integration.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Full Pipeline Integration Test:
 * EligibilityScanner -> PayoutWorker -> PayoutEngine -> PayoutRepository (PostgreSQL RPC) -> DB & Event Ledger.
 */

import { EligibilityScanner } from '../EligibilityScanner.js';
import { PayoutWorker } from '../PayoutWorker.js';
import { PayoutEngine } from '../PayoutEngine.js';
import { EligibilityService } from '../EligibilityService.js';
import { PayoutRepository } from '../PayoutRepository.js';

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
 * Creates in-memory Supabase adapter simulating payment_settlements table AND PostgreSQL RPC record_payout_and_ledger_event.
 */
function createFullPipelineAdapter(initialSettlements: any[]) {
  const settlementsTable = [...initialSettlements];
  const payoutsTable: any[] = [];
  const transactionsTable: any[] = [];

  const mockSupabaseClient: any = {
    from: (table: string) => {
      if (table === 'payment_settlements') {
        let filters: any = {};
        let orderings: any[] = [];
        let limitVal = 100;

        const qb = {
          select: () => qb,
          eq: (col: string, val: any) => { filters[col] = val; return qb; },
          not: (col: string, op: string, val: any) => { filters[`not_${col}`] = val; return qb; },
          gt: (col: string, val: any) => { filters[`gt_${col}`] = val; return qb; },
          order: (col: string, opts: any) => { orderings.push({ col, asc: opts?.ascending }); return qb; },
          limit: (val: number) => { limitVal = val; return qb; },
          then: (resolve: any) => {
            let res = settlementsTable.filter(s => {
              if (filters['settlement_type'] && s.settlement_type !== filters['settlement_type']) return false;
              if (filters['gt_net_amount'] !== undefined && s.net_amount <= filters['gt_net_amount']) return false;
              if (filters['not_settled_at'] && s.settled_at === null) return false;
              return true;
            });

            if (orderings.length > 0) {
              res.sort((a, b) => (a.settled_at < b.settled_at ? -1 : 1));
            }

            resolve({ data: res.slice(0, limitVal), error: null });
          }
        };
        return qb;
      }
      return {};
    },

    rpc: async (fnName: string, params: any) => {
      if (fnName !== 'record_payout_and_ledger_event') {
        return { data: null, error: { code: 'UNKNOWN_RPC', message: 'RPC not found' } };
      }

      const netAmount = params.p_net_amount || params.p_amount || 0;
      const grossAmount = params.p_gross_amount || netAmount;
      const platformFee = params.p_platform_fee || 0;

      let existing = payoutsTable.find(p => p.payout_key === params.p_payout_key);
      let record: any;

      if (existing) {
        existing.status = params.p_status;
        existing.updated_at = new Date().toISOString();
        record = existing;
      } else {
        record = {
          id: `payout_uuid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          payout_key: params.p_payout_key,
          instructor_id: params.p_instructor_id,
          settlement_id: params.p_settlement_id,
          gross_amount: grossAmount,
          platform_fee: platformFee,
          net_amount: netAmount,
          status: params.p_status,
          created_at: new Date().toISOString()
        };
        payoutsTable.push(record);
      }

      let txId: string | null = null;
      if (params.p_ledger_event_type) {
        if (params.p_idempotency_key) {
          const existingTx = transactionsTable.find(t => t.idempotency_key === params.p_idempotency_key);
          if (existingTx) txId = existingTx.id;
        }

        if (!txId) {
          txId = `tx_uuid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          transactionsTable.push({
            id: txId,
            payout_id: record.id,
            payout_key: params.p_payout_key,
            ledger_event_type: params.p_ledger_event_type,
            idempotency_key: params.p_idempotency_key || null
          });
        }
      }

      return {
        data: {
          success: true,
          payout_id: record.id,
          payout_key: record.payout_key,
          status: record.status,
          transaction_id: txId
        },
        error: null
      };
    }
  };

  return { mockSupabaseClient, payoutsTable, transactionsTable };
}

async function runWorkerIntegrationTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutWorker Full Pipeline Integration Tests');
  console.log('======================================================\n');

  const initialSettlements = [
    {
      id: 'set_pipe_100',
      provider_payment_id: 'pay_pipe_100',
      installment_id: 'inst_p_1',
      settlement_type: 'PAYMENT',
      gross_amount: 10000,
      net_amount: 9000,
      platform_fee: 1000,
      fee_amount: 1000,
      instructor_amount: 9000,
      settled_at: '2026-07-29T08:00:00Z',
      payment_installments: {
        id: 'inst_p_1',
        appointment_id: 'app_1',
        instructor_id: 'inst_pipe_A',
        status: 'PAID'
      }
    },
    {
      id: 'set_pipe_200',
      provider_payment_id: 'pay_pipe_200',
      installment_id: 'inst_p_2',
      settlement_type: 'PAYMENT',
      gross_amount: 25000,
      net_amount: 22500,
      platform_fee: 2500,
      fee_amount: 2500,
      instructor_amount: 22500,
      settled_at: '2026-07-29T08:30:00Z',
      payment_installments: {
        id: 'inst_p_2',
        appointment_id: 'app_2',
        instructor_id: 'inst_pipe_B',
        status: 'PAID'
      }
    }
  ];

  const { mockSupabaseClient, payoutsTable, transactionsTable } = createFullPipelineAdapter(initialSettlements);

  const scanner = new EligibilityScanner(mockSupabaseClient);
  const eligibilityService = new EligibilityService();
  const repository = new PayoutRepository(mockSupabaseClient);
  const engine = new PayoutEngine(eligibilityService, repository);
  const worker = new PayoutWorker(engine, scanner);

  console.log('--- Executing Scanner -> Worker -> Engine Batch Run ---');
  const batchResult = await worker.runBatch();

  assert(batchResult.executionStatus === 'SUCCESS', 'Pipeline batch execution returned SUCCESS');
  assert(batchResult.totalScanned === 2, 'Scanner located 2 eligible settlements');
  assert(batchResult.totalProcessed === 2, 'Worker processed 2 settlements to READY');
  assert(payoutsTable.length === 2, 'Database payouts table populated with 2 payout records');
  assert(transactionsTable.length === 2, 'Event Ledger populated with 2 transaction events');

  assert(
    payoutsTable[0].payout_key === 'payout_inst_inst_pipe_A_set_set_pipe_100',
    'Payout 1 payout_key generated deterministically'
  );
  assert(
    payoutsTable[1].payout_key === 'payout_inst_inst_pipe_B_set_set_pipe_200',
    'Payout 2 payout_key generated deterministically'
  );

  assert(
    transactionsTable[0].ledger_event_type === 'PAYOUT_SCHEDULED',
    'Event Ledger record 1 is PAYOUT_SCHEDULED'
  );
  assert(
    transactionsTable[1].ledger_event_type === 'PAYOUT_SCHEDULED',
    'Event Ledger record 2 is PAYOUT_SCHEDULED'
  );

  console.log('\n--- Idempotency Re-Run Verification ---');
  const rerunBatchResult = await worker.runBatch();

  assert(rerunBatchResult.executionStatus === 'SUCCESS', 'Re-run returns SUCCESS');
  assert(payoutsTable.length === 2, 'No duplicate payout rows created on re-run');
  assert(transactionsTable.length === 2, 'No duplicate ledger events created on re-run');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runWorkerIntegrationTests().catch(err => {
  console.error('Fatal worker integration test error:', err);
  process.exit(1);
});
