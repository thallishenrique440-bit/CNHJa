/**
 * PayoutRepository.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 */

import { PayoutRepository } from '../PayoutRepository.js';
import { RecordPayoutPayloadDTO } from '../PayoutTypes.js';

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

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutRepository Unit Tests');
  console.log('======================================================\n');

  // Test 1: Mocks RPC response on success
  const mockSuccessClient: any = {
    rpc: async (fnName: string, params: any) => {
      if (fnName === 'record_payout_and_ledger_event') {
        return {
          data: {
            success: true,
            payout_id: 'payout_uuid_123',
            payout_key: params.p_payout_key,
            status: params.p_status,
            transaction_id: 'tx_uuid_456'
          },
          error: null
        };
      }
      return { data: null, error: { message: 'Unknown RPC' } };
    }
  };

  const repoSuccess = new PayoutRepository(mockSuccessClient);
  const payload: RecordPayoutPayloadDTO = {
    payoutKey: 'payout_inst_inst1_set_set1',
    instructorId: 'inst1',
    settlementId: 'set1',
    grossAmount: 10000,
    platformFee: 1000,
    netAmount: 9000,
    amount: 9000,
    status: 'READY',
    payoutMode: 'SHADOW',
    ledgerEventType: 'PAYOUT_SCHEDULED',
    idempotencyKey: 'evt_idempotency_123'
  };

  const res1 = await repoSuccess.recordPayoutAndLedgerEvent(payload);
  assert(res1.success === true, 'Repository returns success: true from RPC');
  assert(res1.payout_id === 'payout_uuid_123', 'Returns payout_id');
  assert(res1.transaction_id === 'tx_uuid_456', 'Returns transaction_id');

  // Test 2: Mocks RPC error handling
  const mockErrorClient: any = {
    rpc: async () => {
      return {
        data: null,
        error: { code: 'INVALID_AMOUNT', message: 'Net amount must be greater than zero' }
      };
    }
  };

  const repoError = new PayoutRepository(mockErrorClient);
  const res2 = await repoError.recordPayoutAndLedgerEvent(payload);
  assert(res2.success === false, 'Repository returns success: false on RPC error');
  assert(res2.error === 'INVALID_AMOUNT', 'Extracts error code from RPC error');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
