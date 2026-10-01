/**
 * RefundIdempotencyFase1.unit.test.ts
 *
 * FASE 1 — idempotencia da obrigacao de estorno.
 *
 * Defeito: a `operation_key` incluia os splits. Quando o Asaas revertia o
 * split, a lista mudava, a chave mudava e o cron criava OUTRA operacao (e
 * emitia outro POST) para a MESMA obrigacao. Producao registrou duas operacoes
 * DENIED para o mesmo pagamento com seis minutos de diferenca.
 *
 * Tudo em memoria: banco e gateway simulados. Nenhuma rede, nenhum Supabase,
 * nenhuma chamada ao Asaas.
 */
export {};

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

const { BookingCancellationCore } = await import('../BookingCancellationCore.js');
const { RefundOperationRepository } = await import('../RefundOperationRepository.js');
const { buildRefundOperationKey, buildRefundObligationKey } = await import('../RefundOperationKey.js');

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};

// ============================================================================
// Banco em memoria
// ============================================================================
type Row = Record<string, any>;
const UNIQUE: Record<string, string[][]> = {
  refund_operations: [['provider', 'operation_key']],
  refund_operation_events: [['refund_operation_id', 'provider_event_id']],
  transactions: [['appointment_id', 'type']]
};
const OP_DEFAULTS = (): Row => ({
  version: 1, attempt: 0, owner_id: null, lease_until: null, provider_refund_id: null, sent_at: null,
  unknown_since: null, acknowledged_at: null, completed_at: null, completed_amount_cents: null,
  denial_reason: null, currency: 'BRL', metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
});

function createDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => JSON.parse(JSON.stringify(r)));
  let seq = 0;
  const conflicts = (table: string, row: Row) =>
    (UNIQUE[table] || []).some((cols) => (tables[table] || []).some((r) =>
      cols.every((c) => r[c] !== null && r[c] !== undefined && r[c] === row[c])));

  function from(table: string) {
    tables[table] = tables[table] || [];
    let op = 'select'; let payload: any = null; let opts: any = {};
    const filters: Array<(r: Row) => boolean> = [];
    let returning = false; let single: 'one' | 'maybe' | null = null;
    const api: any = {
      select() { if (op !== 'select') returning = true; return api; },
      insert(p: any) { op = 'insert'; payload = p; return api; },
      update(p: any) { op = 'update'; payload = p; return api; },
      upsert(p: any, o: any) { op = 'upsert'; payload = p; opts = o || {}; return api; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return api; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return api; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return api; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return api; },
      or() { return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { single = 'maybe'; return exec(); },
      single() { single = 'one'; return exec(); },
      then(res: any, rej: any) { return exec().then(res, rej); }
    };
    const match = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const out = (rows: Row[]) => {
      const copy = rows.map((r) => JSON.parse(JSON.stringify(r)));
      if (single === 'one') return copy.length ? { data: copy[0], error: null } : { data: null, error: { message: 'not found' } };
      if (single === 'maybe') return { data: copy[0] ?? null, error: null };
      return { data: copy, error: null };
    };
    async function exec(): Promise<any> {
      // cede o event loop: torna as corridas entre workers observaveis
      await Promise.resolve();
      if (op === 'select') return out(match());
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const inserted: Row[] = [];
        for (const p of list) {
          const row = { ...(table === 'refund_operations' ? OP_DEFAULTS() : {}), id: p.id || `${table}_${++seq}`, ...p };
          if (conflicts(table, row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          tables[table].push(row); inserted.push(row);
        }
        return returning ? out(inserted) : { data: null, error: null };
      }
      if (op === 'update') {
        const rows = match();
        for (const r of rows) Object.assign(r, JSON.parse(JSON.stringify(payload)));
        return returning ? out(rows) : { data: null, error: null };
      }
      if (op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const cols = String(opts.onConflict || '').split(',').map((x: string) => x.trim()).filter(Boolean);
        const touched: Row[] = [];
        for (const p of list) {
          const existing = cols.length ? tables[table].find((r) => cols.every((c) => r[c] === p[c])) : null;
          if (existing) { if (opts.ignoreDuplicates) continue; Object.assign(existing, JSON.parse(JSON.stringify(p))); touched.push(existing); }
          else { const row = { ...(table === 'refund_operations' ? OP_DEFAULTS() : {}), id: p.id || `${table}_${++seq}`, ...p }; tables[table].push(row); touched.push(row); }
        }
        return returning ? out(touched) : { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return api;
  }
  return { from, tables };
}

// ============================================================================
// Gateway simulado
// ============================================================================
const PAY = 'pay_1';
const SERVICE = 10000;
const split = (status: string) => ({ id: 'spl_1', walletId: 'wal_1', fixedValue: 90, status });
const payment = (splits: any[], refunds: any[] = [], id = PAY) => ({ id, status: 'RECEIVED', value: 101.99, split: splits, refunds });
const DONE = { id: 'rf_1', status: 'DONE', value: 100, dateCreated: '2026-10-01 10:00:00' };
const DENY_400 = { ok: false, status: 400, body: { errors: [{ code: 'invalid_action', description: 'Saldo insuficiente' }] } };
const OK_DONE = (id = PAY) => ({ ok: true, status: 200, body: payment([], [DONE], id) });

function gateway(getBody: any, post: any = null) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fn = async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'GET') return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(getBody)), text: async () => '' };
    if (!post) throw new Error('POST nao esperado');
    return { ok: post.ok, status: post.status, json: async () => JSON.parse(JSON.stringify(post.body ?? {})), text: async () => JSON.stringify(post.body ?? {}) };
  };
  return { fn, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

const APT = (over: Row = {}): Row => ({
  id: 'apt_1', status: 'pending_approval', instructor_id: 'i1', student_id: 's1',
  payment_intent_id: PAY, provider_payment_id: PAY, provider_name: 'asaas',
  payment_status: 'paid', cancelled_reason: null, group_id: null, price: SERVICE, ...over
});
const OP = (over: Row = {}): Row => ({
  ...OP_DEFAULTS(), id: 'op_legacy', operation_key: 'refund:v1:legacy-with-splits', provider: 'asaas', provider_payment_id: PAY,
  scope: 'SINGLE_APPOINTMENT', status: 'DENIED', requested_amount_cents: SERVICE,
  metadata: { appointmentIds: ['apt_1'], reason: 'auto_expired' }, ...over
});
const db0 = (extra: Record<string, Row[]> = {}) => createDb({
  appointments: [APT()], refund_operations: [], refund_operation_events: [], payment_installments: [], transactions: [], ...extra
});
const run = (db: any, gw: any, over: Row = {}) => BookingCancellationCore.processCancellation({
  appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
  asaasApiKey: 'k', asaasApiUrl: 'https://sandbox.test', httpFetch: gw.fn as any, ...over
} as any);
const attempt = async (fn: () => Promise<any>) => { try { return { value: await fn(), error: null as any }; } catch (e) { return { value: null, error: e }; } };

async function main() {
  console.log('\n=== FASE 1: idempotencia da obrigacao de estorno ===\n');

  // --------------------------------------------------------------------------
  // 1. Chave estavel antes e depois da reversao do split
  // --------------------------------------------------------------------------
  {
    const base = {
      provider: 'asaas', providerPaymentId: PAY, providerInstallmentId: null, refundScope: 'SINGLE_APPOINTMENT',
      items: [{ id: 'apt_1', amountCents: SERVICE }], requestedAmountCents: SERVICE, allocationVersion: 'v2'
    };
    const before = { ...base, splits: [{ id: 'spl_1', amountCents: 9000 }] };
    const after = { ...base, splits: [] };
    check(buildRefundOperationKey(before) !== buildRefundOperationKey(after),
      '1a. (causa) a chave v1 MUDA quando o split e\' revertido');
    check(buildRefundObligationKey(before) === buildRefundObligationKey(after),
      '1b. a chave da obrigacao (v2) e\' identica antes e depois da reversao do split');
    check(buildRefundObligationKey(before) === buildRefundObligationKey({ ...base, splits: [{ id: 'spl_9', amountCents: 1 }] }),
      '1c. nenhum dado de split influencia a chave');
    check(!buildRefundObligationKey(before).includes('spl_1') && !buildRefundObligationKey(before).includes('split'),
      '1d. a chave nao contem nenhuma informacao de split');

    // No Core: recusa com split ativo, depois o Asaas reverte o split.
    const db = db0();
    const gwA = gateway(payment([split('PENDING')]), DENY_400);
    const r1 = await attempt(() => run(db, gwA, { reason: 'auto_expired' }));
    const keyAfterFirst = db.tables.refund_operations[0]?.operation_key;
    check(!r1.error && r1.value?.refundState === 'denied' && db.tables.refund_operations.length === 1 && db.tables.refund_operations[0].status === 'DENIED',
      '1e. primeira execucao: 1 operacao, recusada (DENIED)');

    const gwB = gateway(payment([split('REFUNDED')]), OK_DONE());
    const r2 = await attempt(() => run(db, gwB, { reason: 'auto_expired' }));
    check(db.tables.refund_operations.length === 1, '1f. split revertido: NENHUMA operacao nova e\' criada');
    check(db.tables.refund_operations[0].operation_key === keyAfterFirst, '1g. a operacao mantem a mesma chave');
    check(gwB.posts().length === 0 && r2.value?.refundConfirmed === false && db.tables.appointments[0].payment_status === 'refund_denied',
      '1h. split revertido: nenhum POST; a recusa continua valendo');
    check(JSON.stringify(db.tables.refund_operations[0].metadata.split_snapshot) === JSON.stringify([{ id: 'spl_1', amountCents: 9000 }]),
      '1i. split original preservado como informacao (metadata.split_snapshot)');
    check(db.tables.refund_operations[0].metadata.key_version === 'v2', '1j. operacao nova usa a chave v2');
  }

  // --------------------------------------------------------------------------
  // 2. DENIED impede novo POST automatico (ciclos sucessivos do cron)
  // --------------------------------------------------------------------------
  {
    const db = db0();
    await attempt(() => run(db, gateway(payment([split('PENDING')]), DENY_400), { reason: 'auto_expired' }));
    let posts = 0;
    const states = [split('PENDING'), split('REFUNDED'), split('CANCELED'), split('PENDING'), split('REFUNDED')];
    for (const st of states) {
      const gw = gateway(payment([st]), OK_DONE());
      await attempt(() => run(db, gw, { reason: 'auto_expired' }));
      posts += gw.posts().length;
    }
    check(posts === 0, '2a. 5 ciclos do cron apos a recusa, com o split variando: 0 POST');
    check(db.tables.refund_operations.length === 1 && db.tables.refund_operations[0].status === 'DENIED', '2b. continua 1 operacao, DENIED');
    check(db.tables.refund_operations[0].attempt === 1, '2c. attempt nao cresce: nenhuma tentativa nova foi feita');
    check(db.tables.appointments[0].status === 'expired' && db.tables.appointments[0].payment_status === 'refund_denied',
      '2d. aula encerrada (expired) com o estorno refund_denied');

    // Caso real de producao: DUAS operacoes DENIED antigas (chaves v1 diferentes).
    const dbProd = db0({ refund_operations: [
      OP({ id: 'op_a', operation_key: 'refund:v1:{"splits":[{"id":"spl_1"}]}', created_at: '2026-09-30T12:00:00Z' }),
      OP({ id: 'op_b', operation_key: 'refund:v1:{"splits":[]}', created_at: '2026-09-30T12:06:00Z' })
    ] });
    const gwP = gateway(payment([split('REFUNDED')]), OK_DONE());
    await attempt(() => run(dbProd, gwP, { reason: 'auto_expired' }));
    check(dbProd.tables.refund_operations.length === 2 && gwP.posts().length === 0,
      '2e. duplicatas historicas (v1): nenhuma TERCEIRA operacao, nenhum POST');
  }

  // --------------------------------------------------------------------------
  // 3. CONFLICT impede novo POST automatico
  // --------------------------------------------------------------------------
  {
    const db = db0({ refund_operations: [OP({ status: 'CONFLICT' })] });
    const gw = gateway(payment([split('REFUNDED')]), OK_DONE());
    const r = await attempt(() => run(db, gw));
    check(gw.posts().length === 0 && db.tables.refund_operations.length === 1 && r.value?.refundConfirmed === false
      && db.tables.appointments[0].payment_status === 'refund_requested', '3a. CONFLICT: nenhum POST, nenhuma operacao nova, estorno em analise');
    const gw2 = gateway(payment([]), OK_DONE());
    await attempt(() => run(db, gw2, { explicitRetry: true }));
    check(gw2.posts().length === 0 && db.tables.refund_operations[0].status === 'CONFLICT', '3b. CONFLICT nao e\' reaberto nem por tentativa explicita');
  }

  // --------------------------------------------------------------------------
  // 4. Operacao concluida nao gera nova solicitacao
  // --------------------------------------------------------------------------
  {
    const db = db0({ refund_operations: [OP({ status: 'COMPLETED', acknowledged_at: '2026-10-01T10:00:00Z', completed_at: '2026-10-01T10:00:00Z' })] });
    const gw = gateway(payment([split('REFUNDED')], [DONE]), OK_DONE());
    const r = await attempt(() => run(db, gw));
    check(gw.posts().length === 0 && db.tables.refund_operations.length === 1, '4a. COMPLETED: nenhum POST, nenhuma operacao nova');
    check(!r.error && db.tables.appointments[0].payment_status === 'refunded', '4b. estorno ja concluido e\' reaproveitado');
    const gw2 = gateway(payment([split('CANCELED')], [DONE]), OK_DONE());
    await attempt(() => run(db, gw2));
    check(gw2.posts().length === 0 && db.tables.refund_operations.length === 1, '4c. nova execucao continua sem POST');
  }

  // --------------------------------------------------------------------------
  // 5. Concorrencia: sem operacoes duplicadas, um unico POST
  // --------------------------------------------------------------------------
  {
    // (a) dois workers criando a mesma obrigacao ao mesmo tempo (repositorio)
    const db = db0();
    const input = { operationKey: 'refund:v2:same', providerPaymentId: PAY, scope: 'SINGLE_APPOINTMENT', requestedAmountCents: SERVICE, metadata: { appointmentIds: ['apt_1'] } };
    const [a, b] = await Promise.all([
      RefundOperationRepository.createOrGet(db as any, input),
      RefundOperationRepository.createOrGet(db as any, input)
    ]);
    check(db.tables.refund_operations.length === 1 && a.id === b.id, '5a. createOrGet concorrente: uma unica linha');
    const future = new Date(Date.now() + 60000).toISOString();
    const claims = await Promise.all([
      RefundOperationRepository.claim(db as any, a.id, 'worker-A', future),
      RefundOperationRepository.claim(db as any, a.id, 'worker-B', future)
    ]);
    check(claims.filter((c) => c.claimed).length === 1, '5b. claim concorrente: exatamente um worker pode enviar o POST');

    // (b) duas execucoes simultaneas do Core, com o split em estados DIFERENTES
    const db2 = db0();
    let n = 0;
    const calls: string[] = [];
    const racingFetch = async (url: string, init?: any) => {
      const method = init?.method || 'GET';
      calls.push(method);
      if (method === 'GET') {
        const st = n++ === 0 ? 'PENDING' : 'REFUNDED';
        return { ok: true, status: 200, json: async () => payment([split(st)]), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => payment([], [DONE]), text: async () => '' };
    };
    await Promise.all([
      attempt(() => run(db2, { fn: racingFetch })),
      attempt(() => run(db2, { fn: racingFetch }))
    ]);
    check(db2.tables.refund_operations.length === 1, '5c. execucoes simultaneas do Core: uma unica operacao');
    check(calls.filter((m) => m === 'POST').length === 1, '5d. execucoes simultaneas do Core: um unico POST');

    // (c) outro isolate com a operacao em PENDING e lease viva
    const db3 = db0({ refund_operations: [OP({ status: 'PENDING', owner_id: 'worker-outro', lease_until: future, operation_key: 'refund:v1:old' })] });
    const gw3 = gateway(payment([split('REFUNDED')]), OK_DONE());
    const r3 = await attempt(() => run(db3, gw3));
    check(gw3.posts().length === 0 && db3.tables.refund_operations.length === 1 && r3.value?.refundState === 'in_review',
      '5e. operacao em andamento por outro worker: nenhum POST, nenhuma operacao nova');
  }

  // --------------------------------------------------------------------------
  // 6. Nova tentativa EXPLICITA segue o mecanismo existente
  // --------------------------------------------------------------------------
  {
    const db = db0({ refund_operations: [OP({ attempt: 1, denial_reason: 'Saldo insuficiente' })] });
    const legacyKey = db.tables.refund_operations[0].operation_key;

    const gwAuto = gateway(payment([split('REFUNDED')], []), OK_DONE());
    await attempt(() => run(db, gwAuto));
    check(gwAuto.posts().length === 0, '6a. sem autorizacao explicita: nenhum POST');

    const gwBusy = gateway(payment([split('REFUNDED')], [{ status: 'PENDING', value: 100 }]), OK_DONE());
    await attempt(() => run(db, gwBusy, { explicitRetry: true }));
    check(gwBusy.posts().length === 0, '6b. tentativa explicita bloqueada se o gateway ja\' mostra estorno em processamento');

    const gwRetry = gateway(payment([split('REFUNDED')], []), OK_DONE());
    const r = await attempt(() => run(db, gwRetry, { explicitRetry: true }));
    const op = db.tables.refund_operations[0];
    check(gwRetry.posts().length === 1 && !r.error && op.status === 'COMPLETED', '6c. tentativa explicita: exatamente um POST, estorno confirmado');
    check(db.tables.refund_operations.length === 1 && op.id === 'op_legacy' && op.operation_key === legacyKey,
      '6d. reaproveita a MESMA operacao e a mesma chave (nao contorna a idempotencia)');
    check(op.attempt === 2, '6e. attempt incrementado na mesma linha');
    check(db.tables.refund_operation_events.some((e: Row) => e.source === 'manual_retry' && e.from_status === 'DENIED' && e.to_status === 'REQUESTED'),
      '6f. reabertura rastreada em refund_operation_events');
    const gwAgain = gateway(payment([split('REFUNDED')], [DONE]), OK_DONE());
    await attempt(() => run(db, gwAgain, { explicitRetry: true }));
    check(gwAgain.posts().length === 0, '6g. repetir a tentativa explicita apos concluir nao gera outro POST');
  }

  // --------------------------------------------------------------------------
  // 7. Obrigacoes legitimamente diferentes nao sao confundidas
  // --------------------------------------------------------------------------
  {
    const base = {
      provider: 'asaas', providerPaymentId: PAY, providerInstallmentId: null, refundScope: 'SINGLE_APPOINTMENT',
      items: [{ id: 'apt_1', amountCents: SERVICE }], requestedAmountCents: SERVICE, allocationVersion: 'v2'
    };
    const k = buildRefundObligationKey(base);
    check(k !== buildRefundObligationKey({ ...base, providerPaymentId: 'pay_2' }), '7a. pagamento diferente => chave diferente');
    check(k !== buildRefundObligationKey({ ...base, refundScope: 'FULL_GROUP' }), '7b. escopo diferente => chave diferente');
    check(k !== buildRefundObligationKey({ ...base, items: [{ id: 'apt_2', amountCents: SERVICE }] }), '7c. aula diferente => chave diferente');
    check(k !== buildRefundObligationKey({ ...base, items: [{ id: 'apt_1', amountCents: 5000 }], requestedAmountCents: 5000 }), '7d. valor diferente => chave diferente');

    // Combo: aula 1 teve o estorno recusado; a aula 2 e' outra obrigacao.
    const db = createDb({
      appointments: [APT({ group_id: 'g1' }), APT({ id: 'apt_2', group_id: 'g1' })],
      refund_operations: [OP()], refund_operation_events: [], payment_installments: [], transactions: []
    });
    const gw = gateway(payment([split('PENDING')], []), OK_DONE());
    const r = await attempt(() => run(db, gw, { appointmentId: 'apt_2' }));
    check(gw.posts().length === 1 && db.tables.refund_operations.length === 2 && !r.error,
      '7e. recusa da aula 1 nao bloqueia o estorno (legitimo) da aula 2');
    check(db.tables.refund_operations.find((o: Row) => o.id === 'op_legacy')!.status === 'DENIED',
      '7f. a operacao recusada da aula 1 permanece intacta');

    // Outro pagamento com a mesma aula nao herda a recusa.
    const db2 = createDb({
      appointments: [APT({ provider_payment_id: 'pay_2', payment_intent_id: 'pay_2' })],
      refund_operations: [OP()], refund_operation_events: [], payment_installments: [], transactions: []
    });
    const gw2 = gateway(payment([], [], 'pay_2'), OK_DONE('pay_2'));
    const r2 = await attempt(() => run(db2, gw2));
    check(gw2.posts().length === 1 && !r2.error && db2.tables.refund_operations.length === 2,
      '7g. pagamento diferente nao herda a recusa de outro pagamento');

    const found = await RefundOperationRepository.findByObligation(db as any, 'asaas', PAY, 'FULL_GROUP', ['apt_1'], SERVICE);
    check(found === null, '7h. busca por obrigacao respeita o escopo');
  }

  // --------------------------------------------------------------------------
  // 8. Ranking de findByObligation (ajuste final da Fase 1)
  // --------------------------------------------------------------------------
  {
    const find = (db: any) => RefundOperationRepository.findByObligation(db, 'asaas', PAY, 'SINGLE_APPOINTMENT', ['apt_1'], SERVICE);
    const ACK = '2026-10-01T10:00:00Z';

    // COMPLETED (mais antiga) + PENDING (mais recente) na mesma obrigacao
    const completed = OP({ id: 'op_done', operation_key: 'refund:v1:a', status: 'COMPLETED', acknowledged_at: ACK, completed_at: ACK, created_at: '2026-09-20T10:00:00Z' });
    const pending = OP({ id: 'op_pend', operation_key: 'refund:v1:b', status: 'PENDING', created_at: '2026-09-28T10:00:00Z' });
    const db = db0({ refund_operations: [completed, pending] });
    const f1 = await find(db);
    check(f1?.id === 'op_done', '8a. COMPLETED tem prioridade sobre PENDING mais recente');
    const gw = gateway(payment([split('REFUNDED')], [DONE]), OK_DONE());
    await attempt(() => run(db, gw));
    const ops = db.tables.refund_operations;
    check(gw.posts().length === 0 && ops.length === 2, '8b. COMPLETED + PENDING: nenhum POST, nenhuma operacao nova');
    check(ops.find((o: Row) => o.id === 'op_done')!.status === 'COMPLETED', '8c. operacao COMPLETED nao e\' reaberta');
    check(ops.find((o: Row) => o.id === 'op_pend')!.status === 'PENDING', '8d. PENDING nao vira COMPLETED sem evidencia propria');

    // Empate no mesmo estado: mais recente
    const dbT = db0({ refund_operations: [
      OP({ id: 'den_old', operation_key: 'k1', created_at: '2026-09-20T10:00:00Z' }),
      OP({ id: 'den_new', operation_key: 'k2', created_at: '2026-09-25T10:00:00Z' }) ] });
    check((await find(dbT))?.id === 'den_new', '8e. empate no mesmo estado: mantem criterio de recencia');

    // CONFLICT > DENIED, mesmo com DENIED mais recente
    const dbC = db0({ refund_operations: [
      OP({ id: 'conf', operation_key: 'k1', status: 'CONFLICT', created_at: '2026-09-20T10:00:00Z' }),
      OP({ id: 'den', operation_key: 'k2', status: 'DENIED', created_at: '2026-09-25T10:00:00Z' }) ] });
    check((await find(dbC))?.id === 'conf', '8f. CONFLICT continua priorizado sobre DENIED');

    // Ativo > recusa/conflito, mesmo com recusa mais recente
    const dbA = db0({ refund_operations: [
      OP({ id: 'pend', operation_key: 'k1', status: 'PENDING', created_at: '2026-09-20T10:00:00Z' }),
      OP({ id: 'conf', operation_key: 'k2', status: 'CONFLICT', created_at: '2026-09-25T10:00:00Z' }),
      OP({ id: 'den', operation_key: 'k3', status: 'DENIED', created_at: '2026-09-26T10:00:00Z' }) ] });
    check((await find(dbA))?.id === 'pend', '8g. operacao ativa priorizada sobre CONFLICT/DENIED');

    // Outra obrigacao (valor diferente) nao interfere
    const dbO = db0({ refund_operations: [OP({ id: 'other', status: 'COMPLETED', requested_amount_cents: 5000 })] });
    check((await find(dbO)) === null, '8h. obrigacao distinta (valor diferente) nao e\' selecionada');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length) { failures.forEach((f) => console.error(` - ${f}`)); process.exit(1); }
}

await main();
