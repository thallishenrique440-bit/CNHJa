/**
 * IntegrityChecker.ts
 * CNHJá Financial Architecture v1.0 - Stage 9.0
 *
 * Isolated Audit Engine for checking relationship integrity, amount consistency,
 * duplicate detection, orphan detection, status matching, and full flow verification.
 *
 * STRICTLY READ-ONLY:
 * Performs zero mutations, creates zero side-effects, and calculates no new financial states.
 */

import {
  InconsistencyType,
  RawAuditDataset,
  ReconciliationInconsistency,
  ReconciliationSeverity
} from './ReconciliationTypes.js';

export interface AuditDatasetIndex {
  installmentsById: Map<string, any>;
  settlementsById: Map<string, any>;
  settlementIds: Set<string>;
  settlementInstructorIds: Set<string>;
  payoutsBySettlementId: Map<string, any[]>;
  payoutsByKey: Map<string, any[]>;
  payoutIds: Set<string>;
  payoutKeys: Set<string>;
  payoutInstructorIds: Set<string>;
  transactionsBySettlementKey: Map<string, any[]>;
  transactionsByIdempotency: Map<string, any[]>;
  projectionsByInstructorId: Map<string, any[]>;
  installmentInstructorIds: Set<string>;
}

export class IntegrityChecker {
  /**
   * Builds single-pass O(1) indexing structures over the raw dataset.
   * Constructed once prior to audit execution to eliminate O(n²) linear array scans.
   */
  public buildDatasetIndex(dataset: RawAuditDataset): AuditDatasetIndex {
    const installmentsById = new Map<string, any>();
    const installmentInstructorIds = new Set<string>();

    for (const inst of dataset.installments || []) {
      if (inst.id) installmentsById.set(inst.id, inst);
      const instructorId = inst.instructor_id || inst.instructorId;
      if (instructorId) installmentInstructorIds.add(instructorId);
    }

    const settlementsById = new Map<string, any>();
    const settlementIds = new Set<string>();
    const settlementInstructorIds = new Set<string>();

    for (const s of dataset.settlements || []) {
      if (s.id) {
        settlementsById.set(s.id, s);
        settlementIds.add(s.id);
      }
      const instructorId = s.instructor_id || s.instructorId;
      if (instructorId) settlementInstructorIds.add(instructorId);
    }

    const payoutsBySettlementId = new Map<string, any[]>();
    const payoutsByKey = new Map<string, any[]>();
    const payoutIds = new Set<string>();
    const payoutKeys = new Set<string>();
    const payoutInstructorIds = new Set<string>();

    for (const payout of dataset.payouts || []) {
      if (payout.id) payoutIds.add(payout.id);

      const settlementId = payout.settlement_id || payout.settlementId;
      if (settlementId) {
        let list = payoutsBySettlementId.get(settlementId);
        if (!list) {
          list = [];
          payoutsBySettlementId.set(settlementId, list);
        }
        list.push(payout);
      }

      const payoutKey = payout.payout_key || payout.payoutKey;
      if (payoutKey) {
        payoutKeys.add(payoutKey);
        let list = payoutsByKey.get(payoutKey);
        if (!list) {
          list = [];
          payoutsByKey.set(payoutKey, list);
        }
        list.push(payout);

        if (payoutKey.includes('_')) {
          for (const sId of settlementIds) {
            if (payoutKey.includes(sId)) {
              let setList = payoutsBySettlementId.get(sId);
              if (!setList) {
                setList = [];
                payoutsBySettlementId.set(sId, setList);
              }
              if (!setList.includes(payout)) setList.push(payout);
            }
          }
        }
      }

      const instructorId = payout.instructor_id || payout.instructorId;
      if (instructorId) payoutInstructorIds.add(instructorId);
    }

    const transactionsBySettlementKey = new Map<string, any[]>();
    const transactionsByIdempotency = new Map<string, any[]>();

    for (const tx of dataset.transactions || []) {
      const idempotencyKey = tx.idempotency_key || tx.idempotencyKey;
      if (idempotencyKey) {
        let list = transactionsByIdempotency.get(idempotencyKey);
        if (!list) {
          list = [];
          transactionsByIdempotency.set(idempotencyKey, list);
        }
        list.push(tx);
      }

      const registerTxKey = (key?: string) => {
        if (!key) return;
        let list = transactionsBySettlementKey.get(key);
        if (!list) {
          list = [];
          transactionsBySettlementKey.set(key, list);
        }
        if (!list.includes(tx)) list.push(tx);
      };

      registerTxKey(tx.settlement_id);
      registerTxKey(tx.reference_id);
      registerTxKey(tx.metadata?.settlement_id);

      if (tx.payout_key) {
        registerTxKey(tx.payout_key);
        for (const sId of settlementIds) {
          if (tx.payout_key.includes(sId)) {
            registerTxKey(sId);
          }
        }
      }
    }

    const projectionsByInstructorId = new Map<string, any[]>();

    for (const proj of dataset.projections || []) {
      const instructorId = proj.instructor_id || proj.instructorId;
      if (instructorId) {
        let list = projectionsByInstructorId.get(instructorId);
        if (!list) {
          list = [];
          projectionsByInstructorId.set(instructorId, list);
        }
        list.push(proj);
      }
    }

    return {
      installmentsById,
      settlementsById,
      settlementIds,
      settlementInstructorIds,
      payoutsBySettlementId,
      payoutsByKey,
      payoutIds,
      payoutKeys,
      payoutInstructorIds,
      transactionsBySettlementKey,
      transactionsByIdempotency,
      projectionsByInstructorId,
      installmentInstructorIds
    };
  }

