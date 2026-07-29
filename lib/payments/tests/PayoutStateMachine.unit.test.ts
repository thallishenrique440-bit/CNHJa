/**
 * PayoutStateMachine.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 */

import { PayoutStateMachine } from '../PayoutStateMachine.js';
import { InvalidStateTransitionException } from '../PayoutErrors.js';

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
  console.log('🧪 PayoutStateMachine Unit Tests');
  console.log('======================================================\n');

  // Test 1: Allowed initial states (null -> BLOCKED, READY, PENDING)
  assert(PayoutStateMachine.canTransition(null, 'BLOCKED'), 'Initial creation with BLOCKED is allowed');
  assert(PayoutStateMachine.canTransition(null, 'READY'), 'Initial creation with READY is allowed');
  assert(PayoutStateMachine.canTransition(null, 'PENDING'), 'Initial creation with PENDING is allowed');

  // Test 2: Forbidden initial states (null -> PAID, PROCESSING)
  assert(!PayoutStateMachine.canTransition(null, 'PAID'), 'Initial creation with PAID is forbidden');
  assert(!PayoutStateMachine.canTransition(null, 'PROCESSING'), 'Initial creation with PROCESSING is forbidden');

  // Test 3: Valid state transitions
  assert(PayoutStateMachine.canTransition('BLOCKED', 'READY'), 'BLOCKED -> READY allowed');
  assert(PayoutStateMachine.canTransition('READY', 'PROCESSING'), 'READY -> PROCESSING allowed');
  assert(PayoutStateMachine.canTransition('READY', 'CANCELLED'), 'READY -> CANCELLED allowed');
  assert(PayoutStateMachine.canTransition('PROCESSING', 'PAID'), 'PROCESSING -> PAID allowed');
  assert(PayoutStateMachine.canTransition('PROCESSING', 'FAILED'), 'PROCESSING -> FAILED allowed');
  assert(PayoutStateMachine.canTransition('FAILED', 'READY'), 'FAILED -> READY allowed');

  // Test 4: Same status transitions (metadata updates)
  assert(PayoutStateMachine.canTransition('READY', 'READY'), 'READY -> READY (self) allowed');
  assert(PayoutStateMachine.canTransition('PAID', 'PAID'), 'PAID -> PAID (self) allowed');

  // Test 5: Illegal state transitions from terminal state PAID
  let caughtTerminalPaid = false;
  try {
    PayoutStateMachine.validateTransition('PAID', 'PROCESSING');
  } catch (e: any) {
    caughtTerminalPaid = e instanceof InvalidStateTransitionException && e.message.includes('terminal state');
  }
  assert(caughtTerminalPaid, 'PAID -> PROCESSING throws InvalidStateTransitionException (terminal state)');

  // Test 6: Illegal transition BLOCKED -> PAID
  let caughtBlockedPaid = false;
  try {
    PayoutStateMachine.validateTransition('BLOCKED', 'PAID');
  } catch (e: any) {
    caughtBlockedPaid = e instanceof InvalidStateTransitionException && e.message.includes('Cannot transition');
  }
  assert(caughtBlockedPaid, 'BLOCKED -> PAID throws InvalidStateTransitionException');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
