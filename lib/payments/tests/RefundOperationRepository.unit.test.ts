import { RefundOperationRepository } from '../RefundOperationRepository.js';
import { RefundOperationClaimLostError } from '../RefundOperationErrors.js';

const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

function client(options: { upsert?: any; update?: any; find?: any; inspect?: any } = {}): any {
  const selected = (data: any) => ({ maybeSingle: async () => ({ data, error: null }) });
  return {
    rpc: async () => ({ data: options.update || null, error: null }),
    from: () => ({
      upsert: () => ({ select: () => ({ maybeSingle: async () => ({ data: options.upsert || null, error: null }) }) }),
      update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ is: () => ({ select: () => ({ maybeSingle: async () => ({ data: options.update || null, error: null }) }) }) }) }) }) }),
      select: () => ({ eq: () => ({ ...selected(options.find || options.inspect || null), eq: () => selected(options.find || options.inspect || null) }) })
    })
  };
}

const operation = { id: 'op-1', operation_key: 'k1', provider: 'asaas', status: 'REQUESTED', version: 1 };
const created = await RefundOperationRepository.createOrGet(client({ upsert: operation }), {
  operationKey: 'k1', providerPaymentId: 'pay-1', scope: 'appointment:a1', requestedAmountCents: 10000
});
assert(created.operation_key === 'k1', 'createOrGet preserves operation key');

const claimed = await RefundOperationRepository.claim(client({ update: { ...operation, owner_id: 'worker-1', version: 2 } }), 'op-1', 'worker-1', '2026-08-12T00:00:00Z');
assert(claimed.claimed && claimed.operation.owner_id === 'worker-1' && claimed.operation.version === 2, 'REQUESTED operation can be claimed durably and increments version');

let blocked = false;
try { await RefundOperationRepository.claim(client({ inspect: { status: 'UNKNOWN' } }), 'op-1', 'worker-2', '2026-08-12T00:00:00Z'); }
catch (error) { blocked = error instanceof RefundOperationClaimLostError; }
assert(blocked, 'UNKNOWN operation cannot be claimed for a new POST');
