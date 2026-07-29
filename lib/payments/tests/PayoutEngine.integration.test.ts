/**
 * PayoutEngine.integration.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B (In-Memory Integration Pipeline Test)
 */

import { PayoutEngine } from '../PayoutEngine.js';
import { EligibilityService } from '../EligibilityService.js';
import { PayoutRepository } from '../PayoutRepository.js';
import { EligibleSettlementDTO } from '../PayoutTypes.js';

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

/**
 * Creates an in-memory database simulator matching the Stage 8.1A PostgreSQL RPC behavior.
 */
function createPayoutDatabaseIntegrationAdapter() {
  const payoutsStore: any[] = [];
  const transactionsStore: any[] = [];

  const mockSupabaseClient: any = {
    rpc: async (fnName: string, params: any) => {
      if (fnName !== 'record_payout_and_ledger_event') {
        return { data: null, error: { code: 'UNKNOWN_RPC', message: 'RPC not found' } };
      }

      const netAmount = params.p_net_amount || params.p_amount || 0;
      const grossAmount = params.p_gross_amount || netAmount;
      const platformFee = params.p_platform_fee || 0;

      if (netAmount <= 0) {
        return {
          data: null,
          error: { code: 'INVALID_AMOUNT', message: 'Net payout amount must be greater than zero.' }
        };
      }

      // Unique Settlement ID check
      if (params.p_settlement_id) {
        const existingSettlement = payoutsStore.find(
          p => p.settlement_id === params.p_settlement_id && p.payout_key !== params.p_payout_key
        );
        if (existingSettlement) {
          return {
            data: null,
            error: { code: '23505', message: 'UNIQUE constraint violation: idx_payouts_settlement_id' }
          };
        }
      }

      let existingRecord = payoutsStore.find(p => p.payout_key === params.p_payout_key);
      let payoutRecord: any;

      if (existingRecord) {
        const currentStatus = existingRecord.status;
        const targetStatus = params.p_status;

        // STATE MACHINE VALIDATION
        if (['PAID', 'CANCELLED'].includes(currentStatus) && currentStatus !== targetStatus) {
          return {
            data: null,
            error: {
              code: 'INVALID_STATE_TRANSITION',
              message: `Payout ${params.p_payout_key} is in terminal state ${currentStatus} and cannot transition to ${targetStatus}`
            }
          };
        } else if (currentStatus === targetStatus) {
          // Metadata refresh allowed
        } else if (currentStatus === 'BLOCKED' && targetStatus === 'READY') {
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
          return {
            data: null,
            error: {
              code: 'INVALID_STATE_TRANSITION',
              message: `Cannot transition payout ${params.p_payout_key} from ${currentStatus} to ${targetStatus}`
            }
          };
        }

        existingRecord.status = targetStatus;
        existingRecord.payout_mode = params.p_payout_mode || existingRecord.payout_mode;
        existingRecord.provider_transfer_id = params.p_provider_transfer_id || existingRecord.provider_transfer_id;
        existingRecord.provider_status = params.p_provider_status || existingRecord.provider_status;
        existingRecord.failure_reason = params.p_failure_reason !== undefined ? params.p_failure_reason : existingRecord.failure_reason;
        existingRecord.executed_at = params.p_executed_at || existingRecord.executed_at;
        existingRecord.updated_at = new Date().toISOString();
        payoutRecord = existingRecord;
      } else {
        // Initial creation validation
        if (!['BLOCKED', 'PENDING', 'READY'].includes(params.p_status)) {
          return {
            data: null,
            error: {
              code: 'INVALID_INITIAL_STATE',
              message: `Cannot create payout ${params.p_payout_key} with initial status ${params.p_status}`
            }
          };
        }

        payoutRecord = {
          id: `payout_uuid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          payout_key: params.p_payout_key,
          instructor_id: params.p_instructor_id,
          appointment_id: params.p_appointment_id || null,
          installment_id: params.p_installment_id || null,
          settlement_id: params.p_settlement_id || null,
          gross_amount: grossAmount,
          platform_fee: platformFee,
          net_amount: netAmount,
          amount: netAmount,
          status: params.p_status,
          payout_mode: params.p_payout_mode || 'SHADOW',
          provider_transfer_id: params.p_provider_transfer_id || null,
          provider_status: params.p_provider_status || null,
          failure_reason: params.p_failure_reason || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        payoutsStore.push(payoutRecord);
      }

      // Ledger event insertion
      let transactionId: string | null = null;
      if (params.p_ledger_event_type) {
        if (params.p_idempotency_key) {
          const existingTx = transactionsStore.find(t => t.idempotency_key === params.p_idempotency_key);
          if (existingTx) {
            transactionId = existingTx.id;
          }
        }

        if (!transactionId) {
          transactionId = `tx_uuid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          transactionsStore.push({
            id: transactionId,
            type: 'payout',
            instructor_id: params.p_instructor_id,
            amount: netAmount,
            gross_amount: grossAmount,
            platform_fee: platformFee,
            net_amount: netAmount,
            payout_id: payoutRecord.id,
            payout_key: params.p_payout_key,
            ledger_event_type: params.p_ledger_event_type,
            idempotency_key: params.p_idempotency_key || null,
            created_at: new Date().toISOString()
          });
        }
      }

      return {
        data: {
          success: true,
          payout_id: payoutRecord.id,
          payout_key: payoutRecord.payout_key,
          status: payoutRecord.status,
          transaction_id: transactionId
        },
        error: null
      };
    }
  };

  return {
    payoutsStore,
    transactionsStore,
    mockSupabaseClient
  };
}

