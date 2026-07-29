/**
 * PayoutTypes.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B Types & DTOs
 *
 * Defines domain models, state enums, eligibility interfaces,
 * and RPC request/response contracts for the Payout Engine.
 */

export type PayoutStatus =
  | 'BLOCKED'
  | 'READY'
  | 'PENDING'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'CANCELLED';

export type PayoutMode = 'SHADOW' | 'LIVE';

export type PayoutProviderStatus =
  | 'PENDING'
  | 'IN_TRANSIT'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

export type SettlementType = 'PAYMENT' | 'REFUND' | 'CHARGEBACK';

export const PayoutLedgerEvents = {
  PAYOUT_SCHEDULED: 'PAYOUT_SCHEDULED',
  PAYOUT_BLOCKED: 'PAYOUT_BLOCKED',
  PAYOUT_PROCESSING: 'PAYOUT_PROCESSING',
  PAYOUT_EXECUTED: 'PAYOUT_EXECUTED',
  PAYOUT_FAILED: 'PAYOUT_FAILED',
  PAYOUT_CANCELLED: 'PAYOUT_CANCELLED'
} as const;

export type PayoutLedgerEventType = typeof PayoutLedgerEvents[keyof typeof PayoutLedgerEvents];

export interface EligibleSettlementDTO {
  id: string; // settlement_id
  providerPaymentId: string;
  installmentId?: string | null;
  appointmentId?: string | null;
  instructorId: string;
  settlementType: SettlementType;
  grossAmount: number;        // Cents
  netAmount: number;          // Cents
  platformFee: number;        // Cents
  feeAmount?: number;         // Cents
  instructorAmount: number;   // Cents
  settledAt: string;          // ISO Date
  installmentStatus?: string | null; // e.g. 'PAID', 'RECEIVED'
}

export interface EligibilityCheckResult {
  eligible: boolean;
  reason?: string;
  settlement?: EligibleSettlementDTO;
}

export interface RecordPayoutPayloadDTO {
  payoutKey: string;
  instructorId: string;
  appointmentId?: string | null;
  installmentId?: string | null;
  settlementId?: string | null;
  grossAmount: number;
  platformFee: number;
  netAmount: number;
  amount: number;
  status: PayoutStatus;
  payoutMode?: PayoutMode;
  providerTransferId?: string | null;
  providerStatus?: PayoutProviderStatus | null;
  failureReason?: string | null;
  executedAt?: string | null;
  ledgerEventType?: string | null;
  idempotencyKey?: string | null;
  providerEventId?: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface RecordPayoutResponseDTO {
  success: boolean;
  payout_id?: string;
  payout_key?: string;
  status?: PayoutStatus;
  transaction_id?: string;
  error?: string;
  message?: string;
}

export interface PayoutEngineProcessInput {
  settlement: EligibleSettlementDTO;
  mode?: PayoutMode;
  ledgerEventType?: string;
  idempotencyKey?: string;
}

export interface PayoutEngineProcessResult {
  success: boolean;
  payoutKey: string;
  status: PayoutStatus;
  payoutId?: string;
  transactionId?: string;
  eligibility: EligibilityCheckResult;
  error?: string;
}