  /**
   * Main audit entry point. Runs all integrity checks across the full dataset in O(n) time.
   */
  public checkIntegrity(dataset: RawAuditDataset): ReconciliationInconsistency[] {
    const inconsistencies: ReconciliationInconsistency[] = [];
    const index = this.buildDatasetIndex(dataset);

    // 1. Audit Settlements
    for (const settlement of dataset.settlements) {
      inconsistencies.push(...this.checkSettlement(settlement, dataset, index));
    }

    // 2. Audit Payouts (Duplicates & Orphans)
    inconsistencies.push(...this.checkPayouts(dataset, index));

    // 3. Audit Ledger Transactions (Duplicates & Orphans)
    inconsistencies.push(...this.checkLedgerTransactions(dataset, index));

    // 4. Audit Projections (Duplicates & Orphans)
    inconsistencies.push(...this.checkProjections(dataset, index));

    return inconsistencies;
  }

  /**
   * Validates a single settlement across the entire financial chain.
   */
  public checkSettlement(
    settlement: any,
    dataset: RawAuditDataset,
    index?: AuditDatasetIndex
  ): ReconciliationInconsistency[] {
    const idx = index || this.buildDatasetIndex(dataset);
    const itemInconsistencies: ReconciliationInconsistency[] = [];
    const now = new Date().toISOString();

    const settlementId = settlement.id;
    const installmentId = settlement.installment_id || settlement.installmentId;
    const instructorId =
      settlement.instructor_id ||
      settlement.instructorId ||
      this.resolveInstructorIdFromInstallment(installmentId, dataset.installments, idx);

    const netAmount = Number(settlement.net_amount ?? settlement.netAmount ?? 0);
    const grossAmount = Number(settlement.gross_amount ?? settlement.grossAmount ?? 0);
    const platformFee = Number(settlement.platform_fee ?? settlement.platformFee ?? 0);
    const settlementType = settlement.settlement_type ?? settlement.settlementType ?? 'PAYMENT';
    const settledAt = settlement.settled_at ?? settlement.settledAt;

    // A. Check Orphan Settlement (referenced installment missing)
    let matchedInstallment: any = null;
    if (installmentId) {
      matchedInstallment = idx.installmentsById.get(installmentId) || null;
      if (!matchedInstallment) {
        itemInconsistencies.push({
          id: `inc_orph_set_${settlementId}_${Date.now()}`,
          settlementId,
          installmentId,
          instructorId,
          type: InconsistencyType.ORPHAN_SETTLEMENT,
          severity: ReconciliationSeverity.CRITICAL,
          description: `Settlement ${settlementId} references non-existent installment ${installmentId}`,
          expectedValue: `Valid installment ID`,
          actualValue: null,
          detectedAt: now
        });
      }
    }

    // B. Check Event Ledger existence
    const matchedLedgerEvents = idx.transactionsBySettlementKey.get(settlementId) || [];

    if (matchedLedgerEvents.length === 0) {
      itemInconsistencies.push({
        id: `inc_miss_ledg_${settlementId}_${Date.now()}`,
        settlementId,
        instructorId,
        type: InconsistencyType.MISSING_LEDGER,
        severity: ReconciliationSeverity.ERROR,
        description: `Settlement ${settlementId} has no corresponding Event Ledger transaction`,
        expectedValue: `Event Ledger record for settlement ${settlementId}`,
        actualValue: 0,
        detectedAt: now
      });
    }

    // C. Check Projection existence
    const matchedProjections = instructorId ? idx.projectionsByInstructorId.get(instructorId) || [] : [];
    const matchedProjection = matchedProjections.length > 0 ? matchedProjections[0] : null;

    if (!matchedProjection && instructorId) {
      itemInconsistencies.push({
        id: `inc_miss_proj_${settlementId}_${Date.now()}`,
        settlementId,
        instructorId,
        type: InconsistencyType.MISSING_PROJECTION,
        severity: ReconciliationSeverity.ERROR,
        description: `No projection record found for instructor ${instructorId} linked to settlement ${settlementId}`,
        expectedValue: `Projection record for instructor ${instructorId}`,
        actualValue: null,
        detectedAt: now
      });
    }

    // D. Check Payout existence for eligible settlement
    const isEligibleForPayout =
      settlementType === 'PAYMENT' &&
      settledAt !== null &&
      settledAt !== undefined &&
      netAmount > 0;

    const matchedPayouts = idx.payoutsBySettlementId.get(settlementId) || [];

    if (isEligibleForPayout && matchedPayouts.length === 0) {
      itemInconsistencies.push({
        id: `inc_miss_pay_${settlementId}_${Date.now()}`,
        settlementId,
        instructorId,
        type: InconsistencyType.MISSING_PAYOUT,
        severity: ReconciliationSeverity.WARNING,
        description: `Eligible settlement ${settlementId} (netAmount: ${netAmount}) has no associated Payout`,
        expectedValue: `Payout record for settlement ${settlementId}`,
        actualValue: 0,
        detectedAt: now
      });
    }

    // E. Verify Payout Consistency (Instructor, Values, Status)
    if (matchedPayouts.length > 0) {
      const payout = matchedPayouts[0];
      const payoutInstructorId = payout.instructor_id || payout.instructorId;
      const payoutNetAmount = Number(payout.net_amount ?? payout.netAmount ?? payout.amount ?? 0);
      const payoutGrossAmount = Number(payout.gross_amount ?? payout.grossAmount ?? payoutNetAmount);
      const payoutPlatformFee = Number(payout.platform_fee ?? payout.platformFee ?? 0);
      const payoutStatus = payout.status;

      // 1. Instructor Mismatch
      if (instructorId && payoutInstructorId && instructorId !== payoutInstructorId) {
        itemInconsistencies.push({
          id: `inc_inst_mismatch_${settlementId}_${Date.now()}`,
          settlementId,
          payoutId: payout.id,
          instructorId,
          type: InconsistencyType.INSTRUCTOR_MISMATCH,
          severity: ReconciliationSeverity.CRITICAL,
          description: `Instructor mismatch: Settlement has ${instructorId}, Payout has ${payoutInstructorId}`,
          expectedValue: instructorId,
          actualValue: payoutInstructorId,
          detectedAt: now
        });
      }

      // 2. Value Mismatch
      if (netAmount !== payoutNetAmount || grossAmount !== payoutGrossAmount || platformFee !== payoutPlatformFee) {
        itemInconsistencies.push({
          id: `inc_val_mismatch_${settlementId}_${Date.now()}`,
          settlementId,
          payoutId: payout.id,
          instructorId,
          type: InconsistencyType.VALUE_MISMATCH,
          severity: ReconciliationSeverity.CRITICAL,
          description: `Value mismatch for settlement ${settlementId}: Settlement net=${netAmount}, gross=${grossAmount}, fee=${platformFee} vs Payout net=${payoutNetAmount}, gross=${payoutGrossAmount}, fee=${payoutPlatformFee}`,
          expectedValue: { netAmount, grossAmount, platformFee },
          actualValue: { netAmount: payoutNetAmount, grossAmount: payoutGrossAmount, platformFee: payoutPlatformFee },
          detectedAt: now
        });
      }

      // 3. Status Mismatch
      const validPayoutStatuses = ['BLOCKED', 'READY', 'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'];
      if (!validPayoutStatuses.includes(payoutStatus)) {
        itemInconsistencies.push({
          id: `inc_stat_mismatch_${settlementId}_${Date.now()}`,
          settlementId,
          payoutId: payout.id,
          instructorId,
          type: InconsistencyType.STATUS_MISMATCH,
          severity: ReconciliationSeverity.ERROR,
          description: `Invalid or mismatched payout status '${payoutStatus}' for payout ${payout.id}`,
          expectedValue: `One of ${validPayoutStatuses.join(', ')}`,
          actualValue: payoutStatus,
          detectedAt: now
        });
      }
    }

    // F. Flow Completeness Check
    const hasBrokenFlow =
      (installmentId && !matchedInstallment) ||
      matchedLedgerEvents.length === 0 ||
      (!matchedProjection && Boolean(instructorId));

    if (hasBrokenFlow) {
      itemInconsistencies.push({
        id: `inc_flow_brk_${settlementId}_${Date.now()}`,
        settlementId,
        instructorId,
        type: InconsistencyType.FLOW_BROKEN,
        severity: ReconciliationSeverity.CRITICAL,
        description: `Broken flow chain for settlement ${settlementId}: Installment=${Boolean(matchedInstallment)}, Ledger=${matchedLedgerEvents.length > 0}, Projection=${Boolean(matchedProjection)}`,
        expectedValue: `Full contiguous chain: Installment -> Settlement -> Ledger -> Projection`,
        actualValue: `Broken intermediate step`,
        detectedAt: now
      });
    }

    return itemInconsistencies;
  }

