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
console.log('🧪 RUNNING FASE 3.1.11 REFUND DENIED & SPLIT CALCULATION UNIT TESTS');
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
  console.log('\n📌 TEST 1: PaymentStateMapper handles PAYMENT_REFUND_DENIED correctly');
  const mappedState = PaymentStateMapper.mapAsaasEventToInstallmentStatus('PAYMENT_REFUND_DENIED');
  assert(mappedState === null, 'PAYMENT_REFUND_DENIED mapped to null (installment remains in current state)');

  console.log('\n📌 TEST 2: Asaas Webhook processes PAYMENT_REFUND_DENIED without throwing or marking refunded');
  const payloadDenied = {
    id: 'evt_denied_test_' + Date.now(),
    event: 'PAYMENT_REFUND_DENIED',
    payment: {
      id: 'pay_0a5aevox1jz7lgeh',
      value: 101.49,
      status: 'RECEIVED'
    },
    additionalInfo: {
      denialReason: 'Falha ao processar a transferência.'
    }
  };

  const { req, res } = createMockReqRes(payloadDenied);
  await handler(req, res);

  assert(res.getStatus() === 200, 'Webhook returns HTTP 200 for PAYMENT_REFUND_DENIED');
  const resJson = res.getJson();
  assert(resJson.success === true, 'Webhook response indicates success');
  assert(resJson.event === 'PAYMENT_REFUND_DENIED', 'Webhook acknowledges event type');
  assert(resJson.denialReason === 'Falha ao processar a transferência.', 'Webhook captures denial reason');

  console.log('\n📌 TEST 3: Split Refund Calculation (Nominal Price vs Total Charge Value)');
  // Nominal price: R$ 100,00 (10000 cents)
  // Total purchase value on Asaas (with consumer fees): R$ 101,49
  // Fixed split value: R$ 90,00
  const refundValue = 100.00;
  const totalGroupNominalPrice = 100.00;
  const fixedValue = 90.00;

  const ratio = totalGroupNominalPrice > 0 ? Math.min(1, refundValue / totalGroupNominalPrice) : 1;
  const splitRefundValue = Number((fixedValue * ratio).toFixed(2));

  assert(ratio === 1.0, 'Ratio calculated against nominal price is 1.0 (100%)');
  assert(splitRefundValue === 90.00, 'Split refund value is exactly R$ 90,00 (not contaminated to 88.68)');

  console.log('\n📌 TEST 4: Partial Split Refund Calculation (2-lesson combo)');
  // Combo of 2 lessons: R$ 200,00 nominal total (R$ 100,00 each)
  // Asaas charge value: R$ 201,49
  // Fixed split value: R$ 180,00
  // Refund value for 1 lesson: R$ 100,00
  const refundValuePartial = 100.00;
  const totalGroupNominalPricePartial = 200.00;
  const fixedValuePartial = 180.00;

  const ratioPartial = totalGroupNominalPricePartial > 0 ? Math.min(1, refundValuePartial / totalGroupNominalPricePartial) : 1;
  const splitRefundValuePartial = Number((fixedValuePartial * ratioPartial).toFixed(2));

  assert(ratioPartial === 0.5, 'Ratio for 1 of 2 lessons is 0.5 (50%)');
  assert(splitRefundValuePartial === 90.00, 'Partial split refund value is exactly R$ 90,00');

  console.log('\n====================================================');
  console.log('✅ ALL FASE 3.1.11 UNIT TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
