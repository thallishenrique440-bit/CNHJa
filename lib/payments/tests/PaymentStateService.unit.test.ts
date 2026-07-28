/**
 * Unit Test Suite for PaymentStateService & State Machine
 * CNHJá Financial Architecture v1.0 (Etapa 5)
 */

import { PaymentStateMachine } from '../PaymentStateMachine.js';
import { PaymentStateMapper } from '../PaymentStateMapper.js';
import { PaymentStateService } from '../PaymentStateService.js';
import {
  PaymentInstallmentStatus,
  TransitionOutcome,
  PaymentWarningCode
} from '../PaymentStateTypes.js';
import {
  InstallmentNotFoundError,
  InvalidTransitionError,
  StatePersistenceError
} from '../PaymentStateErrors.js';

async function runUnitTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING UNIT TESTS FOR PAYMENT STATE SERVICE (ETAPA 5)');
  console.log('====================================================\n');

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

  // ----------------------------------------------------
  // TEST GROUP 1: PaymentStateMachine - Transitions
  // ----------------------------------------------------
  console.log('📌 GROUP 1: PaymentStateMachine - Allowed & Disallowed Transitions');

  assert(
    PaymentStateMachine.isValidTransition('PENDING', 'AUTHORIZED') === true,
    'PENDING -> AUTHORIZED is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('PENDING', 'CONFIRMED') === true,
    'PENDING -> CONFIRMED is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('PENDING', 'RECEIVED') === true,
    'PENDING -> RECEIVED is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('AUTHORIZED', 'CONFIRMED') === true,
    'AUTHORIZED -> CONFIRMED is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('CONFIRMED', 'RECEIVED') === true,
    'CONFIRMED -> RECEIVED is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('RECEIVED', 'REFUNDED') === true,
    'RECEIVED -> REFUNDED is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('RECEIVED', 'CHARGEBACK') === true,
    'RECEIVED -> CHARGEBACK is valid'
  );
  assert(
    PaymentStateMachine.isValidTransition('CANCELLED', 'PENDING') === true,
    'CANCELLED -> PENDING (RESTORED) is valid'
  );

  // Invalid transitions
  assert(
    PaymentStateMachine.isValidTransition('REFUNDED', 'RECEIVED') === false,
    'REFUNDED -> RECEIVED is INVALID (terminal state)'
  );
  assert(
    PaymentStateMachine.isValidTransition('RECEIVED', 'PENDING') === false,
    'RECEIVED -> PENDING is INVALID'
  );
  assert(
    PaymentStateMachine.isValidTransition('CONFIRMED', 'AUTHORIZED') === false,
    'CONFIRMED -> AUTHORIZED is INVALID'
  );

  // ----------------------------------------------------
  // TEST GROUP 2: Out-Of-Order & State Regression
  // ----------------------------------------------------
  console.log('\n📌 GROUP 2: Out-Of-Order Detection & Regression Safeguards');

  assert(
    PaymentStateMachine.isOutOfOrder('RECEIVED', 'PENDING') === true,
    'RECEIVED -> PENDING is detected as out-of-order'
  );
  assert(
    PaymentStateMachine.isOutOfOrder('CONFIRMED', 'AUTHORIZED') === true,
    'CONFIRMED -> AUTHORIZED is detected as out-of-order'
  );
  assert(
    PaymentStateMachine.isOutOfOrder('REFUNDED', 'RECEIVED') === true,
    'REFUNDED -> RECEIVED is detected as out-of-order'
  );
  assert(
    PaymentStateMachine.isOutOfOrder('PENDING', 'RECEIVED') === false,
    'PENDING -> RECEIVED is NOT out-of-order'
  );

  // ----------------------------------------------------
  // TEST GROUP 3: Projection Calculations
  // ----------------------------------------------------
  console.log('\n📌 GROUP 3: Appointment Payment Status Projection Calculations');

  assert(
    PaymentStateMachine.calculateAppointmentProjection([{ status: 'RECEIVED' }]) === 'paid',
    'Single installment RECEIVED -> projection "paid"'
  );
  assert(
    PaymentStateMachine.calculateAppointmentProjection([
      { status: 'RECEIVED' },
      { status: 'RECEIVED' },
      { status: 'RECEIVED' }
    ]) === 'paid',
    'All 3 installments RECEIVED -> projection "paid"'
  );
  assert(
    PaymentStateMachine.calculateAppointmentProjection([
      { status: 'RECEIVED' },
      { status: 'PENDING' }
    ]) === 'partially_paid',
    '1 RECEIVED + 1 PENDING -> projection "partially_paid"'
  );
  assert(
    PaymentStateMachine.calculateAppointmentProjection([
      { status: 'REFUNDED' },
      { status: 'REFUNDED' }
    ]) === 'refunded',
    'All REFUNDED -> projection "refunded"'
  );
  assert(
    PaymentStateMachine.calculateAppointmentProjection([
      { status: 'OVERDUE' },
      { status: 'PENDING' }
    ]) === 'overdue',
    'Has OVERDUE -> projection "overdue"'
  );
  assert(
    PaymentStateMachine.calculateAppointmentProjection([
      { status: 'FAILED' }
    ]) === 'failed',
    'Has FAILED -> projection "failed"'
  );

  // ----------------------------------------------------
  // TEST GROUP 4: Event Mapper (Asaas -> Internal)
  // ----------------------------------------------------
  console.log('\n📌 GROUP 4: Asaas Event Mapper');

  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_CREATED') === 'PENDING',
    'PAYMENT_CREATED -> PENDING'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_AUTHORIZED') === 'AUTHORIZED',
    'PAYMENT_AUTHORIZED -> AUTHORIZED'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_CONFIRMED') === 'CONFIRMED',
    'PAYMENT_CONFIRMED -> CONFIRMED'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_RECEIVED') === 'RECEIVED',
    'PAYMENT_RECEIVED -> RECEIVED'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_OVERDUE') === 'OVERDUE',
    'PAYMENT_OVERDUE -> OVERDUE'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_REFUNDED') === 'REFUNDED',
    'PAYMENT_REFUNDED -> REFUNDED'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_CHARGEBACK_REQUESTED') === 'CHARGEBACK',
    'PAYMENT_CHARGEBACK_REQUESTED -> CHARGEBACK'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_DELETED') === 'CANCELLED',
    'PAYMENT_DELETED -> CANCELLED'
  );
  assert(
    PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_CHECKOUT_VIEWED') === null,
    'PAYMENT_CHECKOUT_VIEWED -> null (NO_OP)'
  );

  // ----------------------------------------------------
  // TEST GROUP 5: Error Hierarchy
  // ----------------------------------------------------
  console.log('\n📌 GROUP 5: Error Hierarchy');

  const notFoundErr = new InstallmentNotFoundError('pay_123', 1);
  assert(
    notFoundErr.name === 'InstallmentNotFoundError' && notFoundErr.providerPaymentId === 'pay_123',
    'InstallmentNotFoundError captures providerPaymentId'
  );

  const invalidTransErr = new InvalidTransitionError('REFUNDED', 'RECEIVED');
  assert(
    invalidTransErr.name === 'InvalidTransitionError' && invalidTransErr.currentState === 'REFUNDED',
    'InvalidTransitionError captures state parameters'
  );

  const persistenceErr = new StatePersistenceError('Failed to write', 'Connection timeout');
  assert(
    persistenceErr.name === 'StatePersistenceError' && persistenceErr.originalError === 'Connection timeout',
    'StatePersistenceError captures original error'
  );

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(`TOTAL UNIT TESTS: ${passed + failed}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runUnitTests().catch((err) => {
  console.error('Fatal unit test error:', err);
  process.exit(1);
});
