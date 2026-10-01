/**
 * RefundLifecycleConfirmation.unit.test.ts
 *
 * Ciclo completo do estorno com confirmacao REAL do Asaas:
 *   - POST 2xx nao e' confirmacao; o estado vem do item de estorno;
 *   - id do estorno nunca e' o id do pagamento;
 *   - webhooks (concluido / recusado / duplicado / fora de ordem);
 *   - correcao de COMPLETED nao confirmado;
 *   - idempotencia e concorrencia;
 *   - reconciliacao (somente GET);
 *   - refund_operation_events;
 *   - regra financeira: devolve o SERVICO, nunca a taxa do Asaas.
 *
 * Tudo em memoria: banco simulado e gateway simulado. Nenhuma rede, nenhum
 * Supabase, nenhum Asaas real.
 */
// Modulo (nao script global): evita colisao de nomes com outras suites no tsc.
export {};

// lib/NotificationService cria um client Supabase NO IMPORT. Valores ficticios,
// apontando para uma porta local fechada, sao definidos ANTES do import do
// Core (mesmo padrao de RefundHardeningP1201B). Nenhuma chamada sai daqui.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

const { BookingCancellationCore } = await import('../BookingCancellationCore.js');
const { RefundOperationRepository } = await import('../RefundOperationRepository.js');
const { interpretRefundState, sanitizeProviderMessage } = await import('../RefundConfirmation.js');
const { canTransitionRefund } = await import('../RefundStateMachine.js');

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};

// ============================================================================
// Banco em memoria (somente o que o codigo usa)
// ============================================================================
type Row = Record<string, any>;
const UNIQUE: Record<string, string[][]> = {
  refund_operations: [['provider', 'operation_key']],
  refund_operation_events: [['refund_operation_id', 'provider_event_id']],
  transactions: [['appointment_id', 'type']]
};
const DEFAULTS: Record<string, () => Row> = {
  refund_operations: () => ({
    version: 1, attempt: 0, owner_id: null, lease_until: null, provider_refund_id: null, sent_at: null,
    unknown_since: null, acknowledged_at: null, completed_at: null, completed_amount_cents: null,
    denial_reason: null, receipt_url: null, raw_payload_hash: null, source_event_id: null,
    currency: 'BRL', metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  })
};

function createDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => JSON.parse(JSON.stringify(r)));
  let seq = 0;
  const conflicts = (table: string, row: Row, ignoreId?: string) =>
    (UNIQUE[table] || []).some((cols) => (tables[table] || []).some((r) =>
      r.id !== ignoreId && cols.every((c) => r[c] !== null && r[c] !== undefined && r[c] === row[c])));

  function from(table: string) {
    tables[table] = tables[table] || [];
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: any = null;
    let opts: any = {};
    const filters: Array<(r: Row) => boolean> = [];
    let returning = false;
    let single: 'one' | 'maybe' | null = null;
    let limitN: number | null = null;
    let orderBy: [string, boolean] | null = null;

    const api: any = {
      select() { if (op !== 'select') returning = true; return api; },
      insert(p: any) { op = 'insert'; payload = p; return api; },
      update(p: any) { op = 'update'; payload = p; return api; },
      upsert(p: any, o: any) { op = 'upsert'; payload = p; opts = o || {}; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return api; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return api; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return api; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return api; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return api; },
      or(expr: string) {
        const parts = expr.split(',').map((p) => {
          const [c, o, ...rest] = p.split('.');
          const v = rest.join('.');
          return (r: Row) => (o === 'eq' ? String(r[c]) === v : false);
        });
        filters.push((r) => parts.some((f) => f(r)));
        return api;
      },
      order(c: string, o?: any) { orderBy = [c, o?.ascending !== false]; return api; },
      limit(n: number) { limitN = n; return api; },
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
      if (op === 'select') {
        let rows = match();
        if (orderBy) {
          const [c, asc] = orderBy;
          rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (limitN !== null) rows = rows.slice(0, limitN);
        return out(rows);
      }
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const inserted: Row[] = [];
        for (const p of list) {
          const row = { ...(DEFAULTS[table]?.() || {}), id: p.id || `${table}_${++seq}`, ...p };
          if (conflicts(table, row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          tables[table].push(row);
          inserted.push(row);
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
          if (existing) {
            if (opts.ignoreDuplicates) continue;
            Object.assign(existing, JSON.parse(JSON.stringify(p)));
            touched.push(existing);
          } else {
            const row = { ...(DEFAULTS[table]?.() || {}), id: p.id || `${table}_${++seq}`, ...p };
            tables[table].push(row);
            touched.push(row);
          }
        }
        return returning ? out(touched) : { data: null, error: null };
      }
      if (op === 'delete') {
        const keep = tables[table].filter((r) => !filters.every((f) => f(r)));
        tables[table] = keep;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return api;
  }
  return { from, tables };
}

// ============================================================================
// Gateway Asaas simulado (registra toda chamada)
// ============================================================================
const PAYMENT_ID = 'pay_1';
const SERVICE_CENTS = 10000;          // preco do servico (appointment.price)
const CHARGED_VALUE = 101.99;         // servico + taxa do Asaas cobrada do aluno

type GwResponse = { ok: boolean; status: number; body?: any; throws?: any };
function gateway(post: GwResponse | null, getBody: any = { id: PAYMENT_ID, status: 'RECEIVED', value: CHARGED_VALUE, split: [] }, getOk = true) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fn = async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'GET') {
      if (!getOk) return { ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(getBody)), text: async () => '' };
    }
    if (!post) throw new Error('unexpected POST');
    if (post.throws) throw post.throws;
    return {
      ok: post.ok, status: post.status,
      json: async () => (post.body === undefined ? {} : JSON.parse(JSON.stringify(post.body))),
      text: async () => (typeof post.body === 'string' ? post.body : JSON.stringify(post.body ?? {}))
    };
  };
  return { fn, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

const paymentWithRefunds = (refunds: any[], status = 'RECEIVED') => ({ id: PAYMENT_ID, status, value: CHARGED_VALUE, refunds });
const DONE_ITEM = { id: 'rf_abc', status: 'DONE', value: 100, dateCreated: '2026-10-01 10:00:00', endToEndIdentifier: 'E2E123' };
const PENDING_ITEM = { status: 'PENDING', value: 100, dateCreated: '2026-10-01 10:00:00' };
const CANCELLED_ITEM = { status: 'CANCELLED', value: 100, dateCreated: '2026-10-01 10:00:00' };

const APT = (over: Row = {}): Row => ({
  id: 'apt_1', status: 'pending_approval', instructor_id: 'i1', student_id: 's1',
  payment_intent_id: PAYMENT_ID, provider_payment_id: PAYMENT_ID, provider_name: 'asaas',
  payment_status: 'paid', cancelled_reason: null, group_id: null, price: SERVICE_CENTS, ...over
});
const INSTALLMENT = (over: Row = {}): Row => ({ id: 'inst_1', provider_payment_id: PAYMENT_ID, group_id: null, status: 'RECEIVED', ...over });
const LESSON_TX = (over: Row = {}): Row => ({ id: 'tx_lp', appointment_id: 'apt_1', type: 'lesson_payment', provider_payment_id: PAYMENT_ID, status: 'pending', ...over });
const OP = (over: Row = {}): Row => ({
  ...DEFAULTS.refund_operations(), id: 'op_1', operation_key: 'k1', provider: 'asaas', provider_payment_id: PAYMENT_ID,
  scope: 'SINGLE_APPOINTMENT', status: 'PENDING', requested_amount_cents: SERVICE_CENTS,
  metadata: { appointmentIds: ['apt_1'], reason: 'student_cancelled' }, ...over
});

const baseDb = (extra: Record<string, Row[]> = {}) => createDb({
  appointments: [APT()], refund_operations: [], refund_operation_events: [],
  payment_installments: [INSTALLMENT()], transactions: [LESSON_TX()], ...extra
});

const cancel = (db: any, gw: any, over: Row = {}) => BookingCancellationCore.processCancellation({
  appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
  asaasApiKey: 'k', asaasApiUrl: 'https://sandbox.test', httpFetch: gw.fn as any, ...over
} as any);

const refundTx = (db: any) => db.tables.transactions.find((t: Row) => t.type === 'refund');
const lessonTx = (db: any) => db.tables.transactions.find((t: Row) => t.type === 'lesson_payment');
const events = (db: any) => db.tables.refund_operation_events;

async function expectThrow(fn: () => Promise<any>): Promise<any> {
  try { await fn(); return null; } catch (e) { return e; }
}

async function run() {
  console.log('\n=== Ciclo do estorno com confirmacao real do Asaas ===\n');

  // --------------------------------------------------------------------------
  // U) Mecanismo unico de interpretacao
  // --------------------------------------------------------------------------
  {
    const q = { paymentId: PAYMENT_ID, requestedAmountCents: SERVICE_CENTS };
    check(interpretRefundState(paymentWithRefunds([DONE_ITEM], 'PARTIALLY_REFUNDED'), q).outcome === 'COMPLETED',
      'U1. item DONE com o valor pedido => COMPLETED (mesmo com pagamento PARTIALLY_REFUNDED)');
    check(interpretRefundState(paymentWithRefunds([PENDING_ITEM]), q).outcome === 'PENDING', 'U2. item PENDING => PENDING');
    check(interpretRefundState(paymentWithRefunds([CANCELLED_ITEM]), q).outcome === 'DENIED', 'U3. item CANCELLED => DENIED');
    check(interpretRefundState({ id: PAYMENT_ID }, q).outcome === 'UNKNOWN', 'U4. corpo sem status/itens => UNKNOWN');
    check(interpretRefundState(null, q).outcome === 'UNKNOWN', 'U5. corpo vazio => UNKNOWN');
    check(interpretRefundState(paymentWithRefunds([]), q).outcome === 'NONE', 'U6. RECEIVED com refunds [] => NONE (afirmacao positiva)');
    check(interpretRefundState({ id: PAYMENT_ID, status: 'RECEIVED', value: CHARGED_VALUE }, q).outcome === 'UNKNOWN',
      'U7. RECEIVED sem campo refunds => UNKNOWN (nao se infere ausencia)');
    check(interpretRefundState({ ...paymentWithRefunds([]), status: 'REFUNDED' }, q).outcome !== 'COMPLETED',
      'U8. status REFUNDED sem item nao conclui estorno de valor MENOR que o cobrado');
    const withPayId = interpretRefundState(paymentWithRefunds([{ ...DONE_ITEM, id: PAYMENT_ID }]), q);
    check(withPayId.providerRefundId === null, 'U9. id do pagamento NUNCA vira provider_refund_id');
    check(interpretRefundState(paymentWithRefunds([DONE_ITEM]), q).providerRefundId === 'rf_abc', 'U10. id real do item de estorno e\' usado');
    check(interpretRefundState(paymentWithRefunds([{ ...DONE_ITEM, value: 101.99 }]), q).outcome !== 'COMPLETED',
      'U11. estorno do valor BRUTO nao casa com a operacao (regra financeira)');
    const s1 = sanitizeProviderMessage('{"errors":[{"code":"invalid","description":"Saldo insuficiente para joao@x.com cpf 123.456.789-00"}]}') || '';
    check(s1.includes('Saldo insuficiente') && !s1.includes('joao@x.com') && !s1.includes('123.456.789-00'),
      'U12. motivo de recusa preservado e sem e-mail/documento');
  }

  // --------------------------------------------------------------------------
  // M) Maquina de estados
  // --------------------------------------------------------------------------
  {
    check(!canTransitionRefund('COMPLETED', 'DENIED', { source: 'webhook', complete: false }),
      'M1. COMPLETED nao regride sem a marca de conclusao nao confirmada');
    check(!canTransitionRefund('COMPLETED', 'DENIED', { source: 'local', complete: false, revertsUnconfirmedCompletion: true }),
      'M2. evidencia LOCAL nunca desfaz COMPLETED');
    check(canTransitionRefund('COMPLETED', 'DENIED', { source: 'webhook', complete: false, revertsUnconfirmedCompletion: true }),
      'M3. evidencia externa corrige conclusao nao confirmada');
    check(!canTransitionRefund('COMPLETED', 'PENDING', { source: 'webhook', complete: false, revertsUnconfirmedCompletion: true }),
      'M4. COMPLETED -> PENDING continua proibido');
    check(!canTransitionRefund('DENIED', 'REQUESTED', { source: 'webhook', complete: false }), 'M5. DENIED nao reabre sozinho');
    check(canTransitionRefund('DENIED', 'REQUESTED', { source: 'local', complete: false, explicitRetry: true }), 'M6. DENIED reabre so\' por nova tentativa explicita');
  }

  // --------------------------------------------------------------------------
  // 1. POST 2xx com estorno confirmado
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    const gw = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM], 'PARTIALLY_REFUNDED') });
    const res = await cancel(db, gw);
    const op = db.tables.refund_operations[0];
    check(res.status === 'cancelled' && res.paymentStatus === 'refunded', '1. confirmado: resultado cancelled/refunded');
    check(op.status === 'COMPLETED' && !!op.acknowledged_at, '1. operacao COMPLETED com acknowledged_at');
    check(op.provider_refund_id === 'rf_abc', '1. provider_refund_id = id do ESTORNO (nao pay_1)');
    check(db.tables.appointments[0].status === 'cancelled' && db.tables.appointments[0].payment_status === 'refunded', '1. aula cancelada e estornada');
    check(db.tables.payment_installments[0].status === 'REFUNDED', '1. parcela REFUNDED apos confirmacao');
    check(refundTx(db)?.status === 'completed', '1. transacao de estorno completed');
    check(events(db).some((e: Row) => e.source === 'claim' && e.to_status === 'PENDING')
      && events(db).some((e: Row) => e.source === 'post' && e.to_status === 'COMPLETED'), '1. eventos claim + post registrados');
  }

  // --------------------------------------------------------------------------
  // 2. POST 2xx com estorno pendente
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    const gw = gateway({ ok: true, status: 200, body: paymentWithRefunds([PENDING_ITEM]) });
    const res = await cancel(db, gw);
    const op = db.tables.refund_operations[0];
    check(res.status === 'pending_refund', '2. pendente: resultado pending_refund');
    check(op.status === 'PENDING' && !!op.acknowledged_at && op.owner_id === null && op.lease_until === null,
      '2. PENDING reconhecido, lease liberada (reaper nao o rebaixa)');
    check(db.tables.appointments[0].status === 'pending_approval' && db.tables.appointments[0].payment_status === 'paid',
      '2. aula NAO marcada como estornada');
    check(db.tables.payment_installments[0].status === 'RECEIVED' && !refundTx(db), '2. parcela e ledger intocados');
  }

  // --------------------------------------------------------------------------
  // 3. POST 2xx com resposta ambigua
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    const gw = gateway({ ok: true, status: 200, body: { id: PAYMENT_ID } });
    const res = await cancel(db, gw);
    const op = db.tables.refund_operations[0];
    check(res.status === 'pending_refund' && op.status === 'UNKNOWN', '3. ambiguo: UNKNOWN, sem conclusao');
    check(op.provider_refund_id === null, '3. id do pagamento do corpo NAO e\' gravado como id do estorno');
    check(db.tables.appointments[0].status === 'pending_approval', '3. aula intocada');
  }

  // --------------------------------------------------------------------------
  // 4. POST recusado pelo Asaas (HTTP 4xx e item CANCELLED)
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    const gw = gateway({ ok: false, status: 400, body: { errors: [{ code: 'invalid_action', description: 'Saldo insuficiente. Contato: fin@x.com' }] } });
    const err = await expectThrow(() => cancel(db, gw));
    const op = db.tables.refund_operations[0];
    check(!!err && op.status === 'DENIED', '4. HTTP 4xx: DENIED e erro explicito');
    check(op.denial_reason.includes('Saldo insuficiente') && !op.denial_reason.includes('fin@x.com'), '4. motivo real preservado, sem dado pessoal');
    check(db.tables.appointments[0].status === 'pending_approval' && db.tables.appointments[0].payment_status === 'paid',
      '4. recusa nao altera a aula nem marca pagamento falho');

    const db2 = baseDb();
    const gw2 = gateway({ ok: true, status: 200, body: paymentWithRefunds([CANCELLED_ITEM]) });
    const err2 = await expectThrow(() => cancel(db2, gw2));
    check(!!err2 && db2.tables.refund_operations[0].status === 'DENIED', '4b. 2xx com item CANCELLED: DENIED');
  }

  // --------------------------------------------------------------------------
  // 5. Timeout apos o envio + 11. operacao pendente nao duplica POST
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    const gw = gateway({ ok: false, status: 0, throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
    const err = await expectThrow(() => cancel(db, gw));
    check(!!err && db.tables.refund_operations[0].status === 'UNKNOWN', '5. timeout: UNKNOWN (pode ter sido aplicado)');
    const gw2 = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) });
    const res2 = await cancel(db, gw2);
    check(gw2.posts().length === 0 && res2.status === 'pending_refund', '11. UNKNOWN nao gera novo POST');

    const db3 = baseDb();
    await cancel(db3, gateway({ ok: true, status: 200, body: paymentWithRefunds([PENDING_ITEM]) }));
    const gw3 = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) });
    const res3 = await cancel(db3, gw3);
    check(gw3.posts().length === 0 && res3.status === 'pending_refund', '11. PENDING reconhecido nao gera novo POST');
  }

  // --------------------------------------------------------------------------
  // 6. Webhook de conclusao (evento PARCIAL = caso normal do app)
  // --------------------------------------------------------------------------
  {
    const db = baseDb({ refund_operations: [OP({ acknowledged_at: '2026-10-01T10:00:00Z' })] });
    const r = await BookingCancellationCore.applyRefundEvent(
      db, PAYMENT_ID, paymentWithRefunds([DONE_ITEM], 'PARTIALLY_REFUNDED'), 'COMPLETED', 'evt_1', null);
    const op = db.tables.refund_operations[0];
    check(r.applied === 1 && op.status === 'COMPLETED' && !!op.acknowledged_at, '6. PAYMENT_PARTIALLY_REFUNDED conclui a operacao casada');
    check(db.tables.appointments[0].status === 'cancelled' && db.tables.appointments[0].payment_status === 'refunded',
      '6/14. aula cancelada e estornada pelo webhook');
    check(db.tables.payment_installments[0].status === 'REFUNDED' && refundTx(db)?.status === 'completed' && lessonTx(db)?.status === 'failed',
      '6/14. parcela, ledger de estorno e pagamento da aula coerentes');

    const db2 = baseDb({ refund_operations: [OP()] });
    await BookingCancellationCore.applyRefundEvent(db2, PAYMENT_ID, { id: PAYMENT_ID, status: 'REFUNDED', value: CHARGED_VALUE }, 'COMPLETED', 'evt_2', null);
    check(db2.tables.refund_operations[0].status === 'COMPLETED', '6b. PAYMENT_REFUNDED sem itens + operacao unica: conclui');
  }

  // --------------------------------------------------------------------------
  // 7. Webhook de recusa
  // --------------------------------------------------------------------------
  {
    const db = baseDb({ refund_operations: [OP()] });
    db.tables.appointments[0].payment_status = 'refund_requested';
    await BookingCancellationCore.applyRefundEvent(db, PAYMENT_ID, { id: PAYMENT_ID, status: 'RECEIVED' }, 'DENIED', 'evt_d1', 'Conta destino invalida');
    const op = db.tables.refund_operations[0];
    check(op.status === 'DENIED' && op.denial_reason === 'Conta destino invalida', '7. recusa registrada com o motivo real');
    check(db.tables.appointments[0].payment_status === 'paid', '7. aula volta a "paid" — nunca "failed"');
    check(lessonTx(db)?.status === 'pending', '7. transacao original preservada');
    check(db.tables.appointments[0].status === 'pending_approval', '7. aula nao e\' cancelada por uma recusa');
  }

  // --------------------------------------------------------------------------
  // 8. Webhook duplicado
  // --------------------------------------------------------------------------
  {
    const db = baseDb({ refund_operations: [OP()] });
    const payload = paymentWithRefunds([DONE_ITEM]);
    await BookingCancellationCore.applyRefundEvent(db, PAYMENT_ID, payload, 'COMPLETED', 'evt_dup', null);
    const snapshot = JSON.stringify(db.tables.appointments) + JSON.stringify(db.tables.transactions);
    const r2 = await BookingCancellationCore.applyRefundEvent(db, PAYMENT_ID, payload, 'COMPLETED', 'evt_dup', null);
    check(r2.applied === 0, '8. segundo evento identico nao aplica nada');
    check(JSON.stringify(db.tables.appointments) + JSON.stringify(db.tables.transactions) === snapshot, '8. nenhum registro reescrito');
    check(events(db).filter((e: Row) => e.provider_event_id === 'evt_dup').length === 1, '8. um unico evento por provider_event_id');
  }

  // --------------------------------------------------------------------------
  // 9. Eventos fora de ordem
  // --------------------------------------------------------------------------
  {
    const db = baseDb({ refund_operations: [OP({ status: 'COMPLETED', acknowledged_at: '2026-10-01T10:00:00Z', completed_at: '2026-10-01T10:00:00Z' })] });
    db.tables.appointments[0] = APT({ status: 'cancelled', payment_status: 'refunded' });
    await BookingCancellationCore.applyRefundEvent(db, PAYMENT_ID, { id: PAYMENT_ID, status: 'RECEIVED' }, 'DENIED', 'evt_old', 'antigo');
    check(db.tables.refund_operations[0].status === 'COMPLETED', '9. recusa antiga nao rebaixa conclusao CONFIRMADA');
    check(db.tables.appointments[0].payment_status === 'refunded', '9. aula permanece estornada');
    check(events(db).some((e: Row) => e.raw_payload?.decision === 'ignored_denial_on_confirmed_completion'), '9. evento tardio registrado como ignorado');
    await BookingCancellationCore.applyRefundEvent(db, PAYMENT_ID, paymentWithRefunds([PENDING_ITEM]), 'PENDING', 'evt_late_ip', null);
    check(db.tables.refund_operations[0].status === 'COMPLETED', '9b. REFUND_IN_PROGRESS tardio nao rebaixa COMPLETED');
  }

  // --------------------------------------------------------------------------
  // 10. Recuperacao de COMPLETED marcado incorretamente (legado)
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      appointments: [APT({ status: 'cancelled', payment_status: 'refunded', cancelled_reason: 'student_cancelled' })],
      refund_operations: [OP({ status: 'COMPLETED', acknowledged_at: null, completed_at: '2026-09-20T10:00:00Z', provider_refund_id: PAYMENT_ID })],
      refund_operation_events: [],
      payment_installments: [INSTALLMENT({ status: 'REFUNDED' })],
      transactions: [LESSON_TX({ status: 'failed' }), { id: 'tx_rf', appointment_id: 'apt_1', type: 'refund', provider_payment_id: PAYMENT_ID, status: 'completed', gross_amount: -SERVICE_CENTS }]
    });
    await BookingCancellationCore.applyRefundEvent(db, PAYMENT_ID, { id: PAYMENT_ID, status: 'RECEIVED' }, 'DENIED', 'evt_fix', 'Recusado pelo banco');
    const op = db.tables.refund_operations[0];
    check(op.status === 'DENIED' && op.metadata.requires_manual_review === true, '10. conclusao falsa corrigida para DENIED, com revisao manual');
    check(db.tables.payment_installments[0].status === 'RECEIVED', '10. parcela volta a RECEIVED');
    check(lessonTx(db)?.status === 'pending', '10. pagamento da aula restaurado (nao fica "failed")');
    check(refundTx(db)?.status === 'failed', '10. ledger de estorno marca a recusa');
    check(db.tables.appointments[0].payment_status === 'paid', '10. aula deixa de afirmar "refunded"');
    check(events(db).some((e: Row) => e.from_status === 'COMPLETED' && e.to_status === 'DENIED' && e.source === 'webhook'), '10. correcao rastreada em refund_operation_events');
  }

  // --------------------------------------------------------------------------
  // 12. Concorrencia cron x webhook (CAS)
  // --------------------------------------------------------------------------
  {
    const db = baseDb({ refund_operations: [OP()] });
    const stale = JSON.parse(JSON.stringify(db.tables.refund_operations[0]));
    const view = interpretRefundState(paymentWithRefunds([DONE_ITEM]), { paymentId: PAYMENT_ID, requestedAmountCents: SERVICE_CENTS });
    const [a, b] = await Promise.all([
      BookingCancellationCore.applyProviderEvidence(db, stale, view, { source: 'webhook', providerEventId: 'evt_c' }),
      BookingCancellationCore.applyProviderEvidence(db, JSON.parse(JSON.stringify(stale)), view, { source: 'reconciliation' })
    ]);
    check(a.status === 'COMPLETED' && b.status === 'COMPLETED', '12. ambos os atores terminam vendo COMPLETED');
    check(db.tables.transactions.filter((t: Row) => t.type === 'refund').length === 1, '12. um unico lancamento de estorno');
    check(db.tables.refund_operations[0].version === 2, '12. uma unica transicao aplicada (a outra perdeu o CAS)');
    const gw = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) });
    const again = await cancel(db, gw);
    check(gw.posts().length === 0 && again.alreadyProcessed === true, '12. chamada manual posterior nao gera POST');
  }

  // --------------------------------------------------------------------------
  // 13 / 16. Reconciliacao (somente GET)
  // --------------------------------------------------------------------------
  {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const deps = (gw: any) => ({ httpFetch: gw.fn, asaasApiUrl: 'https://sandbox.test', asaasApiKey: 'k', staleAfterMs: 30 * 60 * 1000 });

    const db1 = baseDb({ refund_operations: [OP({ status: 'UNKNOWN', updated_at: old })] });
    const gw1 = gateway(null, paymentWithRefunds([DONE_ITEM], 'PARTIALLY_REFUNDED'));
    const r1 = await BookingCancellationCore.reconcileRefundOperation(db1, db1.tables.refund_operations[0] as any, deps(gw1));
    check(r1.after === 'COMPLETED' && db1.tables.appointments[0].status === 'cancelled', '13a. UNKNOWN + gateway DONE => COMPLETED e aula finalizada');

    const db2 = baseDb({ refund_operations: [OP({ status: 'PENDING', updated_at: old })] });
    db2.tables.appointments[0].payment_status = 'refund_requested';
    const gw2 = gateway(null, paymentWithRefunds([]));
    const r2 = await BookingCancellationCore.reconcileRefundOperation(db2, db2.tables.refund_operations[0] as any, deps(gw2));
    check(r2.after === 'DENIED' && db2.tables.appointments[0].payment_status === 'paid', '13b. PENDING antigo sem estorno no gateway => DENIED, aula volta a paid');

    const db3 = createDb({
      appointments: [APT({ status: 'cancelled', payment_status: 'refunded' })],
      refund_operations: [OP({ status: 'COMPLETED', acknowledged_at: null, updated_at: old })],
      refund_operation_events: [], payment_installments: [INSTALLMENT({ status: 'REFUNDED' })], transactions: [LESSON_TX({ status: 'failed' })]
    });
    const r3 = await BookingCancellationCore.reconcileRefundOperation(db3, db3.tables.refund_operations[0] as any, deps(gateway(null, paymentWithRefunds([]))));
    check(r3.after === 'DENIED' && db3.tables.payment_installments[0].status === 'RECEIVED', '13c. COMPLETED sem confirmacao e sem estorno no gateway => corrigido');

    const db4 = baseDb({ refund_operations: [OP({ status: 'COMPLETED', acknowledged_at: null, updated_at: old })] });
    const r4 = await BookingCancellationCore.reconcileRefundOperation(db4, db4.tables.refund_operations[0] as any, deps(gateway(null, paymentWithRefunds([DONE_ITEM]))));
    check(r4.after === 'COMPLETED' && !!db4.tables.refund_operations[0].acknowledged_at, '13d. COMPLETED sem confirmacao + gateway DONE => confirmado');

    const db5 = baseDb({ refund_operations: [OP({ status: 'PENDING', updated_at: new Date().toISOString() })] });
    const r5 = await BookingCancellationCore.reconcileRefundOperation(db5, db5.tables.refund_operations[0] as any, deps(gateway(null, paymentWithRefunds([]))));
    check(r5.after === 'PENDING', '13e. PENDING recente nao e\' fechado por "nenhum estorno" (pode estar em transito)');

    const db6 = baseDb({ refund_operations: [OP({ status: 'UNKNOWN', updated_at: old })] });
    const r6 = await BookingCancellationCore.reconcileRefundOperation(db6, db6.tables.refund_operations[0] as any, deps(gateway(null, {}, false)));
    check(r6.after === 'UNKNOWN' && r6.outcome === 'gateway_unavailable', '13f. gateway indisponivel: nada muda');

    const db7 = createDb({
      appointments: [APT({ status: 'pending_approval', payment_status: 'paid' })],
      refund_operations: [OP({ status: 'COMPLETED', acknowledged_at: '2026-10-01T10:00:00Z', updated_at: old })],
      refund_operation_events: [], payment_installments: [INSTALLMENT()], transactions: [LESSON_TX()]
    });
    await BookingCancellationCore.reconcileRefundOperation(db7, db7.tables.refund_operations[0] as any, deps(gateway(null, paymentWithRefunds([DONE_ITEM]))));
    check(db7.tables.appointments[0].status === 'cancelled' && db7.tables.appointments[0].payment_status === 'refunded',
      '13g. estorno confirmado com aula divergente => aula corrigida');

    const allGw = [gw1, gw2];
    check(allGw.every((g) => g.calls.every((c: any) => c.method === 'GET')), '16. reconciliacao so\' faz GET — nenhum POST/estorno/cobranca');

    const stale = await RefundOperationRepository.findStaleForReconciliation(
      createDb({ refund_operations: [OP({ id: 'a', status: 'PENDING', updated_at: old }), OP({ id: 'b', status: 'PENDING', updated_at: new Date().toISOString() }), OP({ id: 'c', status: 'COMPLETED', acknowledged_at: null }), OP({ id: 'd', status: 'COMPLETED', acknowledged_at: old })] }) as any,
      new Date(Date.now() - 10 * 60 * 1000).toISOString());
    check(stale.map((o) => o.id).sort().join(',') === 'a,c', '13h. candidatas: PENDING antiga e COMPLETED nao confirmada');
  }

  // --------------------------------------------------------------------------
  // 15. Regra financeira preservada
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    const gw = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) }, { id: PAYMENT_ID, status: 'RECEIVED', value: CHARGED_VALUE, split: [] });
    await cancel(db, gw);
    const post = gw.posts()[0];
    check(post?.body?.value === 100, '15. POST pede o valor do SERVICO (R$ 100,00), nao o cobrado (R$ 101,99)');
    check(db.tables.refund_operations[0].requested_amount_cents === SERVICE_CENTS, '15. operacao registra o valor do servico');
    check(refundTx(db)?.gross_amount === -SERVICE_CENTS, '15. ledger devolve so\' o servico (taxa do Asaas retida)');
  }

  // --------------------------------------------------------------------------
  // R) Nova tentativa de DENIED: somente explicita e com consulta previa
  // --------------------------------------------------------------------------
  {
    const denied = () => baseDb({ refund_operations: [] });
    const db = denied();
    await expectThrow(() => cancel(db, gateway({ ok: false, status: 400, body: { errors: [{ description: 'nope' }] } })));
    const gwNo = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) });
    await expectThrow(() => cancel(db, gwNo));
    check(gwNo.posts().length === 0, 'R1. DENIED nao e\' tentado de novo automaticamente');

    const gwInFlight = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) },
      paymentWithRefunds([PENDING_ITEM]));
    await expectThrow(() => cancel(db, gwInFlight, { explicitRetry: true }));
    check(gwInFlight.posts().length === 0, 'R2. nova tentativa bloqueada se o gateway ja\' mostra estorno em processamento');

    const gwRetry = gateway({ ok: true, status: 200, body: paymentWithRefunds([DONE_ITEM]) }, paymentWithRefunds([]));
    const res = await cancel(db, gwRetry, { explicitRetry: true });
    const op = db.tables.refund_operations[0];
    check(gwRetry.posts().length === 1 && res.status === 'cancelled' && op.status === 'COMPLETED', 'R3. nova tentativa explicita: um POST, estorno confirmado');
    check(op.attempt === 2 && db.tables.refund_operations.length === 1, 'R4. mesma operacao, attempt incrementado (idempotencia preservada)');
    check(events(db).some((e: Row) => e.source === 'manual_retry' && e.from_status === 'DENIED' && e.to_status === 'REQUESTED'), 'R5. reabertura rastreada');
  }

  // --------------------------------------------------------------------------
  // O) Observabilidade sem dados sensiveis
  // --------------------------------------------------------------------------
  {
    const db = baseDb();
    await expectThrow(() => cancel(db, gateway({ ok: false, status: 400, body: { errors: [{ description: 'Chave invalida para ana@x.com 98765432100' }] } })));
    const dump = JSON.stringify(events(db));
    check(events(db).length >= 2 && events(db).every((e: Row) =>
      typeof e.source === 'string' && e.source.length > 0 && typeof e.to_status === 'string' && 'from_status' in e && !!e.refund_operation_id),
      'O1. transicoes registradas com origem, estado anterior/novo e operacao');
    check(events(db).some((e: Row) => e.from_status === 'PENDING' && e.to_status === 'DENIED' && e.raw_payload?.httpStatus === 400),
      'O1b. recusa registrada com o status HTTP do Asaas');
    check(!dump.includes('ana@x.com') && !dump.includes('98765432100') && !dump.includes('access_token') && !/"k"/.test(dump),
      'O2. eventos sem e-mail, documento ou chave');
    check(events(db).every((e: Row) => Object.keys(e.raw_payload || {}).every((k) =>
      ['asaasPaymentStatus', 'refundItemStatus', 'providerRefundId', 'decision', 'reason', 'httpStatus'].includes(k))),
      'O3. raw_payload restrito a lista branca');
  }

  // --------------------------------------------------------------------------
  // W) Ligacao no webhook e na reconciliacao (estatico: estes handlers criam
  //    clients no import e nao rodam no Node)
  // --------------------------------------------------------------------------
  {
    const fs = await import('node:fs');
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const wh = strip(fs.readFileSync('api/asaas-webhook.ts', 'utf-8'));
    const branch = (start: string, end: string) => {
      const a = wh.indexOf(start); const b = wh.indexOf(end, a + start.length);
      return a >= 0 && b > a ? wh.slice(a, b) : '';
    };
    const inProgress = branch("=== 'PAYMENT_REFUND_IN_PROGRESS'", "['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED']");
    const refunded = branch("['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED']", "=== 'PAYMENT_REFUND_DENIED'");
    const denied = branch("=== 'PAYMENT_REFUND_DENIED'", 'Event ignored');
    check(/applyRefundEvent\([\s\S]*?'PENDING'/.test(inProgress), 'W1. REFUND_IN_PROGRESS aplica evidencia por operacao');
    check(/applyRefundEvent\([\s\S]*?'COMPLETED'/.test(refunded), 'W2. REFUNDED/PARTIALLY_REFUNDED aplica evidencia por operacao');
    check(/applyRefundEvent\([\s\S]*?'DENIED'/.test(denied), 'W3. REFUND_DENIED aplica evidencia por operacao');
    check(!/payment_status:\s*'failed'/.test(denied), 'W4. REFUND_DENIED nunca grava payment_status failed');
    check(!/getReconcilableOperations/.test(inProgress + refunded + denied), 'W5. caminho antigo por status do pagamento removido dos 3 ramos');
    check(refunded.indexOf('refundOps.length > 0') > 0 && refunded.indexOf('refundOps.length > 0') < refunded.indexOf('recordRefundSettlement'),
      'W6. legado (recordRefundSettlement) so\' roda sem operacao de estorno');

    const sync = strip(fs.readFileSync('supabase/functions/sync-payment-status/index.ts', 'utf-8'));
    check(/reconcileRefundOperation\(/.test(sync) && /findStaleForReconciliation\(/.test(sync), 'W7. sync-payment-status reconcilia operacoes de estorno');
    const phase0 = sync.slice(sync.indexOf('async function reconcileRefundOperations'), sync.indexOf('Deno.serve('));
    check(phase0.length > 0 && !/method:\s*'POST'/.test(phase0) && !/\/refund/.test(phase0),
      'W8. a fase de reconciliacao de estornos nao emite POST');
    check(!/payments\/\$\{[^}]+\}\/refund/.test(sync) && (sync.match(/method:\s*'POST'/g) || []).length === 1 && /\/api\/reconcile-payment/.test(sync),
      'W8b. o unico POST do arquivo continua sendo o interno /api/reconcile-payment (preexistente, sem estorno)');
    check(sync.indexOf('reconcileRefundOperations()') < sync.indexOf('No stuck or pending refund appointments found'),
      'W9. reconciliacao roda mesmo sem aulas travadas');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length) { failures.forEach((f) => console.error(` - ${f}`)); process.exit(1); }
}

await run();
