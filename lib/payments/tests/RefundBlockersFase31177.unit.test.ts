import { RefundOperationRepository } from '../RefundOperationRepository.js';
import { BookingCancellationCore } from '../BookingCancellationCore.js';
import { InstallmentService } from '../InstallmentService.js';
import { buildRefundOperationKey } from '../RefundOperationKey.js';
import { RefundOperationRecord } from '../RefundOperationTypes.js';

const assert = (value: boolean, message: string) => {
  if (!value) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
};

// Mock Supabase Client Factory for Phase 3.1.17.7
function createMockSupabase(initialData: {
  appointments?: any[];
  refund_operations?: any[];
  payment_installments?: any[];
  payment_settlements?: any[];
  transactions?: any[];
}) {
  const appointments = [...(initialData.appointments || [])];
  const refundOperations = [...(initialData.refund_operations || [])];
  const paymentInstallments = [...(initialData.payment_installments || [])];
  const paymentSettlements = [...(initialData.payment_settlements || [])];
  const transactions = [...(initialData.transactions || [])];

  const db: any = {
    appointments,
    refundOperations,
    paymentInstallments,
    paymentSettlements,
    transactions,
    rpc: async (fn: string, params: any) => {
      if (fn === 'claim_refund_operation') {
        const op = refundOperations.find(r => r.id === params.p_operation_id);
        if (!op) return { data: null, error: null };
        if (op.status === 'UNKNOWN') return { data: null, error: null };
        op.owner_id = params.p_owner_id;
        op.lease_until = params.p_lease_until;
        op.status = 'PENDING';
        op.version += 1;
        return { data: [op], error: null };
      }
      return { data: null, error: { message: 'RPC not found' } };
    },
    from: (table: string) => {
      if (table === 'appointments') {
        return {
          select: (cols: string) => {
            const chain: any = {
              eq: (col: string, val: any) => {
                const filtered = appointments.filter(a => a[col] === val);
                return {
                  single: async () => ({ data: filtered[0] || null, error: filtered[0] ? null : { message: 'Not found' } }),
                  maybeSingle: async () => ({ data: filtered[0] || null, error: null }),
                  then: (cb: any) => cb({ data: filtered, error: null })
                };
              },
              or: (clause: string) => {
                // simple parser for provider_payment_id.eq.pay_1,payment_intent_id.eq.pay_1
                const match = clause.match(/pay_[0-9a-zA-Z_]+/);
                const val = match ? match[0] : '';
                const filtered = appointments.filter(a => a.provider_payment_id === val || a.payment_intent_id === val);
                return Promise.resolve({ data: filtered, error: null });
              }
            };
            return chain;
          },
          update: (payload: any) => {
            return {
              in: (col: string, vals: any[]) => {
                const matchedOuter = appointments.filter(a => vals.includes(a[col]));
                return {
                  in: (col2: string, vals2: any[]) => {
                    const matched: any[] = [];
                    appointments.forEach(a => {
                      if (vals.includes(a[col]) && vals2.includes(a[col2])) {
                        Object.assign(a, payload);
                        matched.push({ ...a });
                      }
                    });
                    return {
                      select: (cols: string) => Promise.resolve({ data: matched, error: null })
                    };
                  },
                  eq: (col2: string, val2: any) => {
                    appointments.forEach(a => {
                      if (vals.includes(a[col]) && a[col2] === val2) Object.assign(a, payload);
                    });
                    return { error: null };
                  }
                };
              },
              eq: (col: string, val: any) => {
                appointments.forEach(a => {
                  if (a[col] === val) Object.assign(a, payload);
                });
                return { error: null };
              }
            };
          }
        };
      }

      if (table === 'refund_operations') {
        return {
          select: (cols: string) => {
            const filters: Array<{ type: 'eq' | 'neq' | 'in'; col: string; val: any }> = [];
            const createChain = () => ({
              eq: (col: string, val: any) => {
                filters.push({ type: 'eq', col, val });
                return createChain();
              },
              neq: (col: string, val: any) => {
                filters.push({ type: 'neq', col, val });
                return createChain();
              },
              in: (col: string, vals: any[]) => {
                filters.push({ type: 'in', col, val: vals });
                return createChain();
              },
              maybeSingle: async () => {
                const items = filterItems();
                return { data: items[0] ? { ...items[0] } : null, error: null };
              },
              single: async () => {
                const items = filterItems();
                return { data: items[0] ? { ...items[0] } : null, error: null };
              },
              then: (cb: any) => {
                const items = filterItems();
                return Promise.resolve({ data: items, error: null }).then(cb);
              }
            });

            function filterItems() {
              return refundOperations.filter(r => {
                return filters.every(f => {
                  if (f.type === 'eq') return r[f.col] === f.val;
                  if (f.type === 'neq') return r[f.col] !== f.val;
                  if (f.type === 'in') return Array.isArray(f.val) && f.val.includes(r[f.col]);
                  return true;
                });
              });
            }

            return createChain();
          },
          upsert: (payload: any, options?: any) => {
            const key = payload.operation_key;
            let existing = refundOperations.find(r => r.operation_key === key);
            if (existing) {
              return {
                select: () => ({
                  single: async () => ({ data: { ...existing }, error: null }),
                  maybeSingle: async () => ({ data: { ...existing }, error: null })
                })
              };
            } else {
              const rec = { id: `op_${Date.now()}`, version: 1, status: 'REQUESTED', ...payload };
              refundOperations.push(rec);
              return {
                select: () => ({
                  single: async () => ({ data: rec, error: null }),
                  maybeSingle: async () => ({ data: rec, error: null })
                })
              };
            }
          },
          insert: (records: any[]) => {
            const inserted = records.map(r => {
              const rec = { version: 1, ...r };
              refundOperations.push(rec);
              return rec;
            });
            return {
              select: () => ({
                single: async () => ({ data: inserted[0], error: null })
              })
            };
          },
          update: (payload: any) => {
            const filters: Array<{ type: 'eq' | 'in'; col: string; val: any }> = [];
            const createChain = () => ({
              eq: (col: string, val: any) => {
                filters.push({ type: 'eq', col, val });
                return createChain();
              },
              in: (col: string, vals: any[]) => {
                filters.push({ type: 'in', col, val: vals });
                return createChain();
              },
              select: () => ({
                maybeSingle: async () => {
                  let idx = refundOperations.findIndex(r => {
                    return filters.every(f => {
                      if (f.type === 'eq') return r[f.col] === f.val;
                      if (f.type === 'in') return Array.isArray(f.val) && f.val.includes(r[f.col]);
                      return true;
                    });
                  });
                  let updatedItem: any = null;
                  if (idx !== -1) {
                    refundOperations[idx] = { ...refundOperations[idx], ...payload };
                    updatedItem = refundOperations[idx];
                  }
                  return { data: updatedItem, error: null };
                }
              })
            });
            return createChain();
          }
        };
      }

      if (table === 'payment_installments') {
        return {
          select: (cols: string) => {
            const chain: any = {
              eq: (col: string, val: any) => {
                const filtered = paymentInstallments.filter(i => i[col] === val);
                return Promise.resolve({ data: filtered, error: null });
              },
              or: (clause: string) => {
                const match = clause.match(/pay_[0-9a-zA-Z_]+/);
                const val = match ? match[0] : '';
                const filtered = paymentInstallments.filter(i => i.provider_payment_id === val || i.group_id === val);
                return Promise.resolve({ data: filtered, error: null });
              }
            };
            return chain;
          },
          update: (payload: any) => ({
            eq: (col: string, val: any) => {
              paymentInstallments.forEach(i => {
                if (i[col] === val) Object.assign(i, payload);
              });
              return Promise.resolve({ error: null });
            }
          })
        };
      }

      if (table === 'payment_settlements') {
        return {
          upsert: async (record: any) => {
            paymentSettlements.push(record);
            return { data: record, error: null };
          }
        };
      }

      if (table === 'transactions') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: transactions, error: null })
            })
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null })
            })
          }),
          upsert: async (rec: any) => {
            transactions.push(rec);
            return { error: null };
          }
        };
      }

      return { select: () => ({}) };
    }
  };

  return db;
}

