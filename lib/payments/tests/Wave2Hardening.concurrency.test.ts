/**
 * Wave2Hardening.concurrency.test.ts
 * ETAPA 7.2 — HARDENING FINAL DA WAVE 2
 *
 * Test suite verifying:
 * 1. ProjectionDispatcher as single entry point
 * 2. High concurrency dispatch handling (simultaneous webhooks)
 * 3. Idempotency & duplicate event safety
 * 4. Optimistic locking with automatic retries
 * 5. Structured error auditing
 */

import assert from 'assert';
import { ProjectionDispatcher } from '../projections/ProjectionDispatcher.js';
import {
  ProjectionEventPayload,
  ProjectionOutcome,
  ProjectionSourceEventType,
  InstructorProjectionRecord
} from '../projections/ProjectionTypes.js';

function createMockSupabase() {
  const store = new Map<string, any[]>();
  store.set('instructor_financial_projections', []);
  store.set('platform_financial_projections', []);
  store.set('cash_flow_projections', []);
  store.set('transactions', []);

  const createQueryBuilder = (table: string, filters: Array<{ col: string; val: any }> = []) => {
    if (!store.has(table)) store.set(table, []);
    const rows = store.get(table)!;

    const matchesFilters = (item: any) => filters.every(f => item[f.col] === f.val);

    const builder: any = {
      select: (_cols?: string) => builder,
      eq: (col: string, val: any) => createQueryBuilder(table, [...filters, { col, val }]),
      gte: (_col: string, _val: any) => builder,
      lte: (_col: string, _val: any) => builder,
      order: (_col: string, _opts?: any) => builder,
      maybeSingle: async () => {
        const found = rows.find(matchesFilters);
        return { data: found ? { ...found } : null, error: null };
      },
      single: async () => {
        const found = rows.find(matchesFilters);
        return { data: found ? { ...found } : null, error: null };
      },
      update: (payload: any) => ({
        eq: (col1: string, val1: any) => ({
          eq: (col2: string, val2: any) => ({
            select: () => ({
              maybeSingle: async () => {
                const idx = rows.findIndex(r => r[col1] === val1 && r[col2] === val2);
                if (idx === -1) {
                  return { data: null, error: null };
                }
                rows[idx] = { ...rows[idx], ...payload };
                return { data: { ...rows[idx] }, error: null };
              }
            })
          })
        })
      }),
      upsert: (payload: any, _options?: any) => ({
        select: () => ({
          single: async () => {
            const keyCol = table === 'instructor_financial_projections'
              ? 'instructor_id'
              : table === 'platform_financial_projections'
              ? 'platform_key'
              : 'entity_id';
            const idx = rows.findIndex(r => r[keyCol] === payload[keyCol]);
            if (idx >= 0) {
              rows[idx] = { ...rows[idx], ...payload };
            } else {
              rows.push({ ...payload });
            }
            const saved = rows.find(r => r[keyCol] === payload[keyCol]);
            return { data: { ...saved }, error: null };
          }
        })
      }),
      insert: async (payload: any) => {
        rows.push({ ...payload, id: `tx_${Date.now()}_${Math.random()}` });
        return { data: payload, error: null };
      }
    };
    return builder;
  };

  const mock = {
    from: (table: string) => createQueryBuilder(table)
  };

  return { mock, store };
}

