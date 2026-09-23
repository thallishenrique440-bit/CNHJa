import { SupabaseClient } from '@supabase/supabase-js';
import { RefundOperationClaimLostError, RefundOperationNotFoundError, RefundOperationPersistenceError, RefundOperationTransitionError, RefundOperationVersionConflictError } from './RefundOperationErrors.js';
import { canTransitionRefund } from './RefundStateMachine.js';
import {
  ClaimRefundOperationResult,
  CreateRefundOperationInput,
  RefundOperationRecord,
  RefundOperationStatus
} from './RefundOperationTypes.js';

const mapInput = (input: CreateRefundOperationInput) => ({
  operation_key: input.operationKey,
  provider: input.provider || 'asaas',
  provider_payment_id: input.providerPaymentId,
  scope: input.scope,
  status: 'REQUESTED' as const,
  requested_amount_cents: input.requestedAmountCents,
  currency: input.currency || 'BRL',
  metadata: input.metadata || {}
});

export class RefundOperationRepository {
  static async get(supabase: SupabaseClient, operationId: string): Promise<RefundOperationRecord> {
    const { data, error } = await supabase.from('refund_operations').select('*').eq('id', operationId).maybeSingle();
    if (error) throw new RefundOperationPersistenceError('Failed to get refund operation', error);
    if (!data) throw new RefundOperationNotFoundError(operationId);
    return data as RefundOperationRecord;
  }

  static async getByProviderRefundId(supabase: SupabaseClient, provider: string, providerRefundId: string): Promise<RefundOperationRecord | null> {
    const { data, error } = await supabase.from('refund_operations').select('*').eq('provider', provider).eq('provider_refund_id', providerRefundId).maybeSingle();
    if (error) throw new RefundOperationPersistenceError('Failed to find provider refund operation', error);
    return data as RefundOperationRecord | null;
  }
  static async findByOperationKey(
    supabase: SupabaseClient,
    provider: string,
    operationKey: string
  ): Promise<RefundOperationRecord | null> {
    const { data, error } = await supabase
      .from('refund_operations')
      .select('*')
      .eq('provider', provider)
      .eq('operation_key', operationKey)
      .maybeSingle();
    if (error) throw new RefundOperationPersistenceError('Failed to find refund operation', error);
    return data as RefundOperationRecord | null;
  }

