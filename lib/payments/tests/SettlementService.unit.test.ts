/**
 * Unit Tests for Settlement Service (Etapa 6)
 * CNHJá Financial Architecture v1.0
 */

import { SettlementCalculator } from '../SettlementCalculator.js';
import {
  ProcessSettlementInput,
  SettlementOutcome,
  SettlementType,
  SettlementWarningCode
} from '../SettlementTypes.js';
import {
  DuplicateSettlementError,
  InstallmentForSettlementNotFoundError,
  InvalidSettlementAmountError,
  SettlementPersistenceError
} from '../SettlementErrors.js';
import { SettlementService } from '../SettlementService.js';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    failedTests++;
  }
}

async function runUnitTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING UNIT TESTS FOR SETTLEMENT SERVICE (ETAPA 6)');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // GROUP 1: SettlementCalculator - Pure Calculations & Keys
  // ----------------------------------------------------
  console.log('📌 GROUP 1: SettlementCalculator - Pure Calculations & Keys');

  const key1 = SettlementCalculator.generateSettlementKey('pay_123', SettlementType.PAYMENT, 'settle_001');
  assert(key1 === 'pay_123:PAYMENT:settle_001', 'Key generation format with providerSettlementId');

  const key2 = SettlementCalculator.generateSettlementKey('pay_123', SettlementType.PAYMENT, null);
  assert(key2 === 'pay_123:PAYMENT:std', 'Key generation default with null providerSettlementId');

  const calcInput: ProcessSettlementInput = {
    providerPaymentId: 'pay_100',
    installmentNumber: 1,
    settlementType: SettlementType.PAYMENT,
    grossAmount: 10000, // R$ 100,00
    paymentMethod: 'PIX',
    settledAt: '2026-07-27T10:00:00.000Z'
  };

  const calcRes = SettlementCalculator.calculate(calcInput);
  assert(calcRes.grossAmount === 10000, 'Calculates grossAmount in Cents (10000)');
  assert(calcRes.platformFee === 1000, 'Calculates default 10% platformFee (1000)');
  assert(calcRes.feeAmount === 0, 'Default feeAmount is 0 when omitted');
  assert(calcRes.netAmount === 9000, 'Calculates netAmount (10000 - 1000 - 0 = 9000)');
  assert(calcRes.instructorAmount === 9000, 'Calculates instructorAmount equal to netAmount');

  // Release Date calculations
  const pixRelease = SettlementCalculator.calculateReleaseDate('2026-07-27T10:00:00.000Z', 'PIX', 1);
  assert(pixRelease.startsWith('2026-07-28'), 'PIX release date is D+1');

  const ccReleaseInst1 = SettlementCalculator.calculateReleaseDate('2026-07-27T10:00:00.000Z', 'CREDIT_CARD', 1);
  const inst1Days = Math.round((new Date(ccReleaseInst1).getTime() - new Date('2026-07-27T10:00:00.000Z').getTime()) / (1000 * 3600 * 24));
  assert(inst1Days === 30, 'Credit Card installment 1 release date is D+30');

  const ccReleaseInst2 = SettlementCalculator.calculateReleaseDate('2026-07-27T10:00:00.000Z', 'CREDIT_CARD', 2);
  const inst2Days = Math.round((new Date(ccReleaseInst2).getTime() - new Date('2026-07-27T10:00:00.000Z').getTime()) / (1000 * 3600 * 24));
  assert(inst2Days === 60, 'Credit Card installment 2 release date is D+60');

  // Invalid grossAmount check
  let caughtInvalidAmount = false;
  try {
    SettlementCalculator.calculate({
      providerPaymentId: 'pay_err',
      settlementType: SettlementType.PAYMENT,
      grossAmount: -500
    });
  } catch (e: any) {
    if (e instanceof InvalidSettlementAmountError) {
      caughtInvalidAmount = true;
    }
  }
  assert(caughtInvalidAmount, 'Throws InvalidSettlementAmountError on negative grossAmount for PAYMENT');

  // ----------------------------------------------------
  // GROUP 2: Error Hierarchy Validation
  // ----------------------------------------------------
  console.log('\n📌 GROUP 2: Error Hierarchy Validation');

  const dupErr = new DuplicateSettlementError('pay_1:PAYMENT:s1');
  assert(dupErr.settlementKey === 'pay_1:PAYMENT:s1', 'DuplicateSettlementError stores settlementKey');

  const notFoundErr = new InstallmentForSettlementNotFoundError('pay_missing', 2);
  assert(notFoundErr.providerPaymentId === 'pay_missing' && notFoundErr.installmentNumber === 2, 'InstallmentForSettlementNotFoundError captures parameters');

  const persistErr = new SettlementPersistenceError('DB Failure', { code: '23505' });
  assert(persistErr.originalError?.code === '23505', 'SettlementPersistenceError captures original error');

  // ----------------------------------------------------
  // GROUP 3: SettlementService - Execution Logic with Mocks
  // ----------------------------------------------------
  console.log('\n📌 GROUP 3: SettlementService - Execution Logic with Mocks');

  // Mock Supabase Client
  const createMockSupabase = (opts: {
    existingSettlement?: any;
    installment?: any;
    insertSettlementError?: any;
    insertTxError?: any;
  }) => {
    return {
      from: (table: string) => {
        if (table === 'payment_settlements') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: opts.existingSettlement || null, error: null })
                  }),
                  is: () => ({
                    maybeSingle: async () => ({ data: opts.existingSettlement || null, error: null })
                  })
                })
              })
            }),
            insert: () => ({
              select: () => ({
                single: async () => {
                  if (opts.insertSettlementError) throw opts.insertSettlementError;
                  return {
                    data: {
                      id: 'set_999',
                      installment_id: opts.installment?.id || 'inst_100',
                      provider_payment_id: 'pay_test',
                      provider_settlement_id: 'settle_1',
                      settlement_type: SettlementType.PAYMENT,
                      gross_amount: 10000,
                      net_amount: 9000,
                      fee_amount: 0,
                      platform_fee: 1000,
                      instructor_amount: 9000,
                      settled_at: new Date().toISOString(),
                      created_at: new Date().toISOString()
                    },
                    error: opts.insertSettlementError || null
                  };
                }
              })
            })
          };
        }
        if (table === 'payment_installments') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: opts.installment || null, error: null })
                })
              })
            })
          };
        }
        if (table === 'transactions') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { id: 'tx_555' }, error: opts.insertTxError || null })
              })
            })
          };
        }
        return {};
      }
    } as any;
  };

  // Test 1: Successful Settlement Execution
  const mockDb1 = createMockSupabase({
    installment: {
      id: 'inst_100',
      gross_amount: 10000,
      net_amount: 9000,
      platform_fee: 1000,
      student_id: 'stu_1',
      instructor_id: 'inst_1'
    }
  });

  const res1 = await SettlementService.processSettlement({
    providerPaymentId: 'pay_test',
    installmentNumber: 1,
    providerSettlementId: 'settle_1',
    settlementType: SettlementType.PAYMENT,
    grossAmount: 10000,
    paymentMethod: 'PIX'
  }, mockDb1);

  assert(res1.outcome === SettlementOutcome.SETTLEMENT_EXECUTED, 'Process settlement returns SETTLEMENT_EXECUTED');
  assert(res1.settlementId === 'set_999', 'Returns created settlementId');
  assert(res1.transactionId === 'tx_555', 'Returns created transactionId');
  assert(res1.grossAmount === 10000 && res1.netAmount === 9000, 'Calculates correct amounts');

  // Test 2: Idempotency (Duplicate Settlement)
  const mockDb2 = createMockSupabase({
    existingSettlement: {
      id: 'set_already_exists',
      installment_id: 'inst_100',
      gross_amount: 10000,
      net_amount: 9000,
      fee_amount: 0,
      platform_fee: 1000,
      instructor_amount: 9000,
      settled_at: '2026-07-27T12:00:00.000Z'
    }
  });

  const res2 = await SettlementService.processSettlement({
    providerPaymentId: 'pay_test',
    installmentNumber: 1,
    providerSettlementId: 'settle_1',
    settlementType: SettlementType.PAYMENT,
    grossAmount: 10000
  }, mockDb2);

  assert(res2.outcome === SettlementOutcome.NO_OP_DUPLICATE, 'Duplicate settlement returns NO_OP_DUPLICATE');
  assert(res2.warnings.some(w => w.code === SettlementWarningCode.ALREADY_SETTLED), 'Duplicate settlement includes ALREADY_SETTLED warning');

  // Test 3: Missing Installment
  const mockDb3 = createMockSupabase({ installment: null });
  const res3 = await SettlementService.processSettlement({
    providerPaymentId: 'pay_non_existent',
    installmentNumber: 1,
    settlementType: SettlementType.PAYMENT,
    grossAmount: 10000
  }, mockDb3);

  assert(res3.outcome === SettlementOutcome.ERROR, 'Missing installment returns outcome ERROR');
  assert(Boolean(res3.error?.includes('Payment installment not found')), 'Error message indicates installment not found');

  // Summary
  console.log('====================================================');
  console.log(`TOTAL UNIT TESTS: ${passedTests + failedTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${failedTests}`);
  console.log('====================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runUnitTests().catch(err => {
  console.error('Unhandled unit test error:', err);
  process.exit(1);
});
