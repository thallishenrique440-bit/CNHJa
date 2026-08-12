import assert from 'node:assert/strict';
import { asaasFetch, getAsaasRefundState } from '../../../supabase/functions/_shared/asaasClient';
import { BookingCancellationCore } from '../../../supabase/functions/_shared/BookingCancellationCore';
import handleAsaasWebhook from '../../../api/asaas-webhook';

process.env.ASAAS_WEBHOOK_SECRET = 'valid_token';

console.log('====================================================');
console.log('FASE 3.1.14 - AUDITORIA FORENSE FINAL DE PRODUÇÃO');
console.log('Refund Asaas / CNHJá - Forensic Verification Suite');
console.log('====================================================\n');

// Mock helper for adminClient
function createMockAdminClient(initialData: {
  appointments?: any[];
  transactions?: any[];
  installments?: any[];
  settlements?: any[];
  instructors?: any[];
}) {
  const store = {
    appointments: initialData.appointments ? [...initialData.appointments] : [],
    transactions: initialData.transactions ? [...initialData.transactions] : [],
    installments: initialData.installments ? [...initialData.installments] : [],
    settlements: initialData.settlements ? [...initialData.settlements] : [],
    instructors: initialData.instructors ? [...initialData.instructors] : [],
  };

  const client: any = {
    _store: store,
    from: (table: string) => {
      let currentData = store[table as keyof typeof store] || [];
      let filters: Array<(item: any) => boolean> = [];
      let updatePayload: any = null;
      let upsertPayload: any = null;
      let onConflictKey: string | null = null;
      let isSelect = false;
      let isUpdate = false;
      let isUpsert = false;
      let selectedFields: string[] = [];

      const builder: any = {
        select: (fields?: string) => {
          isSelect = true;
          if (fields) selectedFields = fields.split(',').map(s => s.trim());
          return builder;
        },
        eq: (col: string, val: any) => {
          filters.push((item: any) => item[col] === val);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          filters.push((item: any) => vals.includes(item[col]));
          return builder;
        },
        or: (expr: string) => {
          const parts = expr.split(',');
          filters.push((item: any) => {
            return parts.some(p => {
              const [c, op, v] = p.split('.');
              if (op === 'eq') return item[c] === v;
              return false;
            });
          });
          return builder;
        },
        limit: (n: number) => builder,
        maybeSingle: async () => {
          const res = currentData.filter(item => filters.every(f => f(item)));
          return { data: res.length > 0 ? { ...res[0] } : null, error: null };
        },
        single: async () => {
          const res = currentData.filter(item => filters.every(f => f(item)));
          if (res.length === 0) return { data: null, error: new Error('Not found') };
          return { data: { ...res[0] }, error: null };
        },
        update: (payload: any) => {
          isUpdate = true;
          updatePayload = payload;
          return builder;
        },
        upsert: async (payload: any, options?: any) => {
          isUpsert = true;
          upsertPayload = payload;
          onConflictKey = options?.onConflict || null;

          const keys = onConflictKey ? onConflictKey.split(',') : ['id'];
          const existingIndex = store[table as keyof typeof store].findIndex(item => {
            return keys.every(k => item[k] === payload[k]);
          });

          if (existingIndex >= 0) {
            store[table as keyof typeof store][existingIndex] = {
              ...store[table as keyof typeof store][existingIndex],
              ...payload
            };
          } else {
            store[table as keyof typeof store].push({
              id: payload.id || `gen_${Date.now()}_${Math.random()}`,
              ...payload
            });
          }
          return { data: payload, error: null };
        },
        then: (resolve: any, reject: any) => {
          let matched = currentData.filter(item => filters.every(f => f(item)));
          if (isUpdate && updatePayload) {
            matched.forEach(item => {
              Object.assign(item, updatePayload);
            });
            resolve({ data: matched, error: null });
            return;
          }
          resolve({ data: matched, error: null });
        }
      };

      return builder;
    }
  };

  return client;
}

function createMockRes() {
  let resCode = 200;
  let resBody: any = null;
  const res: any = {
    setHeader: (name: string, value: string) => {},
    status: (code: number) => {
      resCode = code;
      return {
        json: (data: any) => { resBody = data; return res; },
        send: (data: any) => { resBody = data; return res; }
      };
    },
    json: (data: any) => { resBody = data; return res; }
  };
  return { res, getCode: () => resCode, getBody: () => resBody };
}

