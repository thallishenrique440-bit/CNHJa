import { RefundOperationRepository } from '../RefundOperationRepository.js';
import { RefundOperationClaimLostError, RefundOperationVersionConflictError } from '../RefundOperationErrors.js';

// P-1.20.1B: uma falha de CAS tem DUAS causas e elas deixaram de compartilhar a
// mesma mensagem. Versao obsoleta -> RefundOperationVersionConflictError;
// dono diferente -> RefundOperationClaimLostError. Antes as duas surgiam como
// "owned by another worker", que foi exatamente a mensagem falsa exibida ao
// aluno no incidente P-1.20: o dono estava certo, so a versao estava errada.
// A intencao original dos dois casos abaixo esta preservada; o que mudou e' a
// precisao do erro exigido.

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
let staleVersionErrorName = '';
try { await RefundOperationRepository.transition(client, 'op-1', 'worker-a', 2, 'PENDING'); }
catch (error: any) {
  staleVersionBlocked = error instanceof RefundOperationVersionConflictError;
  staleVersionErrorName = error?.name;
}
assert(staleVersionBlocked, 'transition with stale version is blocked as a VERSION conflict');
assert(staleVersionErrorName !== 'RefundOperationClaimLostError',
  'stale version is NOT reported as "owned by another worker"');

let staleOwnerBlocked = false;
try { await RefundOperationRepository.transition(client, 'op-1', 'worker-b', 3, 'PENDING'); }
catch (error) { staleOwnerBlocked = error instanceof RefundOperationClaimLostError; }
assert(staleOwnerBlocked, 'transition with stale owner is blocked as a CLAIM LOST (real concurrency)');
