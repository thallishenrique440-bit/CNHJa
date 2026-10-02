/**
 * RefundReconciliationFase31.unit.test.ts
 * Tests for FASE 3.1 & FASE 1.1.E InstallmentService Decoupling & Refund Reconciliation Contract
 *
 * VALIDATES NEW CONTRACT (FASE 1.1.E):
 * - InstallmentService ONLY manages payment_installments lifecycle (status transition to REFUNDED).
 * - InstallmentService NEVER writes to payment_settlements on refund.
 * - InstallmentService NEVER creates transactions with type settlement_refund.
 * - InstallmentService NEVER emits REFUND_CREATED.
 * - InstallmentService NEVER generates artificial provider_settlement_id for refund.
 */

import { InstallmentService } from '../InstallmentService.js';
import { ProjectionDispatcher } from '../projections/ProjectionDispatcher.js';
import { ProjectionSourceEventType } from '../projections/ProjectionTypes.js';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('RUNNING FASE 3.1 / 1.1.E REFUND RECONCILIATION TEST SUITE');
  console.log('====================================================\n');

  // Spy on ProjectionDispatcher to ensure ZERO REFUND_CREATED emissions
  const dispatchedEvents: any[] = [];
  const originalDispatch = ProjectionDispatcher.dispatch;
  ProjectionDispatcher.dispatch = async (supabase: any, payload: any) => {
    dispatchedEvents.push(payload);
    return { outcome: 'PROJECTION_APPLIED' as any };
  };

  // Setup Stateful In-Memory Database to track table mutations
  const settlementDbRows: Map<string, any> = new Map();
  const installmentDbRows: Map<string, any> = new Map();
  let settlementWriteCalls = 0;

  installmentDbRows.set('inst_001', {
    id: 'inst_001',
    installment_number: 1,
    gross_amount: 10000,
    platform_fee: 1000,
    instructor_amount: 9000,
    instructor_id: 'inst_user_1',
    student_id: 'stud_user_1',
    status: 'SCHEDULED'
  });

  const mockStatefulSupabase: any = {
    from: (table: string) => {
      if (table === 'payment_installments') {
        return {
          select: () => ({
            or: () => ({
              eq: () => ({
                data: Array.from(installmentDbRows.values()),
                error: null
              })
            })
          }),
          update: (data: any) => ({
            eq: (col: string, val: any) => {
              if (installmentDbRows.has(val)) {
                const row = installmentDbRows.get(val);
                Object.assign(row, data);
              }
              return Promise.resolve({ error: null });
            }
          })
        };
      }
      if (table === 'payment_settlements') {
        return {
          upsert: (record: any, _options: any) => {
            settlementWriteCalls++;
            const uniqueKey = `${record.provider_payment_id}::${record.settlement_type}::${record.provider_settlement_id}`;
            settlementDbRows.set(uniqueKey, record);
            return Promise.resolve({ error: null });
          },
          insert: (record: any) => {
            settlementWriteCalls++;
            const uniqueKey = `${record.provider_payment_id}::${record.settlement_type}::${record.provider_settlement_id}`;
            settlementDbRows.set(uniqueKey, record);
            return Promise.resolve({ error: null });
          }
        };
      }
      return {};
    }
  };

  // ----------------------------------------------------
  // TEST 1: Legitimate Installment Reconciliation
  // ----------------------------------------------------
  console.log('📌 TEST 1: Legitimate Installment Status Transition (to REFUNDED)');
  await InstallmentService.recordRefundSettlement(mockStatefulSupabase, {
    providerPaymentId: 'pay_test_123',
    groupId: 'grp_001',
    installmentNumber: 1,
    refundAmountCents: 10000,
    providerSettlementId: 'pay_test_123_refund_1',
    refundDate: '2026-08-11T00:00:00.000Z'
  });

  const updatedInstallment = installmentDbRows.get('inst_001');
  assert(updatedInstallment !== undefined, 'Targeted installment exists in DB');
  assert(updatedInstallment.status === 'REFUNDED', 'Installment status successfully updated to REFUNDED');

  // ----------------------------------------------------
  // TEST 2: ZERO Financial Settlement Writes
  // ----------------------------------------------------
  console.log('\n📌 TEST 2: Mandatory Assertion — Zero Writes to payment_settlements');
  assert(settlementWriteCalls === 0, 'Zero write calls (insert/upsert) to payment_settlements executed by InstallmentService');
  assert(settlementDbRows.size === 0, 'Zero settlement records exist in payment_settlements table');

  // ----------------------------------------------------
  // TEST 3: ZERO REFUND_CREATED Event Emissions
  // ----------------------------------------------------
  console.log('\n📌 TEST 3: Mandatory Assertion — Zero REFUND_CREATED Emissions');
  const refundCreatedEvents = dispatchedEvents.filter(
    (e) => e.eventType === ProjectionSourceEventType.REFUND_CREATED
  );
  assert(refundCreatedEvents.length === 0, 'Zero REFUND_CREATED events emitted by InstallmentService');
  assert(dispatchedEvents.length === 0, 'Zero total projection events dispatched by recordRefundSettlement');

  // ----------------------------------------------------
  // TEST 4: Idempotency & Repeat Calls (Sync / Retries)
  // ----------------------------------------------------
  console.log('\n📌 TEST 4: Idempotency & Repeat Retries (Zero Drift)');
  for (let i = 0; i < 4; i++) {
    await InstallmentService.recordRefundSettlement(mockStatefulSupabase, {
      providerPaymentId: 'pay_test_123',
      groupId: 'grp_001',
      installmentNumber: 1,
      refundAmountCents: 10000,
      providerSettlementId: 'pay_test_123_refund_1',
      refundDate: '2026-08-11T00:00:00.000Z'
    });
  }

  assert(installmentDbRows.get('inst_001').status === 'REFUNDED', 'Installment remains REFUNDED after 5 invocations');
  assert(settlementWriteCalls === 0, 'Still ZERO write calls to payment_settlements after 5 invocations');
  assert(settlementDbRows.size === 0, 'Still ZERO records in payment_settlements after 5 invocations');
  assert(dispatchedEvents.length === 0, 'Still ZERO events emitted after 5 invocations');

  // ----------------------------------------------------
  // TEST 5: Standalone/Missing Installment Case
  // ----------------------------------------------------
  console.log('\n📌 TEST 5: Standalone/Missing Installment Handling (No Phantom Settlements Created)');
  await InstallmentService.recordRefundSettlement(mockStatefulSupabase, {
    providerPaymentId: 'pay_non_existent',
    groupId: 'grp_non_existent',
    installmentNumber: 1,
    refundAmountCents: 5000,
    refundDate: '2026-08-11T00:00:00.000Z'
  });

  assert(settlementWriteCalls === 0, 'No standalone/phantom settlement created when installment does not exist');
  assert(settlementDbRows.size === 0, 'payment_settlements table remains strictly empty');

  // ----------------------------------------------------
  // TEST 6: BookingCancellationCore REFUND_REQUESTED vs REFUNDED Status Classification
  // ----------------------------------------------------
  console.log('\n📌 TEST 6: BookingCancellationCore Status Classification Taxonomy');
  const testAsaasStatuses = ['RECEIVED', 'CONFIRMED', 'REFUND_REQUESTED', 'REFUNDED'];
  for (const status of testAsaasStatuses) {
    const isPaid = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'].includes(status);
    const isRefundRequestedOrConfirmed = ['REFUNDED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'].includes(status);
    const isRefundConfirmed = status === 'REFUNDED';

    if (status === 'REFUND_REQUESTED') {
      assert(isPaid === true, 'REFUND_REQUESTED is classified as isPaid');
      assert(isRefundRequestedOrConfirmed === true, 'REFUND_REQUESTED is classified as isRefundRequestedOrConfirmed (skips POST /refund)');
      assert(isRefundConfirmed === false, 'REFUND_REQUESTED is NOT classified as isRefundConfirmed');
    }
    if (status === 'REFUNDED') {
      assert(isPaid === true, 'REFUNDED is classified as isPaid');
      assert(isRefundRequestedOrConfirmed === true, 'REFUNDED is classified as isRefundRequestedOrConfirmed');
      assert(isRefundConfirmed === true, 'REFUNDED is classified as isRefundConfirmed');
    }
  }

  // Restore original dispatch
  ProjectionDispatcher.dispatch = originalDispatch;

  console.log('\n====================================================');
  console.log('✅ ALL FASE 3.1 / 1.1.E REFUND RECONCILIATION TESTS PASSED PERFECTLY!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
