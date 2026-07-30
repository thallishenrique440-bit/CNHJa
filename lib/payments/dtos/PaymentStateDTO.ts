/**
 * PaymentStateDTO.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Read DTOs for Payment Installment States and Event Logs.
 * READ MODEL ONLY. NO BUSINESS LOGIC OR CALCULATIONS IN THIS DTO.
 */

export interface PaymentInstallmentStateDTO {
  id: string;
  providerPaymentId: string;
  appointmentId: string;
  studentId: string;
  instructorId: string;
  status: string; // PENDING | AUTHORIZED | CONFIRMED | RECEIVED | OVERDUE | REFUNDED | CHARGEBACK | FAILED | CANCELLED
  grossAmountCents: number;
  netAmountCents: number;
  platformFeeCents: number;
  dueDate: string;
  paymentDate?: string;
  lastTransitionAt: string;
}

export interface PaymentEventLogDTO {
  eventId: string;
  providerPaymentId: string;
  eventType: string;
  status: string;
  processedAt: string;
  metadata?: Record<string, any>;
}
