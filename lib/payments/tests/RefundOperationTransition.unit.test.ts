import { RefundOperationRepository } from '../RefundOperationRepository.js';
import { RefundOperationClaimLostError } from '../RefundOperationErrors.js';

const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

const record: any = { id: 'op-1', operation_key: 'key', provider: 'asaas', provider_payment_id: 'pay-1', scope: 'appointment', status: 'REQUESTED', version: 2, owner_id: 'worker-a' };
const client: any = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...record }, error: null }) }) }),
    update: (payload: any) => {
      const filters: Record<string, unknown> = {};
      const query: any = {
        eq: (key: string, value: unknown) => { filters[key] = value; return query; },
        select: () => ({ maybeSingle: async () => {
          const matches = filters.id === record.id && filters.owner_id === record.owner_id && filters.version === record.version;
          if (!matches) return { data: null, error: null };
          Object.assign(record, payload);
          return { data: { ...record }, error: null };
        } })
      };
      return query;
    }
  })
};

const transitioned = await RefundOperationRepository.transition(client, 'op-1', 'worker-a', 2, 'PENDING');
assert(transitioned.version === 3 && transitioned.status === 'PENDING', 'transition consumes v2 and produces v3');

let staleVersionBlocked = false;
try { await RefundOperationRepository.transition(client, 'op-1', 'worker-a', 2, 'PENDING'); }
catch (error) { staleVersionBlocked = error instanceof RefundOperationClaimLostError; }
assert(staleVersionBlocked, 'transition with stale version is blocked');

let staleOwnerBlocked = false;
try { await RefundOperationRepository.transition(client, 'op-1', 'worker-b', 3, 'PENDING'); }
catch (error) { staleOwnerBlocked = error instanceof RefundOperationClaimLostError; }
assert(staleOwnerBlocked, 'transition with stale owner is blocked');
