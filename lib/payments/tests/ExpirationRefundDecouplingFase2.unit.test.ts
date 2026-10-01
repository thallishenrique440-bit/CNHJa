/**
 * ExpirationRefundDecouplingFase2.unit.test.ts
 *
 * FASE 2 — o encerramento OPERACIONAL da aula deixa de depender do desfecho
 * FINANCEIRO do estorno.
 *
 * Incidente (2026-10-01): aula paga expirou, o Asaas recusou o estorno e a aula
 * ficou para sempre em `pending_approval`/`paid` — "Processando..." em Minhas
 * Aulas, reprocessada pelo cron a cada minuto.
 *
 * Regra nova: a aula e' encerrada (`expired`/`cancelled`) qualquer que seja o
 * estado do estorno; o estado financeiro fica explicito em `payment_status`
 * (`refunded` | `refund_requested` | `refund_denied`) e nunca afirma estorno
 * concluido sem confirmacao do gateway.
 *
 * Tudo em memoria: banco e gateway simulados. Nenhuma rede, nenhum Supabase,
 * nenhuma chamada ao Asaas.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export {};

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

const { BookingCancellationCore, classifyCancellationResult, REFUND_IN_REVIEW_MESSAGE } = await import('../BookingCancellationCore.js');
const { NotificationService } = await import('../../NotificationService.js');
const { isHiddenFromStudentAgenda } = await import('../../lessonStatus.js');
const { StudentHistoryAdapter } = await import('../../../components/finance/adapters/StudentHistoryAdapter.js');

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};

// Notificacoes capturadas em memoria (nenhuma chamada de rede).
const notifications: Array<Record<string, any>> = [];
(NotificationService as any).createNotification = async (params: Record<string, any>) => { notifications.push(params); return { success: true }; };

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
// Gateway simulado e fixtures
// ============================================================================
const PAY = 'pay_1';
const SERVICE = 10000;
const split = (status: string) => ({ id: 'spl_1', walletId: 'wal_1', fixedValue: 90, status });
const payment = (splits: any[], refunds: any[] = []) => ({ id: PAY, status: 'RECEIVED', value: 101.99, split: splits, refunds });
const DONE = { id: 'rf_1', status: 'DONE', value: 100, dateCreated: '2026-10-01 10:00:00' };
/** Estado real do incidente: o Asaas aceita o pedido e o deixa aguardando autorizacao. */
const AWAITING = { status: 'AWAITING_CRITICAL_ACTION_AUTHORIZATION', value: 100, dateCreated: '2026-10-01 10:00:00' };
const CANCELLED = { status: 'CANCELLED', value: 100, dateCreated: '2026-10-01 10:00:00' };
const POST_DONE = { ok: true, status: 200, body: payment([], [DONE]) };
const POST_PENDING = { ok: true, status: 200, body: payment([], [AWAITING]) };
const POST_DENIED_400 = { ok: false, status: 400, body: { errors: [{ code: 'invalid_action', description: 'Falha ao processar a transferencia.' }] } };

function gateway(getBody: any, post: any = null) {
  const calls: Array<{ method: string; url: string }> = [];
  const fn = async (url: string, init?: any) => {
    const method = init?.method || 'GET';
    calls.push({ method, url });
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
  ...OP_DEFAULTS(), id: 'op_1', operation_key: 'refund:v2:test', provider: 'asaas', provider_payment_id: PAY,
  scope: 'SINGLE_APPOINTMENT', status: 'PENDING', requested_amount_cents: SERVICE,
  acknowledged_at: '2026-10-01T14:00:02Z',
  metadata: { appointmentIds: ['apt_1'], reason: 'auto_expired', key_version: 'v2' }, ...over
});
const db0 = (extra: Record<string, Row[]> = {}) => createDb({
  appointments: [APT()], refund_operations: [], refund_operation_events: [],
  payment_installments: [{ id: 'inst_1', provider_payment_id: PAY, group_id: null, status: 'RECEIVED' }],
  transactions: [{ id: 'tx_lp', appointment_id: 'apt_1', type: 'lesson_payment', provider_payment_id: PAY, status: 'pending' }],
  ...extra
});
const run = (db: any, gw: any, reason: string, over: Row = {}) => BookingCancellationCore.processCancellation({
  appointmentId: 'apt_1', reason, adminClient: db,
  asaasApiKey: 'k', asaasApiUrl: 'https://sandbox.test', httpFetch: gw.fn as any, ...over
} as any);
const apt = (db: any) => db.tables.appointments[0];
const refundTx = (db: any) => db.tables.transactions.find((t: Row) => t.type === 'refund');
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');
/** Frases que so' podem aparecer com estorno CONFIRMADO. */
const claimsRefundDone = (text: string) => /foi reembolsado|estorno processados|reembolso foi processado|valor estornado/i.test(text || '');

