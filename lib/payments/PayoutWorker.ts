/**
 * PayoutWorker.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Operational Worker for executing the Payout Engine on candidate settlements.
 *
 * DELEGATION ONLY:
 * - Invokes exclusively PayoutEngine.processSettlement()
 * - Performs NO financial calculations or direct state transitions.
 * - Creates NO custom locks (relies 100% on PayoutEngine / DB RPC / FOR UPDATE).
 * - Implements fault isolation per settlement item.
 * - Produces structured metrics and telemetric logs.
 */

import { PayoutEngine } from './PayoutEngine.js';
import { EligibilityScanner } from './EligibilityScanner.js';
import { EligibleSettlementDTO } from './PayoutTypes.js';
import {
  WorkerBatchResult,
  PayoutWorkerMetrics,
  SettlementProcessResult,
  WorkerErrorDetail,
  WorkerExecutionStatus,
  ScannerOptions,
  PayoutWorkerOptions
} from './PayoutWorkerTypes.js';

export class PayoutWorker {
  private payoutEngine: PayoutEngine;
  private scanner?: EligibilityScanner;
  private options: PayoutWorkerOptions;

  constructor(
    payoutEngine: PayoutEngine,
    scanner?: EligibilityScanner,
    options: PayoutWorkerOptions = {}
  ) {
    this.payoutEngine = payoutEngine;
    this.scanner = scanner;
    this.options = {
      maxRetries: options.maxRetries || 0,
      transientErrorCodes: options.transientErrorCodes || [
        'DB_COMMUNICATION_ERROR',
        'FETCH_FAILED',
        'TIMEOUT',
        'ECONNRESET',
        'ETIMEDOUT'
      ]
    };
  }

  /**
   * Scans and processes candidate settlements in batch mode.
   */
  public async runBatch(scannerOptions: ScannerOptions = {}): Promise<WorkerBatchResult> {
    if (!this.scanner) {
      throw new Error('EligibilityScanner is required to execute runBatch()');
    }

    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();

    let scannedSettlements: EligibleSettlementDTO[] = [];
    try {
      scannedSettlements = await this.scanner.scanEligibleSettlements(scannerOptions);
    } catch (err: any) {
      const completedTime = Date.now();
      const completedAt = new Date(completedTime).toISOString();
      const durationMs = completedTime - startTime;

      const errorDetail: WorkerErrorDetail = {
        settlementId: 'SCANNER_ERROR',
        message: err.message || 'Scanner execution failed',
        tipo: err.name || 'ScannerException'
      };

      const metrics: PayoutWorkerMetrics = {
        executionId,
        startedAt,
        completedAt,
        durationMs,
        totalScanned: 0,
        totalProcessed: 0,
        totalBlocked: 0,
        totalFailed: 1,
        errors: [errorDetail]
      };

      return {
        executionId,
        executionStatus: 'FAILED',
        startedAt,
        completedAt,
        durationMs,
        totalScanned: 0,
        totalProcessed: 0,
        totalBlocked: 0,
        totalFailed: 1,
        results: [],
        metrics
      };
    }

    return this.processCandidates(scannedSettlements, executionId, startedAt, startTime);
  }

