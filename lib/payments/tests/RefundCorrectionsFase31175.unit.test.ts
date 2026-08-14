import { RefundOperationRepository } from '../RefundOperationRepository.js';
import { BookingCancellationCore } from '../BookingCancellationCore.js';
import { buildRefundOperationKey } from '../RefundOperationKey.js';
import { RefundOperationRecord } from '../RefundOperationTypes.js';

const assert = (value: boolean, message: string) => {
  if (!value) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
};

// Mock Supabase Client Factory
function createMockSupabase(initialData: {
  appointments?: any[];
  refund_operations?: any[];
}) {
  const appointments = [...(initialData.appointments || [])];
  const refundOperations = [...(initialData.refund_operations || [])];

  return {
    from: (table: string) => {
      if (table === 'appointments') {
        return {
          select: (cols: string) => ({
            eq: (col: string, val: any) => {
              const filtered = appointments.filter(a => a[col] === val);
              return {
                single: async () => ({ data: filtered[0] || null, error: filtered[0] ? null : { message: 'Not found' } }),
                then: (cb: any) => cb({ data: filtered, error: null })
              };
            }
          }),
          update: (payload: any) => ({
            in: (col: string, vals: any[]) => {
              appointments.forEach(a => {
                if (vals.includes(a[col])) {
                  Object.assign(a, payload);
                }
              });
              return { error: null };
            },
            eq: (col: string, val: any) => {
              appointments.forEach(a => {
                if (a[col] === val) Object.assign(a, payload);
              });
              return { error: null };
            }
          })
        };
      }

      if (table === 'refund_operations') {
        return {
          select: (cols: string) => ({
            eq: (col: string, val: any) => ({
              eq: (c2: string, v2: any) => ({
                maybeSingle: async () => {
                  const item = refundOperations.find(r => r[col] === val && r[c2] === v2);
                  return { data: item || null, error: null };
                }
              }),
              in: (c2: string, v2List: any[]) => {
                const getFiltered = (excludeKey?: string) => refundOperations.filter(r => r[col] === val && v2List.includes(r[c2]) && (!excludeKey || r.operation_key !== excludeKey));
                return {
                  neq: (c3: string, v3: any) => Promise.resolve({ data: getFiltered(v3), error: null }),
                  then: (cb: any) => Promise.resolve({ data: getFiltered(), error: null }).then(cb)
                };
              },
              maybeSingle: async () => {
                const item = refundOperations.find(r => r[col] === val);
                return { data: item || null, error: null };
              }
            })
          }),
          upsert: (payload: any) => {
            let existing = refundOperations.find(r => r.operation_key === payload.operation_key);
            if (!existing) {
              existing = { id: `op-${Date.now()}`, ...payload, version: 1 };
              refundOperations.push(existing);
            }
            return {
              select: () => ({
                maybeSingle: async () => ({ data: existing, error: null })
              })
            };
          },
          update: (payload: any) => ({
            eq: (c1: string, v1: any) => ({
              eq: (c2: string, v2: any) => ({
                select: () => ({
                  maybeSingle: async () => {
                    const item = refundOperations.find(r => r[c1] === v1);
                    if (item) Object.assign(item, payload);
                    return { data: item || null, error: null };
                  }
                })
              })
            })
          })
        };
      }

      // Default catch-all for transactions / payment_installments
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: () => ({ or: () => Promise.resolve({ error: null }) }), or: () => Promise.resolve({ error: null }) }),
        upsert: () => Promise.resolve({ error: null })
      };
    },
    rpc: async (fn: string, args: any) => {
      if (fn === 'claim_refund_operation') {
        const item = refundOperations.find(r => r.id === args.p_operation_id);
        if (item && item.status === 'REQUESTED') {
          item.owner_id = args.p_owner_id;
          item.lease_until = args.p_lease_until;
          return { data: [item], error: null };
        }
        return { data: [], error: null };
      }
      return { data: null, error: null };
    },
    _getAppointments: () => appointments,
    _getRefundOps: () => refundOperations
  };
}

console.log('=== RUNNING CORRECTION UNIT TESTS (FASE 3.1.17.5) ===\n');

// 1. Test P0-01: handleExpiredPending transitions PENDING with past lease_until to UNKNOWN
{
  const supabase = createMockSupabase({
    refund_operations: [
      {
        id: 'op-pending-expired',
        operation_key: 'key-1',
        provider: 'asaas',
        provider_payment_id: 'pay-100',
        status: 'PENDING',
        lease_until: '2026-08-01T00:00:00Z', // In the past
        requested_amount_cents: 10000,
        version: 2
      }
    ]
  });

  const op = await RefundOperationRepository.get(supabase as any, 'op-pending-expired');
  const updatedOp = await RefundOperationRepository.handleExpiredPending(supabase as any, op);

  assert(updatedOp.status === 'UNKNOWN', 'P0-01: Expired PENDING lease automatically transitions status to UNKNOWN');
}