async function runIntegrationTests() {
  console.log('\n======================================================');
  console.log('🧪 PayoutEngine Full Pipeline Integration Tests');
  console.log('======================================================\n');

  const { payoutsStore, transactionsStore, mockSupabaseClient } = createPayoutDatabaseIntegrationAdapter();

  const eligibilityService = new EligibilityService();
  const repository = new PayoutRepository(mockSupabaseClient);
  const engine = new PayoutEngine(eligibilityService, repository);

  // ----------------------------------------------------
  // TEST 1: End-to-End READY Flow for Eligible Settlement
  // ----------------------------------------------------
  console.log('--- TEST 1: End-to-End READY Flow ---');
  const eligibleSettlement: EligibleSettlementDTO = {
    id: 'set_int_001',
    providerPaymentId: 'pay_asaas_int_001',
    instructorId: 'inst_int_100',
    settlementType: 'PAYMENT',
    grossAmount: 20000,
    netAmount: 18000,
    platformFee: 2000,
    instructorAmount: 18000,
    settledAt: new Date().toISOString(),
    installmentStatus: 'PAID'
  };

  const res1 = await engine.processSettlement({ settlement: eligibleSettlement });
  assert(res1.success === true, 'Eligible settlement processed successfully');
  assert(res1.status === 'READY', 'Status is set to READY');
  assert(res1.payoutKey === 'payout_inst_inst_int_100_set_set_int_001', 'Deterministic payout_key matches');
  assert(payoutsStore.length === 1, 'Payout record stored in database');
  assert(payoutsStore[0].status === 'READY', 'Database status is READY');
  assert(transactionsStore.length === 1, 'Event Ledger transaction created');
  assert(transactionsStore[0].ledger_event_type === 'PAYOUT_SCHEDULED', 'Ledger event type is PAYOUT_SCHEDULED');

  // ----------------------------------------------------
  // TEST 2: End-to-End BLOCKED Flow for Ineligible Settlement
  // ----------------------------------------------------
  console.log('\n--- TEST 2: End-to-End BLOCKED Flow ---');
  const ineligibleSettlement: EligibleSettlementDTO = {
    id: 'set_int_002',
    providerPaymentId: 'pay_asaas_int_002',
    instructorId: 'inst_int_100',
    settlementType: 'REFUND', // Ineligible
    grossAmount: 5000,
    netAmount: 4500,
    platformFee: 500,
    instructorAmount: 4500,
    settledAt: new Date().toISOString(),
    installmentStatus: 'PAID'
  };

  const res2 = await engine.processSettlement({ settlement: ineligibleSettlement });
  assert(res2.success === true, 'Ineligible settlement processed cleanly');
  assert(res2.status === 'BLOCKED', 'Status is set to BLOCKED');
  assert(payoutsStore.length === 2, 'Ineligible payout record stored in database');
  assert(payoutsStore[1].status === 'BLOCKED', 'Database status is BLOCKED');
  assert(transactionsStore.length === 2, 'Event Ledger entry created for BLOCKED event');
  assert(transactionsStore[1].ledger_event_type === 'PAYOUT_BLOCKED', 'Ledger event type is PAYOUT_BLOCKED');

  // ----------------------------------------------------
  // TEST 3: Idempotent Reprocessing of Same Settlement
  // ----------------------------------------------------
  console.log('\n--- TEST 3: Idempotency Verification ---');
  const initialStoreCount = payoutsStore.length;
  const initialTxCount = transactionsStore.length;

  const res3 = await engine.processSettlement({ settlement: eligibleSettlement });
  assert(res3.success === true, 'Reprocessing same settlement returns success');
  assert(res3.status === 'READY', 'Status remains READY');
  assert(payoutsStore.length === initialStoreCount, 'No duplicate payout row created');
  assert(transactionsStore.length === initialTxCount, 'Event Ledger transaction deduplicated via idempotency_key');

  // ----------------------------------------------------
  // TEST 4: Unique Settlement ID Enforcement
  // ----------------------------------------------------
  console.log('\n--- TEST 4: Unique Settlement Constraint ---');
  const duplicateSettlementId: EligibleSettlementDTO = {
    ...eligibleSettlement,
    instructorId: 'inst_int_999' // Different instructor, same settlement_id
  };

  const res4 = await engine.processSettlement({ settlement: duplicateSettlementId });
  assert(res4.success === false, 'Re-using settlement_id with different payout_key fails UNIQUE constraint');
  assert(res4.error?.includes('23505') || res4.error?.includes('UNIQUE') || false, 'Error code identifies UNIQUE constraint violation');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passedTests} Passed, ${failedTests} Failed`);
  console.log('------------------------------------------------------\n');

  if (failedTests > 0) process.exit(1);
}

runIntegrationTests().catch((err) => {
  console.error('Fatal integration test error:', err);
  process.exit(1);
});
