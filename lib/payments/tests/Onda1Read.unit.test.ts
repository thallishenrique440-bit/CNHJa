/**
 * Onda1Read.unit.test.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Unit tests for Onda 1 DTOs, Read Interfaces, and Read Services.
 * Verifies contract structure, read service mappings, and strict read-model compliance.
 */

import { InstructorFinanceReadService } from '../services/InstructorFinanceReadService.js';
import { StudentFinanceReadService } from '../services/StudentFinanceReadService.js';
import { PaymentStateReadService } from '../services/PaymentStateReadService.js';

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

async function runOnda1ReadUnitTests() {
  console.log('\n======================================================');
  console.log('🧪 Stage 10 Onda 1: DTOs & Read Services Unit Tests');
  console.log('======================================================\n');

  // Mock Supabase Client
  const mockSupabase: any = {
    from: (tableName: string) => {
      if (tableName === 'instructor_financial_projections') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  instructor_id: 'inst_123',
                  future_receivables: 10000,
                  pending_release: 5000,
                  settled_available: 15000,
                  total_gross: 30000,
                  total_platform_fee: 3000,
                  total_net: 27000,
                  total_refunds: 0,
                  total_chargebacks: 0,
                  total_overdue: 0,
                  projection_version: 1,
                  rebuild_version: 1,
                  updated_at: '2026-07-30T00:00:00Z'
                },
                error: null
              })
            })
          })
        };
      }

      if (tableName === 'payment_installments') {
        return {
          select: () => {
            const chain: any = {
              eq: (col: string, val: string) => {
                if (col === 'provider_payment_id' && val === 'pay_single') {
                  return {
                    maybeSingle: async () => ({
                      data: {
                        id: 'inst_1',
                        provider_payment_id: 'pay_single',
                        appointment_id: 'app_1',
                        student_id: 'stud_1',
                        instructor_id: 'inst_123',
                        status: 'CONFIRMED',
                        gross_amount: 10000,
                        net_amount: 9000,
                        platform_fee: 1000,
                        due_date: '2026-08-01',
                        payment_date: '2026-07-30',
                        updated_at: '2026-07-30T01:00:00Z'
                      },
                      error: null
                    })
                  };
                }
                return chain;
              },
              order: () => ({
                eq: () => chain,
                limit: () => chain,
                range: () => chain,
                then: (cb: any) => Promise.resolve([
                  {
                    id: 'inst_1',
                    provider_payment_id: 'pay_single',
                    appointment_id: 'app_1',
                    student_id: 'stud_1',
                    instructor_id: 'inst_123',
                    installment_number: 1,
                    gross_amount: 10000,
                    net_amount: 9000,
                    platform_fee: 1000,
                    status: 'CONFIRMED',
                    due_date: '2026-08-01',
                    payment_date: '2026-07-30'
                  }
                ]).then(data => cb({ data, error: null }))
              })
            };
            return chain;
          }
        };
      }

      if (tableName === 'appointments') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'app_1',
                  group_id: 'group_1',
                  payment_status: 'CONFIRMED',
                  price: 100
                },
                error: null
              })
            })
          })
        };
      }

      if (tableName === 'transactions') {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: [
                  {
                    id: 'tx_1',
                    provider_payment_id: 'pay_single',
                    event_type: 'PAYMENT_RECEIVED',
                    status: 'CONFIRMED',
                    created_at: '2026-07-30T00:00:00Z',
                    raw_payload: { amount: 10000 }
                  }
                ],
                error: null
              })
            })
          })
        };
      }

      if (tableName === 'cash_flow_projections') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  lte: () => ({
                    order: async () => ({
                      data: [
                        {
                          projection_date: '2026-08',
                          expected_inflow: 10000,
                          expected_outflow: 1000,
                          settled_inflow: 5000,
                          settled_outflow: 500
                        }
                      ],
                      error: null
                    })
                  })
                })
              })
            })
          })
        };
      }

      return {
        select: () => ({
          eq: async () => ({ data: [], error: null })
        })
      };
    }
  };

  // Test 1: InstructorFinanceReadService - getSummary
  const instructorService = new InstructorFinanceReadService();
  const summary = await instructorService.getSummary(mockSupabase, 'inst_123');
  assert(summary !== null, 'Instructor summary return value is non-null');
  assert(summary?.instructorId === 'inst_123', 'Instructor summary contains correct instructorId');
  assert(summary?.futureReceivablesCents === 10000, 'Instructor summary futureReceivablesCents matches projection');
  assert(summary?.totalGrossCents === 30000, 'Instructor summary totalGrossCents matches projection');

  // Test 2: StudentFinanceReadService - getSummary & getAppointmentPaymentState
  const studentService = new StudentFinanceReadService();
  const appState = await studentService.getAppointmentPaymentState(mockSupabase, 'app_1');
  assert(appState !== null, 'Appointment payment state return value is non-null');
  assert(appState?.appointmentId === 'app_1', 'Appointment payment state contains correct appointmentId');
  assert(appState?.paymentStatus === 'CONFIRMED', 'Appointment payment state status matches official appointment record');
  assert(appState?.totalAmountCents === 10000, 'Appointment total amount in cents is correctly converted');

  // Test 3: PaymentStateReadService - getInstallmentState & getEventLogs
  const paymentStateService = new PaymentStateReadService();
  const installmentState = await paymentStateService.getInstallmentState(mockSupabase, 'pay_single');
  assert(installmentState !== null, 'Installment state return value is non-null');
  assert(installmentState?.providerPaymentId === 'pay_single', 'Installment state matches providerPaymentId');
  assert(installmentState?.status === 'CONFIRMED', 'Installment status matches payment_installments table');

  const logs = await paymentStateService.getEventLogs(mockSupabase, 'pay_single');
  assert(logs.length === 1, 'Event logs retrieved correctly from transactions ledger');
  assert(logs[0].eventType === 'PAYMENT_RECEIVED', 'Event log eventType preserved from transaction record');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runOnda1ReadUnitTests().catch((err) => {
  console.error('Fatal error running Onda 1 unit tests:', err);
  process.exit(1);
});
