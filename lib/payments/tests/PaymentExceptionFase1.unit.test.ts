/**
 * FASE 1 — pagamento recebido sem reserva valida (payment_exceptions).
 *
 * TIPO DE TESTE
 *   - Secoes 1 a 11 e 13: unitarios, com banco EM MEMORIA (mock). O mock
 *     reproduz a restricao UNIQUE (exception_type, provider_payment_id) e o
 *     ON CONFLICT DO NOTHING. Isso valida a LOGICA do servico; NAO valida a
 *     restricao no PostgreSQL real (a migration nao foi aplicada).
 *   - Secao 12: verificacoes sobre o CODIGO-FONTE do webhook, da conciliacao e
 *     da migration (o handler do webhook nao e' executado aqui).
 *
 * Uso: npx tsx lib/payments/tests/PaymentExceptionFase1.unit.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PaymentExceptionService, PaymentExceptionPersistenceError, PAYMENT_WITHOUT_VALID_BOOKING,
  classifyProviderPaymentStatus, evaluateBooking, candidateFromAsaasPayload,
} from '../PaymentExceptionService.js';

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failures.push(label); console.error(`  ❌ ${label}`); }
};

type Row = Record<string, any>;
const NOW = '2026-10-02T20:00:00.000Z';
const SINCE = '2026-09-30T00:00:00.000Z';
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const A = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

// ============================================================================
// Banco em memoria
// ============================================================================
function createDb(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    payment_exceptions: [], transactions: [], payment_installments: [], appointments: [],
    ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, (v || []).map((r) => ({ ...r }))])),
  };
  const writes: Array<{ table: string; op: string }> = [];
  const failNext: Record<string, number> = {};
  let seq = 0;

  function from(table: string) {
    let op = 'select'; let payload: any = null; let returning = false; let lim = Infinity; let single = false;
    let conflictCols: string[] = []; let ignoreDup = false;
    let orderCol: string | null = null; let orderAsc = true;
    const filters: Array<(r: Row) => boolean> = [];
    // Coluna simples ou caminho JSON `coluna->>chave` (como o PostgREST).
    const get = (r: Row, c: string) => {
      const [col, key] = c.split('->>');
      if (key === undefined) return r[col];
      const v = r[col];
      return v && typeof v === 'object' && v[key] !== undefined && v[key] !== null ? String(v[key]) : null;
    };
    const api: any = {
      select() { if (op !== 'select') returning = true; return api; },
      update(p: any) { op = 'update'; payload = p; return api; },
      upsert(p: any, o: any) { op = 'upsert'; payload = p; conflictCols = String(o?.onConflict || '').split(','); ignoreDup = !!o?.ignoreDuplicates; return api; },
      insert(p: any) { op = 'insert'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: any) { filters.push((r) => get(r, c) === v); return api; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(get(r, c))); return api; },
      gte(c: string, v: any) { filters.push((r) => get(r, c) >= v); return api; },
      order(c: string, o?: any) { orderCol = c; orderAsc = o?.ascending !== false; return api; },
      limit(n: number) { lim = n; return api; },
      maybeSingle() { single = true; return api; },
      then(res: any, rej: any) { return exec().then(res, rej); },
    };
    async function exec(): Promise<any> {
      await Promise.resolve(); // cede o event loop: corridas ficam observaveis
      const failKey = `${table}:${op}`;
      if ((failNext[failKey] || 0) > 0) { failNext[failKey]--; return { data: null, error: { message: `simulated ${failKey} failure` } }; }
      if (op === 'select') {
        let rows = tables[table].filter((r) => filters.every((f) => f(r)));
        if (orderCol) rows = [...rows].sort((a, b) => String(get(a, orderCol!)).localeCompare(String(get(b, orderCol!))) * (orderAsc ? 1 : -1));
        rows = rows.slice(0, lim).map((r) => JSON.parse(JSON.stringify(r)));
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      }
      writes.push({ table, op });
      if (op === 'upsert' || op === 'insert') {
        // Verificacao + insercao no MESMO passo sincrono = restricao UNIQUE do banco.
        const dup = tables[table].find((r) => conflictCols.length > 0 && conflictCols.every((c) => r[c] === payload[c]));
        if (dup) {
          if (ignoreDup) return { data: returning ? [] : null, error: null };
          return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        const row = { id: `exc-${++seq}`, created_at: NOW, updated_at: NOW, ...JSON.parse(JSON.stringify(payload)) };
        tables[table].push(row);
        return { data: returning ? [JSON.parse(JSON.stringify(row))] : null, error: null };
      }
      const rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (op === 'update') for (const r of rows) Object.assign(r, JSON.parse(JSON.stringify(payload)));
      if (op === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r));
      return { data: returning ? rows.map((r) => ({ id: r.id })) : null, error: null };
    }
    return api;
  }
  return { from, tables, writes, failNext } as any;
}

const payload = (event: string, id: string, over: Row = {}, eventId = `evt_${event}_${id}`) => ({
  id: eventId, event,
  payment: { id, status: event === 'PAYMENT_RECEIVED' ? 'RECEIVED' : 'CONFIRMED', value: 120, netValue: 117.61, billingType: 'PIX',
    externalReference: G1, paymentDate: '2026-10-02', ...over },
});
const lesson = (n: number, status: string, payment_status: string | null, group = G1, pay: string | null = null): Row =>
  ({ id: A(n), group_id: group, status, payment_status, student_id: A(900), instructor_id: A(901), provider_payment_id: pay });
const ledgerRow = (p: Row, created = '2026-10-02T19:00:00.000Z'): Row =>
  ({ id: `led-${p.id}`, type: 'webhook_event', provider: 'asaas', provider_payment_id: p.payment.id, provider_event_id: p.id, raw_payload: p, created_at: created });
const exceptions = (db: any) => db.tables.payment_exceptions as Row[];
const webhook = (db: any, p: Row, groupId: string | null, lessons: Row[]) =>
  PaymentExceptionService.recordFromWebhook(db, { payload: p, groupId, lessons, providerEventId: p.id });
const scan = (db: any) => PaymentExceptionService.scanFromDatabase(db, { sinceIso: SINCE, nowIso: NOW });

async function main() {
  console.log('=== FASE 1 — pagamento sem reserva valida ===\n');

  // --------------------------------------------------------------------------
  // 1. Pagamento recebido para reserva invalida gera uma ocorrencia
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    const lessons = [lesson(1, 'expired', 'released')];
    const r = await webhook(db, payload('PAYMENT_RECEIVED', 'pay_1'), G1, lessons);
    const e = exceptions(db)[0];
    check(r.outcome === 'created' && exceptions(db).length === 1, '1a. reserva expirada + pagamento recebido: exatamente 1 ocorrencia');
    check(e.exception_type === PAYMENT_WITHOUT_VALID_BOOKING && e.provider_payment_id === 'pay_1' && e.status === 'open'
      && e.detected_by === 'webhook' && e.booking_state === 'expired', '1b. tipo, pagamento, estado open, origem webhook e estado da reserva gravados');
    check(e.amount_cents === 12000 && e.net_amount_cents === 11761 && e.currency === 'BRL' && e.group_id === G1
      && e.appointment_ids.length === 1 && e.appointment_ids[0] === A(1) && e.source_event_id === 'evt_PAYMENT_RECEIVED_pay_1',
      '1c. valores em centavos, moeda, grupo, aulas e evento de origem gravados');
    check(e.provider_payment_status === 'RECEIVED' && e.provider_payment_phase === 'received' && !!e.received_at, '1d. estado original RECEIVED, fase received, data de recebimento preenchida');
    for (const st of ['cancelled', 'rejected']) {
      const d = createDb();
      await webhook(d, payload('PAYMENT_RECEIVED', 'pay_x'), G1, [lesson(1, st, 'released')]);
      check(exceptions(d).length === 1 && exceptions(d)[0].booking_state === st, `1e. reserva ${st}: 1 ocorrencia com o estado correspondente`);
    }
  }

  // --------------------------------------------------------------------------
  // 2. Autorizado (CONFIRMED) nao e' confundido com liquidado
  // --------------------------------------------------------------------------
  {
    check(classifyProviderPaymentStatus('RECEIVED').phase === 'received' && classifyProviderPaymentStatus('received_in_cash').phase === 'received'
      && classifyProviderPaymentStatus('CONFIRMED').phase === 'authorized' && classifyProviderPaymentStatus('PENDING').phase === 'other'
      && classifyProviderPaymentStatus(undefined).phase === 'other', '2a. RECEIVED/RECEIVED_IN_CASH = recebido; CONFIRMED = autorizado; demais = other');
    const db = createDb();
    await webhook(db, payload('PAYMENT_CONFIRMED', 'pay_2', { billingType: 'CREDIT_CARD' }), G1, [lesson(1, 'expired', 'released')]);
    const e = exceptions(db)[0];
    check(e.provider_payment_status === 'CONFIRMED' && e.provider_payment_phase === 'authorized' && e.received_at === null,
      '2b. CONFIRMED: estado original preservado, fase authorized, SEM data de recebimento');
    const r = await webhook(db, payload('PAYMENT_RECEIVED', 'pay_2', { billingType: 'CREDIT_CARD' }), G1, [lesson(1, 'expired', 'released')]);
    check(r.outcome === 'advanced' && exceptions(db).length === 1 && e.provider_payment_phase === 'received' && e.provider_payment_status === 'RECEIVED' && !!e.received_at,
      '2c. liquidacao posterior: a MESMA ocorrencia avanca para received');
    check(candidateFromAsaasPayload(payload('PAYMENT_UPDATED', 'pay_u', { status: 'PENDING' })) === null
      && candidateFromAsaasPayload(payload('PAYMENT_OVERDUE', 'pay_o')) === null, '2d. evento sem pagamento (UPDATED pendente, OVERDUE) nao e\' ocorrencia');
  }

  // --------------------------------------------------------------------------
  // 3. Evento repetido nao duplica
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    const p = payload('PAYMENT_RECEIVED', 'pay_3');
    await webhook(db, p, G1, [lesson(1, 'expired', 'released')]);
    const first = JSON.stringify(exceptions(db)[0]);
    const r2 = await webhook(db, p, G1, [lesson(1, 'expired', 'released')]);
    const r3 = await webhook(db, payload('PAYMENT_UPDATED', 'pay_3', { status: 'RECEIVED' }), G1, [lesson(1, 'expired', 'released')]);
    check(r2.outcome === 'unchanged' && r3.outcome === 'unchanged' && exceptions(db).length === 1 && JSON.stringify(exceptions(db)[0]) === first,
      '3a. mesmo evento e outro evento do mesmo pagamento: 1 ocorrencia, sem alteracao');
  }

  // --------------------------------------------------------------------------
  // 4. Webhook e conciliacao convergem para a mesma ocorrencia
  // --------------------------------------------------------------------------
  {
    const p = payload('PAYMENT_RECEIVED', 'pay_4');
    // webhook primeiro, conciliacao depois
    const db = createDb({ transactions: [ledgerRow(p)], appointments: [lesson(1, 'expired', 'released')] });
    await webhook(db, p, G1, db.tables.appointments);
    const s = await scan(db);
    check(exceptions(db).length === 1 && exceptions(db)[0].detected_by === 'webhook' && s.created === 0 && s.skippedExisting === 1,
      '4a. webhook registrou; a conciliacao encontra a mesma ocorrencia e nao escreve');
    // conciliacao primeiro (webhook nao registrou), webhook reenviado depois
    const db2 = createDb({ transactions: [ledgerRow(p)], appointments: [lesson(1, 'expired', 'released')] });
    const s2 = await scan(db2);
    const r = await webhook(db2, p, G1, db2.tables.appointments);
    check(s2.created === 1 && exceptions(db2).length === 1 && exceptions(db2)[0].detected_by === 'reconciliation' && r.outcome === 'unchanged',
      '4b. conciliacao registrou; o webhook posterior converge para a mesma ocorrencia');
    const s3 = await scan(db2);
    check(s3.created === 0 && exceptions(db2).length === 1, '4c. conciliacao recorrente: nenhuma nova ocorrencia');
  }

  // --------------------------------------------------------------------------
  // 5. Pagamentos distintos do mesmo grupo geram ocorrencias individuais
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    const lessons = [lesson(1, 'expired', 'released'), lesson(2, 'expired', 'released')];
    await webhook(db, payload('PAYMENT_CONFIRMED', 'pay_5a', { installmentNumber: 1 }), G1, lessons);
    await webhook(db, payload('PAYMENT_CONFIRMED', 'pay_5b', { installmentNumber: 2 }), G1, lessons);
    check(exceptions(db).length === 2 && exceptions(db).every((e) => e.group_id === G1)
      && exceptions(db).map((e) => e.installment_number).join(',') === '1,2', '5a. duas parcelas do mesmo grupo: duas ocorrencias, uma por pagamento');
  }

  // --------------------------------------------------------------------------
  // 6. Evento atrasado nao regride o estado financeiro
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    const l = [lesson(1, 'expired', 'released')];
    await webhook(db, payload('PAYMENT_RECEIVED', 'pay_6'), G1, l);
    const receivedAt = exceptions(db)[0].received_at;
    const r = await webhook(db, payload('PAYMENT_CONFIRMED', 'pay_6'), G1, l);
    const e = exceptions(db)[0];
    check(r.outcome === 'unchanged' && e.provider_payment_phase === 'received' && e.provider_payment_status === 'RECEIVED' && e.received_at === receivedAt,
      '6a. CONFIRMED atrasado depois de RECEIVED: ocorrencia continua received');
  }

  // --------------------------------------------------------------------------
  // 7. Ocorrencia resolvida nao e' reaberta
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    const l = [lesson(1, 'expired', 'released')];
    await webhook(db, payload('PAYMENT_CONFIRMED', 'pay_7'), G1, l);
    Object.assign(exceptions(db)[0], { status: 'resolved', resolution: 'manual_review', resolution_notes: 'ok', resolved_by: A(999), resolved_at: NOW });
    const r1 = await webhook(db, payload('PAYMENT_CONFIRMED', 'pay_7'), G1, l);
    const r2 = await webhook(db, payload('PAYMENT_RECEIVED', 'pay_7'), G1, l);
    const e = exceptions(db)[0];
    check(r1.outcome === 'unchanged' && e.status === 'resolved' && e.resolution === 'manual_review' && e.resolved_by === A(999) && e.resolved_at === NOW && exceptions(db).length === 1,
      '7a. evento posterior: continua resolved, campos de resolucao intactos, sem nova linha');
    check(r2.outcome === 'advanced' && r2.status === 'resolved' && e.provider_payment_phase === 'received',
      '7b. liquidacao posterior atualiza so\' os fatos do pagamento; o estado resolved permanece');
  }

  // --------------------------------------------------------------------------
  // 8. Falha de persistencia nao pode virar "processado"
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    db.failNext['payment_exceptions:upsert'] = 1;
    let thrown: any = null;
    try { await webhook(db, payload('PAYMENT_RECEIVED', 'pay_8'), G1, [lesson(1, 'expired', 'released')]); } catch (e) { thrown = e; }
    check(thrown instanceof PaymentExceptionPersistenceError && exceptions(db).length === 0, '8a. falha no insert: o servico LANCA erro (nao devolve sucesso)');
    const r = await webhook(db, payload('PAYMENT_RECEIVED', 'pay_8'), G1, [lesson(1, 'expired', 'released')]);
    check(r.outcome === 'created' && exceptions(db).length === 1, '8b. reprocessamento do mesmo evento grava exatamente 1 ocorrencia');

    const db2 = createDb();
    await webhook(db2, payload('PAYMENT_CONFIRMED', 'pay_8b'), G1, [lesson(1, 'expired', 'released')]);
    db2.failNext['payment_exceptions:select'] = 1;
    let thrown2: any = null;
    try { await webhook(db2, payload('PAYMENT_RECEIVED', 'pay_8b'), G1, [lesson(1, 'expired', 'released')]); } catch (e) { thrown2 = e; }
    check(thrown2 instanceof PaymentExceptionPersistenceError, '8c. falha ao ler a ocorrencia existente tambem lanca erro');
  }

  // --------------------------------------------------------------------------
  // 9. Ausencia de grupo ou de aula nao impede o registro
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    await webhook(db, payload('PAYMENT_RECEIVED', 'pay_9a', { externalReference: undefined }), null, []);
    await webhook(db, payload('PAYMENT_RECEIVED', 'pay_9b'), G1, []);
    const [a, b] = exceptions(db);
    check(exceptions(db).length === 2 && a.booking_state === 'no_group' && a.group_id === null && a.appointment_ids.length === 0 && a.student_id === null,
      '9a. sem grupo: registra com booking_state=no_group e vinculos vazios');
    check(b.booking_state === 'not_found' && b.group_id === G1 && b.appointment_ids.length === 0, '9b. grupo sem aulas: registra com booking_state=not_found');
    check(evaluateBooking(null, []).shouldRecord && evaluateBooking(G1, null).bookingState === 'not_found', '9c. regra pura: sem aulas sempre registra');
  }

  // --------------------------------------------------------------------------
  // 10 e 11. A conciliacao so' le o banco: nao altera aulas, nao estorna, nao
  //          chama o provedor
  // --------------------------------------------------------------------------
  {
    const pA = payload('PAYMENT_RECEIVED', 'pay_10a');                                   // orfao (grupo expirado, nao pago)
    const pB = payload('PAYMENT_RECEIVED', 'pay_10b', { externalReference: G2 });        // valido
    const pTip = payload('PAYMENT_RECEIVED', 'pay_tip', { externalReference: `tip:${A(1)}:tx1` });
    const db = createDb({
      transactions: [ledgerRow(pA), ledgerRow(pB), ledgerRow(pTip),
        { id: 'tx-other', type: 'lesson_payment', provider: 'asaas', provider_payment_id: 'pay_zzz', raw_payload: null, created_at: NOW }],
      payment_installments: [
        { provider_payment_id: 'pay_10c', installment_number: 1, group_id: null, gross_amount: 9000, net_amount: 8800, status: 'RECEIVED', payment_date: '2026-10-02T12:00:00Z', updated_at: '2026-10-02T12:00:00Z' },
        { provider_payment_id: 'pay_10d', installment_number: 1, group_id: G1, gross_amount: 5000, net_amount: 4900, status: 'CANCELLED', payment_date: null, updated_at: '2026-10-02T12:00:00Z' },
      ],
      appointments: [lesson(1, 'expired', 'released'), lesson(2, 'confirmed', 'paid', G2), lesson(3, 'cancelled', 'released', null as any, 'pay_10c')],
    });
    const before = JSON.stringify(db.tables.appointments) + JSON.stringify(db.tables.transactions) + JSON.stringify(db.tables.payment_installments);
    const origFetch = (globalThis as any).fetch;
    let fetchCalls = 0;
    (globalThis as any).fetch = async () => { fetchCalls++; throw new Error('chamada externa proibida'); };
    let s: any;
    try { s = await scan(db); } finally { (globalThis as any).fetch = origFetch; }

    const ids = exceptions(db).map((e) => e.provider_payment_id).sort().join(',');
    check(ids === 'pay_10a,pay_10c' && s.created === 2 && s.skippedValid === 1, '10a. registra o orfao do ledger e o da parcela; ignora o pagamento de reserva valida, a caixinha e a parcela CANCELLED');
    check(exceptions(db).every((e) => e.detected_by === 'reconciliation' && e.status === 'open'), '10b. ocorrencias da conciliacao: origem reconciliation, estado open');
    const c = exceptions(db).find((e) => e.provider_payment_id === 'pay_10c')!;
    check(c.booking_state === 'cancelled' && c.appointment_ids[0] === A(3) && c.amount_cents === 9000, '10c. sem grupo: a aula e\' localizada pelo pagamento e os valores vem da parcela');
    check(before === JSON.stringify(db.tables.appointments) + JSON.stringify(db.tables.transactions) + JSON.stringify(db.tables.payment_installments),
      '10d. aulas, ledger e parcelas ficam IDENTICOS depois da varredura');
    check(db.writes.every((w: Row) => w.table === 'payment_exceptions') && db.writes.every((w: Row) => w.op !== 'delete'),
      '10e. a unica tabela escrita e\' payment_exceptions; nenhum delete');
    check(fetchCalls === 0, '11a. nenhuma chamada de rede durante a varredura (fetch nunca chamado)');
    const svc = readFileSync(resolve(process.cwd(), 'lib/payments/PaymentExceptionService.ts'), 'utf-8');
    check(!/\bfetch\s*\(/.test(svc) && !/asaas\.com|httpFetch|asaasFetch|refund\s*\(/i.test(svc), '11b. o servico nao contem chamada HTTP nem de estorno');

    db.failNext['transactions:select'] = 1;
    let thrown: any = null;
    try { await scan(db); } catch (e) { thrown = e; }
    check(thrown instanceof PaymentExceptionPersistenceError, '10f. falha de leitura na varredura lanca erro (nao e\' tratada como "nada a fazer")');
  }

  // --------------------------------------------------------------------------
  // 12. Reserva valida e reserva paga-e-encerrada NAO geram ocorrencia
  // --------------------------------------------------------------------------
  {
    const db = createDb();
    const r1 = await webhook(db, payload('PAYMENT_RECEIVED', 'pay_12a'), G1, [lesson(1, 'awaiting_payment', 'pending')]);
    const r2 = await webhook(db, payload('PAYMENT_RECEIVED', 'pay_12b'), G1, [lesson(1, 'confirmed', 'paid'), lesson(2, 'pending_approval', 'paid')]);
    check(r1.outcome === 'not_applicable' && r2.outcome === 'not_applicable' && exceptions(db).length === 0 && db.writes.length === 0,
      '12a. reserva ativa: nenhuma ocorrencia e nenhuma escrita');
    for (const ps of ['paid', 'refund_requested', 'refund_denied', 'refunded']) {
      const r = await webhook(db, payload('PAYMENT_RECEIVED', `pay_12_${ps}`), G1, [lesson(1, 'expired', ps)]);
      check(r.outcome === 'not_applicable' && r.bookingState === 'payment_acknowledged', `12b. reserva encerrada com payment_status=${ps}: nao e\' pagamento orfao`);
    }
    check(exceptions(db).length === 0, '12c. nenhum registro nos casos acima');
    check(evaluateBooking(G1, [lesson(1, 'expired', 'released'), lesson(2, 'awaiting_payment', 'pending')]).bookingState === 'partially_invalid',
      '12d. grupo com parte das aulas invalida e sem pagamento reconhecido: registra como partially_invalid');

    const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');
    const wh = src('api/asaas-webhook.ts');
    const calls = wh.split('PaymentExceptionService.recordFromWebhook(').length - 1;
    check(calls === 3, '12e. [fonte] o webhook chama o servico nas tres saidas de pagamento sem reserva');
    const branch = wh.slice(wh.indexOf("['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_UPDATED'].includes"), wh.indexOf("status: 'pending_approval'"));
    const parts = branch.split('PaymentExceptionService.recordFromWebhook(').slice(1);
    check(parts.length === 3 && parts.every((p) => p.indexOf("finalizeLedger('PROCESSED')") > 0 && p.slice(0, p.indexOf("finalizeLedger('PROCESSED')")).indexOf('catch') < 0),
      '12f. [fonte] em cada saida o registro vem ANTES de finalizeLedger(PROCESSED) e nao esta\' envolto em catch');
    check(/catch \(error: any\) \{[\s\S]*processing_status: 'FAILED'[\s\S]*res\.status\(500\)/.test(wh.slice(wh.lastIndexOf('} catch (error: any) {'))),
      '12g. [fonte] erro nao tratado no handler grava o evento como FAILED e responde HTTP 500');
    check(/existingLedger\.processing_status === 'PROCESSED'/.test(wh) && /processing_status: 'PENDING',\s*\n\s*\.\.\.\(paymentId/.test(wh),
      '12h. [fonte] so\' evento PROCESSED e\' encerrado por idempotencia; FAILED/PENDING e\' reaberto para reprocessar');
    check(branch.includes("status: 'pending_approval'") === false && wh.includes("status: 'pending_approval',\n        payment_status: 'paid'".replace('\n', wh.includes('\r\n') ? '\r\n' : '\n')),
      '12i. [fonte] a confirmacao de reserva valida (pending_approval/paid) permanece no webhook, depois das saidas');

    const sync = src('supabase/functions/sync-payment-status/index.ts');
    const fn = sync.slice(sync.indexOf('async function reconcilePaymentExceptions'), sync.indexOf('Deno.serve'));
    check(fn.includes('PaymentExceptionService.scanFromDatabase') && !/asaasFetch|fetch\(|BookingCancellationCore|\.update\(|\.delete\(/.test(fn),
      '12j. [fonte] o passo da conciliacao so\' chama a varredura: sem Asaas, sem Core de cancelamento, sem update/delete');
    check(fn.includes('catch (err') && sync.includes('payment_exceptions: paymentExceptions'), '12k. [fonte] falha na varredura nao interrompe a conciliacao e o resultado vai na resposta');
    check(!/cron\.schedule/.test(src('supabase/migrations/20261002_payment_exceptions.sql').replace(/^--.*$/gm, '')), '12l. [fonte] nenhum cron novo: a varredura usa o job existente');

    const mig = src('supabase/migrations/20261002_payment_exceptions.sql');
    const sql = mig.replace(/^\s*--.*$/gm, '');
    check(/UNIQUE \(exception_type, provider_payment_id\)/.test(sql) && /ENABLE ROW LEVEL SECURITY/.test(sql),
      '12m. [fonte] migration: unicidade por pagamento e RLS ativo');
    // Privilegios resultantes, na ordem em que os comandos aparecem.
    const privStmts = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => /^(GRANT|REVOKE) /i.test(s) && /payment_exceptions/.test(s));
    const ALL = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const priv: Record<string, Set<string>> = {};
    for (const role of ['PUBLIC', 'anon', 'authenticated', 'service_role']) priv[role] = new Set(ALL); // default privileges do Supabase
    for (const s of privStmts) {
      const m = s.match(/^(GRANT|REVOKE) (.+?) ON TABLE public\.payment_exceptions (?:TO|FROM) (.+)$/i);
      if (!m) continue;
      const list = /^ALL/i.test(m[2]) ? ALL : m[2].split(',').map((x) => x.trim().toUpperCase());
      for (const role of m[3].split(',').map((x) => x.trim())) {
        priv[role] = priv[role] || new Set();
        for (const p of list) m[1].toUpperCase() === 'GRANT' ? priv[role].add(p) : priv[role].delete(p);
      }
    }
    const sr = priv['service_role'];
    check(privStmts.length === 2 && /^REVOKE/i.test(privStmts[0]) && /^GRANT/i.test(privStmts[1]), '12m2. [fonte] ordem: REVOKE primeiro, GRANT depois');
    check(!sr.has('DELETE') && !sr.has('TRUNCATE') && !sr.has('REFERENCES') && !sr.has('TRIGGER'), '12m3. [fonte] service_role SEM DELETE e SEM TRUNCATE');
    check(sr.has('SELECT') && sr.has('INSERT') && sr.has('UPDATE') && sr.size === 3, '12m4. [fonte] service_role mantem exatamente SELECT, INSERT e UPDATE');
    check(priv['anon'].size === 0 && priv['authenticated'].size === 0 && priv['PUBLIC'].size === 0, '12m5. [fonte] anon, authenticated e PUBLIC sem nenhum privilegio direto');
    check(!/\b(DROP|DELETE|TRUNCATE|ALTER TABLE (?!public\.payment_exceptions))/i.test(sql) && !/REFERENCES/i.test(sql) && !/CREATE POLICY/i.test(sql),
      '12n. [fonte] migration aditiva: sem DROP/DELETE/TRUNCATE, sem alterar outras tabelas, sem chave estrangeira, sem policy');
  }

  // --------------------------------------------------------------------------
  // 13. Execucoes concorrentes nao criam duplicatas
  // --------------------------------------------------------------------------
  {
    const p = payload('PAYMENT_RECEIVED', 'pay_13');
    const db = createDb({ transactions: [ledgerRow(p)], appointments: [lesson(1, 'expired', 'released')] });
    const results = await Promise.all([
      webhook(db, p, G1, db.tables.appointments), webhook(db, p, G1, db.tables.appointments),
      scan(db), scan(db), webhook(db, payload('PAYMENT_CONFIRMED', 'pay_13'), G1, db.tables.appointments),
    ]);
    const created = results.filter((r: any) => r.outcome === 'created').length + results.filter((r: any) => typeof r.created === 'number').reduce((a: number, r: any) => a + r.created, 0);
    check(exceptions(db).length === 1 && created === 1, '13a. 3 webhooks + 2 varreduras em paralelo: 1 ocorrencia, criada por exatamente um deles');
    check(exceptions(db)[0].provider_payment_phase === 'received', '13b. o resultado final e\' received, qualquer que seja a ordem');

    // CONFIRMED e RECEIVED concorrentes sobre uma ocorrencia authorized
    const db2 = createDb();
    await webhook(db2, payload('PAYMENT_CONFIRMED', 'pay_13b'), G1, [lesson(1, 'expired', 'released')]);
    const rs = await Promise.all([1, 2, 3].map(() => webhook(db2, payload('PAYMENT_RECEIVED', 'pay_13b'), G1, [lesson(1, 'expired', 'released')])));
    check(rs.filter((r) => r.outcome === 'advanced').length === 1 && exceptions(db2).length === 1 && exceptions(db2)[0].provider_payment_phase === 'received',
      '13c. tres RECEIVED concorrentes: o avanco e\' aplicado uma unica vez');
  }

  // --------------------------------------------------------------------------
  // 14. Filtro do ledger no banco: mais de 200 eventos irrelevantes
  // --------------------------------------------------------------------------
  {
    const orphan = payload('PAYMENT_RECEIVED', 'pay_14');
    const noise: Row[] = [];
    const kinds = ['PAYMENT_CREATED', 'PAYMENT_CHECKOUT_VIEWED', 'PAYMENT_SPLIT_DIVERGENCE_BLOCK', 'PAYMENT_OVERDUE'];
    for (let i = 0; i < 250; i++) {
      const p = { id: `evt_noise_${i}`, event: kinds[i % kinds.length], payment: { id: `pay_noise_${i}`, status: 'PENDING', externalReference: G2 } };
      noise.push(ledgerRow(p, `2026-10-02T19:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`));
    }
    // O orfao e' o evento MAIS ANTIGO da janela: sem o filtro no banco, os 200
    // mais recentes seriam todos ruido.
    const db = createDb({ transactions: [...noise, ledgerRow(orphan, '2026-10-01T08:00:00.000Z')], appointments: [lesson(1, 'expired', 'released')] });

    const unfiltered: any = await db.from('transactions').select('*').eq('type', 'webhook_event').eq('provider', 'asaas')
      .gte('created_at', SINCE).order('created_at', { ascending: false }).limit(200);
    check(unfiltered.data.length === 200 && !unfiltered.data.some((r: Row) => r.provider_payment_id === 'pay_14'),
      '14a. controle: sem o filtro de evento, o orfao fica fora dos 200 registros lidos');

    const s1 = await scan(db);
    check(s1.created === 1 && exceptions(db).length === 1 && exceptions(db)[0].provider_payment_id === 'pay_14' && exceptions(db)[0].detected_by === 'reconciliation',
      '14b. com 250 eventos irrelevantes, o orfao e\' encontrado e registrado');
    check(s1.candidates === 1, '14c. so\' o evento de pagamento vira candidato (o ruido nem chega ao codigo)');
    const s2 = await scan(db);
    check(s2.created === 0 && s2.skippedExisting === 1 && exceptions(db).length === 1, '14d. segunda varredura: idempotente, nenhuma nova ocorrencia');
    const svc = readFileSync(resolve(process.cwd(), 'lib/payments/PaymentExceptionService.ts'), 'utf-8');
    const q = svc.slice(svc.indexOf("from('transactions')"), svc.indexOf('.limit(limit)', svc.indexOf("from('transactions')")));
    check(q.includes(".in('raw_payload->>event', PAID_EVENTS)"), '14e. [fonte] o filtro de evento esta\' na consulta, antes do limite');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
