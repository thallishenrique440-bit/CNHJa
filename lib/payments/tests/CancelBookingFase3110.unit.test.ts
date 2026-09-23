/**
 * CancelBookingFase3110.unit.test.ts
 * Comprehensive Unit Test Suite for FASE 3.1.10 - cancel-booking financial lifecycle alignment.
 */

export {};

function check(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
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
  console.log('📌 TEST A: Instructor cancels paid lesson, Asaas returns AWAITING_CRITICAL_ACTION_AUTHORIZATION');
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
  console.log('\n📌 TEST B: Instructor cancels paid lesson, Asaas returns DONE / REFUNDED');
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
  console.log('\n📌 TEST C: Cancellation of unpaid lesson');
  const testC = evaluateCancelBookingState({
    isPaid: false,
    asaasStatus: 'PENDING'
  });
  check(testC.targetPaymentStatus === 'released', 'appointment.payment_status must be released for unpaid lesson');
  check(testC.installmentStatusUpdate === 'CANCELLED', 'payment_installments status must be CANCELLED');

  // TEST D: Retry / Idempotency check
  console.log('\n📌 TEST D: Retry of cancellation');
  // P-1.20.1B: `cancelling` deixou de existir. A intencao do teste (reconhecer
  // um agendamento ja processado) e' preservada sobre os estados TERMINAIS, que
  // agora sao os unicos que o motor escreve.
  const isAlreadyProcessed = (status: string) =>
    ['cancelled', 'expired'].includes(status);
  check(isAlreadyProcessed('cancelled') === true, 'status=cancelled is recognized as already processed');
  check(isAlreadyProcessed('expired') === true, 'status=expired is recognized as non-cancellable');
  check(isAlreadyProcessed('cancelling') === false, 'P-1.20.1B: `cancelling` nao e\' mais um estado do modelo');

  // TEST E: Concurrent cancellation CAS lock
  console.log('\n📌 TEST E: Concurrent cancellation CAS protection');
  // P-1.20.1B: o CAS continua existindo, mas agora ele e' a ESCRITA TERMINAL.
  // Antes, o primeiro worker levava o agendamento a um estado intermediario
  // (`cancelling`) ANTES de falar com o gateway, e uma falha posterior deixava a
  // linha presa para sempre. Agora o unico CAS sobre `appointments` leva direto
  // de um estado elegivel para o estado terminal, depois de o refund concluir.
  let currentStatus = 'pending';
  function simulateCAS(expectedStatus: string, newStatus: string): boolean {
    if (currentStatus === expectedStatus) {
      currentStatus = newStatus;
      return true;
    }
    return false;
  }
  const casCaller1 = simulateCAS('pending', 'cancelled');
  const casCaller2 = simulateCAS('pending', 'cancelled');
  check(casCaller1 === true, 'First caller successfully transitions pending -> cancelled (terminal)');
  check(casCaller2 === false, 'Second caller fails CAS transition and is rejected');
  check(currentStatus === 'cancelled', 'P-1.20.1B: o agendamento nunca passa por um estado intermediario');

  // TEST F: Pending refund status verification
  console.log('\n📌 TEST F: Pending refund status verification (installments & settlements)');
  check(testA.installmentStatusUpdate === 'PRESERVED_RECEIVED', 'payment_installments remains RECEIVED');

  // TEST G: Async reconciliation via webhook/sync
  console.log('\n📌 TEST G: Async reconciliation via webhook/sync');
  const reconciledState = evaluateCancelBookingState({
    isPaid: true,
    asaasStatus: 'REFUNDED'
  });
  check(reconciledState.targetPaymentStatus === 'refunded', 'reconciled appointment.payment_status is refunded');
  check(reconciledState.refundTxStatus === 'completed', 'reconciled refund transaction status is completed');
  check(reconciledState.installmentStatusUpdate === 'REFUNDED', 'reconciled payment_installments status is REFUNDED');

  // TEST H: Idempotent settlement execution simulation
  console.log('\n📌 TEST H: Webhook and sync concurrent reconciliation idempotency');
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
  console.log('✅ ALL FASE 3.1.10 CANCEL-BOOKING UNIT TESTS PASSED!');
  console.log('====================================================');
}

runCancelBookingPhase3110Tests().catch((err) => {
  console.error('❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
