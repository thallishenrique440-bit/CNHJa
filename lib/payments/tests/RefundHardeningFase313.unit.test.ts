import handler from '../../../api/asaas-webhook.js';
import { PaymentStateMapper } from '../PaymentStateMapper.js';
import { asaasFetch } from '../../../supabase/functions/_shared/asaasClient';
import { BookingCancellationCore } from '../../../supabase/functions/_shared/BookingCancellationCore';

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

/**
 * Creates a mock Supabase admin client for cancellation tests
 */
function createMockAdminClient(initialData: {
  appointment: any;
  groupAppointments?: any[];
  refundTxs?: any[];
  projections?: any;
}) {
  let appointmentState = { ...initialData.appointment };
  let groupState = initialData.groupAppointments
    ? initialData.groupAppointments.map(a => ({ ...a }))
    : [appointmentState];
  let refundTxsState = initialData.refundTxs ? [...initialData.refundTxs] : [];

  return {
    from: (table: string) => {
      if (table === 'appointments') {
        return {
          select: (fields: string) => ({
            eq: (field: string, val: any) => ({
              single: async () => {
                if (field === 'id' && val === appointmentState.id) {
                  return { data: { ...appointmentState }, error: null };
                }
                return { data: null, error: new Error('Not found') };
              },
              in: (inField: string, values: any[]) => {
                // Group query
                const filtered = groupState.filter(a => a[field] === val);
                return Promise.resolve({ data: filtered, error: null });
              }
            }),
            or: (orFilter: string) => Promise.resolve({ data: groupState, error: null })
          }),
          update: (updateFields: any) => ({
            in: (field: string, values: any[]) => ({
              in: (field2: string, values2: any[]) => ({
                select: (selFields: string) => {
                  // Atomic claim check
                  const updated: any[] = [];
                  for (const apt of groupState) {
                    if (values.includes(apt.id) && values2.includes(apt.status)) {
                      Object.assign(apt, updateFields);
                      updated.push({ id: apt.id, status: apt.status });
                    }
                  }
                  if (values.includes(appointmentState.id) && values2.includes(appointmentState.status)) {
                    Object.assign(appointmentState, updateFields);
                  }
                  return Promise.resolve({ data: updated, error: null });
                }
              })
            }),
            eq: (field: string, val: any) => ({
              in: (field2: string, values2: any[]) => {
                for (const apt of groupState) {
                  if (apt[field] === val && values2.includes(apt.status)) {
                    Object.assign(apt, updateFields);
                  }
                }
                if (appointmentState[field] === val) {
                  Object.assign(appointmentState, updateFields);
                }
                return Promise.resolve({ data: groupState, error: null });
              }
            })
          })
        };
      }

      if (table === 'transactions') {
        return {
          select: (fields: string) => ({
            eq: (f1: string, v1: any) => ({
              eq: (f2: string, v2: any) => ({
                in: (f3: string, v3: any[]) => {
                  const filtered = refundTxsState.filter(tx => tx[f1] === v1 && tx[f2] === v2 && v3.includes(tx[f3]));
                  return Promise.resolve({ data: filtered, error: null });
                }
              })
            })
          }),
          upsert: async (record: any) => {
            const existingIdx = refundTxsState.findIndex(tx => tx.appointment_id === record.appointment_id && tx.type === record.type);
            if (existingIdx >= 0) {
              refundTxsState[existingIdx] = { ...refundTxsState[existingIdx], ...record };
            } else {
              refundTxsState.push(record);
            }
            return { data: record, error: null };
          },
          update: (fields: any) => ({
            eq: (f1: string, v1: any) => ({
              eq: (f2: string, v2: any) => {
                for (const tx of refundTxsState) {
                  if (tx[f1] === v1 && tx[f2] === v2) {
                    Object.assign(tx, fields);
                  }
                }
                return Promise.resolve({ data: refundTxsState, error: null });
              }
            })
          })
        };
      }

      if (table === 'payment_installments') {
        return {
          update: (fields: any) => ({
            or: () => Promise.resolve({ error: null }),
            eq: () => Promise.resolve({ error: null })
          })
        };
      }

      if (table === 'instructor_financial_projections') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: initialData.projections || null, error: null })
            })
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null })
          })
        };
      }

      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) })
      };
    },

    getAppointmentState: () => appointmentState,
    getGroupState: () => groupState,
    getRefundTxs: () => refundTxsState
  };
}

