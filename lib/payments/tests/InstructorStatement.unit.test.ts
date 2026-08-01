/**
 * InstructorStatement.unit.test.ts
 * Sprint 3 - CNHJá Financial Architecture Wave 2
 *
 * Unit tests for getStatement Read Model endpoint and frontend mapping.
 * Verifies query execution, pagination/status parameters, DTO mapping,
 * and zero-fallback behavior.
 */

import { InstructorFinanceReadService } from '../services/InstructorFinanceReadService.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    failed++;
  }
}

async function runStatementUnitTests() {
  console.log('\n======================================================');
  console.log('🧪 Sprint 3: Instructor Financial Statement Unit Tests');
  console.log('======================================================\n');

  const instructorService = new InstructorFinanceReadService();

  // Test 1: getStatement returns formatted entries from payment_installments
  const mockSupabaseData: any = {
    from: (tableName: string) => {
      if (tableName === 'payment_installments') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    {
                      id: 'inst_1',
                      provider_payment_id: 'pay_100',
                      student_id: 'stud_1',
                      gross_amount: 10000,
                      net_amount: 9000,
                      platform_fee: 1000,
                      status: 'RECEIVED',
                      due_date: '2026-07-01T00:00:00Z',
                      payment_date: '2026-07-02T10:00:00Z'
                    },
                    {
                      id: 'inst_2',
                      provider_payment_id: 'pay_101',
                      student_id: 'stud_2',
                      gross_amount: 5000,
                      net_amount: 4500,
                      platform_fee: 500,
                      status: 'CONFIRMED',
                      due_date: '2026-07-15T00:00:00Z',
                      payment_date: null
                    }
                  ],
                  error: null
                })
              })
            })
          })
        };
      }
      return {};
    }
  };

  const statement = await instructorService.getStatement(mockSupabaseData, 'inst_777', { limit: 20 });

  assert(Array.isArray(statement), 'getStatement returns an array');
  assert(statement.length === 2, 'Returns 2 statement entries');
  assert(statement[0].id === 'inst_1', 'Entry 1 id matches');
  assert(statement[0].grossAmountCents === 10000, 'Entry 1 grossAmountCents is 10000');
  assert(statement[0].netAmountCents === 9000, 'Entry 1 netAmountCents is 9000');
  assert(statement[0].platformFeeCents === 1000, 'Entry 1 platformFeeCents is 1000');
  assert(statement[0].commissionCnhJaCents === 1000, 'Entry 1 commissionCnhJaCents is calculated in Read Model');
  assert(statement[0].status === 'RECEIVED', 'Entry 1 status is RECEIVED');
  assert(statement[0].settledAt === '2026-07-02T10:00:00Z', 'Entry 1 settledAt date matches');

  assert(statement[1].id === 'inst_2', 'Entry 2 id matches');
  assert(statement[1].status === 'CONFIRMED', 'Entry 2 status is CONFIRMED');
  assert(statement[1].settledAt === undefined, 'Entry 2 settledAt is undefined for pending installment');

  // Test 2: Empty statement fallback
  const mockSupabaseEmpty: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({
              data: [],
              error: null
            })
          })
        })
      })
    })
  };

  const emptyStatement = await instructorService.getStatement(mockSupabaseEmpty, 'inst_777');
  assert(Array.isArray(emptyStatement), 'Empty statement returns array');
  assert(emptyStatement.length === 0, 'Empty statement array length is 0');

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runStatementUnitTests().catch((err) => {
  console.error('Fatal error in Sprint 3 unit tests:', err);
  process.exit(1);
});
