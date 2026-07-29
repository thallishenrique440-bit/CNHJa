/**
 * PayoutDatabase.integration.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1A (In-Memory Simulator & Matrix Test)
 */

import { createClient } from '@supabase/supabase-js';

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

function createPayoutDatabaseTestAdapter() {
  const payoutsStore: any[] = [];
  const transactionsStore: any[] = [];

  return {
    payoutsStore,
    transactionsStore,

    async recordPayoutAndLedgerEvent(payload: {
      payoutKey: string;
      instructorId: string;
      appointmentId?: string;
      installmentId?: string;
      settlementId?: string;
      grossAmount?: number;
      platformFee?: number;
      netAmount?: number;
      amount?: number;
      status: string;
      payoutMode?: string;
      providerTransferId?: string;
      providerStatus?: string;
      failureReason?: string;
      executedAt?: string;
      ledgerEventType?: string;
      idempotencyKey?: string;
      providerEventId?: string;
      rawPayload?: any;
    }) {
      const netAmount = payload.netAmount || payload.amount || 0;
      const grossAmount = payload.grossAmount || netAmount;
      const platformFee = payload.platformFee || 0;

      if (netAmount <= 0) {
        throw new Error('INVALID_AMOUNT: Net payout amount must be greater than zero.');
      }

      // Unique Settlement ID check
      if (payload.settlementId) {
        const existingSettlement = payoutsStore.find(
          p => p.settlement_id === payload.settlementId && p.payout_key !== payload.payoutKey
        );
        if (existingSettlement) {
          throw new Error('UNIQUE constraint violation: idx_payouts_settlement_id');
        }
      }

      // Unique Provider Transfer ID check
      if (payload.providerTransferId) {
        const existingTransfer = payoutsStore.find(
          p => p.provider_transfer_id === payload.providerTransferId && p.payout_key !== payload.payoutKey
        );
        if (existingTransfer) {
          throw new Error('UNIQUE constraint violation: idx_payouts_provider_transfer_id');
        }
      }

      // Find existing record for state machine validation
      let existingRecord = payoutsStore.find(p => p.payout_key === payload.payoutKey);
      let payoutRecord: any;

      if (existingRecord) {
        const currentStatus = existingRecord.status;
        const targetStatus = payload.status;

        // STATE MACHINE VALIDATION
        if (['PAID', 'CANCELLED'].includes(currentStatus) && currentStatus !== targetStatus) {
          throw new Error(`INVALID_STATE_TRANSITION: Payout ${payload.payoutKey} is in terminal state ${currentStatus} and cannot transition to ${targetStatus}`);
        } else if (currentStatus === targetStatus) {
          // Same status transition (Allowed metadata refresh)
        } else if (currentStatus === 'BLOCKED' && ['READY'].includes(targetStatus)) {
          // Allowed
        } else if (currentStatus === 'READY' && ['PROCESSING', 'BLOCKED', 'CANCELLED'].includes(targetStatus)) {
          // Allowed
        } else if (currentStatus === 'PENDING' && ['PROCESSING', 'CANCELLED'].includes(targetStatus)) {
          // Allowed
        } else if (currentStatus === 'PROCESSING' && ['PAID', 'FAILED'].includes(targetStatus)) {
          // Allowed
        } else if (currentStatus === 'FAILED' && ['READY', 'CANCELLED'].includes(targetStatus)) {
          // Allowed
        } else {
          throw new Error(`INVALID_STATE_TRANSITION: Cannot transition payout ${payload.payoutKey} from ${currentStatus} to ${targetStatus}`);
        }

        existingRecord.status = targetStatus;
        existingRecord.payout_mode = payload.payoutMode || existingRecord.payout_mode;
        existingRecord.provider_transfer_id = payload.providerTransferId || existingRecord.provider_transfer_id;
        existingRecord.provider_status = payload.providerStatus || existingRecord.provider_status;
        existingRecord.failure_reason = payload.failureReason !== undefined ? payload.failureReason : existingRecord.failure_reason;
        existingRecord.executed_at = payload.executedAt || existingRecord.executed_at;
        existingRecord.updated_at = new Date().toISOString();
        payoutRecord = existingRecord;
      } else {
        // Initial creation validation
        if (!['BLOCKED', 'PENDING', 'READY'].includes(payload.status)) {
          throw new Error(`INVALID_INITIAL_STATE: Cannot create payout ${payload.payoutKey} with initial status ${payload.status}`);
        }

        payoutRecord = {
          id: `payout_uuid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          payout_key: payload.payoutKey,
          instructor_id: payload.instructorId,
          appointment_id: payload.appointmentId || null,
          installment_id: payload.installmentId || null,
          settlement_id: payload.settlementId || null,
          gross_amount: grossAmount,
          platform_fee: platformFee,
          net_amount: netAmount,
          amount: netAmount,
          status: payload.status,
          payout_mode: payload.payoutMode || 'SHADOW',
          provider_transfer_id: payload.providerTransferId || null,
          provider_status: payload.providerStatus || null,
          failure_reason: payload.failureReason || null,
          scheduled_for: new Date().toISOString(),
          executed_at: payload.executedAt || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        payoutsStore.push(payoutRecord);
      }

      // Insert Transaction Event Ledger entry if requested
      let transactionId: string | null = null;
      if (payload.ledgerEventType) {
        if (payload.idempotencyKey) {
          const existingTx = transactionsStore.find(t => t.idempotency_key === payload.idempotencyKey);
          if (existingTx) {
            transactionId = existingTx.id;
          }
        }

        if (!transactionId) {
          transactionId = `tx_uuid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          transactionsStore.push({
            id: transactionId,
            type: 'payout',
            instructor_id: payload.instructorId,
            amount: netAmount,
            gross_amount: grossAmount,
            platform_fee: platformFee,
            net_amount: netAmount,
            event_date: new Date().toISOString(),
            provider: 'asaas',
            provider_event_id: payload.providerEventId || null,
            idempotency_key: payload.idempotencyKey || null,
            receipt_status: 'RECEIVED',
            processing_status: 'PROCESSED',
            raw_payload: payload.rawPayload || null,
            processed_at: new Date().toISOString(),
            processor_version: '1.0.0'
          });
        }
      }

      return {
        success: true,
        payout_id: payoutRecord.id,
        payout_key: payoutRecord.payout_key,
        status: payoutRecord.status,
        transaction_id: transactionId
      };
    }
  };
}

