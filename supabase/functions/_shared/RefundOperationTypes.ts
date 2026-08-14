export type RefundOperationStatus =
  | 'REQUESTED'
  | 'PENDING'
  | 'UNKNOWN'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'DENIED'
  | 'CONFLICT';

export interface RefundOperationRecord {
  id: string;
  operation_key: string;
  provider: string;
  provider_payment_id: string;
  scope: string;
  status: RefundOperationStatus;
  requested_amount_cents: number;
  completed_amount_cents: number | null;
  currency: string;
  version: number;
  owner_id: string | null;
  lease_until: string | null;
  attempt: number;
  provider_refund_id: string | null;
  sent_at: string | null;
  unknown_since: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  denial_reason: string | null;
  receipt_url: string | null;
  raw_payload_hash: string | null;
  source_event_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateRefundOperationInput {
  operationKey: string;
  providerPaymentId: string;
  scope: string;
  requestedAmountCents: number;
  currency?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimRefundOperationResult {
  operation: RefundOperationRecord;
  claimed: boolean;
}
