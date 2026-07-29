/**
 * EligibilityService.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 */

import { EligibilityService } from '../EligibilityService.js';
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
  console.log('🧪 EligibilityService Unit Tests');
  console.log('======================================================\n');

  const service = new EligibilityService();

  const validSettlement: EligibleSettlementDTO = {
    id: 'set_1001',
    providerPaymentId: 'pay_asaas_001',
    instructorId: 'inst_88',
    settlementType: 'PAYMENT',
    grossAmount: 10000,
    netAmount: 9000,
    platformFee: 1000,
    instructorAmount: 9000,
    settledAt: '2026-07-29T10:00:00Z',
    installmentStatus: 'PAID'
  };

  // Test 1: Valid settlement is eligible
  const res1 = service.checkEligibility(validSettlement);
  assert(res1.eligible === true, 'Valid settlement returns eligible = true');

  // Test 2: Ineligible settlementType (e.g. REFUND)
  const refundSettlement: EligibleSettlementDTO = { ...validSettlement, settlementType: 'REFUND' };
  const res2 = service.checkEligibility(refundSettlement);
  assert(res2.eligible === false && (res2.reason?.includes('settlement type') ?? false), 'REFUND settlement returns eligible = false');

  // Test 3: Zero or negative netAmount
  const zeroNetSettlement: EligibleSettlementDTO = { ...validSettlement, netAmount: 0 };
  const res3 = service.checkEligibility(zeroNetSettlement);
  assert(res3.eligible === false && (res3.reason?.includes('net amount') ?? false), 'Zero netAmount returns eligible = false');

  // Test 4: Missing settledAt timestamp
  const missingSettledAt: EligibleSettlementDTO = { ...validSettlement, settledAt: '' };
  const res4 = service.checkEligibility(missingSettledAt);
  assert(res4.eligible === false && (res4.reason?.includes('settledAt') ?? false), 'Empty settledAt returns eligible = false');

  // Test 5: Unsettled installmentStatus (e.g. PENDING)
  const pendingInstallment: EligibleSettlementDTO = { ...validSettlement, installmentStatus: 'PENDING' };
  const res5 = service.checkEligibility(pendingInstallment);
  assert(res5.eligible === false && (res5.reason?.toLowerCase().includes('installment status') ?? false), 'PENDING installmentStatus returns eligible = false');

  // Test 6: Accepted statusRECEIVED
  const receivedInstallment: EligibleSettlementDTO = { ...validSettlement, installmentStatus: 'RECEIVED' };
  const res6 = service.checkEligibility(receivedInstallment);
  assert(res6.eligible === true, 'RECEIVED installmentStatus returns eligible = true');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
