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
  // P-1.19: as entradas passaram a ser localizadas por id em vez de por posicao.
  // A ordenacao do extrato agora usa settledAt com queda para dueDate, para que
  // uma venda ainda sem recebimento apareca no topo em vez de no fim da lista.
  // As assercoes de conteudo sao exatamente as mesmas.
  const entry1: any = statement.find((e: any) => e.id === 'inst_1');
  const entry2: any = statement.find((e: any) => e.id === 'inst_2');

  assert(!!entry1, 'Entry 1 id matches');
  assert(entry1.grossAmountCents === 10000, 'Entry 1 grossAmountCents is 10000');
  assert(entry1.netAmountCents === 9000, 'Entry 1 netAmountCents is 9000');
  assert(entry1.platformFeeCents === 1000, 'Entry 1 platformFeeCents is 1000');
  assert(entry1.commissionCnhJaCents === 1000, 'Entry 1 commissionCnhJaCents is calculated in Read Model');
  assert(entry1.status === 'RECEIVED', 'Entry 1 status is RECEIVED');
  assert(entry1.settledAt === '2026-07-02T10:00:00Z', 'Entry 1 settledAt date matches');

  assert(!!entry2, 'Entry 2 id matches');
  assert(entry2.status === 'CONFIRMED', 'Entry 2 status is CONFIRMED');
  assert(entry2.settledAt === undefined, 'Entry 2 settledAt is undefined for pending installment');

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
