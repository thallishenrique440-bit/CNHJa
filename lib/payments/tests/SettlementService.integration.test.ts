/**
 * Integration Tests for Settlement Service (Etapa 6)
 * CNHJá Financial Architecture v1.0
 */

import { createClient } from '@supabase/supabase-js';
import { SettlementService } from '../SettlementService.js';
import { SettlementOutcome, SettlementType, SettlementWarningCode } from '../SettlementTypes.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

async function runIntegrationTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING INTEGRATION TESTS FOR SETTLEMENT SERVICE');
  console.log('====================================================\n');

  const testProviderPaymentId = `pay_int_test_${Date.now()}`;
  let testInstallmentId: string | null = null;
  let testAppointmentId: string | null = null;
  let createdSettlementId: string | null = null;

  try {
    // ----------------------------------------------------
    // SETUP: Fixtures (Appointment + Installment)
    // ----------------------------------------------------
    console.log('📌 SETUP: Creating dummy appointment and payment_installment');

    // Fetch existing student & instructor profile for relational integrity
    const { data: student } = await supabaseAdmin.from('profiles').select('id').eq('role', 'student').limit(1).maybeSingle();
    const { data: instructor } = await supabaseAdmin.from('instructors').select('id').limit(1).maybeSingle();

    const studentId = student?.id || null;
    const instructorId = instructor?.id || null;

    // Create dummy appointment
    const { data: apt, error: aptErr } = await supabaseAdmin
      .from('appointments')
      .insert({
        student_id: studentId,
        instructor_id: instructorId,
        status: 'pending',
        payment_status: 'pending',
        price: 100,
        date: '2026-08-01',
        start_time: '09:00',
        end_time: '10:00',
        provider_payment_id: testProviderPaymentId
      })
      .select('id')
      .single();

    if (aptErr) throw aptErr;
    testAppointmentId = apt.id;

    // Create dummy payment_installment (Financial Schedule)
    const { data: inst, error: instErr } = await supabaseAdmin
      .from('payment_installments')
      .insert({
        provider_payment_id: testProviderPaymentId,
        installment_number: 1,
        total_installments: 1,
        gross_amount: 10000,
        net_amount: 9000,
        fee_amount: 0,
        platform_fee: 1000,
        instructor_amount: 9000,
        status: 'PENDING',
        appointment_id: testAppointmentId,
        student_id: studentId,
        instructor_id: instructorId
      })
      .select('id')
      .single();

    if (instErr) throw instErr;
    testInstallmentId = inst.id;

    console.log(`  ✅ Created test installment ID: ${testInstallmentId}`);

    // ----------------------------------------------------
    // CASE 1: Process Settlement (PAYMENT type)
    // ----------------------------------------------------
    console.log('\n📌 CASE 1: Execute PAYMENT Settlement');

    const settleRes = await SettlementService.processSettlement({
      providerPaymentId: testProviderPaymentId,
      installmentNumber: 1,
      providerSettlementId: `settle_${testProviderPaymentId}`,
      settlementType: SettlementType.PAYMENT,
      grossAmount: 10000,
      netAmount: 9000,
      platformFee: 1000,
      paymentMethod: 'PIX'
    }, supabaseAdmin);

    console.log('  Result 1:', settleRes);

    assert(settleRes.outcome === SettlementOutcome.SETTLEMENT_EXECUTED, 'Outcome is SETTLEMENT_EXECUTED');
    assert(Boolean(settleRes.settlementId), 'Returns valid settlementId');
    createdSettlementId = settleRes.settlementId || null;

    // Verify record in payment_settlements table
    const { data: psRecord } = await supabaseAdmin
      .from('payment_settlements')
      .select('*')
      .eq('id', createdSettlementId!)
      .single();

    assert(psRecord?.gross_amount === 10000, 'payment_settlements gross_amount is 10000');
    assert(psRecord?.net_amount === 9000, 'payment_settlements net_amount is 9000');
    assert(psRecord?.platform_fee === 1000, 'payment_settlements platform_fee is 1000');
    assert(psRecord?.settlement_type === 'PAYMENT', 'payment_settlements settlement_type is PAYMENT');

    // Verify financial entry in transactions table
    const { data: txRecord } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('idempotency_key', settleRes.settlementKey)
      .maybeSingle();

    assert(Boolean(txRecord), 'Financial transaction record created in transactions table');
    assert(txRecord?.type === 'settlement_credit', 'Transaction type is settlement_credit');

    // Verify Invariants: SettlementService MUST NOT alter payment_installments or appointments
    const { data: instCheck } = await supabaseAdmin
      .from('payment_installments')
      .select('status')
      .eq('id', testInstallmentId!)
      .single();

    assert(instCheck?.status === 'PENDING', 'INVARIANT CONFIRMED: payment_installments status was NOT modified by SettlementService');

    const { data: aptCheck } = await supabaseAdmin
      .from('appointments')
      .select('status, payment_status')
      .eq('id', testAppointmentId!)
      .single();

    assert(aptCheck?.status === 'pending' && aptCheck?.payment_status === 'pending', 'INVARIANT CONFIRMED: appointments status and payment_status were NOT modified by SettlementService');

    // ----------------------------------------------------
    // CASE 2: Duplicate Settlement Attempt (Idempotency)
    // ----------------------------------------------------
    console.log('\n📌 CASE 2: Duplicate Settlement Attempt (Idempotency)');

    const dupRes = await SettlementService.processSettlement({
      providerPaymentId: testProviderPaymentId,
      installmentNumber: 1,
      providerSettlementId: `settle_${testProviderPaymentId}`,
      settlementType: SettlementType.PAYMENT,
      grossAmount: 10000
    }, supabaseAdmin);

    console.log('  Result 2:', dupRes);

    assert(dupRes.outcome === SettlementOutcome.NO_OP_DUPLICATE, 'Duplicate settlement identified as NO_OP_DUPLICATE');
    assert(dupRes.warnings.some(w => w.code === SettlementWarningCode.ALREADY_SETTLED), 'ALREADY_SETTLED warning present');

    // Verify no extra row was created in payment_settlements
    const { count } = await supabaseAdmin
      .from('payment_settlements')
      .select('*', { count: 'exact', head: true })
      .eq('provider_payment_id', testProviderPaymentId)
      .eq('settlement_type', 'PAYMENT');

    assert(count === 1, 'Exactly 1 settlement record exists (Idempotency intact)');

    // ----------------------------------------------------
    // CASE 3: Execute REFUND Settlement
    // ----------------------------------------------------
    console.log('\n📌 CASE 3: Execute REFUND Settlement');

    const refundRes = await SettlementService.processRefundSettlement({
      providerPaymentId: testProviderPaymentId,
      installmentNumber: 1,
      providerSettlementId: `settle_ref_${testProviderPaymentId}`,
      settlementType: SettlementType.REFUND,
      grossAmount: 10000,
      netAmount: 9000,
      platformFee: 1000
    }, supabaseAdmin);

    console.log('  Result 3:', refundRes);

    assert(refundRes.outcome === SettlementOutcome.SETTLEMENT_EXECUTED, 'Refund outcome is SETTLEMENT_EXECUTED');
    assert(refundRes.settlementType === SettlementType.REFUND, 'Refund settlementType is REFUND');

    const { data: refRecord } = await supabaseAdmin
      .from('payment_settlements')
      .select('*')
      .eq('id', refundRes.settlementId!)
      .single();

    assert(refRecord?.settlement_type === 'REFUND', 'payment_settlements record created with settlement_type REFUND');

  } catch (err: any) {
    console.error('❌ Integration test exception:', err);
    failedTests++;
  } finally {
    // ----------------------------------------------------
    // CLEANUP
    // ----------------------------------------------------
    console.log('\n📌 CLEANUP: Removing fixture test data');
    if (testProviderPaymentId) {
      await supabaseAdmin.from('payment_settlements').delete().eq('provider_payment_id', testProviderPaymentId);
      await supabaseAdmin.from('transactions').delete().eq('provider_payment_id', testProviderPaymentId);
      await supabaseAdmin.from('payment_installments').delete().eq('provider_payment_id', testProviderPaymentId);
    }
    if (testAppointmentId) {
      await supabaseAdmin.from('appointments').delete().eq('id', testAppointmentId);
    }
    console.log('  ✅ Cleanup complete');
  }

  // Summary
  console.log('====================================================');
  console.log(`TOTAL INTEGRATION TESTS: ${passedTests + failedTests}`);
  console.log(`PASSED: ${passedTests}`);
  console.log(`FAILED: ${failedTests}`);
  console.log('====================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runIntegrationTests().catch(err => {
  console.error('Unhandled integration test error:', err);
  process.exit(1);
});