  /**
   * Audits Payouts for duplicates and orphans in O(n) time.
   */
  public checkPayouts(dataset: RawAuditDataset, index?: AuditDatasetIndex): ReconciliationInconsistency[] {
    const idx = index || this.buildDatasetIndex(dataset);
    const inconsistencies: ReconciliationInconsistency[] = [];
    const now = new Date().toISOString();

    for (const payout of dataset.payouts) {
      const settlementId = payout.settlement_id || payout.settlementId;

      // Check Orphan Payout (pointing to missing settlement)
      if (settlementId) {
        const settlementExists = idx.settlementIds.has(settlementId);
        if (!settlementExists) {
          inconsistencies.push({
            id: `inc_orph_pay_${payout.id}_${Date.now()}`,
            payoutId: payout.id,
            settlementId,
            instructorId: payout.instructor_id || payout.instructorId,
            type: InconsistencyType.ORPHAN_PAYOUT,
            severity: ReconciliationSeverity.CRITICAL,
            description: `Orphan payout ${payout.id} points to non-existent settlement ${settlementId}`,
            expectedValue: `Valid settlement record`,
            actualValue: null,
            detectedAt: now
          });
        }
      }
    }

    // Detect duplicate payouts by settlementId
    for (const [settlementId, payouts] of idx.payoutsBySettlementId.entries()) {
      if (payouts.length > 1) {
        inconsistencies.push({
          id: `inc_dup_pay_set_${settlementId}_${Date.now()}`,
          settlementId,
          type: InconsistencyType.DUPLICATE_PAYOUT,
          severity: ReconciliationSeverity.CRITICAL,
          description: `Duplicate payouts detected (${payouts.length}) for settlement ${settlementId}`,
          expectedValue: 1,
          actualValue: payouts.length,
          metadata: { payoutIds: payouts.map(p => p.id) },
          detectedAt: now
        });
      }
    }

    // Detect duplicate payouts by payoutKey
    for (const [payoutKey, payouts] of idx.payoutsByKey.entries()) {
      if (payouts.length > 1) {
        inconsistencies.push({
          id: `inc_dup_pay_key_${payoutKey}_${Date.now()}`,
          payoutId: payouts[0].id,
          type: InconsistencyType.DUPLICATE_PAYOUT,
          severity: ReconciliationSeverity.CRITICAL,
          description: `Duplicate payouts detected (${payouts.length}) with same payout_key ${payoutKey}`,
          expectedValue: 1,
          actualValue: payouts.length,
          metadata: { payoutIds: payouts.map(p => p.id) },
          detectedAt: now
        });
      }
    }

    return inconsistencies;
  }

