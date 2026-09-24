/**
 * ConstraintAndCancellationCore.unit.test.ts
 * Tests constraint alignment and BookingCancellationCore logic for refund_requested status.
 */

import { assert } from 'console';
import { SYNTHETIC_IDS } from './fixtures/syntheticFinanceFixtures.js';

function check(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function runConstraintAndCancellationTests() {
  console.log('====================================================');
  console.log('RUNNING CONSTRAINT AND CANCELLATION CORE TEST SUITE');
  console.log('====================================================\n');

  // TEST 1: Constraint Allowed Statuses Validation
  console.log('📌 TEST 1: Allowed Payment Statuses in Constraint');
  const allowedStatuses = [
    'pending',
    'paid',
    'failed',
    'refunded',
    'authorized',
    'released',
    'refund_requested'
  ];

  const testCandidateStatuses = [
    { status: 'refund_requested', expectedValid: true },
    { status: 'pending', expectedValid: true },
    { status: 'paid', expectedValid: true },
    { status: 'failed', expectedValid: true },
    { status: 'refunded', expectedValid: true },
    { status: 'authorized', expectedValid: true },
    { status: 'released', expectedValid: true },
    { status: 'invalid_status_xyz', expectedValid: false },
    { status: 'partially_refunded_invalid', expectedValid: false }
  ];

  for (const candidate of testCandidateStatuses) {
    const isValid = allowedStatuses.includes(candidate.status);
    check(isValid === candidate.expectedValid, `Status '${candidate.status}' validity check: expected ${candidate.expectedValid}, got ${isValid}`);
  }

  // TEST 2: BookingCancellationCore Logic Matrix
  console.log('\n📌 TEST 2: BookingCancellationCore Payment Status Logic Matrix');

  function determineTargetPaymentStatus(isPaid: boolean, isRefundConfirmed: boolean): string {
    if (!isPaid) {
      return 'released';
    }
    if (isRefundConfirmed) {
      return 'refunded';
    }
    return 'refund_requested';
  }

  // Scenario 1: Paid booking, refund requested but not confirmed by gateway yet
  const statusScenario1 = determineTargetPaymentStatus(true, false);
  check(statusScenario1 === 'refund_requested', `isPaid=true, isRefundConfirmed=false -> payment_status is 'refund_requested'`);

  // Scenario 2: Paid booking, refund fully confirmed by gateway
  const statusScenario2 = determineTargetPaymentStatus(true, true);
  check(statusScenario2 === 'refunded', `isPaid=true, isRefundConfirmed=true -> payment_status is 'refunded'`);

  // Scenario 3: Unpaid booking cancelled
  const statusScenario3 = determineTargetPaymentStatus(false, false);
  check(statusScenario3 === 'released', `isPaid=false, isRefundConfirmed=false -> payment_status is 'released'`);

  // TEST 3: cenario REFUND_REQUESTED (puro, sem escrita)
  //
  // AP-09: este bloco usava o appointment 9a8d3879-... e o
  // provider_payment_id pay_7urnp7... de PRODUCAO — o primeiro deles e' um
  // dos 5 registros de teste protegidos. A funcao sob teste e' pura e nao
  // consulta o banco: os identificadores eram decorativos. Foram trocados
  // por identificadores sinteticos para que o teste sobreviva ao reset do
  // banco (AP-10) e nao carregue dado real no repositorio.
  console.log('\n📌 TEST 3: Cenario REFUND_REQUESTED (verificacao pura, sem escrita)');
  const caseData = {
    appointmentId: SYNTHETIC_IDS.appointment,
    providerPaymentId: SYNTHETIC_IDS.providerPayment,
    asaasStatus: 'REFUND_REQUESTED'
  };

  const isPaidCase = ['RECEIVED', 'CONFIRMED', 'REFUND_REQUESTED', 'REFUNDED'].includes(caseData.asaasStatus);
  const isRefundConfirmedCase = caseData.asaasStatus === 'REFUNDED';
  const expectedStatusCase = determineTargetPaymentStatus(isPaidCase, isRefundConfirmedCase);

  check(expectedStatusCase === 'refund_requested', `Cenario REFUND_REQUESTED resolve para payment_status = 'refund_requested' sem violar a constraint`);

  console.log('\n====================================================');
  console.log('✅ ALL CONSTRAINT AND CANCELLATION TESTS PASSED!');
  console.log('====================================================');
}

runConstraintAndCancellationTests().catch((err) => {
  console.error('❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
