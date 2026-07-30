/**
 * ReconciliationTypes.ts
 * CNHJá Financial Architecture v1.0 - Stage 9.0
 *
 * Types, Enums, and DTOs for Historical Reconciliation (Audit Layer).
 */

export enum ReconciliationSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL'
}

export enum InconsistencyType {
  MISSING_LEDGER = 'MISSING_LEDGER',
  MISSING_PROJECTION = 'MISSING_PROJECTION',
  MISSING_PAYOUT = 'MISSING_PAYOUT',
  DUPLICATE_LEDGER = 'DUPLICATE_LEDGER',
  DUPLICATE_PAYOUT = 'DUPLICATE_PAYOUT',
  DUPLICATE_PROJECTION = 'DUPLICATE_PROJECTION',
  ORPHAN_SETTLEMENT = 'ORPHAN_SETTLEMENT',
  ORPHAN_LEDGER = 'ORPHAN_LEDGER',
  ORPHAN_PAYOUT = 'ORPHAN_PAYOUT',
  ORPHAN_PROJECTION = 'ORPHAN_PROJECTION',
  INSTRUCTOR_MISMATCH = 'INSTRUCTOR_MISMATCH',
  VALUE_MISMATCH = 'VALUE_MISMATCH',
  STATUS_MISMATCH = 'STATUS_MISMATCH',
  FLOW_BROKEN = 'FLOW_BROKEN'
}

export interface ReconciliationInconsistency {
  id: string;
  settlementId?: string | null;
  payoutId?: string | null;
  transactionId?: string | null;
  instructorId?: string | null;
  installmentId?: string | null;
  type: InconsistencyType;
  severity: ReconciliationSeverity;
  description: string;
  expectedValue?: any;
  actualValue?: any;
  metadata?: Record<string, unknown>;
  detectedAt: string;
}

export interface ReconciliationSeverityCounts {
  INFO: number;
  WARNING: number;
  ERROR: number;
  CRITICAL: number;
}

export type InconsistencyTypeCounts = Record<InconsistencyType, number>;

export interface ReconciliationSummary {
  healthy: boolean;
  message: string;
  healthScorePercentage: number;
}

export interface ReconciliationReport {
  executionId: string;
  timestamp: string;
  executionTime: number; // in milliseconds
  totalAnalyzed: number;
  totalConsistent: number;
  totalInconsistent: number;
  severityCounts: ReconciliationSeverityCounts;
  inconsistencyTypeCounts: InconsistencyTypeCounts;
  items: ReconciliationInconsistency[];
  summary: ReconciliationSummary;
}

export interface ReconciliationOptions {
  settlementIds?: string[];
  instructorIds?: string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface RawAuditDataset {
  settlements: any[];
  payouts: any[];
  transactions: any[];
  projections: any[];
  installments: any[];
}