  /**
   * Audits Event Ledger transactions for duplicates and orphans in O(n) time.
   */
  public checkLedgerTransactions(dataset: RawAuditDataset, index?: AuditDatasetIndex): ReconciliationInconsistency[] {
    const idx = index || this.buildDatasetIndex(dataset);
    const inconsistencies: ReconciliationInconsistency[] = [];
    const now = new Date().toISOString();

    for (const tx of dataset.transactions) {
      const settlementId = tx.settlement_id || tx.reference_id;

      // Check Orphan Ledger (pointing to missing settlement or payout)
      if (settlementId) {
        const settlementExists = idx.settlementIds.has(settlementId);
        const payoutExists = idx.payoutIds.has(settlementId) || idx.payoutsBySettlementId.has(settlementId);

        if (!settlementExists && !payoutExists) {
          inconsistencies.push({
            id: `inc_orph_ledg_${tx.id}_${Date.now()}`,
            transactionId: tx.id,
            settlementId,
            type: InconsistencyType.ORPHAN_LEDGER,
            severity: ReconciliationSeverity.ERROR,
            description: `Orphan ledger transaction ${tx.id} points to non-existent entity ${settlementId}`,
            expectedValue: `Valid settlement or payout record`,
            actualValue: null,
            detectedAt: now
          });
        }
      }
    }

    // Detect duplicate ledger transactions by idempotency key
    for (const [idempotencyKey, txs] of idx.transactionsByIdempotency.entries()) {
      if (txs.length > 1) {
        inconsistencies.push({
          id: `inc_dup_ledg_${idempotencyKey}_${Date.now()}`,
          transactionId: txs[0].id,
          type: InconsistencyType.DUPLICATE_LEDGER,
          severity: ReconciliationSeverity.ERROR,
          description: `Duplicate ledger transactions (${txs.length}) for idempotency key ${idempotencyKey}`,
          expectedValue: 1,
          actualValue: txs.length,
          metadata: { transactionIds: txs.map(t => t.id) },
          detectedAt: now
        });
      }
    }

    return inconsistencies;
  }

