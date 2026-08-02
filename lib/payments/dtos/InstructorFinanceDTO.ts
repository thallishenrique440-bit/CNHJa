/**
 * InstructorFinanceDTO.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Read DTOs for Instructor Financial Projections and Statements.
 * READ MODEL ONLY. NO BUSINESS LOGIC OR CALCULATIONS IN THIS DTO.
 */

export interface InstructorFinanceSummaryDTO {
  instructorId: string;
  availableBalanceCents: number;      // settled_available
  futureReceivablesCents: number;     // future_receivables
  totalNetSettledCents: number;       // total_net
  totalGrossCents: number;            // total_gross
  totalFeesCents: number;             // total_platform_fee
  pendingReleaseCents: number;        // pending_release
  pendingPayoutCents: number;         // pending_payout
  totalPaidOutCents: number;          // total_paid_out
  totalRefundsCents: number;
  totalChargebacksCents: number;
  totalOverdueCents: number;
  projectionVersion: number;
  updatedAt: string;
}

export interface InstructorStatementEntryDTO {
  id: string;
  providerPaymentId: string;
  installmentId: string;
  studentId: string;
  studentName?: string;
  grossAmountCents: number;
  netAmountCents: number;
  platformFeeCents: number;
  feeAmountCents?: number;
  commissionCnhJaCents?: number;
  status: string; // PENDING | CONFIRMED | RECEIVED | OVERDUE | REFUNDED | CHARGEBACK | CANCELLED
  dueDate: string;
  settledAt?: string;
  groupId?: string;
  installmentNumber?: number;
  totalInstallments?: number;
  settlementsCount?: number;
  receivedInstallments?: number;
  lastSettlementDate?: string;
}

export interface InstructorCashFlowDTO {
  month: string; // YYYY-MM
  expectedInflowCents: number;
  settledInflowCents: number;
  netForecastCents: number;
}

export interface InstructorMonthlyMetricsDTO {
  instructorId: string;
  year: number;
  month: number;
  periodStart: string;
  periodEnd: string;
  monthlyGrossCents: number;
  monthlyNetCents: number;
  monthlyPlatformFeeCents: number;
  monthlyLessonNetCents: number;
  monthlyTipNetCents: number;
  settlementsCount: number;
  updatedAt: string;
}