  /** Creates once; a duplicate key returns the existing operation without resetting its state. */
  static async createOrGet(
    supabase: SupabaseClient,
    input: CreateRefundOperationInput
  ): Promise<RefundOperationRecord> {
    const payload = mapInput(input);
    const { data, error } = await supabase
      .from('refund_operations')
      .upsert(payload, { onConflict: 'provider,operation_key', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    if (error) throw new RefundOperationPersistenceError('Failed to create refund operation', error);
    if (data) return data as RefundOperationRecord;
    const existing = await this.findByOperationKey(supabase, payload.provider, payload.operation_key);
    if (!existing) throw new RefundOperationPersistenceError('Refund operation disappeared after idempotent create');
    return existing;
  }

  /**
   * P-1.20.1B — CLAIM IS THE TRANSITION `REQUESTED -> PENDING`.
   *
   * Before this phase the claim only stamped owner/lease and left the row in
   * REQUESTED; the Core then issued a SEPARATE transition to PENDING using the
   * version it had captured BEFORE the claim. That version was already stale,
   * the CAS matched zero rows and every paid cancellation died with a false
   * "owned by another worker". Folding the transition into the claim makes that
   * defect structurally unrepresentable: there is no intermediate version to
   * get wrong, and no second lock.
   *
   * There is exactly ONE claim mechanism: a single atomic CAS `UPDATE`. The
   * previous RPC-then-fallback pair had divergent semantics (the RPC left
   * REQUESTED, the fallback wrote PENDING) and the RPC additionally pinned
   * `version = 1`, which made any released operation impossible to re-claim.
   *
   * `sent_at` is stamped here, together with PENDING, because from this moment
   * on the operation MAY have reached the gateway. A crash after this point
   * must never be read as "nothing was sent".
   *
   * The returned record carries the NEW version. Callers must thread that value
   * into the next transition and must never compute `version + 1` themselves.
   */
  static async claim(
    supabase: SupabaseClient,
    operationId: string,
    ownerId: string,
    leaseUntil: string
  ): Promise<ClaimRefundOperationResult> {
    let current = await this.get(supabase, operationId);

    // Recovery, in this order, so that no operation is structurally unrecoverable:
    //  - PENDING with an expired lease  -> UNKNOWN (only external evidence may close it)
    //  - REQUESTED holding a dead claim -> released back to an unowned REQUESTED
    if (current.status === 'PENDING') {
      current = await this.handleExpiredPending(supabase, current);
    }
    if (current.status === 'REQUESTED' && current.owner_id) {
      current = await this.releaseStaleRequestedClaim(supabase, current);
    }

    // Only an unowned REQUESTED operation may be claimed.
    if (current.status !== 'REQUESTED' || current.owner_id) {
      return { operation: current, claimed: false };
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('refund_operations')
      .update({
        status: 'PENDING',
        owner_id: ownerId,
        lease_until: leaseUntil,
        sent_at: nowIso,
        attempt: (Number(current.attempt) || 0) + 1,
        version: current.version + 1,
        updated_at: nowIso
      })
      .eq('id', operationId)
      .eq('version', current.version)
      .eq('status', 'REQUESTED')
      .is('owner_id', null)
      .select('*')
      .maybeSingle();

    if (error) throw new RefundOperationPersistenceError('Failed to claim refund operation', error);

    if (!data) {
      // Lost the race to a concurrent worker. Not an error: the other worker owns it.
      const recheck = await this.get(supabase, operationId);
      return { operation: recheck, claimed: false };
    }

    return { operation: data as RefundOperationRecord, claimed: true };
  }

  /**
   * P-1.20.1B: releases a claim stranded on a REQUESTED row.
   *
   * With the claim folded into the transition this state is no longer produced,
   * but rows written by the previous code exist and a future defect could
   * recreate it. Without this, such a row can never be claimed again and the
   * money it represents is frozen forever. Only a lease that has ALREADY
   * expired is released; a live lease means a real worker is holding it.
   */
  static async releaseStaleRequestedClaim(
    supabase: SupabaseClient,
    operation: RefundOperationRecord
  ): Promise<RefundOperationRecord> {
    if (operation.status !== 'REQUESTED' || !operation.owner_id) return operation;

    const leaseExpired = !operation.lease_until
      || new Date(operation.lease_until).getTime() <= Date.now();
    if (!leaseExpired) return operation;

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('refund_operations')
      .update({
        owner_id: null,
        lease_until: null,
        version: operation.version + 1,
        updated_at: nowIso,
        metadata: {
          ...(operation.metadata || {}),
          stale_claim_released_at: nowIso,
          stale_claim_released_from: operation.owner_id
        }
      })
      .eq('id', operation.id)
      .eq('version', operation.version)
      .eq('status', 'REQUESTED')
      .select('*')
      .maybeSingle();

    if (!error && data) return data as RefundOperationRecord;
    return await this.get(supabase, operation.id);
  }

  /**
   * P0-01: Checks if a PENDING operation has an expired lease.
   * If expired, automatically transitions it to UNKNOWN to block direct automatic POST retries.
   */
  static async handleExpiredPending(
    supabase: SupabaseClient,
    operationOrId: RefundOperationRecord | string
  ): Promise<RefundOperationRecord> {
    const operation = typeof operationOrId === 'string'
      ? await this.get(supabase, operationOrId)
      : operationOrId;

    if (operation.status === 'PENDING' && operation.lease_until) {
      const isExpired = new Date(operation.lease_until).getTime() <= Date.now();
      if (isExpired) {
        const { data, error } = await supabase
          .from('refund_operations')
          .update({
            status: 'UNKNOWN',
            unknown_since: new Date().toISOString(),
            // P-1.20.1B: the reaper writes a version too, so a concurrent
            // owner-scoped transition cannot silently overwrite this decision.
            version: operation.version + 1,
            updated_at: new Date().toISOString(),
            metadata: {
              ...(operation.metadata || {}),
              lease_expired_at: new Date().toISOString(),
              reason: 'lease_expired_in_pending'
            }
          })
          .eq('id', operation.id)
          .eq('version', operation.version)
          .eq('status', 'PENDING')
          .select('*')
          .maybeSingle();

        if (!error && data) {
          return data as RefundOperationRecord;
        }
        return await this.get(supabase, operation.id);
      }
    }
    return operation;
  }

  /**
   * Calculates total retained refund amount in cents for a payment across all non-failed refund operations.
   * Retained states: REQUESTED, PENDING, UNKNOWN, COMPLETED, PARTIALLY_COMPLETED, CONFLICT.
   */
  static async getRetainedAmountCents(
    supabase: SupabaseClient,
    providerPaymentId: string,
    excludeOperationKey?: string
  ): Promise<number> {
    const retainedStatuses = ['REQUESTED', 'PENDING', 'UNKNOWN', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CONFLICT'];
    let query = supabase
      .from('refund_operations')
      .select('requested_amount_cents, completed_amount_cents, status')
      .eq('provider_payment_id', providerPaymentId)
      .in('status', retainedStatuses);

    if (excludeOperationKey) {
      query = query.neq('operation_key', excludeOperationKey);
    }

    const { data, error } = await query;

    if (error) {
      console.warn(`[RefundOperationRepository] Error fetching retained refund ops for ${providerPaymentId}:`, error);
      return 0;
    }

    if (!data || data.length === 0) return 0;

    // Explicitly annotated: the generated Deno copy is typechecked with
    // different inference settings and would otherwise fail on implicit `any`.
    return data.reduce((sum: number, op: any) => {
      const amt = op.completed_amount_cents !== null && op.completed_amount_cents !== undefined
        ? Number(op.completed_amount_cents)
        : Number(op.requested_amount_cents);
      return sum + (amt || 0);
    }, 0);
  }

  static async transition(
    supabase: SupabaseClient,
    operationId: string,
    ownerId: string,
    expectedVersion: number,
    status: RefundOperationStatus,
    fields: Record<string, unknown> = {}
  ): Promise<RefundOperationRecord> {
    const current = await this.get(supabase, operationId);
    if (!canTransitionRefund(current.status, status, { source: 'local', complete: status === 'COMPLETED' })) {
      throw new RefundOperationTransitionError(`Invalid refund transition ${current.status} -> ${status}`);
    }
    const { data, error } = await supabase
      .from('refund_operations')
      .update({ ...fields, status, version: expectedVersion + 1, updated_at: new Date().toISOString() })
      .eq('id', operationId)
      .eq('owner_id', ownerId)
      .eq('version', expectedVersion)
      .select('*')
      .maybeSingle();
    if (error) throw new RefundOperationPersistenceError('Failed to transition refund operation', error);
    if (!data) {
      // P-1.20.1B: a CAS miss has two very different causes and they must not
      // share one message. Re-read the row and report the real one.
      const actual = await this.get(supabase, operationId);
      if (actual.version !== expectedVersion) {
        throw new RefundOperationVersionConflictError(operationId, expectedVersion, actual.version);
      }
      throw new RefundOperationClaimLostError(operationId);
    }
    return data as RefundOperationRecord;
  }

  /**
   * Fetches all active operations for a provider payment ID that can be reconciled.
   * Reconcilable states: REQUESTED, PENDING, UNKNOWN, PARTIALLY_COMPLETED, CONFLICT.
   */
  static async getReconcilableOperations(
    supabase: SupabaseClient,
    provider: string,
    providerPaymentId: string
  ): Promise<RefundOperationRecord[]> {
    const activeStatuses = ['REQUESTED', 'PENDING', 'UNKNOWN', 'PARTIALLY_COMPLETED', 'CONFLICT'];
    const { data, error } = await supabase
      .from('refund_operations')
      .select('*')
      .eq('provider', provider)
      .eq('provider_payment_id', providerPaymentId)
      .in('status', activeStatuses);

    if (error) {
      console.warn(`[RefundOperationRepository] Error fetching reconcilable operations for ${providerPaymentId}:`, error);
      return [];
    }
    return (data || []) as RefundOperationRecord[];
  }

  /**
   * Reconciles transition from external gateway evidence (webhook/job).
   * Does NOT require owner_id match, but strictly enforces CAS version and valid state machine transitions.
   */
  static async reconcileTransition(
    supabase: SupabaseClient,
    operationId: string,
    expectedVersion: number,
    status: RefundOperationStatus,
    fields: Record<string, unknown> = {}
  ): Promise<RefundOperationRecord> {
    const current = await this.get(supabase, operationId);
    if (!canTransitionRefund(current.status, status, { source: 'webhook', complete: status === 'COMPLETED' })) {
      throw new RefundOperationTransitionError(`Invalid gateway refund transition ${current.status} -> ${status}`);
    }
    const { data, error } = await supabase
      .from('refund_operations')
      .update({ ...fields, status, version: expectedVersion + 1, updated_at: new Date().toISOString() })
      .eq('id', operationId)
      .eq('version', expectedVersion)
      .select('*')
      .maybeSingle();

    if (error) throw new RefundOperationPersistenceError('Failed to reconcile transition refund operation', error);
    if (!data) {
      const actual = await this.get(supabase, operationId);
      throw new RefundOperationVersionConflictError(operationId, expectedVersion, actual.version);
    }
    return data as RefundOperationRecord;
  }
}
