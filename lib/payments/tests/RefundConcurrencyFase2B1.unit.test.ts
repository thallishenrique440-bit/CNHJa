/**
 * RefundConcurrencyFase2B1.unit.test.ts
 *
 * B1 (revisao da Fase 2) — escrita com visao desatualizada.
 *
 * Depois que o encerramento da aula deixou de depender do estorno, um worker
 * passou a gravar ledger e `payment_status` com o estado da operacao que tinha
 * em MEMORIA. Se o webhook ou outro worker movesse a operacao nesse intervalo,
 * o resultado ficava permanentemente errado:
 *   1. webhook de estorno concluido logo apos o POST -> aula `refunded`, mas
 *      transacao de estorno `pending`;
 *   2. duas instancias simultaneas -> estorno confirmado, aula presa em
 *      `refund_requested`;
 *   3. webhook de recusa na mesma janela -> operacao `DENIED`, aula presa em
 *      `refund_requested`.
 *
 * Os testes executam o Core real (`processCancellation`, `applyRefundEvent`),
 * injetando o evento concorrente em pontos exatos do fluxo, e conferem o
 * ESTADO FINAL de operacao, aula, ledger e parcela. As "duas instancias" sao
 * duas copias independentes do modulo (cada uma com o seu lock em memoria),
 * como dois isolates.
 *
 * Tudo em memoria. Nenhuma rede, nenhum Supabase, nenhuma chamada ao Asaas.
 */
export {};

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

const { BookingCancellationCore } = await import('../BookingCancellationCore.js');
// Segunda copia do modulo = outro isolate (lock em memoria proprio).
// @ts-ignore — o sufixo de consulta so' existe para forcar uma nova instancia.
const { BookingCancellationCore: CoreB } = await import('../BookingCancellationCore.js?isolate=B') as typeof import('../BookingCancellationCore.js');
const { NotificationService } = await import('../../NotificationService.js');
(NotificationService as any).createNotification = async () => ({ success: true });

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};

// ============================================================================
// Banco em memoria, com ganchos para injetar eventos concorrentes
// ============================================================================
type Row = Record<string, any>;
type Hook = { table: string; op: string; when: (payload: any) => boolean; fn: () => Promise<void>; fired: boolean };
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
  const hooks: Hook[] = [];
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
      await Promise.resolve();
      // Evento concorrente: acontece imediatamente ANTES desta instrucao.
      for (const h of hooks) {
        if (!h.fired && h.table === table && h.op === op && h.when(payload)) { h.fired = true; await h.fn(); }
      }
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
  /** Dispara `fn` uma unica vez, imediatamente antes da primeira instrucao que casar. */
  const before = (table: string, op: string, when: (payload: any) => boolean, fn: () => Promise<void>) => {
    const h: Hook = { table, op, when, fn, fired: false }; hooks.push(h); return h;
  };
  return { from, tables, before };
}

// ============================================================================
// Gateway simulado e fixtures
// ============================================================================
const PAY = 'pay_1';
const SERVICE = 10000;
const split = (status: string) => ({ id: 'spl_1', walletId: 'wal_1', fixedValue: 90, status });
const payment = (splits: any[], refunds: any[] = []) => ({ id: PAY, status: 'RECEIVED', value: 101.99, split: splits, refunds });
const DONE = { id: 'rf_1', status: 'DONE', value: 100, dateCreated: '2026-10-01 10:00:00' };
const AWAITING = { status: 'AWAITING_CRITICAL_ACTION_AUTHORIZATION', value: 100, dateCreated: '2026-10-01 10:00:00' };
const POST_DONE = { ok: true, status: 200, body: payment([], [DONE]) };
const POST_PENDING = { ok: true, status: 200, body: payment([], [AWAITING]) };
const POST_DENIED_400 = { ok: false, status: 400, body: { errors: [{ code: 'invalid_action', description: 'Falha ao processar a transferencia.' }] } };