  /**
   * Processes a list of candidate settlements individually with fault isolation.
   */
  public async processCandidates(
    settlements: EligibleSettlementDTO[],
    customExecutionId?: string,
    customStartedAt?: string,
    customStartTime?: number
  ): Promise<WorkerBatchResult> {
    const startTime = customStartTime || Date.now();
    const startedAt = customStartedAt || new Date(startTime).toISOString();
    const executionId =
      customExecutionId || `exec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const totalScanned = settlements.length;
    let totalProcessed = 0;
    let totalBlocked = 0;
    let totalFailed = 0;

    const results: SettlementProcessResult[] = [];
    const errors: WorkerErrorDetail[] = [];

    console.log(`[PayoutWorker][${executionId}] Started batch processing for ${totalScanned} settlements.`);

    for (const settlement of settlements) {
      const itemResult = await this.processSingleSettlementWithRetry(settlement, executionId);

      results.push(itemResult);

      if (itemResult.success) {
        if (itemResult.status === 'BLOCKED') {
          totalBlocked++;
        } else {
          totalProcessed++;
        }
      } else {
        totalFailed++;
        errors.push({
          settlementId: settlement.id,
          message: itemResult.error || 'Processing failed',
          tipo: 'PayoutEngineProcessError'
        });
      }
    }

    const completedTime = Date.now();
    const completedAt = new Date(completedTime).toISOString();
    const durationMs = completedTime - startTime;

    let executionStatus: WorkerExecutionStatus = 'SUCCESS';
    if (totalFailed > 0) {
      if (totalProcessed > 0 || totalBlocked > 0) {
        executionStatus = 'PARTIAL_SUCCESS';
      } else {
        executionStatus = 'FAILED';
      }
    }

    const metrics: PayoutWorkerMetrics = {
      executionId,
      startedAt,
      completedAt,
      durationMs,
      totalScanned,
      totalProcessed,
      totalBlocked,
      totalFailed,
      errors
    };

    console.log(
      `[PayoutWorker][${executionId}] Finished batch processing. Status: ${executionStatus}. Scanned: ${totalScanned}, Processed: ${totalProcessed}, Blocked: ${totalBlocked}, Failed: ${totalFailed}. Duration: ${durationMs}ms.`
    );

    return {
      executionId,
      executionStatus,
      startedAt,
      completedAt,
      durationMs,
      totalScanned,
      totalProcessed,
      totalBlocked,
      totalFailed,
      results,
      metrics
    };
  }

  /**
   * Processes an individual settlement with retry support strictly for transient infrastructure errors.
   */
  private async processSingleSettlementWithRetry(
    settlement: EligibleSettlementDTO,
    executionId: string
  ): Promise<SettlementProcessResult> {
    const maxRetries = this.options.maxRetries || 0;
    let attempt = 0;

    while (true) {
      attempt++;
      try {
        const engineResult = await this.payoutEngine.processSettlement({ settlement });

        console.log(
          `[PayoutWorker][${executionId}] Settlement ${settlement.id} -> PayoutKey: ${engineResult.payoutKey}, Status: ${engineResult.status}, Success: ${engineResult.success}`
        );

        if (!engineResult.success) {
          // Check if error is transient and retry if attempts remain
          if (
            attempt <= maxRetries &&
            this.isTransientError(engineResult.error)
          ) {
            console.warn(
              `[PayoutWorker][${executionId}] Settlement ${settlement.id} transient error on attempt ${attempt}: ${engineResult.error}. Retrying...`
            );
            await new Promise((res) => setTimeout(res, 50 * attempt));
            continue;
          }

          return {
            settlementId: settlement.id,
            payoutKey: engineResult.payoutKey,
            success: false,
            status: engineResult.status,
            error: engineResult.error || 'Engine processing failed'
          };
        }

        return {
          settlementId: settlement.id,
          payoutKey: engineResult.payoutKey,
          success: true,
          status: engineResult.status
        };
      } catch (err: any) {
        if (attempt <= maxRetries && this.isTransientError(err.message || err.code)) {
          console.warn(
            `[PayoutWorker][${executionId}] Settlement ${settlement.id} exception on attempt ${attempt}: ${err.message}. Retrying...`
          );
          await new Promise((res) => setTimeout(res, 50 * attempt));
          continue;
        }

        console.error(
          `[PayoutWorker][${executionId}] Settlement ${settlement.id} processing exception: ${err.message}`
        );

        return {
          settlementId: settlement.id,
          success: false,
          error: err.message || 'Unhandled worker processing exception'
        };
      }
    }
  }

  /**
   * Determines if an error code or message represents a transient infrastructure failure.
   */
  private isTransientError(errorMsg?: string): boolean {
    if (!errorMsg) return false;
    const transientCodes = this.options.transientErrorCodes || [];
    return transientCodes.some((code) =>
      errorMsg.toUpperCase().includes(code.toUpperCase())
    );
  }
}
