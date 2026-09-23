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

// P-1.20.1B: o claim passou a LER a operacao antes de tentar o CAS (para poder
// reaproveitar um lease vencido), entao o mock precisa devolver a linha atual em
// `find`. E o claim agora e' a propria transicao REQUESTED -> PENDING, por isso
// o registro devolvido ja vem com status PENDING.
const claimed = await RefundOperationRepository.claim(
  client({
    find: { ...operation, owner_id: null },
    update: { ...operation, status: 'PENDING', owner_id: 'worker-1', version: 2, sent_at: '2026-08-12T00:00:00Z' }
  }),
  'op-1', 'worker-1', '2026-08-12T00:00:00Z'
);
assert(claimed.claimed && claimed.operation.owner_id === 'worker-1' && claimed.operation.version === 2, 'REQUESTED operation can be claimed durably and increments version');
assert(claimed.operation.status === 'PENDING', 'P-1.20.1B: o claim E a transicao REQUESTED -> PENDING');

// P-1.20.1B: a intencao — "UNKNOWN nao pode ser claimada para um novo POST" —
// esta preservada. O que mudou e' a forma da recusa: `claim` RETORNA
// `claimed: false` (contrato real, ja no HEAD anterior) em vez de lancar. A
// assercao anterior exigia um throw que a implementacao nunca fez, e por isso
// este arquivo ja falhava em d40ba79.
const unknownClaim = await RefundOperationRepository.claim(
  client({ find: { ...operation, status: 'UNKNOWN', owner_id: null } }),
  'op-1', 'worker-2', '2026-08-12T00:00:00Z'
);
assert(unknownClaim.claimed === false, 'UNKNOWN operation cannot be claimed for a new POST');
assert(unknownClaim.operation.status === 'UNKNOWN', 'UNKNOWN operation is returned untouched');
void RefundOperationClaimLostError;