/** `gate`: se informado, o POST so' responde depois que a promessa resolve. `duringPost`: roda enquanto o POST esta' em voo. */
function gateway(getBody: any, post: any, o: { gate?: Promise<void>; duringPost?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const fn = async (_url: string, init?: any) => {
    const method = init?.method || 'GET';
    calls.push(method);
    if (method === 'GET') return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(getBody)), text: async () => '' };
    if (o.gate) await o.gate;
    if (o.duringPost) await o.duringPost();
    return { ok: post.ok, status: post.status, json: async () => JSON.parse(JSON.stringify(post.body ?? {})), text: async () => JSON.stringify(post.body ?? {}) };
  };
  return { fn, calls, posts: () => calls.filter((c) => c === 'POST').length };
}

const APT = (over: Row = {}): Row => ({
  id: 'apt_1', status: 'pending_approval', instructor_id: 'i1', student_id: 's1',
  payment_intent_id: PAY, provider_payment_id: PAY, provider_name: 'asaas',
  payment_status: 'paid', cancelled_reason: null, group_id: null, price: SERVICE, ...over
});
const db0 = () => createDb({
  appointments: [APT()], refund_operations: [], refund_operation_events: [],
  payment_installments: [{ id: 'inst_1', provider_payment_id: PAY, group_id: null, status: 'RECEIVED' }],
  transactions: [{ id: 'tx_lp', appointment_id: 'apt_1', type: 'lesson_payment', provider_payment_id: PAY, status: 'pending' }]
});
const runWith = (core: any, db: any, gw: any, reason = 'auto_expired', over: Row = {}) => core.processCancellation({
  appointmentId: 'apt_1', reason, adminClient: db,
  asaasApiKey: 'k', asaasApiUrl: 'https://sandbox.test', httpFetch: gw.fn as any, ...over
} as any);
const run = (db: any, gw: any, reason = 'auto_expired', over: Row = {}) => runWith(BookingCancellationCore, db, gw, reason, over);
const attempt = async (fn: () => Promise<any>) => { try { return { value: await fn(), error: null as any }; } catch (e) { return { value: null, error: e }; } };

const webhookDone = (db: any, id = 'evt_done') => BookingCancellationCore.applyRefundEvent(db, PAY, payment([], [DONE]), 'COMPLETED', id, null).then(() => {});
const webhookDenied = (db: any, id = 'evt_denied') => BookingCancellationCore.applyRefundEvent(db, PAY, { id: PAY, status: 'RECEIVED' }, 'DENIED', id, 'Falha ao processar a transferencia.').then(() => {});

const snapshot = (db: any) => {
  const a = db.tables.appointments[0];
  const op = db.tables.refund_operations[0];
  const tx = db.tables.transactions.find((t: Row) => t.type === 'refund');
  return {
    apt: `${a.status}/${a.payment_status}`,
    reason: a.cancelled_reason,
    // `+ack` = conclusao CONFIRMADA pelo gateway (unica que autoriza `refunded`).
    op: op ? `${op.status}${op.status === 'COMPLETED' && op.acknowledged_at ? '+ack' : ''}` : '-',
    ops: db.tables.refund_operations.length,
    tx: tx?.status ?? '-',
    inst: db.tables.payment_installments[0].status
  };
};
const REFUNDED = { apt: 'expired/refunded', op: 'COMPLETED+ack', tx: 'completed', inst: 'REFUNDED' };
const DENIED = { apt: 'expired/refund_denied', op: 'DENIED', tx: 'failed', inst: 'RECEIVED' };
const same = (s: any, want: any) => Object.keys(want).every((k) => s[k] === want[k]);
const show = (s: any) => `apt=${s.apt} op=${s.op} tx=${s.tx} inst=${s.inst}`;

