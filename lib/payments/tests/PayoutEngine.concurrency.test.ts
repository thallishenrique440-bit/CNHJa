/**
 * PayoutEngine.concurrency.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * Concurrency & Race Condition Test (Fase 5 - Correção 5).
 * Simulates simultaneous concurrent execution of processSettlement() for the same settlement record.
 * Verifies FOR UPDATE lock behavior simulation, unique constraint handling, idempotency,
 * state machine integrity, and Event Ledger deduplication.
 */

import { PayoutEngine } from '../PayoutEngine.js';
import { EligibilityService } from '../EligibilityService.js';
import { PayoutRepository } from '../PayoutRepository.js';
import { EligibleSettlementDTO } from '../PayoutTypes.js';

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
 * Creates an in-memory database adapter simulating PostgreSQL transaction atomicity & FOR UPDATE locking.
 */
function createConcurrentDatabaseAdapter() {
  const payoutsTable: any[] = [];
  const transactionsTable: any[] = [];
  let isLocked = false;

  const mockSupabaseClient: any = {
    rpc: async (fnName: string, params: any) => {
      if (fnName !== 'record_payout_and_ledger_event') {
        return { data: null, error: { code: 'UNKNOWN_RPC', message: 'RPC not found' } };
      }

      // Simulate thread contention / queue delay under lock
      while (isLocked) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      isLocked = true;

      try {
        const netAmount = params.p_net_amount || params.p_amount || 0;
        const grossAmount = params.p_gross_amount || netAmount;
        const platformFee = params.p_platform_fee || 0;

        let existingPayout = payoutsTable.find(p => p.payout_key === params.p_payout_key);
        let payoutRecord: any;

        if (existingPayout) {
          // Concurrent request acquires lock AFTER initial creation
          existingPayout.status = params.p_status;
          existingPayout.updated_at = new Date().toISOString();
          payoutRecord = existingPayout;
        } else {
          // Initial concurrent creation
          payoutRecord = {
            id: `payout_uuid_concurrent_${Date.now()}`,
            payout_key: params.p_payout_key,
            instructor_id: params.p_instructor_id,
            settlement_id: params.p_settlement_id,
            gross_amount: grossAmount,
            platform_fee: platformFee,
            net_amount: netAmount,
            amount: netAmount,
            status: params.p_status,
            payout_mode: params.p_payout_mode || 'SHADOW',
            created_at: new Date().toISOString()
          };
          payoutsTable.push(payoutRecord);
        }

        // Ledger Event Deduplication via Idempotency Key
        let transactionId: string | null = null;
        if (params.p_ledger_event_type) {
          if (params.p_idempotency_key) {
            const existingTx = transactionsTable.find(t => t.idempotency_key === params.p_idempotency_key);
            if (existingTx) {
              transactionId = existingTx.id;
            }
          }

          if (!transactionId) {
            transactionId = `tx_uuid_concurrent_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            transactionsTable.push({
              id: transactionId,
              payout_id: payoutRecord.id,
              payout_key: params.p_payout_key,
              ledger_event_type: params.p_ledger_event_type,
              idempotency_key: params.p_idempotency_key || null,
              created_at: new Date().toISOString()
            });
          }
        }

        return {
          data: {
            success: true,
            payout_id: payoutRecord.id,
            payout_key: payoutRecord.payout_key,
            status: payoutRecord.status,
            transaction_id: transactionId
          },
          error: null
        };
      } finally {
        isLocked = false;
      }
    }
  };

  return { payoutsTable, transactionsTable, mockSupabaseClient };
}

async function runConcurrencyTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutEngine Concurrency & Race Condition Tests');
  console.log('======================================================\n');

  const { payoutsTable, transactionsTable, mockSupabaseClient } = createConcurrentDatabaseAdapter();

  const eligibilityService = new EligibilityService();
  const repository = new PayoutRepository(mockSupabaseClient);
  const engine = new PayoutEngine(eligibilityService, repository);

  const settlement: EligibleSettlementDTO = {
    id: 'set_concurrent_100',
    providerPaymentId: 'pay_asaas_concurrent_100',
    instructorId: 'inst_concurrent_50',
    settlementType: 'PAYMENT',
    grossAmount: 30000,
    netAmount: 27000,
    platformFee: 3000,
    instructorAmount: 27000,
    settledAt: new Date().toISOString(),
    installmentStatus: 'PAID'
  };

  console.log('--- Executing 2 Parallel processSettlement() Calls ---');

  // Trigger two simultaneous processing requests for the exact same settlement
  const [res1, res2] = await Promise.all([
    engine.processSettlement({ settlement }),
    engine.processSettlement({ settlement })
  ]);

  // Validation 1: Both operations succeed cleanly
  assert(res1.success === true, 'First concurrent execution succeeded');
  assert(res2.success === true, 'Second concurrent execution succeeded');

  // Validation 2: Identical deterministic payout key
  assert(res1.payoutKey === res2.payoutKey, 'Payout keys match across parallel executions');

  // Validation 3: Exactly 1 row in payouts table (No duplicate creation)
  assert(payoutsTable.length === 1, 'Database contains exactly 1 payout row (no duplicates)');

  // Validation 4: Exactly 1 transaction in Event Ledger (Idempotency key deduplication)
  assert(transactionsTable.length === 1, 'Event Ledger contains exactly 1 deduplicated transaction');

  // Validation 5: Payout status remains READY
  assert(payoutsTable[0].status === 'READY', 'Payout state maintained as READY without corruption');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runConcurrencyTests().catch(err => {
  console.error('Fatal concurrency test error:', err);
  process.exit(1);
});
