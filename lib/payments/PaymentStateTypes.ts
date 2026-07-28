/**
 * Payment State Service Types & DTOs - CNHJá Financial Architecture v1.0
 * Strict Type Safety, zero 'any'.
 */

export type PaymentInstallmentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'CHARGEBACK'
  | 'CANCELLED'
  | 'FAILED';

export type AppointmentPaymentStatusProjection =
  | 'pending'
  | 'partially_paid'
  | 'paid'
  | 'refunded'
  | 'failed'
  | 'overdue';

export enum TransitionOutcome {
  TRANSITION_EXECUTED = 'TRANSITION_EXECUTED',
  NO_OP_DUPLICATE = 'NO_OP_DUPLICATE',
  NO_OP_OUT_OF_ORDER = 'NO_OP_OUT_OF_ORDER',
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  UNKNOWN_EVENT = 'UNKNOWN_EVENT',
  INSTALLMENT_NOT_FOUND = 'INSTALLMENT_NOT_FOUND',
  ERROR = 'ERROR'
}

export enum PaymentWarningCode {
  OUT_OF_ORDER_EVENT = 'OUT_OF_ORDER_EVENT',
  UNMAPPED_ASAAS_EVENT = 'UNMAPPED_ASAAS_EVENT',
  PAYMENT_ID_MISMATCH = 'PAYMENT_ID_MISMATCH',
  SUPABASE_UPDATE_WARNING = 'SUPABASE_UPDATE_WARNING'
}

export interface AsaasPaymentObject {
  id: string;
  customer?: string;
  installment?: string;
  installmentNumber?: number;
  installmentCount?: number;
  value?: number;
  netValue?: number;
  status?: string;
  billingType?: string;
  externalReference?: string;
  paymentDate?: string;
  clientPaymentDate?: string;
  creditDate?: string;
  estimatedCreditDate?: string;
  [key: string]: unknown;
}

export interface AsaasWebhookPayload {
  id?: string;
  event?: string;
  payment?: AsaasPaymentObject;
  account?: { id: string; [key: string]: unknown } | string;
  accountId?: string;
  dateCreated?: string;
  [key: string]: unknown;
}

export interface ProcessPaymentEventParams {
  providerPaymentId: string;
  providerEventId: string | null;
  eventType: string;
  installmentNumber?: number | null;
  externalReference?: string | null;
  payload: AsaasWebhookPayload;
  ledgerId?: string;
  timestamp?: string;
}

export interface PaymentStateProcessingResult {
  oldState: PaymentInstallmentStatus | null;
  newState: PaymentInstallmentStatus | null;
  transitionExecuted: boolean;
  noop: boolean;
  noopReason?: 'DUPLICATE_EVENT' | 'OUT_OF_ORDER_EVENT' | 'SAME_STATE' | 'UNMAPPED_EVENT' | 'INSTALLMENT_NOT_FOUND';
  outcome: TransitionOutcome;
  installmentId?: string;
  appointmentId?: string;
  groupId?: string;
  appointmentPaymentStatusUpdated?: boolean;
  newAppointmentPaymentStatus?: AppointmentPaymentStatusProjection;
  warnings: Array<{ code: PaymentWarningCode; message: string }>;
  processingError?: string;
}