/** Pontos do fluxo em que o evento concorrente e' injetado (todos DEPOIS do POST). */
const WINDOWS: Array<{ label: string; arm: (db: any, fire: () => Promise<void>) => void }> = [
  { label: 'antes da escrita do ledger', arm: (db, fire) => db.before('transactions', 'upsert', (p: any) => p?.type === 'refund', fire) },
  { label: 'entre o ledger e o encerramento da aula', arm: (db, fire) => db.before('appointments', 'update', (p: any) => p?.status === 'expired', fire) },
  { label: 'logo apos o encerramento da aula', arm: (db, fire) => {
    // primeira leitura da operacao DEPOIS do update que encerra a aula
    let closed = false;
    db.before('appointments', 'update', (p: any) => { if (p?.status === 'expired') closed = true; return false; }, async () => {});
    db.before('refund_operations', 'select', () => closed, fire);
  } }
];

async function main() {
  console.log('\n=== B1: concorrencia e visao desatualizada da operacao de estorno ===\n');

  // --------------------------------------------------------------------------
  // 1. Webhook de estorno CONCLUIDO chega logo apos o POST
  // --------------------------------------------------------------------------
  for (const w of WINDOWS) {
    const db = db0();
    w.arm(db, () => webhookDone(db));
    const gw = gateway(payment([split('PENDING')]), POST_PENDING);
    const res = await run(db, gw);
    const s = snapshot(db);
    check(same(s, REFUNDED), `1. webhook concluido ${w.label}: aula refunded, operacao confirmada, ledger completed, parcela REFUNDED [${show(s)}]`);
    check(s.reason === 'auto_expired' && gw.posts() === 1 && s.ops === 1, `1. webhook concluido ${w.label}: motivo preservado, 1 POST, 1 operacao`);
    check(res.status === 'expired', `1. webhook concluido ${w.label}: resultado operacional expired`);
    // repeticao do webhook e novo ciclo do cron nao alteram nada
    await webhookDone(db, 'evt_done_again');
    const gw2 = gateway(payment([split('REFUNDED')]), POST_DONE);
    await run(db, gw2);
    check(same(snapshot(db), REFUNDED) && gw2.calls.length === 0, `1. webhook concluido ${w.label}: reentrega e novo ciclo sao idempotentes`);
  }
  {
    // webhook chega ENQUANTO o POST ainda esta' em voo (antes de o Core ler a resposta)
    const db = db0();
    const gw = gateway(payment([split('PENDING')]), POST_PENDING, { duringPost: () => webhookDone(db) });
    await attempt(() => run(db, gw));
    const gwNext = gateway(payment([split('REFUNDED')], [DONE]), POST_DONE);
    await attempt(() => run(db, gwNext));
    const s = snapshot(db);
    check(same(s, REFUNDED) && gw.posts() === 1 && gwNext.posts() === 0, `1. webhook concluido durante o POST: estado final consistente, sem segundo POST [${show(s)}]`);
  }

  // --------------------------------------------------------------------------
  // 3. Webhook de RECUSA chega na mesma janela
  // --------------------------------------------------------------------------
  for (const w of WINDOWS) {
    const db = db0();
    w.arm(db, () => webhookDenied(db));
    const gw = gateway(payment([split('PENDING')]), POST_PENDING);
    const res = await run(db, gw);
    const s = snapshot(db);
    check(same(s, DENIED), `3. webhook de recusa ${w.label}: aula refund_denied, operacao DENIED, ledger failed [${show(s)}]`);
    check(s.reason === 'auto_expired' && gw.posts() === 1 && res.refundConfirmed === false, `3. webhook de recusa ${w.label}: nunca afirma estorno, 1 POST`);
    await webhookDenied(db, 'evt_denied_again');
    let posts = 0;
    for (let i = 0; i < 3; i++) { const g = gateway(payment([split('REFUNDED')]), POST_DONE); await run(db, g); posts += g.posts(); }
    check(same(snapshot(db), DENIED) && posts === 0, `3. webhook de recusa ${w.label}: recusa preservada, nenhum POST automatico depois`);
  }
  {
    const db = db0();
    const gw = gateway(payment([split('PENDING')]), POST_PENDING, { duringPost: () => webhookDenied(db) });
    await attempt(() => run(db, gw));
    const gwNext = gateway(payment([split('REFUNDED')]), POST_DONE);
    await attempt(() => run(db, gwNext));
    const s = snapshot(db);
    check(same(s, { apt: 'expired/refund_denied', op: 'DENIED', inst: 'RECEIVED' }) && s.tx !== 'completed' && gw.posts() === 1 && gwNext.posts() === 0,
      `3. webhook de recusa durante o POST: aula encerrada como refund_denied, sem segundo POST [${show(s)}]`);
  }

  // --------------------------------------------------------------------------
  // 2. Duas instancias simultaneas
  // --------------------------------------------------------------------------
  for (const [label, post, want] of [
    ['estorno confirmado', POST_DONE, REFUNDED],
    ['estorno recusado', POST_DENIED_400, DENIED]
  ] as Array<[string, any, any]>) {
    // A envia o POST e fica aguardando o gateway; B roda inteiro nesse meio-tempo.
    const db = db0();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gwA = gateway(payment([split('PENDING')]), post, { gate });
    const gwB = gateway(payment([split('PENDING')]), POST_DONE);
    const pA = runWith(BookingCancellationCore, db, gwA);
    while (gwA.posts() === 0) await new Promise((r) => setTimeout(r, 1));
    const resB = await runWith(CoreB, db, gwB);
    const mid = snapshot(db);
    check(gwB.posts() === 0 && mid.apt === 'expired/refund_requested' && resB.refundConfirmed === false,
      `2. (${label}) instancia B durante o POST de A: encerra a aula como "em analise", sem POST [${show(mid)}]`);
    release();
    const resA = await pA;
    const s = snapshot(db);
    check(same(s, want), `2. (${label}) apos A concluir: aula, operacao, ledger e parcela coerentes [${show(s)}]`);
    check(gwA.posts() + gwB.posts() === 1 && s.ops === 1 && db.tables.refund_operations[0].attempt === 1, `2. (${label}) um unico POST, uma unica operacao, uma tentativa`);
    check(resA.refundConfirmed === (want === REFUNDED) && resA.paymentStatus === s.apt.split('/')[1], `2. (${label}) resultado de A reflete o estado final`);
    if (want === REFUNDED) await webhookDone(db); else await webhookDenied(db);
    check(same(snapshot(db), want), `2. (${label}) webhook posterior nao altera o estado final`);
  }
  {
    // A recebe PENDING; B encerrou antes; a recusa chega depois por webhook.
    const db = db0();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gwA = gateway(payment([split('PENDING')]), POST_PENDING, { gate });
    const pA = runWith(BookingCancellationCore, db, gwA);
    while (gwA.posts() === 0) await new Promise((r) => setTimeout(r, 1));
    await runWith(CoreB, db, gateway(payment([split('PENDING')]), POST_DONE));
    release();
    await pA;
    check(same(snapshot(db), { apt: 'expired/refund_requested', op: 'PENDING', tx: 'pending', inst: 'RECEIVED' }), '2. (estorno pendente) duas instancias: aula encerrada, estorno em analise');
    await webhookDone(db);
    check(same(snapshot(db), REFUNDED), '2. (estorno pendente) confirmacao posterior fecha tudo como refunded');
  }
  {
    // B le a aula ainda aberta, mas so' prossegue depois que A terminou tudo.
    const db = db0();
    let release!: () => void;
    const gateB = new Promise<void>((r) => { release = r; });
    const gwB = { calls: [] as string[], posts: () => gwB.calls.filter((c) => c === 'POST').length, fn: async (_u: string, init?: any) => {
      const method = init?.method || 'GET'; gwB.calls.push(method);
      await gateB;
      return { ok: true, status: 200, json: async () => payment([split('REFUNDED')], [DONE]), text: async () => '' };
    } };
    const pB = runWith(CoreB, db, gwB);
    while (gwB.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    const gwA = gateway(payment([split('PENDING')]), POST_DONE);
    await runWith(BookingCancellationCore, db, gwA);
    release();
    const resB = await pB;
    const s = snapshot(db);
    check(same(s, REFUNDED) && gwA.posts() === 1 && gwB.posts() === 0, `2. B com leitura antiga da aula, apos A concluir: nada e' rebaixado, sem segundo POST [${show(s)}]`);
    check(resB.refundConfirmed === true && resB.alreadyProcessed === true, '2. B reconhece o estorno ja confirmado');
  }

  // --------------------------------------------------------------------------
  // 4. Guardas das escritas
  // --------------------------------------------------------------------------
  {
    // ledger: visao nao confirmada nunca rebaixa um estorno confirmado
    const db = db0();
    db.tables.transactions.push({ id: 'tx_rf', appointment_id: 'apt_1', type: 'refund', provider_payment_id: PAY, status: 'completed' });
    await BookingCancellationCore.writeRefundTransactions(db, { paymentId: PAY, appointments: [APT()], reason: 'auto_expired', isRefundConfirmed: false });
    await BookingCancellationCore.writeRefundTransactions(db, { paymentId: PAY, appointments: [APT()], reason: 'auto_expired', isRefundConfirmed: false, isRefundDenied: true });
    check(db.tables.transactions.find((t: Row) => t.type === 'refund')?.status === 'completed', '4a. ledger: estorno confirmado nao e\' rebaixado para pending/failed');

    // alinhamento: so' promove, com CAS, e nunca mexe em aula aberta nem no status
    const dbA = createDb({ appointments: [
      APT({ id: 'a_req', status: 'expired', payment_status: 'refund_requested' }),
      APT({ id: 'a_den', status: 'expired', payment_status: 'refund_denied' }),
      APT({ id: 'a_ref', status: 'cancelled', payment_status: 'refunded' }),
      APT({ id: 'a_open', status: 'pending_approval', payment_status: 'paid' })
    ] });
    const ids = ['a_req', 'a_den', 'a_ref', 'a_open'];
    const ps = () => dbA.tables.appointments.map((a: Row) => `${a.status}/${a.payment_status}`).join(' ');
    await BookingCancellationCore.alignClosedAppointments(dbA, ids, 'in_review');
    check(ps() === 'expired/refund_requested expired/refund_denied cancelled/refunded pending_approval/paid', '4b. alinhamento "em analise" nao altera nada (nao rebaixa refunded nem refund_denied)');
    await BookingCancellationCore.alignClosedAppointments(dbA, ids, 'denied');
    check(ps() === 'expired/refund_denied expired/refund_denied cancelled/refunded pending_approval/paid', '4c. alinhamento "recusado": so\' refund_requested -> refund_denied; refunded intacto');
    await BookingCancellationCore.alignClosedAppointments(dbA, ids, 'confirmed');
    check(ps() === 'expired/refunded expired/refunded cancelled/refunded pending_approval/paid', '4d. alinhamento "confirmado": aulas encerradas -> refunded; aula aberta e status intactos');
  }

  // --------------------------------------------------------------------------
  // 5. Falha transitoria reconciliada sem novo POST
  // --------------------------------------------------------------------------
  {
    const db = db0();
    const gwFail = gateway(payment([split('PENDING')]), { ok: false, status: 503, body: {} });
    const first = await attempt(() => run(db, gwFail));
    check(!!first.error && db.tables.refund_operations[0].status === 'UNKNOWN' && db.tables.appointments[0].status === 'pending_approval',
      '5a. erro 5xx no POST: operacao UNKNOWN, aula ainda aberta');
    const gw2 = gateway(payment([split('PENDING')], [DONE]), POST_DONE);
    await run(db, gw2);
    const s = snapshot(db);
    check(gw2.posts() === 0 && same(s, REFUNDED), `5b. ciclo seguinte: evidencia do gateway (GET) confirma o estorno, sem novo POST [${show(s)}]`);
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
