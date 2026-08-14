import { SupabaseClient } from '@supabase/supabase-js';
import { RefundOperationClaimLostError, RefundOperationNotFoundError, RefundOperationPersistenceError, RefundOperationTransitionError } from './RefundOperationErrors.js';
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
   * Durable claim. This phase only claims the operation; it deliberately does
   * not call Asaas or mark sent_at. UNKNOWN is never claimable for a new POST.
   */
  static async claim(
    supabase: SupabaseClient,
    operationId: string,
    ownerId: string,
    leaseUntil: string
  ): Promise<ClaimRefundOperationResult> {
    try {
      const { data, error } = await supabase.rpc('claim_refund_operation', {
        p_operation_id: operationId,
        p_owner_id: ownerId,
        p_lease_until: leaseUntil
      });
      if (!error) {
        const claimedOperation = Array.isArray(data) ? data[0] : data;
        if (claimedOperation) {
          return { operation: claimedOperation as RefundOperationRecord, claimed: true };
        }
      }
    } catch {
      // RPC fallback to direct CAS update
    }

    // Direct atomic CAS claim update
    const currentRes = await supabase.from('refund_operations').select('*').eq('id', operationId).maybeSingle();
    if (currentRes.error) throw new RefundOperationPersistenceError('Failed to inspect refund operation before claim', currentRes.error);
    if (!currentRes.data) throw new RefundOperationNotFoundError(operationId);

    let current = currentRes.data as RefundOperationRecord;

    // Handle PENDING lease expiration if expired
    if (current.status === 'PENDING') {
      current = await this.handleExpiredPending(supabase, current);
    }

    // ONLY REQUESTED status can be claimed
    if (current.status !== 'REQUESTED') {
      return { operation: current, claimed: false };
    }

    const { data: updated, error: updateErr } = await supabase
      .from('refund_operations')
      .update({
        owner_id: ownerId,
        lease_until: leaseUntil,
        status: 'PENDING',
        version: current.version + 1,
        updated_at: new Date().toISOString()
      })
      .eq('id', operationId)
      .eq('version', current.version)
      .eq('status', 'REQUESTED')
      .select('*')
      .maybeSingle();

    if (updateErr || !updated) {
      const recheck = await supabase.from('refund_operations').select('*').eq('id', operationId).maybeSingle();
      return { operation: (recheck.data as RefundOperationRecord) || current, claimed: false };
    }

    return { operation: updated as RefundOperationRecord, claimed: true };
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
            updated_at: new Date().toISOString(),
            metadata: {
              ...(operation.metadata || {}),
              lease_expired_at: new Date().toISOString(),
              reason: 'lease_expired_in_pending'
            }
          })
          .eq('id', operation.id)
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

    return data.reduce((sum, op) => {
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
    if (!data) throw new RefundOperationClaimLostError(operationId);
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
    if (!canTransitionRefund(current.status, status, { source: 'gateway', complete: status === 'COMPLETED' })) {
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
    if (!data) throw new RefundOperationClaimLostError(operationId);
    return data as RefundOperationRecord;
  }
}