async function runStage81AInfrastructureTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING STAGE 8.1A PAYOUT ENGINE INFRASTRUCTURE TESTS (IN-MEMORY)');
  console.log('====================================================\n');

  const dbAdapter = createPayoutDatabaseTestAdapter();

  const testInstructorId = '00000000-0000-4000-a000-000000000888';
  const testSettlementId = 'settlement_uuid_10001';
  const testPayoutKey = `payout_${testInstructorId}_${testSettlementId}`;

  // TEST 1: Creation Defaults
  console.log('📌 TEST 1: Create Payout Record with Defaults (BLOCKED, SHADOW, Financial breakdown)');
  const res1 = await dbAdapter.recordPayoutAndLedgerEvent({
    payoutKey: testPayoutKey,
    instructorId: testInstructorId,
    settlementId: testSettlementId,
    grossAmount: 16000,
    platformFee: 1000,
    netAmount: 15000,
    status: 'BLOCKED',
    payoutMode: 'SHADOW'
  });

  assert(res1.success === true, 'RPC recordPayoutAndLedgerEvent returns success');
  assert(res1.status === 'BLOCKED', 'Initial payout status is BLOCKED');
  assert(dbAdapter.payoutsStore.length === 1, 'Payout record saved to table');
  assert(dbAdapter.payoutsStore[0].gross_amount === 16000, 'Gross amount preserved');
  assert(dbAdapter.payoutsStore[0].platform_fee === 1000, 'Platform fee preserved');
  assert(dbAdapter.payoutsStore[0].net_amount === 15000, 'Net amount preserved');
  assert(dbAdapter.payoutsStore[0].amount === 15000, 'Amount alias matches net_amount');

  // TEST 2: Unique Settlement Constraint
  console.log('\n📌 TEST 2: Enforce Unique Settlement ID Constraint (1 Settlement -> 1 Payout)');
  let settlementConflictCaught = false;
  try {
    await dbAdapter.recordPayoutAndLedgerEvent({
      payoutKey: `payout_duplicate_settlement_${Date.now()}`,
      instructorId: testInstructorId,
      settlementId: testSettlementId,
      amount: 15000,
      status: 'PENDING'
    });
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint violation') && err.message.includes('settlement_id')) {
      settlementConflictCaught = true;
    }
  }
  assert(settlementConflictCaught, 'Prevent duplicate payouts for the same settlement_id');

  // TEST 3: Amount Check Constraint
  console.log('\n📌 TEST 3: Enforce Amount > 0 CHECK Constraint');
  let invalidAmountCaught = false;
  try {
    await dbAdapter.recordPayoutAndLedgerEvent({
      payoutKey: 'payout_invalid_amount_key',
      instructorId: testInstructorId,
      netAmount: -500,
      status: 'BLOCKED'
    });
  } catch (err: any) {
    if (err.message.includes('INVALID_AMOUNT')) {
      invalidAmountCaught = true;
    }
  }
  assert(invalidAmountCaught, 'Reject negative or zero payout amounts');

  // TEST 4: Valid State Machine Transitions
  console.log('\n📌 TEST 4: Valid State Transitions (BLOCKED -> READY -> PROCESSING)');
  const resReady = await dbAdapter.recordPayoutAndLedgerEvent({
    payoutKey: testPayoutKey,
    instructorId: testInstructorId,
    netAmount: 15000,
    status: 'READY'
  });
  assert(resReady.status === 'READY', 'Status transitioned BLOCKED -> READY');

  const resProc = await dbAdapter.recordPayoutAndLedgerEvent({
    payoutKey: testPayoutKey,
    instructorId: testInstructorId,
    netAmount: 15000,
    status: 'PROCESSING',
    ledgerEventType: 'PAYOUT_PROCESSING',
    idempotencyKey: `evt_proc_${testPayoutKey}`
  });
  assert(resProc.status === 'PROCESSING', 'Status transitioned READY -> PROCESSING');
  assert(Boolean(resProc.transaction_id), 'Ledger entry created in transactions');

  // TEST 5: Final State Transition to PAID
  console.log('\n📌 TEST 5: Transition to Terminal State PAID');
  const executedAt = new Date().toISOString();
  const resPaid = await dbAdapter.recordPayoutAndLedgerEvent({
    payoutKey: testPayoutKey,
    instructorId: testInstructorId,
    netAmount: 15000,
    status: 'PAID',
    providerTransferId: 'trans_asaas_887766',
    providerStatus: 'DONE',
    executedAt: executedAt
  });
  assert(resPaid.status === 'PAID', 'Payout reached terminal state PAID');

  // TEST 6: Prevent Regression from Terminal State (PAID -> PENDING)
  console.log('\n📌 TEST 6: Prevent Illegal State Regression from Terminal State (PAID -> PENDING)');
  let regressionCaught = false;
  try {
    await dbAdapter.recordPayoutAndLedgerEvent({
      payoutKey: testPayoutKey,
      instructorId: testInstructorId,
      netAmount: 15000,
      status: 'PENDING'
    });
  } catch (err: any) {
    if (err.message.includes('INVALID_STATE_TRANSITION')) {
      regressionCaught = true;
    }
  }
  assert(regressionCaught, 'State Machine prevents regression from PAID to PENDING');

  console.log('\n====================================================');
  console.log(`📊 STAGE 8.1A IN-MEMORY TEST SUMMARY: PASSED=${passedTests}, FAILED=${failedTests}`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runStage81AInfrastructureTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
