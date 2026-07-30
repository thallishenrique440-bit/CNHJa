/**
 * PayoutWorker.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Unit tests for PayoutWorker.
 * Verifies individual item processing, batch execution, fault isolation,
 * metrics aggregation, and executionStatus determination.
 */

import { PayoutWorker } from '../PayoutWorker.js';
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

async function runPayoutWorkerUnitTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutWorker Unit Tests');
  console.log('======================================================\n');

  const candidates: EligibleSettlementDTO[] = [
    {
      id: 'set_w_001',
      providerPaymentId: 'pay_001',
      instructorId: 'inst_1',
      settlementType: 'PAYMENT',
      grossAmount: 10000,
      netAmount: 9000,
      platformFee: 1000,
      instructorAmount: 9000,
      settledAt: new Date().toISOString()
    },
    {
      id: 'set_w_002',
      providerPaymentId: 'pay_002',
      instructorId: 'inst_1',
      settlementType: 'PAYMENT',
      grossAmount: 15000,
      netAmount: 13500,
      platformFee: 1500,
      instructorAmount: 13500,
      settledAt: new Date().toISOString()
    },
    {
      id: 'set_w_003',
      providerPaymentId: 'pay_003',
      instructorId: 'inst_2',
      settlementType: 'PAYMENT',
      grossAmount: 20000,
      netAmount: 18000,
      platformFee: 2000,
      instructorAmount: 18000,
      settledAt: new Date().toISOString()
    }
  ];

  // Mock Engine 1: All successful (READY)
  const mockEngineSuccess: any = {
    processSettlement: async (input: any) => {
      return {
        success: true,
        payoutKey: `payout_${input.settlement.id}`,
        status: 'READY',
        eligibility: { eligible: true }
      };
    }
  };

  const worker1 = new PayoutWorker(mockEngineSuccess);
  const batch1 = await worker1.processCandidates(candidates);

  assert(batch1.executionStatus === 'SUCCESS', 'All successful candidates produce executionStatus = SUCCESS');
  assert(batch1.totalScanned === 3, 'totalScanned is 3');
  assert(batch1.totalProcessed === 3, 'totalProcessed is 3');
  assert(batch1.totalFailed === 0, 'totalFailed is 0');
  assert(batch1.results.length === 3, 'results contains 3 items');
  assert(batch1.metrics.durationMs >= 0, 'durationMs is recorded');

  // Mock Engine 2: Fault Isolation & Partial Success (1 succeeds, 1 blocked, 1 fails with exception)
  const mockEngineMixed: any = {
    processSettlement: async (input: any) => {
      if (input.settlement.id === 'set_w_001') {
        return {
          success: true,
          payoutKey: 'payout_set_w_001',
          status: 'READY',
          eligibility: { eligible: true }
        };
      } else if (input.settlement.id === 'set_w_002') {
        return {
          success: true,
          payoutKey: 'payout_set_w_002',
          status: 'BLOCKED',
          eligibility: { eligible: false, reason: 'Ineligible' }
        };
      } else {
        throw new Error('Database connection reset during RPC call');
      }
    }
  };

  const worker2 = new PayoutWorker(mockEngineMixed);
  const batch2 = await worker2.processCandidates(candidates);

  assert(batch2.executionStatus === 'PARTIAL_SUCCESS', 'Mixed results produce executionStatus = PARTIAL_SUCCESS');
  assert(batch2.totalScanned === 3, 'totalScanned is 3');
  assert(batch2.totalProcessed === 1, 'totalProcessed is 1 (READY item)');
  assert(batch2.totalBlocked === 1, 'totalBlocked is 1 (BLOCKED item)');
  assert(batch2.totalFailed === 1, 'totalFailed is 1 (Fault isolation caught exception)');
  assert(batch2.metrics.errors.length === 1, 'metrics.errors captured 1 failed error detail');
  assert(batch2.metrics.errors[0].settlementId === 'set_w_003', 'Error logged for set_w_003');

  // Mock Engine 3: All fail -> FAILED
  const mockEngineFail: any = {
    processSettlement: async () => {
      throw new Error('Fatal engine crash');
    }
  };

  const worker3 = new PayoutWorker(mockEngineFail);
  const batch3 = await worker3.processCandidates(candidates);

  assert(batch3.executionStatus === 'FAILED', 'All failures produce executionStatus = FAILED');
  assert(batch3.totalFailed === 3, 'totalFailed is 3');
  assert(batch3.totalProcessed === 0, 'totalProcessed is 0');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runPayoutWorkerUnitTests().catch(err => {
  console.error('Fatal worker unit test error:', err);
  process.exit(1);
});
