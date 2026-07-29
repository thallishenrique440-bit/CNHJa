/**
 * PayoutEngine.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * Core Payout Orchestrator.
 * Orchestrates eligibility evaluation, key generation, state machine validation,
 * and repository record creation for single settlement repasse events.
 *
 * Strict Boundaries:
 * - NO background scanning / crons / workers
 * - NO external Asaas API calls (Stage 8.1C)
 * - NO direct SQL queries (delegates to PayoutRepository -> RPC)
 */

import { EligibilityService } from './EligibilityService.js';
import { PayoutKeyFactory } from './PayoutKeyFactory.js';
import { PayoutStateMachine } from './PayoutStateMachine.js';
import { PayoutRepository } from './PayoutRepository.js';
import {
  PayoutEngineProcessInput,
  PayoutEngineProcessResult,
  PayoutStatus,
  RecordPayoutPayloadDTO,
  PayoutLedgerEvents
} from './PayoutTypes.js';
import { PayoutDomainException } from './PayoutErrors.js';

export class PayoutEngine {
  private eligibilityService: EligibilityService;
  private repository: PayoutRepository;

  constructor(
    eligibilityService?: EligibilityService,
    repository?: PayoutRepository
  ) {
    this.eligibilityService = eligibilityService || new EligibilityService();
    this.repository = repository || new PayoutRepository();
  }

  /**
   * Processes a settlement repasse event through the Stage 8.1B pipeline.
   */
  public async processSettlement(
    input: PayoutEngineProcessInput
  ): Promise<PayoutEngineProcessResult> {
    const { settlement, mode = 'SHADOW', ledgerEventType, idempotencyKey } = input;

    if (!settlement) {
      return {
        success: false,
        payoutKey: '',
        status: 'BLOCKED',
        eligibility: { eligible: false, reason: 'Settlement input missing' },
        error: 'Settlement object is null or undefined'
      };
    }

    // 1. Generate deterministic payout key via PayoutKeyFactory
    let payoutKey: string;
    try {
      payoutKey = PayoutKeyFactory.generateKey(settlement.instructorId, settlement.id);
    } catch (keyErr: any) {
      return {
        success: false,
        payoutKey: '',
        status: 'BLOCKED',
        eligibility: { eligible: false, reason: keyErr.message },
        error: keyErr.message
      };
    }

    // 2. Evaluate financial eligibility rules
    const eligibility = this.eligibilityService.checkEligibility(settlement);
    const initialStatus: PayoutStatus = eligibility.eligible ? 'READY' : 'BLOCKED';

    // 3. In-memory state machine validation
    try {
      PayoutStateMachine.validateTransition(null, initialStatus);
    } catch (smErr: any) {
      return {
        success: false,
        payoutKey,
        status: initialStatus,
        eligibility,
        error: smErr.message
      };
    }

    // 4. Construct payload DTO
    const resolvedLedgerEventType =
      ledgerEventType ||
      (eligibility.eligible
        ? PayoutLedgerEvents.PAYOUT_SCHEDULED
        : PayoutLedgerEvents.PAYOUT_BLOCKED);
    const resolvedIdempotencyKey =
      idempotencyKey || `evt_${payoutKey}_${initialStatus.toLowerCase()}`;

    const payload: RecordPayoutPayloadDTO = {
      payoutKey,
      instructorId: settlement.instructorId,
      appointmentId: settlement.appointmentId,
      installmentId: settlement.installmentId,
      settlementId: settlement.id,
      grossAmount: settlement.grossAmount,
      platformFee: settlement.platformFee,
      netAmount: settlement.netAmount,
      amount: settlement.netAmount,
      status: initialStatus,
      payoutMode: mode,
      ledgerEventType: resolvedLedgerEventType,
      idempotencyKey: resolvedIdempotencyKey
    };

    // 5. Delegate persistence and Event Ledger entry to Repository
    try {
      const res = await this.repository.recordPayoutAndLedgerEvent(payload);

      if (!res.success) {
        return {
          success: false,
          payoutKey,
          status: initialStatus,
          eligibility,
          error: res.message || res.error || 'Failed to record payout in repository'
        };
      }

      return {
        success: true,
        payoutKey,
        status: (res.status as PayoutStatus) || initialStatus,
        payoutId: res.payout_id,
        transactionId: res.transaction_id,
        eligibility
      };
    } catch (repoErr: any) {
      return {
        success: false,
        payoutKey,
        status: initialStatus,
        eligibility,
        error: repoErr.message
      };
    }
  }
}