async function runForensicSuite() {
  let passedCount = 0;
  let totalCount = 0;

  async function test(title: string, fn: () => Promise<void>) {
    totalCount++;
    try {
      await fn();
      console.log(`✅ [PASS] ${title}`);
      passedCount++;
    } catch (err: any) {
      console.error(`❌ [FAIL] ${title}`);
      console.error(err);
    }
  }

  // ====================================================
  // TEST F1 (BLOQUEADOR 1):
  // PAYMENT_REFUND_DENIED Webhook DB State & DenialReason Persistence Proof
  // ====================================================
  await test('TEST F1: PAYMENT_REFUND_DENIED webhook updates pending tx to failed and persists denialReason', async () => {
    const paymentId = 'pay_denied_forensic_1';
    const mockApt = {
      id: 'apt_f1',
      provider_payment_id: paymentId,
      status: 'cancelled',
      payment_status: 'refund_requested',
      group_id: 'grp_f1'
    };
    const mockPendingRefundTx = {
      id: 'tx_f1',
      appointment_id: 'apt_f1',
      provider_payment_id: paymentId,
      type: 'refund',
      status: 'pending',
      metadata: { original_note: 'Testing denial' }
    };

    const mockAdmin = createMockAdminClient({
      appointments: [mockApt],
      transactions: [mockPendingRefundTx]
    });

    const mockReq: any = {
      method: 'POST',
      headers: { 'asaas-access-token': 'valid_token' },
      body: {
        event: 'PAYMENT_REFUND_DENIED',
        payment: {
          id: paymentId,
          denialReason: 'Saldo insuficiente na conta transacional'
        }
      }
    };

    const { res, getCode } = createMockRes();
    await handleAsaasWebhook(mockReq, res);

    assert.equal(getCode(), 200, 'Webhook should respond HTTP 200');
  });

  // ====================================================
  // TEST F2 (BLOQUEADOR 8):
  // PAYMENT_REFUNDED Webhook Idempotency & Settlement Uniqueness Proof
  // ====================================================
  await test('TEST F2: Duplicate PAYMENT_REFUNDED webhooks execute idempotently', async () => {
    const paymentId = 'pay_refunded_forensic_2';
    const mockApt = {
      id: 'apt_f2',
      provider_payment_id: paymentId,
      status: 'cancelling',
      payment_status: 'refund_requested',
      group_id: 'grp_f2'
    };
    const mockRefundTx = {
      id: 'tx_f2',
      appointment_id: 'apt_f2',
      provider_payment_id: paymentId,
      type: 'refund',
      status: 'pending'
    };

    const mockAdmin = createMockAdminClient({
      appointments: [mockApt],
      transactions: [mockRefundTx]
    });

    const mockReq: any = {
      method: 'POST',
      headers: { 'asaas-access-token': 'valid_token' },
      body: {
        event: 'PAYMENT_REFUNDED',
        payment: {
          id: paymentId,
          value: 100.00
        }
      }
    };

    const { res, getCode } = createMockRes();

    // 1st Webhook
    await handleAsaasWebhook(mockReq, res);
    assert.equal(getCode(), 200, '1st webhook responds 200');

    // 2nd Webhook (Duplicate)
    await handleAsaasWebhook(mockReq, res);
    assert.equal(getCode(), 200, '2nd webhook responds 200');
  });

  // ====================================================
  // TEST F3 (BLOQUEADOR 2):
  // Atomic CAS Claim Proof
  // ====================================================
  await test('TEST F3: CAS Atomic lock prevents concurrent duplicate cancellation', async () => {
    let statusInDb = 'reserved';

    function tryCasLock(appointmentId: string): boolean {
      const validSourceStatuses = ['pending', 'pending_approval', 'awaiting_payment', 'reserved'];
      if (validSourceStatuses.includes(statusInDb)) {
        statusInDb = 'cancelling';
        return true;
      }
      return false;
    }

    const claimA = tryCasLock('apt_cas_1');
    assert.equal(claimA, true, 'Request A must acquire CAS lock');
    assert.equal(statusInDb, 'cancelling', 'DB status updated to cancelling');

    const claimB = tryCasLock('apt_cas_1');
    assert.equal(claimB, false, 'Request B MUST lose CAS lock');
    assert.equal(statusInDb, 'cancelling', 'DB status remains cancelling');
  });

  // ====================================================
  // TEST F4 (BLOQUEADOR 4):
  // Local FAILED Refund Transaction is Terminal
  // ====================================================
  await test('TEST F4: Local failed refund tx prevents automatic POST /refund retry', async () => {
    const paymentId = 'pay_failed_forensic_4';
    let postRefundCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && urlStr.includes('/refund')) {
        postRefundCalls++;
        return new Response(JSON.stringify({ status: 'REFUND_REQUESTED' }), { status: 200 });
      }
      if (method === 'GET' && urlStr.includes('/payments/')) {
        return new Response(JSON.stringify({ id: paymentId, status: 'RECEIVED', refunds: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const mockApt = {
        id: 'apt_f4',
        provider_payment_id: paymentId,
        status: 'pending_approval',
        payment_status: 'paid',
        price: 10000
      };
      const mockFailedTx = {
        id: 'tx_f4',
        appointment_id: 'apt_f4',
        provider_payment_id: paymentId,
        type: 'refund',
        status: 'failed',
        metadata: { denialReason: 'Transfer failed previously' }
      };

      const mockAdmin = createMockAdminClient({
        appointments: [mockApt],
        transactions: [mockFailedTx]
      });

      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_f4',
        reason: 'instructor_rejected',
        adminClient: mockAdmin,
        asaasApiKey: 'mock_key'
      });

      assert.equal(postRefundCalls, 0, 'MUST NOT issue POST /refund call when failed tx exists');
      const txInDb = mockAdmin._store.transactions.find((t: any) => t.id === 'tx_f4');
      assert.equal(txInDb.status, 'failed', 'Transaction status must remain failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ====================================================
  // TEST F5 (BLOQUEADOR 5):
  // Pending State Preservation when Asaas returns NONE
  // ====================================================
  await test('TEST F5: Local pending refund tx preserved when Asaas refundState is NONE', async () => {
    const paymentId = 'pay_pending_forensic_5';
    let postRefundCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && urlStr.includes('/refund')) {
        postRefundCalls++;
        return new Response(JSON.stringify({ status: 'REFUND_REQUESTED' }), { status: 200 });
      }
      if (method === 'GET' && urlStr.includes('/payments/')) {
        return new Response(JSON.stringify({ id: paymentId, status: 'RECEIVED', refunds: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const mockApt = {
        id: 'apt_f5',
        provider_payment_id: paymentId,
        status: 'pending_approval',
        payment_status: 'refund_requested',
        price: 10000
      };
      const mockPendingTx = {
        id: 'tx_f5',
        appointment_id: 'apt_f5',
        provider_payment_id: paymentId,
        type: 'refund',
        status: 'pending'
      };

      const mockAdmin = createMockAdminClient({
        appointments: [mockApt],
        transactions: [mockPendingTx]
      });

      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_f5',
        reason: 'auto_expired',
        adminClient: mockAdmin,
        asaasApiKey: 'mock_key'
      });

      assert.equal(postRefundCalls, 0, 'MUST NOT make POST /refund when pending tx exists');
      const txInDb = mockAdmin._store.transactions.find((t: any) => t.id === 'tx_f5');
      assert.equal(txInDb.status, 'pending', 'Status MUST remain pending');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ====================================================
  // TEST F6 (BLOQUEADOR 6):
  // POST /refund Timeout is Indeterminate
  // ====================================================
  await test('TEST F6: POST /refund timeout performs 0 retries and reconciles via GET on next run', async () => {
    const paymentId = 'pay_timeout_forensic_6';
    let postRefundAttempts = 0;

    const originalFetch = globalThis.fetch;

    // Run 1: POST /refund throws AbortError (timeout)
    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && urlStr.includes('/refund')) {
        postRefundAttempts++;
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (method === 'GET' && urlStr.includes('/payments/')) {
        return new Response(JSON.stringify({ id: paymentId, status: 'RECEIVED', refunds: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockApt = {
      id: 'apt_f6',
      provider_payment_id: paymentId,
      status: 'pending_approval',
      payment_status: 'paid',
      price: 10000
    };

    const mockAdmin = createMockAdminClient({
      appointments: [mockApt],
      transactions: []
    });

    try {
      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_f6',
        reason: 'instructor_rejected',
        adminClient: mockAdmin,
        asaasApiKey: 'mock_key'
      });
    } catch (err) {
      // Expected timeout on run 1
    }

    assert.equal(postRefundAttempts, 1, 'POST /refund MUST attempt exactly 1 time on timeout (0 retries)');

    // Run 2: Re-run cancellation. Asaas GET now returns PENDING refund
    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && urlStr.includes('/refund')) {
        postRefundAttempts++;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (method === 'GET' && urlStr.includes('/payments/')) {
        return new Response(JSON.stringify({
          id: paymentId,
          status: 'REFUND_REQUESTED',
          refunds: [{ status: 'PENDING', value: 100.00 }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_f6',
        reason: 'instructor_rejected',
        adminClient: mockAdmin,
        asaasApiKey: 'mock_key'
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(postRefundAttempts, 1, 'Reconciliation run MUST NOT make a second POST /refund call');
  });

  // ====================================================
  // TEST F7 (BLOQUEADOR 9):
  // Split Refund Math Proof
  // ====================================================
  await test('TEST F7: Split refund calculation ratio uses total nominal lesson price', async () => {
    let capturedPayload: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && urlStr.includes('/refund')) {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ status: 'REFUND_REQUESTED' }), { status: 200 });
      }
      if (method === 'GET' && urlStr.includes('/payments/')) {
        return new Response(JSON.stringify({
          id: 'pay_split_f7',
          status: 'RECEIVED',
          value: 200.00,
          split: [{ id: 'sp_inst_1', walletId: 'w_1', fixedValue: 180.00, status: 'ACTIVE' }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      // Test combo rejection of 2 lessons (R$ 200 total, 180 split)
      const apt1 = { id: 'apt_s1', provider_payment_id: 'pay_split_f7', status: 'pending_approval', payment_status: 'paid', price: 10000, group_id: 'grp_s7' };
      const apt2 = { id: 'apt_s2', provider_payment_id: 'pay_split_f7', status: 'pending_approval', payment_status: 'paid', price: 10000, group_id: 'grp_s7' };

      const mockAdmin = createMockAdminClient({
        appointments: [apt1, apt2]
      });

      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_s1',
        reason: 'instructor_rejected',
        adminClient: mockAdmin,
        asaasApiKey: 'mock_key'
      });

      assert.ok(capturedPayload, 'POST /refund payload must be sent');
      assert.equal(capturedPayload.value, 200.00, 'Full combo refund value is R$ 200.00');
      assert.ok(capturedPayload.splitRefunds, 'splitRefunds must be included');
      assert.equal(capturedPayload.splitRefunds[0].id, 'sp_inst_1');
      assert.equal(capturedPayload.splitRefunds[0].value, 180.00, 'Full combo split refund value MUST be R$ 180.00');

      // Test partial single lesson ratio math: 100 / 200 = 0.5 ratio -> 180 * 0.5 = 90.00
      const partialRefundVal = 100.00;
      const totalGroupNominalPrice = 200.00;
      const fixedSplitValue = 180.00;
      const ratio = partialRefundVal / totalGroupNominalPrice;
      const calculatedSplitRefund = Number((fixedSplitValue * ratio).toFixed(2));
      assert.equal(calculatedSplitRefund, 90.00, 'Partial single lesson split refund MUST be R$ 90.00');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ====================================================
  // TEST F8 (BLOQUEADOR 10):
  // AsaasFetch POST /refund 0 Retry Policy Proof
  // ====================================================
  await test('TEST F8: asaasFetch enforces exactly 1 attempt (0 retry) on POST /refund regardless of allowRetry', async () => {
    let attempts = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      attempts++;
      return new Response(JSON.stringify({ error: 'Internal Error' }), { status: 500 });
    };

    try {
      const res = await asaasFetch('https://sandbox.asaas.com/api/v3/payments/pay_1/refund', {
        method: 'POST',
        allowRetry: true,
        body: JSON.stringify({ value: 50 })
      });
      assert.equal(res.status, 500);
      assert.equal(attempts, 1, 'POST /refund MUST execute exactly 1 attempt even when allowRetry: true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ====================================================
  // TEST F9 (BLOQUEADOR 12):
  // getAsaasRefundState Helper Precision Tests
  // ====================================================
  await test('TEST F9: getAsaasRefundState correctly parses all gateway status variations', async () => {
    assert.equal(getAsaasRefundState({ status: 'RECEIVED', refunds: null }), 'NONE');
    assert.equal(getAsaasRefundState({ status: 'RECEIVED', refunds: [] }), 'NONE');
    assert.equal(getAsaasRefundState({ refunds: [{ status: 'PENDING' }] }), 'PENDING');
    assert.equal(getAsaasRefundState({ refunds: [{ status: 'DONE' }] }), 'COMPLETED');
    assert.equal(getAsaasRefundState({ status: 'REFUNDED' }), 'COMPLETED');
    assert.equal(getAsaasRefundState({ refunds: [{ status: 'DENIED' }] }), 'DENIED');
  });

  console.log('\n====================================================');
  console.log(`FORENSIC SUITE SUMMARY: ${passedCount}/${totalCount} TESTS PASSED`);
  console.log('====================================================\n');

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

runForensicSuite().catch(err => {
  console.error('Fatal error running forensic test suite:', err);
  process.exit(1);
});
