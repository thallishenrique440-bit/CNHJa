/**
 * StudentFinanceDTO.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Read DTOs for Student Financial Payments and Installment States.
 * READ MODEL ONLY. NO BUSINESS LOGIC OR CALCULATIONS IN THIS DTO.
 */

export interface StudentInstallmentDTO {
  id: string;
  providerPaymentId: string;
  appointmentId: string;
  instructorId: string;
  instructorName?: string;
  installmentNumber: number;
  totalInstallments: number;
  amountCents: number;
  status: string; // PENDING | AUTHORIZED | CONFIRMED | RECEIVED | OVERDUE | REFUNDED | FAILED | CANCELLED
  dueDate: string;
  paymentDate?: string;
  paymentMethod?: string;
}

export interface StudentPaymentSummaryDTO {
  studentId: string;
  totalSpentCents: number;
  classesDone: number;
  classesScheduled: number;
  pendingPaymentsCents: number;
  confirmedPaymentsCount: number;
  overduePaymentsCount: number;
}

export interface StudentAppointmentPaymentStateDTO {
  appointmentId: string;
  groupId: string;
  paymentStatus: string; // PENDING | CONFIRMED | RECEIVED | OVERDUE | REFUNDED | FAILED
  totalAmountCents: number;
  installments: StudentInstallmentDTO[];
}

export interface StudentLessonDTO {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  netAmount?: number;
}

export interface StudentHistoryItemDTO {
  id: string;
  providerPaymentId: string;
  groupId?: string;
  appointmentId?: string;
  instructorName: string;
  grossAmountCents: number;
  feeAmountCents: number;
  lessonPriceCents: number;
  paymentMethod?: string;
  dueDate: string;
  paymentDate?: string;
  status: string; // 'completed' | 'pending' | 'failed' | 'refunded'
  combo: boolean;
  isCombo: boolean;
  lessonCount: number;
  lessons: StudentLessonDTO[];
  appointmentDate?: string;
  appointmentTime?: string;
  createdAt: string;
  receivedInstallments?: number;
  totalInstallments?: number;
  latestPaymentDate?: string;
}

export interface StudentFinanceDataDTO {
  summary: StudentPaymentSummaryDTO;
  history: StudentHistoryItemDTO[];
}
