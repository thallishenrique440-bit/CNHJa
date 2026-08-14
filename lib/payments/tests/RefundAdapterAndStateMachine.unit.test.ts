import { adaptAsaasRefunds } from '../AsaasRefundAdapter.js';
import { applyRefundTransition } from '../RefundStateMachine.js';

const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

check(adaptAsaasRefunds({ status: 'RECEIVED' }).status === 'UNKNOWN', 'missing refunds is UNKNOWN');
check(adaptAsaasRefunds({ status: 'RECEIVED', refunds: null }).status === 'UNKNOWN', 'null refunds is UNKNOWN');
check(adaptAsaasRefunds({ status: 'RECEIVED', refunds: [] }, { refundsComplete: true }).status === 'NONE', 'complete empty refunds is NONE');
check(adaptAsaasRefunds({ refunds: [{ status: 'PENDING', value: 100 }] }).status === 'PENDING', 'pending refund is PENDING');
check(adaptAsaasRefunds({ refunds: [{ status: 'DONE', value: 100, refundedSplits: [{ value: 90 }] }] }).completedValueCents === 10000, 'DONE amount uses refund.value');
check(adaptAsaasRefunds({ refunds: [{ status: 'DONE', value: 100 }, { status: 'DONE', value: 100 }] }).completedValueCents === 20000, 'multiple refunds are accumulated');
check(adaptAsaasRefunds({ refunds: [{ status: 'DENIED', value: 100 }] }).status === 'DENIED', 'denied refund is DENIED');
check(adaptAsaasRefunds({ status: 'PARTIALLY_REFUNDED', refunds: [{ status: 'DONE', value: 100 }, { status: 'PENDING', value: 100 }] }).status === 'PARTIALLY_COMPLETED', 'partial completion is explicit');
check(applyRefundTransition('UNKNOWN', 'PENDING').conflict, 'UNKNOWN without gateway evidence cannot transition');
check(applyRefundTransition('UNKNOWN', 'PENDING', { source: 'provider_refunds', complete: true }).applied, 'UNKNOWN can reconcile from provider evidence');
check(applyRefundTransition('DENIED', 'COMPLETED', { source: 'webhook', complete: true }).conflict, 'denied is not silently overwritten');
check(applyRefundTransition('COMPLETED', 'DENIED', { source: 'webhook', complete: true }).conflict, 'completed is not downgraded');

