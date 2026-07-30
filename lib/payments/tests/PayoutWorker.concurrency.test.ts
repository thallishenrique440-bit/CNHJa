/**
 * PayoutWorker.concurrency.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Concurrency Test for PayoutWorker:
 * Simulates two parallel Worker executions targeting the same settlement candidates.
 * Verifies zero duplicate payouts, zero race conditions, idempotency, payout_key reuse,
 * and state machine integrity.
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
 * Adapter simulating concurrent database operations with FOR UPDATE atomic lock behavior.
 */
function createConcurrentWorkerAdapter(settlements: any[]) {
  const payoutsTable: any[] = [];
  const transactionsTable: any[] = [];
  let isLocked = false;

  const mockSupabaseClient: any = {
    from: (table: string) => {
      if (table === 'payment_settlements') {
        return {
          select: () => ({
            eq: () => ({
              not: () => ({
                gt: () => ({
                  order: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({ data: settlements, error: null })
                    })
                  })
                })
              })
            })
          })
        };
      }
      return {};
    },

    rpc: async (fnName: string, params: any) => {
      if (fnName !== 'record_payout_and_ledger_event') {
        return { data: null, error: { code: 'UNKNOWN_RPC', message: 'RPC not found' } };
      }

      // Simulate lock acquisition delay under concurrent contention
      while (isLocked) {
        await new Promise(res => setTimeout(res, 5));
      }
      isLocked = true;

      try {
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
            id: `payout_uuid_w_conc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
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
            txId = `tx_uuid_w_conc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
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
      } finally {
        isLocked = false;
      }
    }
  };

  return { mockSupabaseClient, payoutsTable, transactionsTable };
}

async function runWorkerConcurrencyTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutWorker Concurrency Tests');
  console.log('======================================================\n');

  const settlements = [
    {
      id: 'set_conc_worker_01',
      provider_payment_id: 'pay_conc_01',
      installment_id: 'inst_c_1',
      settlement_type: 'PAYMENT',
      gross_amount: 15000,
      net_amount: 13500,
      platform_fee: 1500,
      fee_amount: 1500,
      instructor_amount: 13500,
      settled_at: '2026-07-29T09:00:00Z',
      payment_installments: {
        id: 'inst_c_1',
        appointment_id: 'app_c_1',
        instructor_id: 'inst_conc_A',
        status: 'PAID'
      }
    }
  ];

  const { mockSupabaseClient, payoutsTable, transactionsTable } = createConcurrentWorkerAdapter(settlements);

  const scanner = new EligibilityScanner(mockSupabaseClient);
  const eligibilityService = new EligibilityService();
  const repository = new PayoutRepository(mockSupabaseClient);
  const engine = new PayoutEngine(eligibilityService, repository);

  const worker1 = new PayoutWorker(engine, scanner);
  const worker2 = new PayoutWorker(engine, scanner);

  console.log('--- Executing 2 Parallel Worker.runBatch() Calls ---');

  const [res1, res2] = await Promise.all([
    worker1.runBatch(),
    worker2.runBatch()
  ]);

  assert(res1.executionStatus === 'SUCCESS', 'Worker 1 batch run succeeded');
  assert(res2.executionStatus === 'SUCCESS', 'Worker 2 batch run succeeded');

  assert(payoutsTable.length === 1, 'Exactly 1 payout record in database (no duplicates)');
  assert(transactionsTable.length === 1, 'Exactly 1 Event Ledger transaction created (deduplicated)');

  assert(payoutsTable[0].status === 'READY', 'Payout status is READY');
  assert(
    res1.results[0].payoutKey === res2.results[0].payoutKey,
    'Deterministic payout_key matches across both parallel worker runs'
  );

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runWorkerConcurrencyTests().catch(err => {
  console.error('Fatal worker concurrency test error:', err);
  process.exit(1);
});
