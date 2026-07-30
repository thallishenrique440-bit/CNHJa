/**
 * EligibilityScanner.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Unit tests for EligibilityScanner.
 * Verifies read-only queries, filters, ordering, pagination, and output DTO mapping.
 */

import { EligibilityScanner } from '../EligibilityScanner.js';

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

/**
 * Mock Supabase Client for EligibilityScanner
 */
function createMockSupabaseScannerClient(mockRows: any[]) {
  return {
    from: (table: string) => {
      assert(table === 'payment_settlements', 'Scanner targets payment_settlements table exclusively');

      let filters: any = {};
      let orderings: any[] = [];
      let limitVal = 100;

      const queryBuilder = {
        select: (cols: string) => queryBuilder,
        eq: (col: string, val: any) => {
          filters[col] = { type: 'eq', val };
          return queryBuilder;
        },
        not: (col: string, op: string, val: any) => {
          filters[col] = { type: 'not', op, val };
          return queryBuilder;
        },
        gt: (col: string, val: any) => {
          filters[`gt_${col}`] = { col, type: 'gt', val };
          return queryBuilder;
        },
        order: (col: string, opts: any) => {
          orderings.push({ col, ascending: opts?.ascending });
          return queryBuilder;
        },
        limit: (val: number) => {
          limitVal = val;
          return queryBuilder;
        },
        then: (resolve: any) => {
          // Apply mock filtering
          let result = [...mockRows];

          if (filters['settlement_type']) {
            result = result.filter(r => r.settlement_type === filters['settlement_type'].val);
          }
          if (filters['settled_at']) {
            result = result.filter(r => r.settled_at !== null && r.settled_at !== undefined);
          }
          if (filters['gt_net_amount']) {
            result = result.filter(r => r.net_amount > filters['gt_net_amount'].val);
          }
          if (filters['gt_id']) {
            result = result.filter(r => r.id > filters['gt_id'].val);
          }

          // Apply ordering
          if (orderings.length > 0) {
            result.sort((a, b) => {
              for (const ord of orderings) {
                if (a[ord.col] < b[ord.col]) return ord.ascending ? -1 : 1;
                if (a[ord.col] > b[ord.col]) return ord.ascending ? 1 : -1;
              }
              return 0;
            });
          }

          // Apply limit
          result = result.slice(0, limitVal);

          resolve({ data: result, error: null });
        }
      };

      return queryBuilder;
    }
  } as any;
}

async function runEligibilityScannerTests() {
  console.log('\n======================================================');
  console.log('🧪 EligibilityScanner Unit Tests');
  console.log('======================================================\n');

  const mockDbRows = [
    {
      id: 'set_001',
      provider_payment_id: 'pay_001',
      installment_id: 'inst_001',
      settlement_type: 'PAYMENT',
      gross_amount: 10000,
      net_amount: 9000,
      platform_fee: 1000,
      fee_amount: 1000,
      instructor_amount: 9000,
      settled_at: '2026-07-29T10:00:00Z',
      payment_installments: {
        id: 'inst_001',
        appointment_id: 'app_001',
        instructor_id: 'inst_10',
        status: 'PAID'
      }
    },
    {
      id: 'set_002',
      provider_payment_id: 'pay_002',
      installment_id: 'inst_002',
      settlement_type: 'REFUND', // Should be filtered out
      gross_amount: 5000,
      net_amount: 4500,
      platform_fee: 500,
      fee_amount: 500,
      instructor_amount: 4500,
      settled_at: '2026-07-29T10:05:00Z',
      payment_installments: {
        id: 'inst_002',
        appointment_id: 'app_002',
        instructor_id: 'inst_10',
        status: 'PAID'
      }
    },
    {
      id: 'set_003',
      provider_payment_id: 'pay_003',
      installment_id: 'inst_003',
      settlement_type: 'PAYMENT',
      gross_amount: 20000,
      net_amount: 0, // Zero net amount -> should be filtered out
      platform_fee: 20000,
      fee_amount: 20000,
      instructor_amount: 0,
      settled_at: '2026-07-29T10:10:00Z',
      payment_installments: {
        id: 'inst_003',
        appointment_id: 'app_003',
        instructor_id: 'inst_10',
        status: 'PAID'
      }
    },
    {
      id: 'set_004',
      provider_payment_id: 'pay_004',
      installment_id: 'inst_004',
      settlement_type: 'PAYMENT',
      gross_amount: 15000,
      net_amount: 13500,
      platform_fee: 1500,
      fee_amount: 1500,
      instructor_amount: 13500,
      settled_at: '2026-07-29T10:15:00Z',
      payment_installments: {
        id: 'inst_004',
        appointment_id: 'app_004',
        instructor_id: 'inst_20',
        status: 'PAID'
      }
    }
  ];

  const mockClient = createMockSupabaseScannerClient(mockDbRows);
  const scanner = new EligibilityScanner(mockClient);

  // Test 1: Query eligible settlements (Filtering REFUND and net_amount <= 0)
  const results = await scanner.scanEligibleSettlements();
  assert(results.length === 2, 'Returns only 2 eligible settlements (filters REFUND and netAmount = 0)');
  assert(results[0].id === 'set_001', 'First settlement is set_001');
  assert(results[1].id === 'set_004', 'Second settlement is set_004');
  assert(results[0].instructorId === 'inst_10', 'Maps instructorId from installment');
  assert(results[1].instructorId === 'inst_20', 'Maps instructorId for set_004');

  // Test 2: Pagination with limit = 1
  const paginated = await scanner.scanEligibleSettlements({ limit: 1 });
  assert(paginated.length === 1, 'Respects limit parameter = 1');
  assert(paginated[0].id === 'set_001', 'Returns first ordered element');

  // Test 3: Cursor pagination with afterSettlementId
  const afterCursor = await scanner.scanEligibleSettlements({ afterSettlementId: 'set_001' });
  assert(afterCursor.length === 1, 'Cursor pagination returns 1 element after set_001');
  assert(afterCursor[0].id === 'set_004', 'Element after set_001 is set_004');

  console.log('\n------------------------------------------------------');
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) process.exit(1);
}

runEligibilityScannerTests().catch(err => {
  console.error('Fatal scanner test error:', err);
  process.exit(1);
});
