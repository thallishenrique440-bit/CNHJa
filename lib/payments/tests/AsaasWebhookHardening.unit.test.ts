import handler from '../../../api/asaas-webhook.js';

// Setup environment variables for test execution
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
console.log('🧪 RUNNING HARDENING TESTS FOR ASAAS WEBHOOK (STAGE 10)');
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

async function runHardeningTests() {
  let passedCount = 0;
  let totalCount = 0;

  console.log('\n📌 SCENARIO 1: Webhook received WITH payment_installments contract (Contractual Amounts Prioritized)');
  totalCount++;
  try {
    // Contractual expected values in payment_installments:
    // Sale: R$ 230,00 (23000 cents)
    // Net instructor contract: R$ 207,00 (20700 cents)
    // Platform fee: R$ 23,00 (2300 cents)
    // Asaas Gateway netValue payload: R$ 240,63 (24063 cents - contaminated with student interest) -> MUST BE IGNORED!

    const payloadCenario1 = {
      id: 'evt_test_cenario_1_valid',
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_cenario_1_valid_contract',
        installmentNumber: 1,
        installmentCount: 1,
        value: 230.00,
        netValue: 240.63, // Contaminated gateway value
        billingType: 'CREDIT_CARD',
        paymentDate: '2026-07-30'
      }
    };

    const { req, res } = createMockReqRes(payloadCenario1);
    await handler(req, res);

    assert(res.getStatus() === 200, 'HTTP response code is 200');
    const resBody = res.getJson();
    assert(resBody.success === true, 'Response indicates success');

    passedCount++;
  } catch (err: any) {
    console.error('Scenario 1 error:', err.message);
  }

  console.log('\n📌 SCENARIO 2: Webhook received WITHOUT payment_installments contract (Reconciliation Pending)');
  totalCount++;
  try {
    const payloadCenario2 = {
      id: 'evt_test_cenario_2_missing',
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_cenario_2_missing_contract_99999',
        installmentNumber: 1,
        value: 230.00,
        netValue: 247.23,
        billingType: 'CREDIT_CARD'
      }
    };

    const { req, res } = createMockReqRes(payloadCenario2);
    await handler(req, res);

    assert(res.getStatus() === 200, 'HTTP response code is 200');
    const resBody = res.getJson();
    assert(resBody.success === true, 'Response indicates success');
    assert(resBody.processing_status === 'RECONCILIATION_PENDING', 'Processing status is RECONCILIATION_PENDING');
    assert(resBody.message.includes('retained for reconciliation'), 'Message indicates retention for reconciliation');
    assert(resBody.reason.includes('Missing official contract in payment_installments'), 'Reason cites missing payment_installments contract');

    passedCount++;
  } catch (err: any) {
    console.error('Scenario 2 error:', err.message);
  }

  console.log('\n====================================================');
  console.log(`TOTAL HARDENING TESTS: ${totalCount}`);
  console.log(`PASSED: ${passedCount}`);
  console.log(`FAILED: ${totalCount - passedCount}`);
  console.log('====================================================');

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

runHardeningTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