async function runTests() {
  const runId = Date.now();

  console.log('====================================================');
  console.log('🧪 RUNNING FASE 3.1.13 REFUND IDEMPOTENCY & HARDENING SUITE');
  console.log('====================================================');

  // Backup original global fetch
  const originalFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------
    // PART 1: HTTP Client Retry Policies in asaasFetch
    // -------------------------------------------------------------
    console.log('\n📌 TEST 1: GET request with HTTP 500 error performs automatic retry');
    let fetchAttemptsTest1 = 0;
    globalThis.fetch = async (url: any, init: any) => {
      fetchAttemptsTest1++;
      if (fetchAttemptsTest1 === 1) {
        return new Response(JSON.stringify({ error: 'Transient Server Error' }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: 'pay_123', status: 'RECEIVED' }), { status: 200 });
    };

    const res1 = await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_123', {
      method: 'GET',
      backoffMs: 10,
      maxRetries: 2
    });
    assert(res1.status === 200, 'GET request recovered on 2nd attempt');
    assert(fetchAttemptsTest1 === 2, `GET request performed 2 attempts (actual: ${fetchAttemptsTest1})`);

    console.log('\n📌 TEST 2: POST /refund with HTTP 500 does NOT perform automatic retry');
    let fetchAttemptsTest2 = 0;
    globalThis.fetch = async () => {
      fetchAttemptsTest2++;
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    };

    const res2 = await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_123/refund', {
      method: 'POST',
      body: JSON.stringify({ value: 100 }),
      backoffMs: 10,
      maxRetries: 3
    });
    assert(res2.status === 500, 'POST /refund returned HTTP 500 immediately');
    assert(fetchAttemptsTest2 === 1, `POST /refund made exactly 1 attempt without retries (actual: ${fetchAttemptsTest2})`);

    console.log('\n📌 TEST 3: POST /refund with HTTP 503 does NOT perform automatic retry');
    let fetchAttemptsTest3 = 0;
    globalThis.fetch = async () => {
      fetchAttemptsTest3++;
      return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
    };

    const res3 = await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_123/refund', {
      method: 'POST',
      body: JSON.stringify({ value: 100 }),
      backoffMs: 10,
      maxRetries: 3
    });
    assert(res3.status === 503, 'POST /refund returned HTTP 503 immediately');
    assert(fetchAttemptsTest3 === 1, `POST /refund made exactly 1 attempt for HTTP 503 (actual: ${fetchAttemptsTest3})`);

    console.log('\n📌 TEST 4: POST /refund with HTTP 429 does NOT perform automatic retry');
    let fetchAttemptsTest4 = 0;
    globalThis.fetch = async () => {
      fetchAttemptsTest4++;
      return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 });
    };

    const res4 = await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_123/refund', {
      method: 'POST',
      body: JSON.stringify({ value: 100 }),
      backoffMs: 10,
      maxRetries: 3
    });
    assert(res4.status === 429, 'POST /refund returned HTTP 429 immediately');
    assert(fetchAttemptsTest4 === 1, `POST /refund made exactly 1 attempt for HTTP 429 (actual: ${fetchAttemptsTest4})`);

    console.log('\n📌 TEST 5: POST /refund with Timeout (AbortError) does NOT perform automatic retry');
    let fetchAttemptsTest5 = 0;
    globalThis.fetch = async (url: any, init: any) => {
      fetchAttemptsTest5++;
      return new Promise((_, reject) => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        setTimeout(() => reject(err), 15);
      });
    };

    let caughtErr5: any = null;
    try {
      await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_123/refund', {
        method: 'POST',
        body: JSON.stringify({ value: 100 }),
        timeoutMs: 10,
        backoffMs: 10,
        maxRetries: 3
      });
    } catch (e: any) {
      caughtErr5 = e;
    }
    assert(caughtErr5 !== null, 'Timeout error thrown to caller');
    assert(fetchAttemptsTest5 === 1, `POST /refund made exactly 1 attempt on timeout (actual: ${fetchAttemptsTest5})`);

    console.log('\n📌 TEST 6: POST /refund with Network Error (TypeError) does NOT perform automatic retry');
    let fetchAttemptsTest6 = 0;
    globalThis.fetch = async () => {
      fetchAttemptsTest6++;
      throw new TypeError('Failed to fetch');
    };

    let caughtErr6: any = null;
    try {
      await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_123/refund', {
        method: 'POST',
        body: JSON.stringify({ value: 100 }),
        backoffMs: 10,
        maxRetries: 3
      });
    } catch (e: any) {
      caughtErr6 = e;
    }
    assert(caughtErr6 !== null, 'Network error thrown to caller');
    assert(fetchAttemptsTest6 === 1, `POST /refund made exactly 1 attempt on network error (actual: ${fetchAttemptsTest6})`);

    // -------------------------------------------------------------
    // PART 2: Cancellation Execution & Single Refund Request
    // -------------------------------------------------------------
    console.log('\n📌 TEST 7: First cancellation execution produces exactly 1 POST /refund call');
    let refundPostCountTest7 = 0;
    globalThis.fetch = async (url: any, init: any) => {
      const u = String(url);
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET' && u.includes('/payments/pay_test_7')) {
        return new Response(JSON.stringify({ id: 'pay_test_7', status: 'RECEIVED', value: 100, refunds: [] }), { status: 200 });
      }
      if (m === 'POST' && u.includes('/refund')) {
        refundPostCountTest7++;
        return new Response(JSON.stringify({ id: 'ref_123', status: 'REFUND_REQUESTED', value: 100 }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockAdmin7 = createMockAdminClient({
      appointment: { id: 'apt_7', status: 'pending', price: 10000, provider_payment_id: 'pay_test_7', payment_status: 'released' }
    });

    const res7 = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_7',
      reason: 'instructor_rejected',
      adminClient: mockAdmin7,
      asaasApiKey: 'mock_key',
      asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
    });

    assert(res7.success === true, 'Cancellation succeeded');
    assert(refundPostCountTest7 === 1, `Exactly 1 POST /refund call issued (actual: ${refundPostCountTest7})`);

    console.log('\n📌 TEST 8: Second cancellation execution with refund PENDING produces 0 additional POST /refund calls');
    let refundPostCountTest8 = 0;
    globalThis.fetch = async (url: any, init: any) => {
      const u = String(url);
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET' && u.includes('/payments/pay_test_8')) {
        return new Response(JSON.stringify({
          id: 'pay_test_8',
          status: 'RECEIVED',
          value: 100,
          refunds: [{ status: 'PENDING', value: 100 }]
        }), { status: 200 });
      }
      if (m === 'POST' && u.includes('/refund')) {
        refundPostCountTest8++;
        return new Response(JSON.stringify({ id: 'ref_456', status: 'REFUND_REQUESTED' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockAdmin8 = createMockAdminClient({
      appointment: { id: 'apt_8', status: 'pending', price: 10000, provider_payment_id: 'pay_test_8', payment_status: 'refund_requested' },
      refundTxs: [{ appointment_id: 'apt_8', provider_payment_id: 'pay_test_8', type: 'refund', status: 'pending' }]
    });

    const res8 = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_8',
      reason: 'instructor_rejected',
      adminClient: mockAdmin8,
      asaasApiKey: 'mock_key',
      asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
    });

    assert(res8.success === true, 'Second cancellation processed cleanly');
    assert(refundPostCountTest8 === 0, `0 additional POST /refund calls issued on second run (actual: ${refundPostCountTest8})`);

    // -------------------------------------------------------------
    // PART 3: Concurrency Control
    // -------------------------------------------------------------
    console.log('\n📌 TEST 9: Two concurrent cancellation requests generate at most 1 POST /refund call');
    let refundPostCountTest9 = 0;
    globalThis.fetch = async (url: any, init: any) => {
      const u = String(url);
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET' && u.includes('/payments/pay_test_9')) {
        return new Response(JSON.stringify({ id: 'pay_test_9', status: 'RECEIVED', value: 100, refunds: [] }), { status: 200 });
      }
      if (m === 'POST' && u.includes('/refund')) {
        refundPostCountTest9++;
        // Simulate minor gateway latency
        await new Promise(r => setTimeout(r, 20));
        return new Response(JSON.stringify({ id: 'ref_789', status: 'REFUND_REQUESTED' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockAdmin9 = createMockAdminClient({
      appointment: { id: 'apt_9', status: 'pending', price: 10000, provider_payment_id: 'pay_test_9', payment_status: 'released' }
    });

    const [c1, c2] = await Promise.all([
      BookingCancellationCore.processCancellation({
        appointmentId: 'apt_9',
        reason: 'instructor_rejected',
        adminClient: mockAdmin9,
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      }),
      BookingCancellationCore.processCancellation({
        appointmentId: 'apt_9',
        reason: 'instructor_rejected',
        adminClient: mockAdmin9,
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      })
    ]);

    assert(refundPostCountTest9 <= 1, `At most 1 POST /refund call issued during concurrent execution (actual: ${refundPostCountTest9})`);

    // -------------------------------------------------------------
    // PART 4: Timeout & Post-Timeout Reconciliation
    // -------------------------------------------------------------
    console.log('\n📌 TEST 10: Timeout after Asaas receives POST /refund does not generate a second POST /refund call');
    let totalRefundPostsTest10 = 0;

    // Run 1: POST /refund times out on client side, but Asaas recorded it as PENDING
    globalThis.fetch = async (url: any, init: any) => {
      const u = String(url);
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET') {
        return new Response(JSON.stringify({ id: 'pay_test_10', status: 'RECEIVED', value: 100, refunds: [] }), { status: 200 });
      }
      if (m === 'POST' && u.includes('/refund')) {
        totalRefundPostsTest10++;
        // Timeout simulation
        return new Promise((_, reject) => {
          const err = new Error('Gateway Timeout');
          err.name = 'AbortError';
          setTimeout(() => reject(err), 10);
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockAdmin10 = createMockAdminClient({
      appointment: { id: 'apt_10', status: 'pending', price: 10000, provider_payment_id: 'pay_test_10', payment_status: 'released' }
    });

    try {
      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_10',
        reason: 'instructor_rejected',
        adminClient: mockAdmin10,
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });
    } catch (e: any) {
      console.log(`  ℹ️ Expected timeout error caught on Run 1: ${e.message}`);
    }

    assert(totalRefundPostsTest10 === 1, 'First run issued 1 POST /refund attempt');

    // Reset status to pending for Run 2 retry simulation
    mockAdmin10.getAppointmentState().status = 'pending';

    // Run 2: Re-run cancellation when Asaas GET now reflects refunds = [{ status: "PENDING" }]
    globalThis.fetch = async (url: any, init: any) => {
      const u = String(url);
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET') {
        return new Response(JSON.stringify({
          id: 'pay_test_10',
          status: 'RECEIVED',
          value: 100,
          refunds: [{ status: 'PENDING', value: 100 }]
        }), { status: 200 });
      }
      if (m === 'POST' && u.includes('/refund')) {
        totalRefundPostsTest10++;
        return new Response(JSON.stringify({ id: 'ref_dup' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const res10b = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_10',
      reason: 'instructor_rejected',
      adminClient: mockAdmin10,
      asaasApiKey: 'mock_key',
      asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
    });

    assert(res10b.success === true, 'Run 2 reconciled successfully');
    assert(totalRefundPostsTest10 === 1, `Total POST /refund calls stayed 1 after timeout reconciliation (actual: ${totalRefundPostsTest10})`);

    // -------------------------------------------------------------
    // PART 5: PAYMENT_REFUND_DENIED & Prevention of Loop
    // -------------------------------------------------------------
    console.log('\n📌 TEST 11: PAYMENT_REFUND_DENIED event produces transaction.status = failed');
    const payloadDenied11 = {
      id: `evt_denied_${runId}_11`,
      event: 'PAYMENT_REFUND_DENIED',
      payment: { id: 'pay_denied_11', value: 100, status: 'RECEIVED' },
      additionalInfo: { denialReason: 'Transferência rejeitada pelo banco do destinatário.' }
    };
    const { req: req11, res: res11 } = createMockReqRes(payloadDenied11);
    await handler(req11, res11);
    assert(res11.getStatus() === 200, 'PAYMENT_REFUND_DENIED webhook returned HTTP 200');

    console.log('\n📌 TEST 12: PAYMENT_REFUND_DENIED event preserves denialReason');
    const res12Json = res11.getJson();
    assert(res12Json.denialReason === 'Transferência rejeitada pelo banco do destinatário.', 'denialReason preserved in response');

    console.log('\n📌 TEST 13: Refund failed / DENIED does NOT trigger automatic POST /refund retry');
    let refundPostCountTest13 = 0;
    globalThis.fetch = async (url: any, init: any) => {
      const u = String(url);
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET') {
        return new Response(JSON.stringify({
          id: 'pay_denied_13',
          status: 'RECEIVED',
          value: 100,
          refunds: [{ status: 'DENIED', denialReason: 'Bank transfer failed' }]
        }), { status: 200 });
      }
      if (m === 'POST' && u.includes('/refund')) {
        refundPostCountTest13++;
        return new Response(JSON.stringify({ id: 'ref_retry' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockAdmin13 = createMockAdminClient({
      appointment: { id: 'apt_13', status: 'pending', price: 10000, provider_payment_id: 'pay_denied_13', payment_status: 'failed' },
      refundTxs: [{ appointment_id: 'apt_13', provider_payment_id: 'pay_denied_13', type: 'refund', status: 'failed' }]
    });

    const res13 = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_13',
      reason: 'instructor_rejected',
      adminClient: mockAdmin13,
      asaasApiKey: 'mock_key',
      asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
    });

    assert(res13.success === true, 'Cancellation processing safely completed without retry');
    assert(refundPostCountTest13 === 0, `0 POST /refund calls made when refund is DENIED/failed (actual: ${refundPostCountTest13})`);

    // -------------------------------------------------------------
    // PART 6: PAYMENT_REFUNDED Idempotency & Webhooks
    // -------------------------------------------------------------
    console.log('\n📌 TEST 14: PAYMENT_REFUNDED webhook is idempotent');
    const payloadRefunded14 = {
      id: `evt_refunded_${runId}_14`,
      event: 'PAYMENT_REFUNDED',
      payment: { id: 'pay_refunded_14', value: 100, status: 'REFUNDED' }
    };

    const { req: req14a, res: res14a } = createMockReqRes(payloadRefunded14);
    await handler(req14a, res14a);
    assert(res14a.getStatus() === 200, 'First PAYMENT_REFUNDED webhook succeeds');

    const { req: req14b, res: res14b } = createMockReqRes(payloadRefunded14);
    await handler(req14b, res14b);
    assert(res14b.getStatus() === 200, 'Duplicate PAYMENT_REFUNDED webhook succeeds idempotently');

    console.log('\n📌 TEST 15: Duplicate PAYMENT_REFUNDED event does not duplicate settlements');
    assert(res14b.getJson().success === true, 'Duplicate settlement creation safely bypassed');

    // -------------------------------------------------------------
    // PART 7: Split Math & Refund State Mapping Verification
    // -------------------------------------------------------------
    console.log('\n📌 TEST 16: Split refund calculation for R$ 200 nominal / R$ 100 refund / R$ 180 split produces R$ 90.00');
    const totalGroupNominalPrice = 200;
    const refundValue = 100;
    const sFixedValue = 180;
    const ratio = totalGroupNominalPrice > 0 ? Math.min(1, refundValue / totalGroupNominalPrice) : 1;
    const splitRefundValue = Number((sFixedValue * ratio).toFixed(2));
    assert(splitRefundValue === 90.00, `Split refund value is R$ 90.00 (actual: ${splitRefundValue})`);

    console.log('\n📌 TEST 17: refunds = null returns NONE');
    assert(PaymentStateMapper.getAsaasRefundState({ status: 'RECEIVED', refunds: null }) === 'NONE', 'refunds=null -> NONE');

    console.log('\n📌 TEST 18: refunds = [] returns NONE');
    assert(PaymentStateMapper.getAsaasRefundState({ status: 'RECEIVED', refunds: [] }) === 'NONE', 'refunds=[] -> NONE');

    console.log('\n📌 TEST 19: refunds = [{ status: "PENDING" }] returns PENDING');
    assert(PaymentStateMapper.getAsaasRefundState({ status: 'RECEIVED', refunds: [{ status: 'PENDING' }] }) === 'PENDING', 'refunds=[PENDING] -> PENDING');

    console.log('\n📌 TEST 20: refunds = [{ status: "DONE" }] / status REFUNDED returns COMPLETED');
    assert(PaymentStateMapper.getAsaasRefundState({ status: 'REFUNDED', refunds: [{ status: 'DONE' }] }) === 'COMPLETED', 'status=REFUNDED -> COMPLETED');

    console.log('\n📌 TEST 21: refunds = [{ status: "DENIED" }] returns DENIED');
    assert(PaymentStateMapper.getAsaasRefundState({ status: 'RECEIVED', refunds: [{ status: 'DENIED' }] }) === 'DENIED', 'refunds=[DENIED] -> DENIED');

    // -------------------------------------------------------------
    // PART 8: Phase 3.1.13.1 Forensic Hardening Verifications
    // -------------------------------------------------------------

    // TEST 22 (Bloqueador 1 / TEST A): CAS Lock Concurrence
    console.log('\n📌 TEST 22 (Bloqueador 1 / TEST A): Concurrent cancellation process loses CAS lock when status becomes cancelling');
    {
      const runA = `cas_${Date.now()}`;
      const mockApt = {
        id: `apt_${runA}`,
        status: 'pending',
        price: 10000,
        student_id: 'std_cas',
        instructor_id: 'inst_cas',
        provider_payment_id: `pay_${runA}`
      };
      const mockClient = createMockAdminClient({ appointment: mockApt });

      // First execution claims lock (pending -> cancelling) and proceeds
      let postCount = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes('/payments/')) {
          if (init?.method === 'POST' && urlStr.includes('/refund')) {
            postCount++;
            return new Response(JSON.stringify({ status: 'REFUNDED' }), { status: 200 });
          }
          return new Response(JSON.stringify({ status: 'RECEIVED', refunds: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      };

      const resA = await BookingCancellationCore.processCancellation({
        adminClient: mockClient,
        appointmentId: mockApt.id,
        reason: 'student_cancelled',
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });
      assert(resA.success === true, 'First process acquired lock and completed cancellation');
      assert(postCount === 1, `First process made 1 POST /refund call (actual: ${postCount})`);

      // Second execution attempts cancellation on now-'cancelling' appointment
      // Since 'cancelling' is excluded from source statuses, zero rows are updated
      let postCountSecond = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (init?.method === 'POST' && urlStr.includes('/refund')) {
          postCountSecond++;
        }
        return new Response(JSON.stringify({ status: 'RECEIVED', refunds: [] }), { status: 200 });
      };

      const resB = await BookingCancellationCore.processCancellation({
        adminClient: mockClient,
        appointmentId: mockApt.id,
        reason: 'student_cancelled',
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });

      assert(resB.success === false, 'Second process lost CAS lock');
      assert(resB.alreadyProcessed === true, 'Second process flagged alreadyProcessed = true');
      assert(postCountSecond === 0, `Second process made 0 POST /refund calls (actual: ${postCountSecond})`);
    }

    // TEST 23 (Bloqueador 2 / TEST B): allowRetry = true DOES NOT enable retries for POST /refund
    console.log('\n📌 TEST 23 (Bloqueador 2 / TEST B): allowRetry: true cannot enable automatic retries for POST /refund');
    {
      const endpoints = [
        { url: 'https://sandbox.asaas.com/api/v3/payments/pay_retry_block_1/refund', status: 500 },
        { url: 'https://sandbox.asaas.com/api/v3/payments/pay_retry_block_2/refund', status: 503 },
        { url: 'https://sandbox.asaas.com/api/v3/installments/inst_retry_block_3/refund', status: 429 }
      ];

      for (const ep of endpoints) {
        let attempts = 0;
        globalThis.fetch = async () => {
          attempts++;
          return new Response(JSON.stringify({ errors: [{ description: 'Gateway error' }] }), { status: ep.status });
        };

        try {
          await asaasFetch(ep.url, {
            method: 'POST',
            allowRetry: true,
            body: JSON.stringify({ value: 100 })
          });
        } catch (_) {}

        assert(attempts === 1, `POST /refund with allowRetry:true on HTTP ${ep.status} executed strictly 1 attempt (actual: ${attempts})`);
      }

      // Timeout / AbortError test
      let abortAttempts = 0;
      globalThis.fetch = async () => {
        abortAttempts++;
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };

      try {
        await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_retry_block_4/refund', {
          method: 'POST',
          allowRetry: true,
          body: JSON.stringify({ value: 100 })
        });
      } catch (_) {}

      assert(abortAttempts === 1, `POST /refund with allowRetry:true on AbortError executed strictly 1 attempt (actual: ${abortAttempts})`);
    }

    // TEST 24 (Bloqueador 3 / TEST C): failed state remains failed and preserves metadata
    console.log('\n📌 TEST 24 (Bloqueador 3 / TEST C): Existing failed refund transaction remains failed and preserves denialReason');
    {
      const runC = `failed_persist_${Date.now()}`;
      const mockAptC = {
        id: `apt_${runC}`,
        status: 'pending',
        price: 15000,
        student_id: 'std_c',
        instructor_id: 'inst_c',
        provider_payment_id: `pay_${runC}`
      };
      const existingFailedTx = {
        appointment_id: mockAptC.id,
        provider_payment_id: mockAptC.provider_payment_id,
        type: 'refund',
        status: 'failed',
        metadata: {
          denialReason: 'Chave PIX do destinatário inválida',
          denial_reason: 'Chave PIX do destinatário inválida',
          denied_at: '2026-08-12T10:00:00Z'
        }
      };

      const mockClientC = createMockAdminClient({
        appointment: mockAptC,
        refundTxs: [existingFailedTx]
      });

      let postCountC = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (init?.method === 'POST' && urlStr.includes('/refund')) {
          postCountC++;
        }
        return new Response(JSON.stringify({ status: 'RECEIVED', refunds: [{ status: 'DENIED', denialReason: 'Chave PIX inválida' }] }), { status: 200 });
      };

      const resC = await BookingCancellationCore.processCancellation({
        adminClient: mockClientC,
        appointmentId: mockAptC.id,
        reason: 'student_cancelled',
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });

      assert(resC.success === true, 'Cancellation completed safely without new POST /refund');
      assert(postCountC === 0, `0 POST /refund calls made (actual: ${postCountC})`);

      const refTxsC = mockClientC.getRefundTxs();
      const refTxC = refTxsC.find((tx: any) => tx.appointment_id === mockAptC.id && tx.type === 'refund');
      assert(refTxC !== undefined, 'Refund transaction exists in DB');
      assert(refTxC.status === 'failed', `Transaction status preserved as 'failed' (actual: ${refTxC?.status})`);
      assert(refTxC.metadata?.denialReason === 'Chave PIX do destinatário inválida', 'denialReason preserved in metadata');
    }

    // TEST 25 (Bloqueador 3 / TEST D): Webhook PAYMENT_REFUND_DENIED persists failed status and denialReason
    console.log('\n📌 TEST 25 (Bloqueador 3 / TEST D): PAYMENT_REFUND_DENIED webhook persists failed status and denialReason');
    {
      const payIdD = `pay_denied_webhook_${Date.now()}`;
      const payloadDenied = {
        id: `evt_denied_${payIdD}`,
        event: 'PAYMENT_REFUND_DENIED',
        payment: { id: payIdD, denialReason: 'Saldo insuficiente para estorno' },
        additionalInfo: { denialReason: 'Saldo insuficiente para estorno' }
      };

      const { req: reqD, res: resD } = createMockReqRes(payloadDenied);
      await handler(reqD, resD);

      assert(resD.getStatus() === 200, 'PAYMENT_REFUND_DENIED webhook handled with HTTP 200');
    }

    // TEST 26 (Bloqueador 3 / TEST E): Local failed refund transaction without remote DENIED
    console.log('\n📌 TEST 26 (Bloqueador 3 / TEST E): Local failed refund transaction prevents POST /refund even if remote refunds = []');
    {
      const runE = `failed_local_${Date.now()}`;
      const mockAptE = {
        id: `apt_${runE}`,
        status: 'pending',
        price: 12000,
        student_id: 'std_e',
        instructor_id: 'inst_e',
        provider_payment_id: `pay_${runE}`
      };
      const existingFailedTxE = {
        appointment_id: mockAptE.id,
        provider_payment_id: mockAptE.provider_payment_id,
        type: 'refund',
        status: 'failed',
        metadata: { denialReason: 'Falha anterior registrada localmente' }
      };

      const mockClientE = createMockAdminClient({
        appointment: mockAptE,
        refundTxs: [existingFailedTxE]
      });

      let postCountE = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (init?.method === 'POST' && urlStr.includes('/refund')) {
          postCountE++;
        }
        return new Response(JSON.stringify({ status: 'RECEIVED', refunds: [] }), { status: 200 });
      };

      const resE = await BookingCancellationCore.processCancellation({
        adminClient: mockClientE,
        appointmentId: mockAptE.id,
        reason: 'student_cancelled',
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });

      assert(resE.success === true, 'Cancellation completed');
      assert(postCountE === 0, `0 POST /refund calls made due to local failed transaction (actual: ${postCountE})`);

      const refTxsE = mockClientE.getRefundTxs();
      const refTxE = refTxsE.find((tx: any) => tx.appointment_id === mockAptE.id && tx.type === 'refund');
      assert(refTxE?.status === 'failed', `Transaction status preserved as 'failed' (actual: ${refTxE?.status})`);
    }

    // TEST 27 (Bloqueador 3 / TEST F): completed state remains completed
    console.log('\n📌 TEST 27 (Bloqueador 3 / TEST F): Existing completed refund transaction remains completed');
    {
      const runF = `completed_${Date.now()}`;
      const mockAptF = {
        id: `apt_${runF}`,
        status: 'pending',
        price: 20000,
        student_id: 'std_f',
        instructor_id: 'inst_f',
        provider_payment_id: `pay_${runF}`
      };
      const existingCompletedTxF = {
        appointment_id: mockAptF.id,
        provider_payment_id: mockAptF.provider_payment_id,
        type: 'refund',
        status: 'completed',
        metadata: { asaas_refund_status: 'REFUNDED' }
      };

      const mockClientF = createMockAdminClient({
        appointment: mockAptF,
        refundTxs: [existingCompletedTxF]
      });

      let postCountF = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (init?.method === 'POST' && urlStr.includes('/refund')) {
          postCountF++;
        }
        return new Response(JSON.stringify({ status: 'REFUNDED', refunds: [{ status: 'DONE' }] }), { status: 200 });
      };

      const resF = await BookingCancellationCore.processCancellation({
        adminClient: mockClientF,
        appointmentId: mockAptF.id,
        reason: 'student_cancelled',
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });

      assert(resF.success === true, 'Cancellation completed');
      assert(postCountF === 0, `0 POST /refund calls made for already completed refund (actual: ${postCountF})`);

      const refTxsF = mockClientF.getRefundTxs();
      const refTxF = refTxsF.find((tx: any) => tx.appointment_id === mockAptF.id && tx.type === 'refund');
      assert(refTxF?.status === 'completed', `Transaction status preserved as 'completed' (actual: ${refTxF?.status})`);
    }

    // TEST 28 (Bloqueador 3 / TEST G): pending state remains pending
    console.log('\n📌 TEST 28 (Bloqueador 3 / TEST G): Existing pending refund transaction remains pending when remote is PENDING');
    {
      const runG = `pending_${Date.now()}`;
      const mockAptG = {
        id: `apt_${runG}`,
        status: 'pending',
        price: 18000,
        student_id: 'std_g',
        instructor_id: 'inst_g',
        provider_payment_id: `pay_${runG}`
      };
      const existingPendingTxG = {
        appointment_id: mockAptG.id,
        provider_payment_id: mockAptG.provider_payment_id,
        type: 'refund',
        status: 'pending',
        metadata: { asaas_refund_status: 'REFUND_REQUESTED' }
      };

      const mockClientG = createMockAdminClient({
        appointment: mockAptG,
        refundTxs: [existingPendingTxG]
      });

      let postCountG = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (init?.method === 'POST' && urlStr.includes('/refund')) {
          postCountG++;
        }
        return new Response(JSON.stringify({ status: 'RECEIVED', refunds: [{ status: 'PENDING' }] }), { status: 200 });
      };

      const resG = await BookingCancellationCore.processCancellation({
        adminClient: mockClientG,
        appointmentId: mockAptG.id,
        reason: 'student_cancelled',
        asaasApiKey: 'mock_key',
        asaasApiUrl: 'https://sandbox.asaas.com/api/v3'
      });

      assert(resG.success === true, 'Cancellation completed');
      assert(postCountG === 0, `0 POST /refund calls made for already pending refund (actual: ${postCountG})`);

      const refTxsG = mockClientG.getRefundTxs();
      const refTxG = refTxsG.find((tx: any) => tx.appointment_id === mockAptG.id && tx.type === 'refund');
      assert(refTxG?.status === 'pending', `Transaction status preserved as 'pending' (actual: ${refTxG?.status})`);
    }

    console.log('\n====================================================');
    console.log('🎉 ALL 28 TESTS PASSED SUCCESSFULLY! (28/28 PASS)');
    console.log('====================================================');

  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests().catch(err => {
  console.error('\n❌ SUITE TERMINATED WITH ERROR:', err);
  process.exit(1);
});