async function runHardeningTests() {
  console.log('🚀 Running ETAPA 7.2 Wave 2 Hardening & Concurrency Tests...\n');

  // Test 1: Single entry point dispatch
  console.log('📌 TEST 1: ProjectionDispatcher Single Entry Point');
  const { mock } = createMockSupabase();
  const instructorId = 'inst_hardening_101';

  const scheduleEvent: ProjectionEventPayload = {
    eventType: ProjectionSourceEventType.FINANCIAL_SCHEDULE_CREATED,
    eventId: 'sched_pay_h1',
    providerPaymentId: 'pay_h1',
    instructorId,
    grossAmount: 10000,
    netAmount: 8500,
    platformFee: 1500,
    feeAmount: 0,
    instructorAmount: 8500,
    dueDate: new Date().toISOString()
  };

  const dispatchRes1 = await ProjectionDispatcher.dispatch(mock as any, scheduleEvent);
  assert.strictEqual(dispatchRes1.outcome, ProjectionOutcome.PROJECTION_UPDATED, 'Dispatcher executes update');
  assert.strictEqual(dispatchRes1.instructorProjection?.future_receivables, 8500, 'Future receivables increased to 8500');

  // Test 2: Idempotency / Extreme Duplicity
  console.log('📌 TEST 2: Extreme Duplicity & Idempotency');
  const dispatchResDup = await ProjectionDispatcher.dispatch(mock as any, scheduleEvent);
  assert.strictEqual(dispatchResDup.outcome, ProjectionOutcome.NO_OP_ALREADY_PROJECTED, 'Duplicate schedule event detected');
  assert.strictEqual(dispatchResDup.instructorProjection?.future_receivables, 8500, 'Future receivables untouched on duplicate');

  // Test 3: Multiple Simultaneous Webhooks (Concurrency Simulation)
  console.log('📌 TEST 3: Simultaneous Settlement Webhooks Concurrency');
  const settlementEvent1: ProjectionEventPayload = {
    eventType: ProjectionSourceEventType.SETTLEMENT_CREATED,
    settlementId: 'st_h1',
    providerPaymentId: 'pay_h1',
    instructorId,
    grossAmount: 10000,
    netAmount: 8500,
    platformFee: 1500,
    feeAmount: 0,
    instructorAmount: 8500,
    settledAt: new Date().toISOString()
  };

  const settlementEvent2: ProjectionEventPayload = {
    eventType: ProjectionSourceEventType.SETTLEMENT_CREATED,
    settlementId: 'st_h2',
    providerPaymentId: 'pay_h2',
    instructorId,
    grossAmount: 20000,
    netAmount: 17000,
    platformFee: 3000,
    feeAmount: 0,
    instructorAmount: 17000,
    settledAt: new Date().toISOString()
  };

  // Dispatch both settlements concurrently
  const [res1, res2] = await Promise.all([
    ProjectionDispatcher.dispatch(mock as any, settlementEvent1),
    ProjectionDispatcher.dispatch(mock as any, settlementEvent2)
  ]);

  assert(res1.outcome === ProjectionOutcome.PROJECTION_UPDATED || res1.outcome === ProjectionOutcome.NO_OP_ALREADY_PROJECTED);
  assert(res2.outcome === ProjectionOutcome.PROJECTION_UPDATED || res2.outcome === ProjectionOutcome.NO_OP_ALREADY_PROJECTED);

  // Check resulting database state
  const finalProj = (await mock.from('instructor_financial_projections').select('*').eq('instructor_id', instructorId).maybeSingle()).data as InstructorProjectionRecord;

  assert(finalProj.total_net === 25500, `Total net is exactly 25,500 (8,500 + 17,000), actual: ${finalProj.total_net}`);
  assert(finalProj.projection_version >= 2, 'Projection version incremented consistently');

  // Test 4: Structured Error Auditing & Event Ledger Fallback
  console.log('📌 TEST 4: Structured Error Auditing on Missing Provider Payment ID');
  const invalidEvent: any = {
    eventType: ProjectionSourceEventType.STATE_TRANSITION,
    providerPaymentId: null
  };

  const errRes = await ProjectionDispatcher.dispatch(mock as any, invalidEvent);
  assert.strictEqual(errRes.outcome, ProjectionOutcome.NO_OP_IGNORED_EVENT, 'Missing providerPaymentId gracefully ignored with error log');

  console.log('\n✅ ALL Wave 2 Hardening & Concurrency Tests Passed Successfully!');
}

runHardeningTests().catch((err) => {
  console.error('❌ Wave 2 Hardening test failed:', err);
  process.exit(1);
});
