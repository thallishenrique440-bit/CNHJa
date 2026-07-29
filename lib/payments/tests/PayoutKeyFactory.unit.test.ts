/**
 * PayoutKeyFactory.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 */

import { PayoutKeyFactory } from '../PayoutKeyFactory.js';
import { InvalidPayoutKeyException } from '../PayoutErrors.js';

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
  console.log('🧪 PayoutKeyFactory Unit Tests');
  console.log('======================================================\n');

  // Test 1: Deterministic key generation
  const instructorId = 'inst_12345';
  const settlementId = 'set_67890';
  const key1 = PayoutKeyFactory.generateKey(instructorId, settlementId);
  const key2 = PayoutKeyFactory.generateKey(instructorId, settlementId);

  assert(key1 === 'payout_inst_inst_12345_set_set_67890', 'Generates expected key format');
  assert(key1 === key2, 'Key generation is deterministic across multiple calls');

  // Test 2: Handles whitespace trimming
  const trimmedKey = PayoutKeyFactory.generateKey(' inst_12345 ', ' set_67890 ');
  assert(trimmedKey === 'payout_inst_inst_12345_set_set_67890', 'Trims whitespace before formatting');

  // Test 3: Throws InvalidPayoutKeyException on empty instructorId
  let caughtErrorInst = false;
  try {
    PayoutKeyFactory.generateKey('', settlementId);
  } catch (e: any) {
    caughtErrorInst = e instanceof InvalidPayoutKeyException && e.message.includes('instructorId is required');
  }
  assert(caughtErrorInst, 'Throws InvalidPayoutKeyException when instructorId is empty');

  // Test 4: Throws InvalidPayoutKeyException on empty settlementId
  let caughtErrorSet = false;
  try {
    PayoutKeyFactory.generateKey(instructorId, '   ');
  } catch (e: any) {
    caughtErrorSet = e instanceof InvalidPayoutKeyException && e.message.includes('settlementId is required');
  }
  assert(caughtErrorSet, 'Throws InvalidPayoutKeyException when settlementId is empty');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
