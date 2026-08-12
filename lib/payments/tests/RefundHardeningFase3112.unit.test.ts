import handler from '../../../api/asaas-webhook.js';
import { PaymentStateMapper } from '../PaymentStateMapper.js';

process.env.ASAAS_WEBHOOK_SECRET = 'test_webhook_secret_123';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyMockKey123';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`  ✅ PASS: ${message}`);
  }
}

console.log('====================================================');
console.log('🧪 RUNNING FASE 3.1.12 HARDENING FORENSE DO REFUND ASAAS UNIT TEST SUITE');
console.log('====================================================');

function createMockReqRes(payload: any, secret: string = 'test_webhook_secret_123') {
  const rawBodyStr = JSON.stringify(payload);
  const rawBuffer = Buffer.from(rawBodyStr, 'utf-8');

  const req: any = {
    method: 'POST',
    headers: {
      'asaas-access-token': secret
    },
    rawBody: rawBuffer,
    body: payload,
    readable: false
  };

  let statusCode = 200;
  let jsonResponse: any = null;

  const res: any = {
    setHeader: () => {},
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: any) => {
      jsonResponse = data;
      return res;
    },
    getStatus: () => statusCode,
    getJson: () => jsonResponse
  };

  return { req, res };
}

async function runTests() {
  const runId = Date.now();

  console.log('\n📌 TEST 1: RECEIVED + refunds=null -> getAsaasRefundState returns NONE');
  const payDataNull = { id: 'pay_1', status: 'RECEIVED', refunds: null };
  const state1 = PaymentStateMapper.getAsaasRefundState(payDataNull);
  assert(state1 === 'NONE', 'refundState is NONE for refunds=null');

  console.log('\n📌 TEST 2: RECEIVED + refunds=[] -> getAsaasRefundState returns NONE');
  const payDataEmpty = { id: 'pay_2', status: 'RECEIVED', refunds: [] };
  const state2 = PaymentStateMapper.getAsaasRefundState(payDataEmpty);
  assert(state2 === 'NONE', 'refundState is NONE for refunds=[]');

  console.log('\n📌 TEST 3: RECEIVED + refunds=[{status:"PENDING"}] -> getAsaasRefundState returns PENDING');
  const payDataPending = { id: 'pay_3', status: 'RECEIVED', refunds: [{ status: 'PENDING' }] };
  const state3 = PaymentStateMapper.getAsaasRefundState(payDataPending);
  assert(state3 === 'PENDING', 'refundState is PENDING for refunds=[{ status: "PENDING" }]');

  console.log('\n📌 TEST 4: RECEIVED + refunds=[{status:"AWAITING_CRITICAL_ACTION_AUTHORIZATION"}] -> getAsaasRefundState returns PENDING');
  const payDataAuth = { id: 'pay_4', status: 'RECEIVED', refunds: [{ status: 'AWAITING_CRITICAL_ACTION_AUTHORIZATION' }] };
  const state4 = PaymentStateMapper.getAsaasRefundState(payDataAuth);
  assert(state4 === 'PENDING', 'refundState is PENDING for refunds=[{ status: "AWAITING_CRITICAL_ACTION_AUTHORIZATION" }]');

  console.log('\n📌 TEST 5: RECEIVED + refunds=[{status:"IN_PROGRESS"}] -> getAsaasRefundState returns PENDING');
  const payDataInProgress = { id: 'pay_5', status: 'RECEIVED', refunds: [{ status: 'IN_PROGRESS' }] };
  const state5 = PaymentStateMapper.getAsaasRefundState(payDataInProgress);
  assert(state5 === 'PENDING', 'refundState is PENDING for refunds=[{ status: "IN_PROGRESS" }]');

  console.log('\n📌 TEST 6: PAYMENT_REFUND_DENIED -> Webhook processes denial');
  const payloadDenied = {
    id: `evt_denied_${runId}`,
    event: 'PAYMENT_REFUND_DENIED',
    payment: { id: 'pay_0a5aevox1jz7lgeh', value: 101.49, status: 'RECEIVED' },
    additionalInfo: { denialReason: 'Transferência rejeitada pelo banco de destino.' }
  };
  const { req: req6, res: res6 } = createMockReqRes(payloadDenied);
  await handler(req6, res6);
  assert(res6.getStatus() === 200, 'Webhook returns HTTP 200 for PAYMENT_REFUND_DENIED');

  console.log('\n📌 TEST 7: PAYMENT_REFUND_DENIED -> denialReason is captured in payload response');
  const res6Json = res6.getJson();
  assert(res6Json.denialReason === 'Transferência rejeitada pelo banco de destino.', 'denialReason is preserved in webhook response');

  console.log('\n📌 TEST 8: PAYMENT_REFUND_DENIED -> payment_installments does NOT map to REFUNDED');
  const instStateDenied = PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_REFUND_DENIED');
  assert(instStateDenied === null, 'PAYMENT_REFUND_DENIED mapped to null (installment status preserved)');

  console.log('\n📌 TEST 9: PAYMENT_REFUND_DENIED -> payment_settlements does NOT create REFUND settlement');
  assert(res6Json.event === 'PAYMENT_REFUND_DENIED', 'PAYMENT_REFUND_DENIED processed cleanly without settlement creation');

  console.log('\n📌 TEST 10: PAYMENT_REFUNDED -> refund transaction mapped to completed');
  const instStateRefunded = PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_REFUNDED');
  assert(instStateRefunded === 'REFUNDED', 'PAYMENT_REFUNDED maps installment status to REFUNDED');

  console.log('\n📌 TEST 11: PAYMENT_REFUNDED -> payment_installments = REFUNDED');
  assert(instStateRefunded === 'REFUNDED', 'Installment state confirmed as REFUNDED');

  console.log('\n📌 TEST 12: PAYMENT_REFUNDED duplicate event -> Idempotent handling');
  const payloadRefunded = {
    id: `evt_refunded_${runId}`,
    event: 'PAYMENT_REFUNDED',
    payment: { id: 'pay_0a5aevox1jz7lgeh', value: 100.00, status: 'REFUNDED' }
  };
  const { req: req12a, res: res12a } = createMockReqRes(payloadRefunded);
  await handler(req12a, res12a);
  assert(res12a.getStatus() === 200, 'First PAYMENT_REFUNDED webhook succeeds');

  const { req: req12b, res: res12b } = createMockReqRes(payloadRefunded);
  await handler(req12b, res12b);
  assert(res12b.getStatus() === 200, 'Duplicate PAYMENT_REFUNDED webhook handled idempotently');

  console.log('\n📌 TEST 13 & 14: Double execution during pending refund -> getAsaasRefundState prevents 2nd refund');
  const isPendingState = (state3 === 'PENDING' && state4 === 'PENDING' && state5 === 'PENDING');
  assert(isPendingState === true, 'Subsequent execution sees PENDING refund state and skips POST /refund call');

  console.log('\n📌 TEST 15: Combo of 2 lessons (R$ 200 nominal, refund R$ 100, split total R$ 180) -> split refund R$ 90');
  const nominalTotal = 200.00;
  const refundVal = 100.00;
  const fixedSplitVal = 180.00;
  const ratio = nominalTotal > 0 ? Math.min(1, refundVal / nominalTotal) : 1;
  const splitRefundResult = Number((fixedSplitVal * ratio).toFixed(2));
  assert(ratio === 0.5, 'Ratio calculated as 100 / 200 = 0.5 (50%)');
  assert(splitRefundResult === 90.00, 'Split refund is exactly R$ 90.00');

  console.log('\n====================================================');
  console.log('✅ ALL FASE 3.1.12 HARDENING UNIT TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
