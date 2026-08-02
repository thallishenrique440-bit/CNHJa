/**
 * Settlement Types & DTOs
 * CNHJá Financial Architecture v1.0 (Etapa 6 - Settlement Service)
 */

export enum SettlementType {
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
  CHARGEBACK = 'CHARGEBACK'
}

export enum SettlementOutcome {
  SETTLEMENT_EXECUTED = 'SETTLEMENT_EXECUTED',
  NO_OP_DUPLICATE = 'NO_OP_DUPLICATE',
  NO_OP_SKIPPED = 'NO_OP_SKIPPED',
  ERROR = 'ERROR'
}

export enum SettlementWarningCode {
  ALREADY_SETTLED = 'ALREADY_SETTLED',
  ZERO_NET_AMOUNT = 'ZERO_NET_AMOUNT',
  MISSING_PROVIDER_SETTLEMENT_ID = 'MISSING_PROVIDER_SETTLEMENT_ID'
}

export interface SettlementWarning {
  code: SettlementWarningCode;
  message: string;
}

// Input DTO for Settlement Processing
export interface ProcessSettlementInput {
  origin?: 'LESSON' | 'TIP';
  studentId?: string | null;
  instructorId?: string | null;
  appointmentId?: string | null;
  installmentId?: string;
  providerPaymentId: string;
  installmentNumber?: number | null;
  providerSettlementId?: string | null;
  settlementType: SettlementType;
  grossAmount: number;      // Value in Cents
  netAmount?: number;        // Value in Cents (calculated if omitted)
  feeAmount?: number;        // Provider transaction fee in Cents
  platformFee?: number;     // Platform fee in Cents
  instructorAmount?: number; // Net to instructor in Cents
  paymentMethod?: 'PIX' | 'CREDIT_CARD' | 'BOLETO' | string;
  settledAt?: string;       // ISO Timestamp
  eventLedgerId?: string | null;
  payload?: any;
}

// Calculation Result Output
export interface SettlementCalculationResult {
  grossAmount: number;
  netAmount: number;
  feeAmount: number;
  platformFee: number;
  instructorAmount: number;
  settlementKey: string;
  settledAt: string;   // Exact settlement timestamp (ISO String)
  releaseDate: string; // Calculated payout availability date (ISO String)
}

// Database record interface for payment_settlements
export interface PaymentSettlementRecord {
  id: string;
  installment_id: string | null;
  provider_payment_id: string;
  provider_settlement_id: string | null;
  settlement_type: SettlementType;
  gross_amount: number;
  net_amount: number;
  fee_amount: number;
  platform_fee: number;
  instructor_amount: number;
  settled_at: string;
  created_at: string;
}

// Result DTO returned by SettlementService
export interface SettlementProcessResult {
  outcome: SettlementOutcome;
  settlementId?: string;
  transactionId?: string;
  installmentId?: string | null;
  settlementType: SettlementType;
  settlementKey: string;
  grossAmount: number;
  netAmount: number;
  feeAmount: number;
  platformFee: number;
  instructorAmount: number;
  settledAt: string;
  warnings: SettlementWarning[];
  error?: string;
}
