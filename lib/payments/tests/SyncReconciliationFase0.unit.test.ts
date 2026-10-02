/**
 * SyncReconciliationFase0.unit.test.ts
 *
 * FASE 0 — conciliacao financeira (`sync-payment-status`).
 *
 * O handler e' uma Edge Function Deno e nao roda aqui. O que roda e' o codigo
 * REAL de que ele depende:
 *   - `_shared/syncPaymentDecision.ts`: as decisoes por grupo, extraidas do
 *     handler sem mudanca de regra (o handler importa exatamente este modulo);
 *   - `BookingCancellationCore.reconcileRefundOperation`: conciliacao de cada
 *     operacao de estorno (somente GET no gateway);
 *   - `RefundOperationRepository.findStaleForReconciliation`: quais operacoes
 *     entram na conciliacao.
 * A liquidacao de pagamento recebido e' delegada pelo handler a
 * `/api/reconcile-payment`, coberta por `tests-p118p26/reconcilePayment`.
 *
 * Tudo em memoria. Nenhuma rede, nenhum Supabase, nenhuma chamada ao Asaas.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export {};

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

const {
  classifySyncGroup, classifyClosedGroupRefund, paymentStatusAfterRefundDenial,
  resolveSyncEligibilityConfig, isOperationallyCurrent, lessonEndMs, eligibilityThresholdMs
} = await import('../../../supabase/functions/_shared/syncPaymentDecision.js');
const { BookingCancellationCore } = await import('../BookingCancellationCore.js');
const { RefundOperationRepository } = await import('../RefundOperationRepository.js');
const { NotificationService } = await import('../../NotificationService.js');
(NotificationService as any).createNotification = async () => ({ success: true });

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};
const origWarn = console.warn; const origError = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = origWarn; console.error = origError; }
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
  version: 1, attempt: 1, owner_id: null, lease_until: null, provider_refund_id: null, sent_at: '2026-10-01T10:00:00Z',
  unknown_since: null, acknowledged_at: null, completed_at: null, completed_amount_cents: null,
  denial_reason: null, currency: 'BRL', metadata: {}, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z'
});

function createDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => JSON.parse(JSON.stringify(r)));
  let seq = 0;
  const failWrites = { table: '', count: 0 };
  const conflicts = (table: string, row: Row) =>
    (UNIQUE[table] || []).some((cols) => (tables[table] || []).some((r) =>
      cols.every((c) => r[c] !== null && r[c] !== undefined && r[c] === row[c])));

  function from(table: string) {
    tables[table] = tables[table] || [];
    let op = 'select'; let payload: any = null; let opts: any = {}; let lim = Infinity;
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
      lt(c: string, v: any) { filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] < v); return api; },
      or() { return api; },
      order() { return api; },
      limit(n: number) { lim = n; return api; },
      maybeSingle() { single = 'maybe'; return exec(); },
      single() { single = 'one'; return exec(); },
      then(res: any, rej: any) { return exec().then(res, rej); }
    };
    const match = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const out = (rows: Row[]) => {
      const copy = rows.slice(0, lim).map((r) => JSON.parse(JSON.stringify(r)));
      if (single === 'one') return copy.length ? { data: copy[0], error: null } : { data: null, error: { message: 'not found' } };
      if (single === 'maybe') return { data: copy[0] ?? null, error: null };
      return { data: copy, error: null };
    };
    async function exec(): Promise<any> {
      await Promise.resolve();
      if (op === 'select') return out(match());
      if (failWrites.count > 0 && failWrites.table === table) { failWrites.count--; return { data: null, error: { message: 'simulated write failure' } }; }
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const inserted: Row[] = [];
        for (const p of list) {
          const row = { id: p.id || `${table}_${++seq}`, ...p };
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
          else { const row = { id: p.id || `${table}_${++seq}`, ...p }; tables[table].push(row); touched.push(row); }
        }
        return returning ? out(touched) : { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return api;
  }
  return { from, tables, failWrites };
}

// ============================================================================
// Fixtures
// ============================================================================
const PAY = 'pay_1';
const payment = (refunds: any[], status = 'RECEIVED') => ({ id: PAY, status, value: 101.99, split: [], refunds });
const DONE = { id: 'rf_1', status: 'DONE', value: 100 };
const AWAITING = { status: 'AWAITING_CRITICAL_ACTION_AUTHORIZATION', value: 100 };
const CANCELLED = { status: 'CANCELLED', value: 100 };
const OLD = '2026-10-01T09:00:00Z';

const APT = (over: Row = {}): Row => ({
  id: 'apt_1', status: 'expired', instructor_id: 'i1', student_id: 's1', payment_intent_id: PAY, provider_payment_id: PAY,
  provider_name: 'asaas', payment_status: 'refund_requested', cancelled_reason: 'auto_expired', group_id: null, price: 10000, ...over
});
const OP = (over: Row = {}): Row => ({
  ...OP_DEFAULTS(), id: 'op_1', operation_key: 'refund:v2:t', provider: 'asaas', provider_payment_id: PAY, scope: 'SINGLE_APPOINTMENT',
  status: 'PENDING', requested_amount_cents: 10000, acknowledged_at: '2026-10-01T10:00:02Z', updated_at: OLD,
  metadata: { appointmentIds: ['apt_1'], reason: 'auto_expired', key_version: 'v2' }, ...over
});
const db0 = (over: Record<string, Row[]> = {}) => createDb({
  appointments: [APT()], refund_operations: [OP()], refund_operation_events: [],
  payment_installments: [{ id: 'inst_1', provider_payment_id: PAY, group_id: null, status: 'RECEIVED' }],
  transactions: [{ id: 'tx_rf', appointment_id: 'apt_1', type: 'refund', provider_payment_id: PAY, status: 'pending' }], ...over
});
function gateway(body: any, o: { ok?: boolean; throws?: boolean } = {}) {
  const calls: string[] = [];
  const fn = async (_u: string, init?: any) => {
    calls.push(init?.method || 'GET');
    if (o.throws) throw new Error('ECONNRESET');
    return { ok: o.ok !== false, status: o.ok === false ? 503 : 200, json: async () => JSON.parse(JSON.stringify(body)), text: async () => '' };
  };
  return { fn, calls, posts: () => calls.filter((c) => c !== 'GET').length };
}
const reconcile = (db: any, gw: any, opIndex = 0) => BookingCancellationCore.reconcileRefundOperation(
  db, db.tables.refund_operations[opIndex] as any, { httpFetch: gw.fn as any, asaasApiUrl: 'https://sandbox.test', asaasApiKey: 'k' });
const state = (db: any) => {
  const a = db.tables.appointments[0]; const o = db.tables.refund_operations[0];
  const t = db.tables.transactions.find((x: Row) => x.type === 'refund');
  return `${a.status}/${a.payment_status}|${o.status}${o.status === 'COMPLETED' && o.acknowledged_at ? '+ack' : ''}|${t?.status}|${db.tables.payment_installments[0].status}`;
};
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

async function main() {
  console.log('\n=== FASE 0: conciliacao financeira (sync-payment-status) ===\n');

  // --------------------------------------------------------------------------
  // A. Decisao por grupo (codigo importado pelo handler)
  // --------------------------------------------------------------------------
  {
    check(classifySyncGroup('RECEIVED', ['awaiting_payment']) === 'reconcile_payment', 'A1. pagamento recebido e ainda nao conciliado (webhook ausente): delega a liquidacao oficial');
    check(classifySyncGroup('RECEIVED', ['pending_approval']) === 'reconcile_payment' && classifySyncGroup('RECEIVED_IN_CASH', ['reserved']) === 'reconcile_payment',
      'A2. pagamento ja\' conciliado em grupo aberto: mesma decisao (a liquidacao oficial e\' idempotente)');
    check(classifySyncGroup('CONFIRMED', ['awaiting_payment']) === 'skip_not_received', 'A3. cartao autorizado, credito futuro: nenhuma acao financeira');
    check(classifySyncGroup('PENDING', ['awaiting_payment']) === 'skip_other' && classifySyncGroup('OVERDUE', ['reserved']) === 'skip_other'
      && classifySyncGroup(null, ['reserved']) === 'skip_other' && classifySyncGroup('QUALQUER', []) === 'skip_other', 'A4. nao pago, vencido, ausente ou desconhecido: nenhuma acao');
    check(classifySyncGroup('RECEIVED', ['expired']) === 'closed_group' && classifySyncGroup('CONFIRMED', ['cancelled', 'pending_approval']) === 'closed_group',
      'A5. pagamento recebido com aula encerrada no grupo: nunca reabre; so\' avalia o estorno');
    check(classifySyncGroup('REFUNDED', ['expired']) === 'repair_refunded' && classifySyncGroup('refunded', ['pending_approval']) === 'repair_refunded',
      'A6. Asaas REFUNDED (confirmacao real): alinha o estado financeiro');
    check(classifySyncGroup('PARTIALLY_REFUNDED', ['expired']) === 'skip_partial_refund', 'A7. estorno parcial: decidido por operacao, nao pelo grupo');
  }

  // --------------------------------------------------------------------------
  // B. Aula encerrada: o que fazer com o estorno
  // --------------------------------------------------------------------------
  {
    check(classifyClosedGroupRefund('DENIED', 1) === 'mark_denied' && classifyClosedGroupRefund('COMPLETED', 2) === 'mark_refunded', 'B1. recusa e conclusao explicitas do gateway sao aplicadas');
    check(['PENDING', 'NONE', 'UNKNOWN', 'PARTIALLY_COMPLETED', null, undefined].every((s) => classifyClosedGroupRefund(s as any, 1) === 'preserve_pending'),
      'B2. estorno em andamento, ausente ou desconhecido: preservado (ausencia de evidencia NAO e\' recusa)');
    check(classifyClosedGroupRefund('DENIED', 0) === 'skip_closed' && classifyClosedGroupRefund('COMPLETED', 0) === 'skip_closed',
      'B3. sem transacao de estorno pendente no banco (ex.: aula ja\' refund_denied ou refunded): nada e\' sobrescrito');
    check(paymentStatusAfterRefundDenial('expired') === 'refund_denied' && paymentStatusAfterRefundDenial('cancelled') === 'refund_denied', 'B4. recusa em aula encerrada: refund_denied');
    check(paymentStatusAfterRefundDenial('pending_approval') === 'paid' && paymentStatusAfterRefundDenial('confirmed') === 'paid', 'B5. recusa em aula aberta: paid — nunca "failed"');
  }

  // --------------------------------------------------------------------------
  // C. Selecao das operacoes de estorno a conciliar
  // --------------------------------------------------------------------------
  {
    const NEW = new Date().toISOString();
    const db = createDb({ refund_operations: [
      OP({ id: 'pend_old', status: 'PENDING', updated_at: OLD }),
      OP({ id: 'pend_new', status: 'PENDING', updated_at: NEW, operation_key: 'k2' }),
      OP({ id: 'unk_old', status: 'UNKNOWN', updated_at: OLD, operation_key: 'k3' }),
      OP({ id: 'done_unack', status: 'COMPLETED', acknowledged_at: null, operation_key: 'k4' }),
      OP({ id: 'done_ack', status: 'COMPLETED', acknowledged_at: OLD, operation_key: 'k5' }),
      OP({ id: 'denied', status: 'DENIED', updated_at: OLD, operation_key: 'k6' }),
      OP({ id: 'conflict', status: 'CONFLICT', updated_at: OLD, operation_key: 'k7' }),
      OP({ id: 'requested', status: 'REQUESTED', updated_at: OLD, operation_key: 'k8' })
    ] });
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const picked = (await RefundOperationRepository.findStaleForReconciliation(db as any, cutoff, 25)).map((o: Row) => o.id).sort();
    check(JSON.stringify(picked) === JSON.stringify(['done_unack', 'pend_old', 'unk_old']), `C1. entram: PENDING/UNKNOWN parados e COMPLETED nao confirmada [${picked.join(', ')}]`);
    check(!picked.includes('denied') && !picked.includes('conflict'), 'C2. DENIED e CONFLICT nunca sao reprocessados (refund_denied protegido)');
    check(!picked.includes('done_ack') && !picked.includes('pend_new'), 'C3. conclusao confirmada e operacao recente (estorno em andamento) ficam de fora');
    check(!picked.includes('requested'), 'C4. operacao REQUESTED nunca enviada nao entra (lacuna conhecida: fica sem tratamento automatico)');
  }

  // --------------------------------------------------------------------------
  // D. Conciliacao de uma operacao (codigo real, somente GET)
  // --------------------------------------------------------------------------
  {
    // webhook ausente: o gateway mostra o estorno concluido
    const db = db0();
    const gw = gateway(payment([DONE]));
    const r = await reconcile(db, gw);
    check(r.after === 'COMPLETED' && state(db) === 'expired/refunded|COMPLETED+ack|completed|REFUNDED', `D1. webhook ausente + gateway com estorno concluido: operacao, aula, ledger e parcela alinhados [${state(db)}]`);
    check(gw.posts() === 0, 'D2. conciliacao so\' consulta (nenhum POST)');

    // execucoes repetidas
    const before = state(db);
    for (let i = 0; i < 3; i++) await reconcile(db, gateway(payment([DONE])));
    check(state(db) === before && db.tables.refund_operations.length === 1 && db.tables.transactions.filter((t: Row) => t.type === 'refund').length === 1,
      'D3. tres execucoes repetidas: mesmo estado, sem operacao nem transacao duplicada');

    // divergencia: gateway recusou, banco ainda "em analise"
    const dbD = db0();
    await reconcile(dbD, gateway(payment([CANCELLED])));
    check(state(dbD) === 'expired/refund_denied|DENIED|failed|RECEIVED', `D4. divergencia (gateway recusou): refund_denied, ledger failed, parcela intocada [${state(dbD)}]`);

    // estado refund_denied nao e' sobrescrito
    const dbK = db0({ appointments: [APT({ payment_status: 'refund_denied' })], refund_operations: [OP({ status: 'DENIED', denial_reason: 'x' })],
      transactions: [{ id: 'tx_rf', appointment_id: 'apt_1', type: 'refund', provider_payment_id: PAY, status: 'failed' }] });
    const kBefore = state(dbK);
    await reconcile(dbK, gateway(payment([])));
    await reconcile(dbK, gateway(payment([AWAITING])));
    check(state(dbK) === kBefore, `D5. operacao DENIED / aula refund_denied: conciliacao nao altera nada [${state(dbK)}]`);

    // estorno em andamento
    const dbP = db0({ refund_operations: [OP({ updated_at: new Date().toISOString() })] });
    const pBefore = state(dbP);
    await reconcile(dbP, gateway(payment([AWAITING])));
    await reconcile(dbP, gateway(payment([])));
    check(state(dbP) === pBefore, `D6. estorno em andamento (operacao recente): preservado [${state(dbP)}]`);

    // falha de comunicacao com o Asaas
    const dbF = db0();
    const fBefore = state(dbF);
    const r1 = await reconcile(dbF, gateway(null, { throws: true }));
    const r2 = await reconcile(dbF, gateway({}, { ok: false }));
    check(r1.outcome === 'gateway_unreachable' && r2.outcome === 'gateway_unavailable' && state(dbF) === fBefore, 'D7. Asaas indisponivel (rede ou 5xx): nada e\' escrito');
    await reconcile(dbF, gateway(payment([DONE])));
    check(state(dbF) === 'expired/refunded|COMPLETED+ack|completed|REFUNDED', 'D8. na execucao seguinte, com o gateway de volta, a conciliacao conclui');

    // execucoes concorrentes sobre a mesma operacao
    const dbC = db0();
    await quiet(() => Promise.all([reconcile(dbC, gateway(payment([DONE]))), reconcile(dbC, gateway(payment([DONE])))]));
    const completedEvents = dbC.tables.refund_operation_events.filter((e: Row) => e.to_status === 'COMPLETED' && e.from_status !== 'COMPLETED').length;
    check(state(dbC) === 'expired/refunded|COMPLETED+ack|completed|REFUNDED' && dbC.tables.refund_operations.length === 1 && completedEvents === 1,
      `D9. duas conciliacoes simultaneas: uma unica transicao, estado final coerente [${state(dbC)}]`);

    // falha parcial: a escrita da aula falha no meio; a execucao seguinte completa
    const dbX = db0();
    dbX.failWrites.table = 'appointments'; dbX.failWrites.count = 5;
    await quiet(() => reconcile(dbX, gateway(payment([DONE]))).catch(() => null));
    const mid = state(dbX);
    dbX.failWrites.count = 0;
    await quiet(() => BookingCancellationCore.finalizeConfirmedRefund(dbX, dbX.tables.refund_operations[0] as any));
    check(mid.startsWith('expired/refund_requested|COMPLETED+ack') && state(dbX) === 'expired/refunded|COMPLETED+ack|completed|REFUNDED',
      `D10. falha parcial (aula nao gravada): operacao fica confirmada e a finalizacao posterior completa [${mid} -> ${state(dbX)}]`);
    const stillStale = (await RefundOperationRepository.findStaleForReconciliation(dbX as any, new Date().toISOString(), 25)).length;
    check(stillStale === 0, 'D11. LACUNA REGISTRADA: operacao COMPLETED confirmada nao e\' re-selecionada pela conciliacao; se a aula ficou para tras, depende de outro gatilho');
  }

  // --------------------------------------------------------------------------
  // E. O handler usa estas decisoes e continua sem emitir estorno
  // --------------------------------------------------------------------------
  {
    const s = src('supabase/functions/sync-payment-status/index.ts');
    check(s.includes("from '../_shared/syncPaymentDecision.ts'") && s.includes('classifySyncGroup(asaasStatus') && s.includes('classifyClosedGroupRefund(refundState'),
      'E1. handler importa e usa as decisoes testadas acima');
    const idxElig = s.indexOf("reason: 'historical_lessons'");
    const idxGateway = s.indexOf('const url = `${asaasApiUrl}/payments/${paymentId}`');
    check(idxElig > 0 && idxGateway > idxElig && s.includes('isOperationallyCurrent((allGroupApts'), 'E1b. grupo historico e\' descartado ANTES da consulta ao gateway');
    check(s.includes('const eligibleOps = candidates.filter') && s.includes('REFUND_RECONCILE_BATCH * 4') && s.includes('eligibleOps.slice(0, REFUND_RECONCILE_BATCH)'),
      'E1c. operacoes historicas sao filtradas antes de formar o lote (nao ocupam o lugar das validas)');
    check(s.includes('paymentStatusAfterRefundDenial(apt.status)') && !/payment_status:\s*'failed'/.test(s), 'E2. recusa de estorno no handler nunca grava "failed"');
    check(s.includes("and(status.in.(cancelled,expired),payment_status.in.(paid,refund_requested))"), 'E3. seletor nao inclui aulas refund_denied nem refunded');
    check(!s.includes('/refund') && s.includes("requireCronAuth(req, 'sync-payment-status')"), 'E4. handler nao chama endpoint de estorno e exige CRON_SECRET');
    const mig = src('supabase/migrations/20261001_schedule_sync_payment_status.sql');
    const exec = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    check(exec.includes("cron.schedule(") && exec.includes("invoke_edge_function_cron('sync-payment-status')") && exec.includes("'sync-payment-status-job'"),
      'E5. proposta de agendamento usa o mecanismo existente (pg_cron + invoke_edge_function_cron)');
    check(!/\b(UPDATE|DELETE|INSERT|ALTER|DROP)\b/i.test(exec.replace(/cron\.unschedule/g, '')), 'E6. proposta de agendamento nao altera tabelas nem dados');
  }

  // --------------------------------------------------------------------------
  // F. Elegibilidade operacional: aulas passadas ficam fora
  // --------------------------------------------------------------------------
  {
    const NOW = Date.parse('2026-10-02T15:00:00Z'); // 12:00 em Brasilia
    const cfg = resolveSyncEligibilityConfig(() => undefined);
    const L = (date: string, start: string, end: string | null = null) => ({ date, start_time: start, end_time: end });
    const cur = (lessons: any[], c = cfg, now = NOW) => isOperationallyCurrent(lessons, now, c);

    check(cfg.pastLessonGraceMs === 24 * 60 * 60 * 1000 && cfg.minLessonEndMs === null, 'F1. padrao: tolerancia de 24 h apos o fim da aula, sem data minima');
    check(lessonEndMs(L('2026-10-02', '11:00:00', '12:00:00')) === NOW && lessonEndMs(L('2026-10-02', '11:00', null)) === NOW,
      'F2. fim da aula em horario de Brasilia; sem end_time usa inicio + 60 min');
    check(cur([L('2026-10-05', '09:00:00', '10:00:00')]), 'F3. aula futura: elegivel');
    check(cur([L('2026-10-02', '11:30:00', '12:30:00')]), 'F4. aula em andamento (comecou, ainda nao terminou): elegivel');
    check(cur([L('2026-10-02', '11:00:00', '12:00:00')]), 'F5. aula que termina exatamente agora: elegivel');
    check(cur([L('2026-10-02', '07:00:00', '08:00:00')]) && cur([L('2026-10-01', '13:00:00', '14:00:00')]),
      'F6. aula encerrada ha\' menos de 24 h (pagamento ou estorno ainda em processamento): elegivel');
    check(cur([L('2026-10-01', '11:00:00', '12:00:00')]) && !cur([L('2026-10-01', '10:59:00', '11:59:00')]),
      'F7. limite exato: encerrada ha\' 24 h e\' elegivel; ha\' 24 h e 1 min nao e\'');
    check(!cur([L('2026-09-30', '16:00:00', '17:00:00')]) && !cur([L('2026-08-12', '11:00:00', '12:00:00')]), 'F8. aulas passadas alem da tolerancia: ignoradas');
    check(cur([L('2026-08-12', '11:00:00', '12:00:00'), L('2026-10-09', '11:00:00', '12:00:00')]),
      'F9. combo com uma aula antiga e uma futura: elegivel (vale a ultima aula)');
    check(!cur([]) && !cur([{ date: null, start_time: null, end_time: null } as any]) && !cur([L('data-invalida', '10:00')]),
      'F10. sem aula ou com data invalida: NAO elegivel (dado faltando nunca libera processamento)');

    // configuracao por ambiente
    const env = (o: Record<string, string>) => (name: string) => o[name];
    const c48 = resolveSyncEligibilityConfig(env({ SYNC_PAST_LESSON_GRACE_HOURS: '48' }));
    check(cur([L('2026-09-30', '16:00:00', '17:00:00')], c48) && !cur([L('2026-09-30', '10:00:00', '11:00:00')], c48), 'F11. tolerancia configuravel (48 h)');
    const cMin = resolveSyncEligibilityConfig(env({ SYNC_MIN_LESSON_DATE: '2026-10-02' }));
    check(!cur([L('2026-10-01', '22:00:00', '23:00:00')], cMin) && cur([L('2026-10-02', '00:00:00', '01:00:00')], cMin),
      'F12. data minima: aula anterior a 02/10 e\' ignorada mesmo dentro da tolerancia');
    check(eligibilityThresholdMs(NOW, cMin) === Date.parse('2026-10-02T03:00:00Z'), 'F13. o limite e\' o maior entre (agora - tolerancia) e a data minima');
    const bad = resolveSyncEligibilityConfig(env({ SYNC_PAST_LESSON_GRACE_HOURS: 'abc', SYNC_MIN_LESSON_DATE: '02/10/2026' }));
    check(bad.pastLessonGraceMs === cfg.pastLessonGraceMs && bad.minLessonEndMs === null, 'F14. configuracao invalida cai no padrao');

    // retrato de producao (leitura de 02/10 01:02 UTC): tudo historico
    const SNAP = Date.parse('2026-10-02T01:02:00Z');
    const prod: Array<[string, any]> = [
      ['aula cancelled/refund_requested de 12/08', L('2026-08-12', '11:00:00', '12:00:00')],
      ['operacao REQUESTED de 22/09', L('2026-09-22', '11:00:00', '12:00:00')],
      ['operacao REQUESTED de 24/09', L('2026-09-24', '07:00:00', '08:00:00')],
      ['operacao COMPLETED nao confirmada de 30/09 16h', L('2026-09-30', '16:00:00', '17:00:00')],
      ['operacao COMPLETED nao confirmada de 30/09 19h', L('2026-09-30', '19:00:00', '20:00:00')]
    ];
    check(prod.every(([, l]) => !cur([l], cfg, SNAP)), 'F15. registros historicos atuais de producao: nenhum e\' elegivel (nada seria consultado nem alterado)');
    check(cur([L('2026-10-01', '19:00:00', '20:00:00')], cfg, SNAP) && !cur([L('2026-10-01', '19:00:00', '20:00:00')], resolveSyncEligibilityConfig(env({ SYNC_MIN_LESSON_DATE: '2026-10-02' })), SNAP),
      'F16. aula de 01/10 19h ainda esta\' dentro das 24 h; com a data minima em 02/10 fica fora');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
