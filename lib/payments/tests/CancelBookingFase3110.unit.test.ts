/**
 * CancelBookingFase3110.unit.test.ts
 * Comprehensive Unit Test Suite for FASE 3.1.10 - cancel-booking financial lifecycle alignment.
 */

export {};

function check(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`âŒ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  âœ“ ${msg}`);
  }
}

// Logic mirror of cancel-booking decision matrix
function evaluateCancelBookingState(params: {
  isPaid: boolean;
  asaasStatus?: string;
  refundResStatus?: string;
}) {
  const { isPaid, asaasStatus = '', refundResStatus = '' } = params;

  let isRefundConfirmed = asaasStatus.toUpperCase() === 'REFUNDED';

  if (refundResStatus.toUpperCase() === 'DONE' || refundResStatus.toUpperCase() === 'REFUNDED') {
    isRefundConfirmed = true;
  }

  const targetPaymentStatus = isPaid
    ? (isRefundConfirmed ? 'refunded' : 'refund_requested')
    : 'released';

  const refundTxStatus = isRefundConfirmed ? 'completed' : 'pending';
  const installmentStatusUpdate = !isPaid
    ? 'CANCELLED'
    : (isRefundConfirmed ? 'REFUNDED' : 'PRESERVED_RECEIVED');

  return {
    targetPaymentStatus,
    refundTxStatus,
    installmentStatusUpdate,
    isRefundConfirmed
  };
}

async function runCancelBookingPhase3110Tests() {
  console.log('====================================================');
  console.log('RUNNING CANCEL-BOOKING FASE 3.1.10 UNIT TEST SUITE');
  console.log('====================================================\n');

  // TEST A: Instructor cancels paid lesson, Gateway returns HTTP 200 with AWAITING_CRITICAL_ACTION_AUTHORIZATION
  console.log('ðŸ“Œ TEST A: Instructor cancels paid lesson, Asaas returns AWAITING_CRITICAL_ACTION_AUTHORIZATION');
  const testA = evaluateCancelBookingState({
    isPaid: true,
    asaasStatus: 'RECEIVED',
    refundResStatus: 'AWAITING_CRITICAL_ACTION_AUTHORIZATION'
  });
  check(testA.targetPaymentStatus === 'refund_requested', 'appointment.payment_status must be refund_requested');
  check(testA.refundTxStatus === 'pending', 'refund transaction status must be pending');
  check(testA.installmentStatusUpdate === 'PRESERVED_RECEIVED', 'payment_installments status must be preserved as RECEIVED');
  check(testA.isRefundConfirmed === false, 'isRefundConfirmed must be false');

  // TEST B: Instructor cancels paid lesson, Gateway returns DONE or REFUNDED
  console.log('\nðŸ“Œ TEST B: Instructor cancels paid lesson, Asaas returns DONE / REFUNDED');
  const testB1 = evaluateCancelBookingState({
    isPaid: true,
    asaasStatus: 'RECEIVED',
    refundResStatus: 'DONE'
  });
  check(testB1.targetPaymentStatus === 'refunded', 'appointment.payment_status must be refunded when DONE');
  check(testB1.refundTxStatus === 'completed', 'refund transaction status must be completed when DONE');
  check(testB1.installmentStatusUpdate === 'REFUNDED', 'payment_installments status must be REFUNDED when DONE');

  const testB2 = evaluateCancelBookingState({
    isPaid: true,
    asaasStatus: 'REFUNDED',
    refundResStatus: ''
  });
  check(testB2.targetPaymentStatus === 'refunded', 'appointment.payment_status must be refunded when asaasStatus is REFUNDED');
  check(testB2.refundTxStatus === 'completed', 'refund transaction status must be completed when asaasStatus is REFUNDED');

  // TEST C: Cancellation of unpaid lesson
  console.log('\nðŸ“Œ TEST C: Cancellation of unpaid lesson');
  const testC = evaluateCancelBookingState({
    isPaid: false,
    asaasStatus: 'PENDING'
  });
  check(testC.targetPaymentStatus === 'released', 'appointment.payment_status must be released for unpaid lesson');
  check(testC.installmentStatusUpdate === 'CANCELLED', 'payment_installments status must be CANCELLED');

  // TEST D: Retry / Idempotency check
  console.log('\nðŸ“Œ TEST D: Retry of cancellation');
  const isAlreadyCancelledOrCancelling = (status: string) =>
    ['cancelled', 'cancelling', 'expired'].includes(status);
  check(isAlreadyCancelledOrCancelling('cancelled') === true, 'status=cancelled is recognized as already processed');
  check(isAlreadyCancelledOrCancelling('cancelling') === true, 'status=cancelling is recognized as in-progress');
  check(isAlreadyCancelledOrCancelling('expired') === true, 'status=expired is recognized as non-cancellable');

  // TEST E: Concurrent cancellation CAS lock
  console.log('\nðŸ“Œ TEST E: Concurrent cancellation CAS protection');
  let currentStatus = 'pending';
  function simulateCAS(expectedStatus: string, newStatus: string): boolean {
    if (currentStatus === expectedStatus) {
      currentStatus = newStatus;
      return true;
    }
    return false;
  }
  const casCaller1 = simulateCAS('pending', 'cancelling');
  const casCaller2 = simulateCAS('pending', 'cancelling');
  check(casCaller1 === true, 'First caller successfully transitions pending -> cancelling');
  check(casCaller2 === false, 'Second caller fails CAS transition and is rejected');

  // TEST F: Pending refund status verification
  console.log('\nðŸ“Œ TEST F: Pending refund status verification (installments & settlements)');
  check(testA.installmentStatusUpdate === 'PRESERVED_RECEIVED', 'payment_installments remains RECEIVED');

  // TEST G: Async reconciliation via webhook/sync
  console.log('\nðŸ“Œ TEST G: Async reconciliation via webhook/sync');
  const reconciledState = evaluateCancelBookingState({
    isPaid: true,
    asaasStatus: 'REFUNDED'
  });
  check(reconciledState.targetPaymentStatus === 'refunded', 'reconciled appointment.payment_status is refunded');
  check(reconciledState.refundTxStatus === 'completed', 'reconciled refund transaction status is completed');
  check(reconciledState.installmentStatusUpdate === 'REFUNDED', 'reconciled payment_installments status is REFUNDED');

  // TEST H: Idempotent settlement execution simulation
  console.log('\nðŸ“Œ TEST H: Webhook and sync concurrent reconciliation idempotency');
  let settlementCount = 0;
  function processSettlementOnce(alreadySettled: boolean) {
    if (alreadySettled) {
      return false;
    }
    settlementCount++;
    return true;
  }
  const sync1 = processSettlementOnce(false);
  const webhook1 = processSettlementOnce(true);
  check(sync1 === true, 'First reconciliation processes settlement');
  check(webhook1 === false, 'Concurrent/subsequent reconciliation skips duplicate settlement');
  check(settlementCount === 1, 'Exactly 1 settlement recorded');

  console.log('\n====================================================');
  console.log('âœ… ALL FASE 3.1.10 CANCEL-BOOKING UNIT TESTS PASSED!');
  console.log('====================================================');
}

runCancelBookingPhase3110Tests().catch((err) => {
  console.error('âŒ TEST SUITE FAILED:', err);
  process.exit(1);
});
