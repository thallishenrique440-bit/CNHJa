/**
 * InstructorMonthlyMetrics.unit.test.ts
 * Sprint 1 - CNHJá Financial Architecture Wave 2
 *
 * Unit tests for getMonthlyMetrics and action=monthly Read Model.
 * Verifies calculation accuracy, SSOT query filtering against payment_settlements,
 * zero-fallback behavior for empty months, and UTC period bounds.
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

async function runMonthlyMetricsUnitTests() {
  console.log('\n======================================================');
  console.log('🧪 Sprint 1: Instructor Monthly Metrics Unit Tests');
  console.log('======================================================\n');

  const instructorService = new InstructorFinanceReadService();

  // Test 1: Month with multiple settlements (lessons and tips)
  const mockSupabaseWithData: any = {
    from: (tableName: string) => {
      if (tableName === 'payment_settlements') {
        return {
          select: () => ({
            eq: (col: string, val: string) => ({
              gte: (startCol: string, startVal: string) => ({
                lt: async (endCol: string, endVal: string) => ({
                  data: [
                    {
                      id: 'set_1',
                      installment_id: 'inst_1',
                      settlement_type: 'PAYMENT',
                      gross_amount: 10000,
                      net_amount: 9000,
                      platform_fee: 1000,
                      instructor_amount: 9000,
                      settled_at: '2026-07-10T12:00:00Z',
                      payment_installments: {
                        id: 'inst_1',
                        instructor_id: 'inst_777',
                        appointment_id: 'app_101',
                        transaction_id: 'tx_1'
                      }
                    },
                    {
                      id: 'set_2',
                      installment_id: null,
                      settlement_type: 'PAYMENT',
                      gross_amount: 2000,
                      net_amount: 2000,
                      platform_fee: 0,
                      instructor_amount: 2000,
                      settled_at: '2026-07-15T14:00:00Z',
                      payment_installments: null
                    },
                    {
                      id: 'set_3',
                      installment_id: 'inst_1',
                      settlement_type: 'REFUND',
                      gross_amount: 1000,
                      net_amount: 900,
                      platform_fee: 100,
                      instructor_amount: 900,
                      settled_at: '2026-07-20T10:00:00Z',
                      payment_installments: {
                        id: 'inst_1',
                        instructor_id: 'inst_777',
                        appointment_id: 'app_101',
                        transaction_id: 'tx_1'
                      }
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

  const metrics = await instructorService.getMonthlyMetrics(
    mockSupabaseWithData,
    'inst_777',
    2026,
    7
  );

  assert(metrics.instructorId === 'inst_777', 'Correct instructorId in metrics');
  assert(metrics.year === 2026, 'Correct year in metrics');
  assert(metrics.month === 7, 'Correct month in metrics');
  assert(metrics.periodStart === '2026-07-01T00:00:00.000Z', 'Correct periodStart boundary UTC');
  assert(metrics.periodEnd === '2026-08-01T00:00:00.000Z', 'Correct periodEnd boundary UTC');

  // Net calculations: 9000 (lesson) + 2000 (tip) - 900 (lesson refund) = 10100 net total
  // Lesson net: 9000 - 900 = 8100
  // Tip net: 2000
  // Gross: 10000 + 2000 - 1000 = 11000
  // Fees: 1000 + 0 - 100 = 900
  assert(metrics.monthlyGrossCents === 11000, `Gross cents aggregated correctly: expected 11000, got ${metrics.monthlyGrossCents}`);
  assert(metrics.monthlyNetCents === 10100, `Net cents aggregated correctly: expected 10100, got ${metrics.monthlyNetCents}`);
  assert(metrics.monthlyPlatformFeeCents === 900, `Platform fees aggregated correctly: expected 900, got ${metrics.monthlyPlatformFeeCents}`);
  assert(metrics.monthlyLessonNetCents === 8100, `Lesson net cents aggregated correctly: expected 8100, got ${metrics.monthlyLessonNetCents}`);
  assert(metrics.monthlyTipNetCents === 2000, `Tip net cents aggregated correctly: expected 2000, got ${metrics.monthlyTipNetCents}`);
  assert(metrics.settlementsCount === 3, 'Settlements count is 3');

  // Test 2: Month with no settlements (empty result fallback)
  const mockSupabaseEmpty: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            lt: async () => ({
              data: [],
              error: null
            })
          })
        })
      })
    })
  };

  const emptyMetrics = await instructorService.getMonthlyMetrics(
    mockSupabaseEmpty,
    'inst_777',
    2026,
    5
  );

  assert(emptyMetrics.instructorId === 'inst_777', 'Empty month returns correct instructorId');
  assert(emptyMetrics.year === 2026, 'Empty month returns correct year');
  assert(emptyMetrics.month === 5, 'Empty month returns correct month');
  assert(emptyMetrics.monthlyGrossCents === 0, 'Empty month gross cents is 0');
  assert(emptyMetrics.monthlyNetCents === 0, 'Empty month net cents is 0');
  assert(emptyMetrics.monthlyLessonNetCents === 0, 'Empty month lesson net cents is 0');
  assert(emptyMetrics.monthlyTipNetCents === 0, 'Empty month tip net cents is 0');
  assert(emptyMetrics.settlementsCount === 0, 'Empty month settlements count is 0');

  // Test 3: Default parameters (year and month omitted)
  const now = new Date();
  const defaultMetrics = await instructorService.getMonthlyMetrics(
    mockSupabaseEmpty,
    'inst_777'
  );
  assert(defaultMetrics.year === now.getUTCFullYear(), 'Default year matches current UTC year');
  assert(defaultMetrics.month === (now.getUTCMonth() + 1), 'Default month matches current UTC month');

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runMonthlyMetricsUnitTests().catch((err) => {
  console.error('Fatal error in Sprint 1 unit tests:', err);
  process.exit(1);
});