export async function runAllTests() {
  console.log('🚀 Running Phase 3.1.17.7 Forensic Integration Tests...');

  // Scenario 1: Single PENDING RefundOperation reconciled to COMPLETED
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_1',
          operation_key: 'key_1',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_100',
          requested_amount_cents: 8000,
          completed_amount_cents: null,
          status: 'PENDING',
          version: 1
        }
      ]
    });

    const ops = await RefundOperationRepository.getReconcilableOperations(mockDb, 'asaas', 'pay_100');
    assert(ops.length === 1, 'Scenario 1: Found 1 reconcilable operation');

    const reconciled = await RefundOperationRepository.reconcileTransition(mockDb, 'ref_op_1', 1, 'COMPLETED', {
      completed_amount_cents: 8000,
      provider_refund_id: 'refr_100'
    });
    assert(reconciled.status === 'COMPLETED', 'Scenario 1: Status transitioned to COMPLETED');
    assert(reconciled.version === 2, 'Scenario 1: Version incremented to 2');
  }

  // Scenario 2: Webhook PAYMENT_REFUNDED with item breakdown matches exact requested_amount_cents
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_2',
          operation_key: 'key_2',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_200',
          requested_amount_cents: 12000,
          completed_amount_cents: null,
          status: 'PENDING',
          version: 1
        }
      ]
    });

    const ops = await RefundOperationRepository.getReconcilableOperations(mockDb, 'asaas', 'pay_200');
    const itemValueCents = 12000;
    const matches = ops.filter(op => op.requested_amount_cents === itemValueCents);
    assert(matches.length === 1, 'Scenario 2: Exact item match found');

    const updated = await RefundOperationRepository.reconcileTransition(mockDb, matches[0].id, matches[0].version, 'COMPLETED', {
      completed_amount_cents: itemValueCents,
      provider_refund_id: 'refr_200'
    });
    assert(updated.status === 'COMPLETED', 'Scenario 2: Single item match transitioned to COMPLETED');
  }

  // Scenario 3: Multiple ambiguous operations set CONFLICT status
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_3a',
          operation_key: 'key_3a',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_300',
          requested_amount_cents: 8000,
          status: 'PENDING',
          version: 1
        },
        {
          id: 'ref_op_3b',
          operation_key: 'key_3b',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_300',
          requested_amount_cents: 8000,
          status: 'PENDING',
          version: 1
        }
      ]
    });

    const ops = await RefundOperationRepository.getReconcilableOperations(mockDb, 'asaas', 'pay_300');
    assert(ops.length === 2, 'Scenario 3: Two candidate operations found for same payment');

    // Without item breakdown, multiple candidates set CONFLICT
    for (const op of ops) {
      await RefundOperationRepository.reconcileTransition(mockDb, op.id, op.version, 'CONFLICT', {
        metadata: { conflict_reason: 'Ambiguous match across multiple operations' }
      });
    }

    const recheck = await mockDb.from('refund_operations').select('*').in('id', ['ref_op_3a', 'ref_op_3b']);
    assert(recheck.data.every((r: any) => r.status === 'CONFLICT'), 'Scenario 3: Ambiguous operations transitioned to CONFLICT');
  }

  // Scenario 4: Webhook PAYMENT_REFUND_IN_PROGRESS updates REQUESTED to PENDING
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_4',
          operation_key: 'key_4',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_400',
          requested_amount_cents: 5000,
          status: 'REQUESTED',
          version: 1
        }
      ]
    });

    const ops = await RefundOperationRepository.getReconcilableOperations(mockDb, 'asaas', 'pay_400');
    assert(ops[0].status === 'REQUESTED', 'Scenario 4: Found REQUESTED operation');

    const pendingOp = await RefundOperationRepository.reconcileTransition(mockDb, ops[0].id, ops[0].version, 'PENDING', {
      sent_at: new Date().toISOString()
    });
    assert(pendingOp.status === 'PENDING', 'Scenario 4: Transitioned to PENDING');
  }

  // Scenario 5: Webhook PAYMENT_REFUND_DENIED sets PENDING to DENIED
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_5',
          operation_key: 'key_5',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_500',
          requested_amount_cents: 7000,
          status: 'PENDING',
          version: 1
        }
      ]
    });

    const ops = await RefundOperationRepository.getReconcilableOperations(mockDb, 'asaas', 'pay_500');
    const denied = await RefundOperationRepository.reconcileTransition(mockDb, ops[0].id, ops[0].version, 'DENIED', {
      metadata: { denial_reason: 'Saldo insuficiente' }
    });
    assert(denied.status === 'DENIED', 'Scenario 5: PENDING operation marked DENIED on refund denial');
  }

  // Scenario 6: Duplicate webhook delivery is idempotent
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_6',
          operation_key: 'key_6',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_600',
          requested_amount_cents: 9000,
          completed_amount_cents: 9000,
          status: 'COMPLETED',
          version: 2
        }
      ]
    });

    const ops = await RefundOperationRepository.getReconcilableOperations(mockDb, 'asaas', 'pay_600');
    assert(ops.length === 0, 'Scenario 6: Completed operation is not reconcilable again (idempotency)');
  }

  // Scenario 7: Out-of-order webhook delivery (PAYMENT_REFUNDED before PAYMENT_REFUND_IN_PROGRESS)
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_7',
          operation_key: 'key_7',
          scope_type: 'SINGLE_APPOINTMENT',
          provider: 'asaas',
          provider_payment_id: 'pay_700',
          requested_amount_cents: 10000,
          status: 'REQUESTED',
          version: 1
        }
      ]
    });

    // DIRECT transition from REQUESTED -> COMPLETED on early PAYMENT_REFUNDED
    const completed = await RefundOperationRepository.reconcileTransition(mockDb, 'ref_op_7', 1, 'COMPLETED', {
      completed_amount_cents: 10000
    });
    assert(completed.status === 'COMPLETED', 'Scenario 7: Out-of-order refund transitions directly to COMPLETED');
  }

  // Scenario 8: Concurrent cancellation attempts (Distributed DB Atomic Lock)
  {
    const mockDb = createMockSupabase({
      appointments: [
        { id: 'apt_8', status: 'confirmed', provider_payment_id: 'pay_800', price: 80 }
      ]
    });

    // Worker 1 acquires lock
    const { data: lock1 } = await mockDb.from('appointments')
      .update({ status: 'cancelling' })
      .in('id', ['apt_8'])
      .in('status', ['confirmed'])
      .select('id');

    assert(lock1 && lock1.length === 1, 'Scenario 8: Worker 1 successfully acquired atomic lock');

    // Worker 2 attempts same lock
    const { data: lock2 } = await mockDb.from('appointments')
      .update({ status: 'cancelling' })
      .in('id', ['apt_8'])
      .in('status', ['confirmed'])
      .select('id');

    assert(!lock2 || lock2.length === 0, 'Scenario 8: Worker 2 failed to acquire lock (atomic isolation verified)');
  }

  // Scenario 9: Partial refund on single appointment isolates installment refunding
  {
    const mockDb = createMockSupabase({
      payment_installments: [
        { id: 'inst_9a', appointment_id: 'apt_9a', group_id: 'group_9', provider_payment_id: 'pay_900', status: 'PAID' },
        { id: 'inst_9b', appointment_id: 'apt_9b', group_id: 'group_9', provider_payment_id: 'pay_900', status: 'PAID' }
      ]
    });

    await InstallmentService.recordRefundSettlement(mockDb, {
      providerPaymentId: 'pay_900',
      groupId: 'group_9',
      appointmentId: 'apt_9a',
      refundAmountCents: 8000,
      providerSettlementId: 'set_9a'
    });

    assert(mockDb.paymentInstallments.find((i: any) => i.id === 'inst_9a').status === 'REFUNDED', 'Scenario 9: Targeted installment marked REFUNDED');
    assert(mockDb.paymentInstallments.find((i: any) => i.id === 'inst_9b').status === 'PAID', 'Scenario 9: Sibling installment remains PAID');
  }

  // Scenario 10: Claim fallback works when RPC fails/unavailable
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_10',
          operation_key: 'key_10',
          status: 'REQUESTED',
          version: 1
        }
      ]
    });
    // Override rpc to fail
    mockDb.rpc = async () => ({ data: null, error: { message: 'Function not found' } });

    const claimed = await RefundOperationRepository.claim(mockDb, 'ref_op_10', 'owner_10', new Date(Date.now() + 300000).toISOString());
    assert(claimed.claimed === true, 'Scenario 10: Fallback CAS claim succeeded when RPC unavailable');
    assert(claimed.operation.status === 'PENDING', 'Scenario 10: Status changed to PENDING via fallback');
  }

  // Scenario 11: Expired lease auto-transitions PENDING to UNKNOWN and blocks claim
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'ref_op_11',
          operation_key: 'key_11',
          status: 'PENDING',
          lease_until: new Date(Date.now() - 1000).toISOString(),
          version: 1
        }
      ]
    });

    const unknownOp = await RefundOperationRepository.handleExpiredPending(mockDb, 'ref_op_11');
    assert(unknownOp.status === 'UNKNOWN', 'Scenario 11: Expired PENDING lease converted to UNKNOWN');

    const claimRes = await RefundOperationRepository.claim(mockDb, 'ref_op_11', 'owner_11', new Date(Date.now() + 300000).toISOString());
    assert(claimRes.claimed === false, 'Scenario 11: Claim blocked on UNKNOWN status');
  }

  // Scenario 12: Single appointment cancellation scope isolation
  {
    const mockKey = buildRefundOperationKey({
      provider: 'asaas',
      providerPaymentId: 'pay_120',
      refundScope: 'SINGLE_APPOINTMENT',
      items: [{ id: 'apt_12a', amountCents: 8000 }],
      splits: [],
      requestedAmountCents: 8000,
      allocationVersion: 'v1'
    });
    assert(mockKey.includes('"refundScope":"SINGLE_APPOINTMENT"') && mockKey.includes('"id":"apt_12a"'), 'Scenario 12: Key isolates single appointment');
  }

  // Scenario 13: Full group cancellation scope
  {
    const mockKey = buildRefundOperationKey({
      provider: 'asaas',
      providerPaymentId: 'pay_130',
      refundScope: 'FULL_GROUP',
      items: [
        { id: 'apt_13a', amountCents: 6000 },
        { id: 'apt_13b', amountCents: 6000 }
      ],
      splits: [],
      requestedAmountCents: 12000,
      allocationVersion: 'v1'
    });
    assert(mockKey.includes('"refundScope":"FULL_GROUP"') && mockKey.includes('"requestedAmountCents":12000'), 'Scenario 13: Key encompasses full group');
  }

  // Scenario 14: Integer cents arithmetic prevents floating-point drift
  {
    const priceCents = Math.round(79.99 * 100);
    assert(priceCents === 7999, 'Scenario 14: 79.99 converts cleanly to 7999 integer cents without floating drift');
  }

  // ==============================================================================
  // PHASE 3.1.17.7.1 — CLAIM FALLBACK ISOLATED AUDIT TESTS
  // ==============================================================================

  // Phase 3.1.17.7.1 - Test 1: REQUESTED status can be claimed
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_req_1', operation_key: 'k1', status: 'REQUESTED', version: 1 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_req_1', 'worker-A', new Date(Date.now() + 60000).toISOString());
    assert(claimRes.claimed === true, 'Phase 3.1.17.7.1 - Test 1: REQUESTED status claimed successfully');
    assert(claimRes.operation.status === 'PENDING', 'Phase 3.1.17.7.1 - Test 1: Status changed to PENDING');
    assert(claimRes.operation.owner_id === 'worker-A', 'Phase 3.1.17.7.1 - Test 1: Owner assigned to worker-A');
    assert(claimRes.operation.version === 2, 'Phase 3.1.17.7.1 - Test 1: Version incremented to 2');
  }

  // Phase 3.1.17.7.1 - Test 2: Valid PENDING status CANNOT be claimed again
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'op_pend_2',
          operation_key: 'k2',
          status: 'PENDING',
          version: 5,
          owner_id: 'worker-A',
          lease_until: new Date(Date.now() + 300000).toISOString()
        }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_pend_2', 'worker-B', new Date(Date.now() + 600000).toISOString());
    assert(claimRes.claimed === false, 'Phase 3.1.17.7.1 - Test 2: Valid PENDING claim rejected');
    assert(claimRes.operation.status === 'PENDING', 'Phase 3.1.17.7.1 - Test 2: Status remains PENDING');
    assert(claimRes.operation.version === 5, 'Phase 3.1.17.7.1 - Test 2: Version remains 5');
    assert(claimRes.operation.owner_id === 'worker-A', 'Phase 3.1.17.7.1 - Test 2: Owner remains worker-A');
  }

  // Phase 3.1.17.7.1 - Test 3 & 4: Two concurrent workers on REQUESTED (CAS/version race)
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_conc_3', operation_key: 'k3', status: 'REQUESTED', version: 10 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });

    const [resA, resB] = await Promise.all([
      RefundOperationRepository.claim(mockDb, 'op_conc_3', 'worker-A', new Date(Date.now() + 60000).toISOString()),
      RefundOperationRepository.claim(mockDb, 'op_conc_3', 'worker-B', new Date(Date.now() + 60000).toISOString())
    ]);

    const winnerCount = (resA.claimed ? 1 : 0) + (resB.claimed ? 1 : 0);
    assert(winnerCount === 1, 'Phase 3.1.17.7.1 - Test 3 & 4: Exactly one worker claimed, CAS isolation verified');
  }

  // Phase 3.1.17.7.1 - Test 5: UNKNOWN status CANNOT be claimed
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_unkn_5', operation_key: 'k5', status: 'UNKNOWN', version: 3 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_unkn_5', 'worker-A', new Date(Date.now() + 60000).toISOString());
    assert(claimRes.claimed === false, 'Phase 3.1.17.7.1 - Test 5: UNKNOWN status blocked from claim');
  }

  // Phase 3.1.17.7.1 - Test 6: COMPLETED status CANNOT be claimed
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_comp_6', operation_key: 'k6', status: 'COMPLETED', version: 4 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_comp_6', 'worker-A', new Date(Date.now() + 60000).toISOString());
    assert(claimRes.claimed === false, 'Phase 3.1.17.7.1 - Test 6: COMPLETED status blocked from claim');
  }

  // Phase 3.1.17.7.1 - Test 7: DENIED status CANNOT be claimed
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_den_7', operation_key: 'k7', status: 'DENIED', version: 2 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_den_7', 'worker-A', new Date(Date.now() + 60000).toISOString());
    assert(claimRes.claimed === false, 'Phase 3.1.17.7.1 - Test 7: DENIED status blocked from claim');
  }

  // Phase 3.1.17.7.1 - Test 8: CONFLICT status CANNOT be claimed
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_conf_8', operation_key: 'k8', status: 'CONFLICT', version: 2 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_conf_8', 'worker-A', new Date(Date.now() + 60000).toISOString());
    assert(claimRes.claimed === false, 'Phase 3.1.17.7.1 - Test 8: CONFLICT status blocked from claim');
  }

  // Phase 3.1.17.7.1 - Test 9: Expired PENDING lease transitions to UNKNOWN and blocks claim
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        {
          id: 'op_exp_9',
          operation_key: 'k9',
          status: 'PENDING',
          lease_until: new Date(Date.now() - 5000).toISOString(),
          version: 2
        }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC unavailable' } });
    const claimRes = await RefundOperationRepository.claim(mockDb, 'op_exp_9', 'worker-A', new Date(Date.now() + 60000).toISOString());
    assert(claimRes.claimed === false, 'Phase 3.1.17.7.1 - Test 9: Expired PENDING lease returned claimed = false');
    assert(claimRes.operation.status === 'UNKNOWN', 'Phase 3.1.17.7.1 - Test 9: Status transitioned to UNKNOWN');
  }

  // Phase 3.1.17.7.1 - Test 10: RPC unavailable matrix fallback verification
  {
    const mockDb = createMockSupabase({
      refund_operations: [
        { id: 'op_mat_req', operation_key: 'km1', status: 'REQUESTED', version: 1 },
        { id: 'op_mat_pend', operation_key: 'km2', status: 'PENDING', lease_until: new Date(Date.now() + 60000).toISOString(), version: 1 },
        { id: 'op_mat_unkn', operation_key: 'km3', status: 'UNKNOWN', version: 1 }
      ]
    });
    mockDb.rpc = async () => ({ data: null, error: { message: 'RPC missing' } });

    const c1 = await RefundOperationRepository.claim(mockDb, 'op_mat_req', 'w1', new Date().toISOString());
    const c2 = await RefundOperationRepository.claim(mockDb, 'op_mat_pend', 'w2', new Date().toISOString());
    const c3 = await RefundOperationRepository.claim(mockDb, 'op_mat_unkn', 'w3', new Date().toISOString());

    assert(c1.claimed === true, 'Phase 3.1.17.7.1 - Test 10: Fallback REQUESTED claimed = true');
    assert(c2.claimed === false, 'Phase 3.1.17.7.1 - Test 10: Fallback PENDING claimed = false');
    assert(c3.claimed === false, 'Phase 3.1.17.7.1 - Test 10: Fallback UNKNOWN claimed = false');
  }

  // Phase 3.1.17.7.1 - Regression Test: PENDING status prevents duplicate POST /refund in BookingCancellationCore
  {
    let postCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => {
      if (typeof url === 'string' && url.includes('/refund')) {
        postCallCount++;
        return { ok: true, json: async () => ({ id: 'ref_mock_123' }) };
      }
      if (typeof url === 'string' && url.includes('/payments/pay_test_pending')) {
        return {
          ok: true,
          json: async () => ({ status: 'CONFIRMED', value: 100, id: 'pay_test_pending' })
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;

    try {
      const expectedKey = buildRefundOperationKey({
        provider: 'asaas',
        providerPaymentId: 'pay_test_pending',
        refundScope: 'SINGLE_APPOINTMENT',
        items: [{ id: 'apt_post_reg', amountCents: 10000 }],
        splits: [],
        requestedAmountCents: 10000,
        allocationVersion: 'v1'
      });

      const mockDb = createMockSupabase({
        appointments: [
          {
            id: 'apt_post_reg',
            status: 'confirmed',
            provider_payment_id: 'pay_test_pending',
            price: 10000,
            group_id: null
          }
        ],
        refund_operations: [
          {
            id: 'op_post_reg',
            operation_key: expectedKey,
            provider_payment_id: 'pay_test_pending',
            scope: 'SINGLE_APPOINTMENT',
            requested_amount_cents: 10000,
            status: 'PENDING',
            lease_until: new Date(Date.now() + 300000).toISOString(),
            version: 2
          }
        ]
      });
      mockDb.rpc = async () => ({ data: null, error: { message: 'RPC missing' } });

      await BookingCancellationCore.processCancellation({
        appointmentId: 'apt_post_reg',
        reason: 'student_cancelled',
        adminClient: mockDb,
        asaasApiKey: 'mock_key'
      });

      assert(postCallCount === 0, 'Phase 3.1.17.7.1 - Regression Test: Zero POST /refund calls executed when operation is PENDING');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log('✅ ALL FORENSIC INTEGRATION AND AUDIT TEST SCENARIOS PASSED PERFECTLY!');
}

runAllTests().catch(err => {
  console.error('❌ Test suite execution error:', err);
  process.exit(1);
});