// 2. Test P0-02: Scope SINGLE_APPOINTMENT only affects target appointment and ignores group siblings
{
  const mockDb = createMockSupabase({
    appointments: [
      {
        id: 'apt-1',
        status: 'confirmed',
        group_id: 'group-combo-1',
        price: 8000, // R$ 80,00
        student_id: 'student-1',
        instructor_id: 'instructor-1',
        provider_payment_id: 'pay-combo-1'
      },
      {
        id: 'apt-2',
        status: 'confirmed',
        group_id: 'group-combo-1',
        price: 8000, // R$ 80,00
        student_id: 'student-1',
        instructor_id: 'instructor-1',
        provider_payment_id: 'pay-combo-1'
      }
    ]
  });

  // Intercept fetch for Asaas API payment consultation
  const originalFetch = global.fetch;
  global.fetch = (async (url: string) => {
    if (url.includes('/payments/pay-combo-1')) {
      return {
        ok: true,
        json: async () => ({
          id: 'pay-combo-1',
          status: 'RECEIVED',
          value: 160.0,
          split: []
        })
      };
    }
    return { ok: true, json: async () => ({ id: 'ref-1' }) };
  }) as any;

  try {
    const result = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt-1',
      reason: 'student_cancelled',
      scope: 'SINGLE_APPOINTMENT',
      adminClient: mockDb
    });

    const apts = mockDb._getAppointments();
    const apt1 = apts.find(a => a.id === 'apt-1');
    const apt2 = apts.find(a => a.id === 'apt-2');

    assert(apt1.status === 'cancelled', 'P0-02: Target appointment apt-1 is cancelled');
    assert(apt2.status === 'confirmed', 'P0-02: Sibling appointment apt-2 remains confirmed under SINGLE_APPOINTMENT scope');
    assert(result.processedCount === 1, 'P0-02: Processed count is exactly 1 under SINGLE_APPOINTMENT scope');
  } finally {
    global.fetch = originalFetch;
  }
}

// 3. Test Cumulative Ceiling: Refund exceeding available balance is rejected
{
  const mockDb = createMockSupabase({
    appointments: [
      {
        id: 'apt-big',
        status: 'confirmed',
        price: 20000, // R$ 200,00
        provider_payment_id: 'pay-limited'
      }
    ],
    refund_operations: [
      {
        id: 'op-prev',
        operation_key: 'key-prev',
        provider: 'asaas',
        provider_payment_id: 'pay-limited',
        status: 'COMPLETED',
        requested_amount_cents: 15000, // R$ 150,00 already refunded
        completed_amount_cents: 15000
      }
    ]
  });

  const originalFetch = global.fetch;
  global.fetch = (async (url: string) => {
    if (url.includes('/payments/pay-limited')) {
      return {
        ok: true,
        json: async () => ({
          id: 'pay-limited',
          status: 'RECEIVED',
          value: 200.0, // Total payment was R$ 200,00 (20000 cents)
          split: []
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  }) as any;

  try {
    let thrown = false;
    let errMsg = '';
    try {
      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt-big',
        reason: 'student_cancelled',
        scope: 'SINGLE_APPOINTMENT',
        asaasApiKey: 'mock-key',
        adminClient: mockDb
      });
    } catch (err: any) {
      errMsg = err?.message || String(err);
      thrown = errMsg.includes('exceeds available balance');
    }

    if (!thrown) console.error(`Debug Test 3: thrown=${thrown}, errMsg="${errMsg}"`);
    assert(thrown, 'Cumulative Ceiling: Refund request of 20000 cents blocked when available balance is 5000 cents');
  } finally {
    global.fetch = originalFetch;
  }
}

// 4. Test UNKNOWN state blocks POST retry
{
  const targetOpKey = buildRefundOperationKey({
    provider: 'asaas',
    providerPaymentId: 'pay-unknown',
    refundScope: 'SINGLE_APPOINTMENT',
    items: [{ id: 'apt-unknown', amountCents: 5000 }],
    splits: [],
    requestedAmountCents: 5000,
    allocationVersion: 'v1'
  });

  const mockDb = createMockSupabase({
    appointments: [
      {
        id: 'apt-unknown',
        status: 'confirmed',
        price: 5000,
        provider_payment_id: 'pay-unknown'
      }
    ],
    refund_operations: [
      {
        id: 'op-unkn',
        operation_key: targetOpKey,
        provider: 'asaas',
        provider_payment_id: 'pay-unknown',
        status: 'UNKNOWN',
        requested_amount_cents: 5000
      }
    ]
  });

  let postCalled = false;
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, opts: any) => {
    if (url.includes('/payments/pay-unknown/refund')) {
      postCalled = true;
    }
    if (url.includes('/payments/pay-unknown')) {
      return {
        ok: true,
        json: async () => ({
          id: 'pay-unknown',
          status: 'RECEIVED',
          value: 50.0,
          split: []
        })
      };
    }
    return { ok: true, json: async () => ({}) };
  }) as any;

  try {
    await BookingCancellationCore.processCancellation({
      appointmentId: 'apt-unknown',
      reason: 'student_cancelled',
      scope: 'SINGLE_APPOINTMENT',
      asaasApiKey: 'mock-key',
      adminClient: mockDb
    });

    assert(!postCalled, 'UNKNOWN state strictly blocks direct POST /refund calls to Asaas');
  } finally {
    global.fetch = originalFetch;
  }
}

console.log('\n=== ALL CORRECTION TESTS PASSED PERFECTLY ===');