  /**
   * Audits Projections for duplicates and orphans in O(n) time.
   */
  public checkProjections(dataset: RawAuditDataset, index?: AuditDatasetIndex): ReconciliationInconsistency[] {
    const idx = index || this.buildDatasetIndex(dataset);
    const inconsistencies: ReconciliationInconsistency[] = [];
    const now = new Date().toISOString();

    for (const proj of dataset.projections) {
      const instructorId = proj.instructor_id || proj.instructorId;

      if (instructorId) {
        // Check Orphan Projection (instructor has no settlements or payouts or installments)
        const hasSettlements = idx.settlementInstructorIds.has(instructorId);
        const hasPayouts = idx.payoutInstructorIds.has(instructorId);
        const hasInstallments = idx.installmentInstructorIds.has(instructorId);

        if (!hasSettlements && !hasPayouts && !hasInstallments) {
          inconsistencies.push({
            id: `inc_orph_proj_${proj.id || instructorId}_${Date.now()}`,
            instructorId,
            type: InconsistencyType.ORPHAN_PROJECTION,
            severity: ReconciliationSeverity.WARNING,
            description: `Orphan projection record for instructor ${instructorId} with no settlements, payouts, or installments`,
            expectedValue: `Associated financial activity`,
            actualValue: null,
            detectedAt: now
          });
        }
      }
    }

    // Detect duplicate active projection records for same instructor
    for (const [instructorId, projs] of idx.projectionsByInstructorId.entries()) {
      if (projs.length > 1) {
        inconsistencies.push({
          id: `inc_dup_proj_${instructorId}_${Date.now()}`,
          instructorId,
          type: InconsistencyType.DUPLICATE_PROJECTION,
          severity: ReconciliationSeverity.WARNING,
          description: `Multiple projection records (${projs.length}) for instructor ${instructorId}`,
          expectedValue: 1,
          actualValue: projs.length,
          detectedAt: now
        });
      }
    }

    return inconsistencies;
  }

  private resolveInstructorIdFromInstallment(
    installmentId?: string,
    installments: any[] = [],
    index?: AuditDatasetIndex
  ): string | null {
    if (!installmentId) return null;
    const inst = index ? index.installmentsById.get(installmentId) : installments.find(i => i.id === installmentId);
    return inst ? inst.instructor_id || inst.instructorId || null : null;
  }
}
