/**
 * PayoutWorkerTypes.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Types, DTOs, and Metrics interfaces for EligibilityScanner and PayoutWorker.
 */

import { PayoutStatus, EligibleSettlementDTO } from './PayoutTypes.js';

export interface ScannerOptions {
  limit?: number;
  afterSettlementId?: string;
  afterSettledAt?: string;
}

export type WorkerExecutionStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED';

export interface SettlementProcessResult {
  settlementId: string;
  payoutKey?: string;
  success: boolean;
  status?: PayoutStatus;
  error?: string;
}

export interface WorkerErrorDetail {
  settlementId: string;
  message: string;
  tipo: string;
}

export interface PayoutWorkerMetrics {
  executionId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalScanned: number;
  totalProcessed: number;
  totalBlocked: number;
  totalFailed: number;
  errors: WorkerErrorDetail[];
}

export interface WorkerBatchResult {
  executionId: string;
  executionStatus: WorkerExecutionStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalScanned: number;
  totalProcessed: number;
  totalBlocked: number;
  totalFailed: number;
  results: SettlementProcessResult[];
  metrics: PayoutWorkerMetrics;
}

export interface PayoutWorkerOptions {
  maxRetries?: number;
  transientErrorCodes?: string[];
}
