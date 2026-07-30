/**
 * InstructorFinanceDTO.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Read DTOs for Instructor Financial Projections and Statements.
 * READ MODEL ONLY. NO BUSINESS LOGIC OR CALCULATIONS IN THIS DTO.
 */

export interface InstructorFinanceSummaryDTO {
  instructorId: string;
  futureReceivablesCents: number;
  pendingReleaseCents: number;
  settledAvailableCents: number;
  totalGrossCents: number;
  totalPlatformFeeCents: number;
  totalNetCents: number;
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
  status: string; // PENDING | CONFIRMED | RECEIVED | OVERDUE | REFUNDED | CHARGEBACK | CANCELLED
  dueDate: string;
  settledAt?: string;
}

export interface InstructorCashFlowDTO {
  month: string; // YYYY-MM
  expectedInflowCents: number;
  settledInflowCents: number;
  netForecastCents: number;
}
