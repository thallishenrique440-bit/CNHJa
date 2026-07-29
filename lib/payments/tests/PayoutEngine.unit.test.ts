/**
 * PayoutEngine.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
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

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutEngine Unit Tests');
  console.log('======================================================\n');

  const eligibilityService = new EligibilityService();

  const mockClient: any = {
    rpc: async (fnName: string, params: any) => {
      return {
        data: {
          success: true,
          payout_id: `payout_${Date.now()}`,
          payout_key: params.p_payout_key,
          status: params.p_status,
          transaction_id: `tx_${Date.now()}`
        },
        error: null
      };
    }
  };

  const repository = new PayoutRepository(mockClient);
  const engine = new PayoutEngine(eligibilityService, repository);

  const eligibleSettlement: EligibleSettlementDTO = {
    id: 'set_9901',
    providerPaymentId: 'pay_asaas_9901',
    instructorId: 'inst_777',
    settlementType: 'PAYMENT',
    grossAmount: 15000,
    netAmount: 13500,
    platformFee: 1500,
    instructorAmount: 13500,
    settledAt: '2026-07-29T10:00:00Z',
    installmentStatus: 'PAID'
  };

  // Test 1: Process eligible settlement -> READY
  const result1 = await engine.processSettlement({ settlement: eligibleSettlement });
  assert(result1.success === true, 'Processes eligible settlement successfully');
  assert(result1.status === 'READY', 'Status is set to READY for eligible settlement');
  assert(result1.payoutKey === 'payout_inst_inst_777_set_set_9901', 'Payout key generated deterministically');
  assert(result1.eligibility.eligible === true, 'Eligibility marked as true');

  // Test 2: Process ineligible settlement -> BLOCKED
  const ineligibleSettlement: EligibleSettlementDTO = {
    ...eligibleSettlement,
    id: 'set_9902',
    netAmount: 0 // Ineligible
  };

  const result2 = await engine.processSettlement({ settlement: ineligibleSettlement });
  assert(result2.success === true, 'Processes ineligible settlement without crashing');
  assert(result2.status === 'BLOCKED', 'Status is set to BLOCKED for ineligible settlement');
  assert(result2.eligibility.eligible === false, 'Eligibility marked as false');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
