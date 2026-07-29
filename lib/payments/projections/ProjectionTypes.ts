/**
 * ProjectionTypes.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7 - Projection Service)
 *
 * Types, Interfaces, Enums, and DTOs for the CQRS Read Model layer.
 */

export enum ProjectionOutcome {
  PROJECTION_UPDATED = 'PROJECTION_UPDATED',
  NO_OP_ALREADY_PROJECTED = 'NO_OP_ALREADY_PROJECTED',
  NO_OP_IGNORED_EVENT = 'NO_OP_IGNORED_EVENT',
  ERROR = 'ERROR',
  REBUILD_SUCCESS = 'REBUILD_SUCCESS'
}

export enum ProjectionSourceEventType {
  STATE_TRANSITION = 'STATE_TRANSITION',
  SETTLEMENT_EXECUTED = 'SETTLEMENT_EXECUTED',
  SETTLEMENT_REFUND = 'SETTLEMENT_REFUND',
  SETTLEMENT_CHARGEBACK = 'SETTLEMENT_CHARGEBACK',
  REBUILD_REQUEST = 'REBUILD_REQUEST'
}

export type CashFlowEntityType = 'INSTRUCTOR' | 'PLATFORM';

export interface InstructorProjectionRecord {
  id?: string;
  instructor_id: string;
  future_receivables: number;  // Cents
  pending_release: number;     // Cents
  settled_available: number;   // Cents
  total_gross: number;         // Cents
  total_platform_fee: number;  // Cents
  total_net: number;           // Cents
  total_refunds: number;       // Cents
  total_chargebacks: number;   // Cents
  total_overdue: number;       // Cents
  projection_version: number;
  last_processed_event_id: string | null;
  last_processed_settlement_id: string | null;
  rebuild_version: number;
  created_at?: string;
  updated_at?: string;
}

export interface PlatformProjectionRecord {
  id?: string;
  platform_key: string;       // Default 'GLOBAL'
  gmv: number;                // Cents
  total_revenue: number;      // Platform fee in Cents
  total_fee_collected: number;// Provider fee in Cents
  total_instructor_payouts: number; // Cents
  total_refunds: number;      // Cents
  total_chargebacks: number;  // Cents
  projection_version: number;
  last_processed_event_id: string | null;
  last_processed_settlement_id: string | null;
  rebuild_version: number;
  created_at?: string;
  updated_at?: string;
}

export interface CashFlowProjectionRecord {
  id?: string;
  entity_type: CashFlowEntityType;
  entity_id: string;          // Instructor UUID or 'GLOBAL'
  projection_date: string;    // YYYY-MM-DD
  expected_inflow: number;    // Cents
  expected_outflow: number;   // Cents
  settled_inflow: number;     // Cents
  settled_outflow: number;    // Cents
  projection_version: number;
  last_processed_event_id: string | null;
  last_processed_settlement_id: string | null;
  rebuild_version: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectionEventPayload {
  eventType: ProjectionSourceEventType;
  eventId?: string;              // Ledger / event ID
  settlementId?: string;         // Settlement record ID
  providerPaymentId: string;
  installmentId?: string;
  instructorId?: string;
  studentId?: string;
  appointmentId?: string;
  grossAmount?: number;          // Cents
  netAmount?: number;            // Cents
  platformFee?: number;          // Cents
  feeAmount?: number;            // Cents
  instructorAmount?: number;     // Cents
  status?: string;               // e.g. PENDING, RECEIVED, REFUNDED
  settlementType?: 'PAYMENT' | 'REFUND' | 'CHARGEBACK';
  dueDate?: string;              // ISO or YYYY-MM-DD
  paymentDate?: string;          // ISO
  settledAt?: string;            // ISO
  releaseDate?: string;          // ISO or YYYY-MM-DD
  rebuildVersion?: number;
}

export interface ProjectionResult {
  outcome: ProjectionOutcome;
  instructorProjection?: InstructorProjectionRecord;
  platformProjection?: PlatformProjectionRecord;
  cashFlowProjection?: CashFlowProjectionRecord;
  projectionVersion?: number;
  rebuildVersion?: number;
  lastProcessedEventId?: string | null;
  lastProcessedSettlementId?: string | null;
  error?: string;
}

export interface InstructorDashboardProjectionDTO {
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
  rebuildVersion: number;
  updatedAt: string;
}

export interface PlatformDashboardProjectionDTO {
  platformKey: string;
  gmvCents: number;
  totalRevenueCents: number;
  totalFeeCollectedCents: number;
  totalInstructorPayoutsCents: number;
  totalRefundsCents: number;
  totalChargebacksCents: number;
  projectionVersion: number;
  rebuildVersion: number;
  updatedAt: string;
}

export interface MonthlyForecastDTO {
  month: string;               // YYYY-MM
  entityType: CashFlowEntityType;
  entityId: string;
  expectedInflowCents: number;
  expectedOutflowCents: number;
  settledInflowCents: number;
  settledOutflowCents: number;
  netForecastCents: number;
}

export interface RebuildSummaryDTO {
  outcome: ProjectionOutcome;
  rebuildVersion: number;
  totalInstallmentsProcessed: number;
  totalSettlementsProcessed: number;
  instructorsProjectedCount: number;
  cashFlowEntriesCount: number;
  durationMs: number;
}