async function main() {
  console.log('\n=== FASE 2: encerramento operacional x desfecho financeiro do estorno ===\n');

  // --------------------------------------------------------------------------
  // 1. Aula expirada com reembolso CONCLUIDO
  // --------------------------------------------------------------------------
  {
    const db = db0();
    const gw = gateway(payment([split('PENDING')]), POST_DONE);
    const res = await run(db, gw, 'auto_expired');
    check(res.status === 'expired' && res.refundConfirmed === true && res.refundState === 'confirmed', '1a. concluido: aula expired, estorno confirmado');
    check(apt(db).status === 'expired' && apt(db).payment_status === 'refunded' && apt(db).cancelled_reason === 'auto_expired', '1b. expired / refunded / motivo auto_expired');
    check(db.tables.payment_installments[0].status === 'REFUNDED' && refundTx(db)?.status === 'completed', '1c. parcela REFUNDED e ledger completed');
    check(gw.posts().length === 1 && classifyCancellationResult(res) === 'refund_confirmed', '1d. um unico POST; contado como estorno confirmado');
  }

  // --------------------------------------------------------------------------
  // 2. Aula expirada com reembolso PENDENTE (estado real do incidente)
  // --------------------------------------------------------------------------
  {
    notifications.length = 0;
    const db = db0();
    const gw = gateway(payment([split('PENDING')]), POST_PENDING);
    const res = await run(db, gw, 'auto_expired');
    check(res.success === true && res.status === 'expired', '2a. pendente: a aula e\' encerrada (expired)');
    check(res.refundConfirmed === false && res.refundState === 'in_review' && res.paymentStatus === 'refund_requested', '2b. estorno NAO confirmado, em analise');
    check(apt(db).status === 'expired' && apt(db).payment_status === 'refund_requested' && apt(db).cancelled_reason === 'auto_expired', '2c. expired / refund_requested / motivo auto_expired');
    check(db.tables.refund_operations[0].status === 'PENDING', '2d. operacao de estorno segue PENDING (reconciliacao preservada)');
    check(db.tables.payment_installments[0].status === 'RECEIVED', '2e. parcela NAO vira REFUNDED sem confirmacao');
    check(refundTx(db)?.status === 'pending', '2f. ledger de estorno pendente (nunca completed)');
    check(res.message.includes(REFUND_IN_REVIEW_MESSAGE) && !claimsRefundDone(res.message), '2g. mensagem: reembolso em analise, sem afirmar conclusao');
    const student = notifications.find((n) => n.userId === 's1');
    check(!!student && String(student.message).includes(REFUND_IN_REVIEW_MESSAGE) && !claimsRefundDone(student.message), '2h. aluno avisado: reembolso em analise, acompanhar no Financeiro');
    check(classifyCancellationResult(res) === 'refund_in_review', '2i. cron NAO conta estorno pendente como concluido');
  }

  // --------------------------------------------------------------------------
  // 3. Aula expirada com reembolso NEGADO
  // --------------------------------------------------------------------------
  {
    // (a) recusa na propria chamada (HTTP 4xx)
    const db = db0();
    const gw = gateway(payment([split('PENDING')]), POST_DENIED_400);
    const res = await run(db, gw, 'auto_expired');
    const op = db.tables.refund_operations[0];
    check(res.status === 'expired' && res.refundState === 'denied' && res.refundConfirmed === false, '3a. negado no POST: aula encerrada, estorno negado');
    check(apt(db).status === 'expired' && apt(db).payment_status === 'refund_denied', '3b. expired / refund_denied (nunca refunded, nunca failed)');
    check(op.status === 'DENIED' && op.metadata.requires_manual_review === true, '3c. operacao DENIED marcada para revisao manual');
    check(refundTx(db)?.status === 'failed' && db.tables.payment_installments[0].status === 'RECEIVED', '3d. ledger de estorno failed; parcela segue RECEIVED');
    check(!claimsRefundDone(res.message) && classifyCancellationResult(res) === 'refund_denied', '3e. mensagem nao afirma estorno; contado como recusado');

    // (b) fluxo real: pendente no POST, recusa chega depois pelo webhook
    const db2 = db0();
    await run(db2, gateway(payment([split('PENDING')]), POST_PENDING), 'auto_expired');
    await BookingCancellationCore.applyRefundEvent(db2, PAY, { id: PAY, status: 'RECEIVED' }, 'DENIED', 'evt_denied', 'Falha ao processar a transferencia.');
    check(db2.tables.refund_operations[0].status === 'DENIED', '3f. webhook PAYMENT_REFUND_DENIED: operacao DENIED');
    check(apt(db2).status === 'expired' && apt(db2).payment_status === 'refund_denied', '3g. aula continua expired; financeiro vira refund_denied (nao volta a paid)');
    check(refundTx(db2)?.status === 'failed', '3h. ledger de estorno marca a recusa');

    // (c) aulas presas de producao: aula ainda aberta, operacao(oes) ja' DENIED
    const db3 = db0({ refund_operations: [
      OP({ id: 'op_a', status: 'DENIED', operation_key: 'refund:v1:{"splits":[{"id":"spl_1"}]}', created_at: '2026-10-01T10:00:03Z', acknowledged_at: null }),
      OP({ id: 'op_b', status: 'DENIED', operation_key: 'refund:v1:{"splits":[]}', created_at: '2026-10-01T10:06:00Z', acknowledged_at: null })
    ] });
    const gw3 = gateway(payment([split('REFUNDED')]), POST_DONE);
    const res3 = await run(db3, gw3, 'auto_expired');
    check(res3.status === 'expired' && apt(db3).status === 'expired' && apt(db3).payment_status === 'refund_denied', '3i. aula presa com DENIED antigo e\' encerrada na primeira execucao');
    check(gw3.posts().length === 0 && db3.tables.refund_operations.length === 2, '3j. sem POST e sem operacao nova para a aula presa');
  }

  // --------------------------------------------------------------------------
  // 4. Rejeicao do instrutor com reembolso negado
  // --------------------------------------------------------------------------
  {
    notifications.length = 0;
    const db = db0();
    const gw = gateway(payment([split('PENDING')]), { ok: true, status: 200, body: payment([], [CANCELLED]) });
    const res = await run(db, gw, 'instructor_rejected', { initiatedBy: 'i1' });
    check(res.status === 'cancelled' && res.refundState === 'denied', '4a. rejeicao + estorno negado: aula cancelled');
    check(apt(db).status === 'cancelled' && apt(db).cancelled_reason === 'instructor_rejected' && apt(db).payment_status === 'refund_denied', '4b. cancelled / instructor_rejected / refund_denied');
    const student = notifications.find((n) => n.userId === 's1');
    check(!!student && !claimsRefundDone(student.message) && String(student.message).includes(REFUND_IN_REVIEW_MESSAGE), '4c. aluno NAO recebe "valor foi reembolsado"; recebe "em analise"');
    const again = await run(db, gateway(payment([split('REFUNDED')]), POST_DONE), 'instructor_rejected');
    check(again.alreadyProcessed === true && again.refundConfirmed === false && again.refundState === 'denied', '4d. repetir a rejeicao: idempotente, ainda sem afirmar estorno');
  }

  // --------------------------------------------------------------------------
  // 5. Cancelamento pelo aluno com reembolso pendente ou negado
  // --------------------------------------------------------------------------
  {
    const dbP = db0();
    const resP = await run(dbP, gateway(payment([split('PENDING')]), POST_PENDING), 'student_cancelled', { scope: 'SINGLE_APPOINTMENT' });
    check(resP.status === 'cancelled' && apt(dbP).status === 'cancelled' && apt(dbP).cancelled_reason === 'student_cancelled'
      && apt(dbP).payment_status === 'refund_requested', '5a. aluno cancela, estorno pendente: cancelled / student_cancelled / refund_requested');
    check(resP.refundConfirmed === false && resP.message.includes(REFUND_IN_REVIEW_MESSAGE), '5b. resposta informa reembolso em analise');

    const dbD = db0();
    const resD = await run(dbD, gateway(payment([split('PENDING')]), POST_DENIED_400), 'student_cancelled', { scope: 'SINGLE_APPOINTMENT' });
    check(resD.status === 'cancelled' && apt(dbD).status === 'cancelled' && apt(dbD).cancelled_reason === 'student_cancelled'
      && apt(dbD).payment_status === 'refund_denied', '5c. aluno cancela, estorno negado: cancelled / student_cancelled / refund_denied');
    check(resD.refundConfirmed === false && !claimsRefundDone(resD.message), '5d. resposta nao afirma estorno concluido');
  }

  // --------------------------------------------------------------------------
  // 6. Cron nao repete POST apos DENIED ou CONFLICT
  // --------------------------------------------------------------------------
  {
    const db = db0();
    const first = gateway(payment([split('PENDING')]), POST_DENIED_400);
    await run(db, first, 'auto_expired');
    let posts = 0; let gatewayCalls = 0;
    for (const st of ['PENDING', 'REFUNDED', 'CANCELED', 'PENDING', 'REFUNDED']) {
      const gw = gateway(payment([split(st)]), POST_DONE);
      const r = await run(db, gw, 'auto_expired');
      posts += gw.posts().length; gatewayCalls += gw.calls.length;
      if (!r.alreadyProcessed) posts += 1000;
    }
    check(first.posts().length === 1 && posts === 0, '6a. apos DENIED: 5 ciclos do cron, 0 POST');
    check(gatewayCalls === 0, '6b. aula encerrada nao gera nem consulta (GET) ao Asaas nos ciclos seguintes');
    check(db.tables.refund_operations.length === 1 && db.tables.refund_operations[0].attempt === 1, '6c. continua 1 operacao, 1 tentativa');
    // a aula encerrada sai do seletor do Modulo B (pending_approval + paid)
    check(!(apt(db).status === 'pending_approval' && apt(db).payment_status === 'paid'), '6d. aula encerrada nao satisfaz mais o seletor do Modulo B');

    const dbC = db0({ refund_operations: [OP({ status: 'CONFLICT' })] });
    const gwC = gateway(payment([split('REFUNDED')]), POST_DONE);
    const resC = await run(dbC, gwC, 'auto_expired');
    check(gwC.posts().length === 0 && dbC.tables.refund_operations.length === 1 && dbC.tables.refund_operations[0].status === 'CONFLICT', '6e. CONFLICT: nenhum POST, nenhuma operacao nova');
    check(apt(dbC).status === 'expired' && apt(dbC).payment_status === 'refund_requested' && resC.refundConfirmed === false, '6f. CONFLICT: aula encerrada, estorno em analise (nunca refunded)');
    const gwC2 = gateway(payment([split('REFUNDED')]), POST_DONE);
    await run(dbC, gwC2, 'auto_expired');
    check(gwC2.calls.length === 0, '6g. CONFLICT: ciclos seguintes nao tocam o gateway');

    const cronSrc = src('supabase/functions/check-expired-bookings/index.ts');
    check(cronSrc.includes("refund_confirmed: moduleBRefundConfirmed") && cronSrc.includes('classifyCancellationResult(res)'), '6h. cron separa aula encerrada de estorno confirmado na contagem');
    check(cronSrc.includes(".eq('status', 'pending_approval')") && cronSrc.includes(".eq('payment_status', 'paid')"), '6i. seletor do Modulo B continua restrito a pending_approval + paid');
  }

  // --------------------------------------------------------------------------
  // 7. Sincronizador nao reabre aula encerrada
  // --------------------------------------------------------------------------
  {
    // reconciliacao (usada pelo sync-payment-status) sobre aula ja' encerrada
    const db = db0({
      appointments: [APT({ status: 'expired', payment_status: 'refund_requested', cancelled_reason: 'auto_expired' })],
      refund_operations: [OP({ updated_at: '2026-10-01T10:00:00Z' })]
    });
    const gwDenied = gateway(payment([], [CANCELLED]));
    await BookingCancellationCore.reconcileRefundOperation(db, db.tables.refund_operations[0] as any, { httpFetch: gwDenied.fn as any, asaasApiUrl: 'https://sandbox.test', asaasApiKey: 'k' });
    check(db.tables.refund_operations[0].status === 'DENIED', '7a. reconciliacao aplica a recusa na operacao');
    check(apt(db).status === 'expired' && apt(db).payment_status === 'refund_denied', '7b. aula continua expired; financeiro refund_denied (nao volta a paid/failed)');
    check(gwDenied.posts().length === 0, '7c. reconciliacao nunca emite POST');

    const db2 = db0({
      appointments: [APT({ status: 'cancelled', payment_status: 'refund_requested', cancelled_reason: 'student_cancelled' })],
      refund_operations: [OP({ updated_at: new Date().toISOString(), metadata: { appointmentIds: ['apt_1'], reason: 'student_cancelled' } })]
    });
    await BookingCancellationCore.reconcileRefundOperation(db2, db2.tables.refund_operations[0] as any, { httpFetch: gateway(payment([], [])).fn as any, asaasApiUrl: 'https://sandbox.test', asaasApiKey: 'k' });
    check(apt(db2).status === 'cancelled' && apt(db2).payment_status === 'refund_requested' && db2.tables.refund_operations[0].status === 'PENDING',
      '7d. sem evidencia no gateway (operacao recente): nada muda');

    const syncSrc = src('supabase/functions/sync-payment-status/index.ts');
    check(syncSrc.includes("and(status.in.(cancelled,expired),payment_status.in.(paid,refund_requested))"), '7e. seletor do sync nao inclui aulas refund_denied nem refunded');
    check(!/payment_status:\s*'failed'/.test(syncSrc), '7f. sync nao grava mais payment_status failed em recusa de estorno');
    check(syncSrc.includes("payment_status: isClosed ? 'refund_denied' : 'paid'") && syncSrc.includes(".eq('payment_status', 'refund_requested')"), '7g. recusa no sync: aula encerrada -> refund_denied, com CAS');
    const reopenWrites = syncSrc.split("status: 'pending_approval',").length - 1;
    const guardedWrites = syncSrc.split(".in('status', ['reserved', 'pending_approval', 'awaiting_payment'])").length - 1;
    check(reopenWrites === 1 && guardedWrites >= 2, '7h. unica escrita de pending_approval no sync tem CAS em status aberto (nao reabre aula encerrada)');
  }

  // --------------------------------------------------------------------------
  // 8. Confirmacao tardia atualiza APENAS o estado financeiro
  // --------------------------------------------------------------------------
  {
    notifications.length = 0;
    const db = db0();
    await run(db, gateway(payment([split('PENDING')]), POST_PENDING), 'auto_expired');
    const closedAt = apt(db).status;
    notifications.length = 0;
    await BookingCancellationCore.applyRefundEvent(db, PAY, payment([], [DONE]), 'COMPLETED', 'evt_refunded', null);
    const op = db.tables.refund_operations[0];
    check(op.status === 'COMPLETED' && !!op.acknowledged_at, '8a. webhook de estorno concluido: operacao COMPLETED confirmada');
    check(closedAt === 'expired' && apt(db).status === 'expired' && apt(db).cancelled_reason === 'auto_expired', '8b. aula continua expired, mesmo motivo (nao e\' reaberta nem reescrita)');
    check(apt(db).payment_status === 'refunded', '8c. estado financeiro passa a refunded');
    check(db.tables.payment_installments[0].status === 'REFUNDED' && refundTx(db)?.status === 'completed', '8d. parcela REFUNDED e ledger completed so\' agora');
    check(notifications.length === 0, '8e. nenhuma notificacao de expiracao duplicada');

    // estorno aparece no gateway DEPOIS de uma recusa: conflito -> em analise
    const db2 = db0();
    await run(db2, gateway(payment([split('PENDING')]), POST_DENIED_400), 'auto_expired');
    await BookingCancellationCore.applyRefundEvent(db2, PAY, payment([], [DONE]), 'COMPLETED', 'evt_late', null);
    check(db2.tables.refund_operations[0].status === 'CONFLICT', '8f. estorno apos recusa: operacao CONFLICT (revisao), nunca COMPLETED automatico');
    check(apt(db2).status === 'expired' && apt(db2).payment_status === 'refund_requested', '8g. aula continua expired; financeiro volta a "em analise" (nao afirma negado nem concluido)');

    // nova tentativa EXPLICITA do estorno de uma aula ja' encerrada
    const db3 = db0();
    await run(db3, gateway(payment([split('PENDING')]), POST_DENIED_400), 'auto_expired');
    const gwAuto = gateway(payment([split('REFUNDED')], []), POST_DONE);
    await run(db3, gwAuto, 'auto_expired');
    const gwRetry = gateway(payment([split('REFUNDED')], []), POST_DONE);
    const resRetry = await run(db3, gwRetry, 'auto_expired', { explicitRetry: true });
    check(gwAuto.posts().length === 0 && gwRetry.posts().length === 1, '8h. so\' a tentativa explicita emite POST (uma vez)');
    check(apt(db3).status === 'expired' && apt(db3).payment_status === 'refunded' && resRetry.refundConfirmed === true && resRetry.status === 'expired',
      '8i. tentativa explicita confirmada: aula segue expired, financeiro refunded');
    check(db3.tables.refund_operations.length === 1 && db3.tables.refund_operations[0].attempt === 2, '8j. mesma operacao reaproveitada');
  }

  // --------------------------------------------------------------------------
  // 9. Mensagens nao afirmam conclusao sem confirmacao
  // --------------------------------------------------------------------------
  {
    for (const [label, post] of [['pendente', POST_PENDING], ['negado', POST_DENIED_400]] as Array<[string, any]>) {
      for (const reason of ['auto_expired', 'instructor_rejected', 'student_cancelled']) {
        notifications.length = 0;
        const db = db0();
        const res = await run(db, gateway(payment([split('PENDING')]), post), reason);
        const texts = [res.message, ...notifications.map((n) => String(n.message))];
        check(res.refundConfirmed === false && texts.every((t) => !claimsRefundDone(t)), `9. ${reason} + estorno ${label}: nenhuma mensagem afirma estorno concluido`);
      }
    }
    notifications.length = 0;
    const dbOk = db0();
    const ok = await run(dbOk, gateway(payment([split('PENDING')]), POST_DONE), 'instructor_rejected');
    check(ok.refundConfirmed === true && claimsRefundDone(ok.message) && claimsRefundDone(String(notifications.find((n) => n.userId === 's1')?.message)),
      '9g. com confirmacao do gateway as mensagens de estorno concluido continuam valendo');

    const approveSrc = src('supabase/functions/approve-booking/index.ts');
    check(approveSrc.includes('expirationResult?.refundConfirmed === true') && !approveSrc.includes("expirationResult?.status === 'expired' ||"),
      '9h. approve-booking decide "reembolso processado" por refundConfirmed, nao pelo status da aula');
    for (const fn of ['reject-booking', 'cancel-booking']) {
      const s = src(`supabase/functions/${fn}/index.ts`);
      check(s.includes('refund_confirmed: result.refundConfirmed') && s.includes('message: result.message') && !s.includes("=== 'pending_refund'"),
        `9i. ${fn} devolve o estado real do estorno e a mensagem do Core`);
    }
    const agendaSrc = src('pages/InstructorAgenda.tsx');
    check(agendaSrc.includes("data?.refund_state === 'in_review' || data?.refund_state === 'denied'"), '9j. agenda do instrutor so\' diz "valor estornado" com estorno confirmado');
  }

  // --------------------------------------------------------------------------
  // 10. Aula encerrada nao volta a aparecer em Minhas Aulas; Financeiro distingue
  // --------------------------------------------------------------------------
  {
    check(isHiddenFromStudentAgenda('expired', 'auto_expired') === true, '10a. aula expired fica fora da agenda ativa');
    check(isHiddenFromStudentAgenda('pending_approval', null) === false && isHiddenFromStudentAgenda('confirmed', null) === false, '10b. aulas ativas continuam visiveis');
    check(isHiddenFromStudentAgenda('cancelled', 'system_cleanup_expired') === true && isHiddenFromStudentAgenda('cancelled', 'user_retry_new_attempt') === true,
      '10c. cancelamentos tecnicos continuam ocultos');
    const lessonsSrc = src('pages/student/Lessons.tsx');
    check(lessonsSrc.includes(".neq('status', 'cancelled')") && lessonsSrc.includes('isHiddenFromStudentAgenda(apt.status, apt.cancelled_reason)'),
      '10d. Minhas Aulas: consulta exclui cancelled e a lista usa a regra de aula encerrada');

    // ponta a ponta: apos cada desfecho do estorno a aula encerrada segue oculta
    for (const post of [POST_DONE, POST_PENDING, POST_DENIED_400]) {
      const db = db0();
      await run(db, gateway(payment([split('PENDING')]), post), 'auto_expired');
      await BookingCancellationCore.applyRefundEvent(db, PAY, { id: PAY, status: 'RECEIVED' }, 'DENIED', 'evt_x', 'recusado');
      check(isHiddenFromStudentAgenda(apt(db).status, apt(db).cancelled_reason), `10e. expirada (${apt(db).payment_status}) nao reaparece em Minhas Aulas`);
    }
    const dbCancel = db0();
    await run(dbCancel, gateway(payment([split('PENDING')]), POST_DENIED_400), 'student_cancelled');
    check(apt(dbCancel).status === 'cancelled', '10f. cancelada pelo aluno fica cancelled (excluida na consulta) mesmo com estorno negado');

    const base = { id: 'h1', status: 'completed', isFinancial: true, instructorName: 'Instrutor', grossAmountCents: 10199, totalInstallments: 1, receivedInstallments: 1 };
    const vmPending = StudentHistoryAdapter.toViewModel({ ...base, refundStatus: 'pending' });
    const vmDenied = StudentHistoryAdapter.toViewModel({ ...base, refundStatus: 'denied' });
    const vmDone = StudentHistoryAdapter.toViewModel({ ...base, status: 'refunded', refundStatus: 'completed' });
    const vmNone = StudentHistoryAdapter.toViewModel({ ...base });
    check(vmPending.status.badge?.label === 'Reembolso em análise' && vmPending.header.title !== 'Reembolso recebido' && !vmPending.amount.isRefund,
      '10g. Financeiro: reembolso pendente = "Reembolso em análise", sem "Reembolso recebido"');
    check(vmDenied.status.badge?.label === 'Reembolso negado' && vmDenied.header.title !== 'Reembolso recebido' && !vmDenied.amount.isRefund,
      '10h. Financeiro: reembolso negado = "Reembolso negado", sem "Reembolso recebido"');
    check(vmDone.status.badge?.label === 'Reembolsado' && vmDone.header.title === 'Reembolso recebido', '10i. Financeiro: reembolso concluido = "Reembolsado"');
    check(vmNone.status.badge?.label === 'Concluído', '10j. Financeiro: compra sem reembolso inalterada');
    const svcSrc = src('lib/payments/services/StudentFinanceReadService.ts');
    check(svcSrc.includes("paymentStatuses.includes('refund_denied')") && svcSrc.includes("every(ps => ps === 'refunded')"), '10k. servico de leitura deriva o estado do reembolso de payment_status');
  }

  // --------------------------------------------------------------------------
  // M. Migration do novo estado financeiro
  // --------------------------------------------------------------------------
  {
    const mig = src('supabase/migrations/20261001_refund_denied_payment_status.sql');
    const prev = src('supabase/migrations/20260811_add_refund_requested_to_appointments_payment_status_check.sql');
    // Leitura ESTATICA: a migration nao foi executada em nenhum banco.
    const strip = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const literals = (chunk: string | undefined) => (chunk?.match(/'([a-z_]+)'/g) || []).map((v) => v.replace(/'/g, ''));
    const executable = strip(mig);
    // lista anterior: CHECK (payment_status IN (...)); lista nova: v_allowed := ARRAY[...]
    const before = literals(strip(prev).match(/payment_status IN \(([\s\S]*?)\)/)?.[1]);
    const after = literals(executable.match(/v_allowed\s+CONSTANT text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/)?.[1]);
    check(before.length === 7 && before.every((v) => after.includes(v)), 'M1. migration preserva os 7 valores existentes do CHECK');
    check(after.length === 8 && after.includes('refund_denied'), 'M2. migration acrescenta somente refund_denied');
    check(!/\b(UPDATE|DELETE|INSERT)\b/i.test(executable), 'M3. migration nao altera nenhuma linha');
    check(executable.includes('FROM pg_constraint c') && executable.includes('v_attnum = ANY (c.conkey)')
      && executable.includes('DROP CONSTRAINT %I') && !/DROP CONSTRAINT IF EXISTS/.test(executable),
      'M4. migration localiza o CHECK pela coluna (qualquer nome), nao por um nome fixo');
    check((executable.match(/RAISE EXCEPTION/g) || []).length >= 5 && /BEGIN;[\s\S]*COMMIT;/.test(executable),
      'M5. migration e\' transacional e aborta diante de valor extra, valor em uso fora da lista ou CHECK composto');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
