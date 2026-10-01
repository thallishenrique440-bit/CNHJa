/**
 * InstallmentProjectionRefundStateFase2.unit.test.ts
 *
 * Parcelamento x estado de reembolso.
 *
 * `PaymentStateService.processEvent` recalcula `appointments.payment_status`
 * para o GRUPO inteiro a cada transicao de parcela. Sem protecao, a chegada da
 * parcela seguinte trocava `refund_denied` / `refund_requested` / `refunded` de
 * uma aula por `paid`, apagando o estado financeiro do reembolso.
 *
 * Regra: a projecao das parcelas nao sobrescreve estado de reembolso, exceto
 * quando a propria projecao e' `refunded` (todas as parcelas REFUNDED pelo
 * gateway). O processamento normal das parcelas nao muda.
 *
 * Executa o `processEvent` real sobre um banco em memoria. O banco interpreta
 * o filtro PostgREST (`or`) usado no UPDATE; a sintaxe real so' pode ser
 * confirmada contra um PostgREST de verdade.
 */
export {};

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

const { PaymentStateService } = await import('../PaymentStateService.js');
const { PaymentStateMachine } = await import('../PaymentStateMachine.js');

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};

type Row = Record<string, any>;

/** Interpreta `a.is.null,a.not.in.(x,y)` (as duas unicas formas usadas). Forma desconhecida = erro. */
function parseOrFilter(expr: string): (r: Row) => boolean {
  const clauses: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { clauses.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) clauses.push(cur);
  const preds = clauses.map((c) => {
    let m = c.match(/^([a-z_]+)\.is\.null$/);
    if (m) { const col = m[1]; return (r: Row) => r[col] === null || r[col] === undefined; }
    m = c.match(/^([a-z_]+)\.not\.in\.\(([^)]*)\)$/);
    if (m) {
      const col = m[1]; const vals = m[2].split(',');
      // semantica SQL: NULL NOT IN (...) nao e' verdadeiro
      return (r: Row) => r[col] !== null && r[col] !== undefined && !vals.includes(r[col]);
    }
    throw new Error(`filtro or() nao suportado pelo banco de teste: ${c}`);
  });
  return (r: Row) => preds.some((p) => p(r));
}

function createDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => ({ ...r }));
  const orFilters: string[] = [];
  function from(table: string) {
    tables[table] = tables[table] || [];
    let op = 'select'; let payload: any = null;
    const filters: Array<(r: Row) => boolean> = [];
    let single: 'one' | 'maybe' | null = null;
    const api: any = {
      select() { return api; },
      insert(p: any) { op = 'insert'; payload = p; return api; },
      update(p: any) { op = 'update'; payload = p; return api; },
      upsert(p: any) { op = 'insert'; payload = p; return api; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return api; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return api; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return api; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return api; },
      or(expr: string) { orFilters.push(expr); filters.push(parseOrFilter(expr)); return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { single = 'maybe'; return exec(); },
      single() { single = 'one'; return exec(); },
      then(res: any, rej: any) { return exec().then(res, rej); }
    };
    const match = () => tables[table].filter((r) => filters.every((f) => f(r)));
    async function exec(): Promise<any> {
      if (op === 'select') {
        const rows = match().map((r) => ({ ...r }));
        if (single) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      }
      if (op === 'update') { for (const r of match()) Object.assign(r, payload); return { data: null, error: null }; }
      if (op === 'insert') { for (const p of (Array.isArray(payload) ? payload : [payload])) tables[table].push({ ...p }); return { data: null, error: null }; }
      return { data: null, error: null };
    }
    return api;
  }
  return { from, tables, orFilters };
}

const G = 'grp_1';
const inst = (n: number, status: string, over: Row = {}): Row => ({
  id: `inst_${n}`, provider_payment_id: `pay_${n}`, installment_number: n, group_id: G, appointment_id: null,
  status, payment_date: null, gross_amount: 5100, net_amount: 4500, platform_fee: 500, fee_amount: 100, ...over
});
const apt = (id: string, status: string, payment_status: string | null): Row => ({ id, group_id: G, status, payment_status });
const event = (db: any, n: number, eventType: string) => PaymentStateService.processEvent({
  providerPaymentId: `pay_${n}`, providerEventId: `evt_${n}_${eventType}_${Math.random()}`, eventType,
  installmentNumber: n, externalReference: null, payload: { event: eventType, payment: { id: `pay_${n}` } } as any,
  timestamp: new Date().toISOString()
} as any, db as any);
const ps = (db: any) => db.tables.appointments.map((a: Row) => `${a.id}=${a.status}/${a.payment_status}`).join(' ');

// silencia o ruido do dispatcher de projecoes (tabelas inexistentes no banco de teste)
const origWarn = console.warn; const origError = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = origWarn; console.error = origError; }
};

async function main() {
  console.log('\n=== Parcelamento: a projecao das parcelas preserva o estado de reembolso ===\n');

  // --------------------------------------------------------------------------
  // 0. Regra pura e coerencia com o filtro do UPDATE
  // --------------------------------------------------------------------------
  {
    const S = PaymentStateMachine.shouldProjectionOverwrite;
    check(S('paid', 'paid') && S('pending', 'paid') && S(null, 'paid') && S('failed', 'pending'), '0a. sem estado de reembolso: a projecao escreve normalmente');
    check(!S('refund_denied', 'paid') && !S('refund_requested', 'paid') && !S('refunded', 'paid'), '0b. parcela paga nunca transforma estado de reembolso em paid');
    check(!S('refund_denied', 'partially_paid') && !S('refund_denied', 'overdue') && !S('refund_denied', 'failed') && !S('refund_denied', 'pending'),
      '0c. nenhuma projecao de pagamento apaga refund_denied');
    check(S('refund_denied', 'refunded') && S('refund_requested', 'refunded') && S('refunded', 'refunded'), '0d. projecao refunded (todas as parcelas REFUNDED) alcanca aulas em estado de reembolso');
    // o filtro enviado ao banco decide exatamente como a regra pura
    const statuses = [null, 'pending', 'paid', 'failed', 'authorized', 'released', 'refund_requested', 'refund_denied', 'refunded'];
    const projections = ['pending', 'partially_paid', 'paid', 'refunded', 'failed', 'overdue'] as const;
    let coherent = true;
    for (const p of projections) {
      const f = PaymentStateMachine.projectionOverwriteFilter(p);
      const pred = f ? parseOrFilter(f) : () => true;
      for (const s of statuses) if (pred({ payment_status: s }) !== S(s, p)) coherent = false;
    }
    check(coherent, '0e. filtro do UPDATE e regra pura concordam para todos os pares (estado atual, projecao)');
  }

  // --------------------------------------------------------------------------
  // 1. Parcela posterior chegando apos refund_denied
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      payment_installments: [inst(1, 'RECEIVED'), inst(2, 'CONFIRMED'), inst(3, 'CONFIRMED')],
      appointments: [apt('a1', 'expired', 'refund_denied'), apt('a2', 'expired', 'refund_denied')]
    });
    const res = await quiet(() => event(db, 2, 'PAYMENT_RECEIVED'));
    check(res.transitionExecuted === true && db.tables.payment_installments[1].status === 'RECEIVED', '1a. a parcela 2 e\' processada normalmente (CONFIRMED -> RECEIVED)');
    check(ps(db) === 'a1=expired/refund_denied a2=expired/refund_denied', `1b. refund_denied preservado apos a parcela [${ps(db)}]`);
    check(db.orFilters.length === 1 && db.orFilters[0] === 'payment_status.is.null,payment_status.not.in.(refund_requested,refund_denied,refunded)', '1c. a protecao vai no proprio UPDATE (atomico)');
  }

  // --------------------------------------------------------------------------
  // 2. Processamento normal de parcelas, sem reembolso
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      payment_installments: [inst(1, 'PENDING'), inst(2, 'PENDING')],
      appointments: [apt('a1', 'awaiting_payment', 'pending'), apt('a2', 'awaiting_payment', null)]
    });
    await quiet(() => event(db, 1, 'PAYMENT_CONFIRMED'));
    await quiet(() => event(db, 2, 'PAYMENT_CONFIRMED'));
    check(ps(db) === 'a1=awaiting_payment/paid a2=awaiting_payment/paid', `2a. todas as parcelas confirmadas: paid (inclusive aula com payment_status nulo) [${ps(db)}]`);
    await quiet(() => event(db, 1, 'PAYMENT_RECEIVED'));
    await quiet(() => event(db, 2, 'PAYMENT_RECEIVED'));
    check(ps(db) === 'a1=awaiting_payment/paid a2=awaiting_payment/paid' && db.tables.payment_installments.every((i: Row) => i.status === 'RECEIVED'),
      '2b. recebimento das parcelas: continua paid; parcelas RECEIVED');
    check(db.tables.appointments.every((a: Row) => a.status === 'awaiting_payment'), '2c. a projecao nunca altera appointments.status');
  }

  // --------------------------------------------------------------------------
  // 3. Grupo com parcela paga e outra pendente
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      payment_installments: [inst(1, 'PENDING'), inst(2, 'PENDING')],
      appointments: [apt('a1', 'pending_approval', 'pending'), apt('a2', 'expired', 'refund_denied')]
    });
    const res = await quiet(() => event(db, 1, 'PAYMENT_RECEIVED'));
    check(res.newAppointmentPaymentStatus === 'partially_paid', '3a. uma parcela paga e outra pendente: projecao partially_paid (inalterada)');
    check(ps(db) === 'a1=pending_approval/partially_paid a2=expired/refund_denied', `3b. aula sem reembolso recebe a projecao; aula com refund_denied e' preservada [${ps(db)}]`);
  }

  // --------------------------------------------------------------------------
  // 4. Reembolso confirmado
  // --------------------------------------------------------------------------
  {
    // estorno de UMA aula do combo ja' confirmado; a outra segue ativa
    const db = createDb({
      payment_installments: [inst(1, 'RECEIVED'), inst(2, 'CONFIRMED')],
      appointments: [apt('a1', 'cancelled', 'refunded'), apt('a2', 'confirmed', 'paid')]
    });
    await quiet(() => event(db, 2, 'PAYMENT_RECEIVED'));
    check(ps(db) === 'a1=cancelled/refunded a2=confirmed/paid', `4a. parcela posterior nao transforma refunded em paid; aula ativa segue paid [${ps(db)}]`);

    // gateway estorna TODAS as parcelas: a projecao refunded vale para o grupo
    const db2 = createDb({
      payment_installments: [inst(1, 'RECEIVED'), inst(2, 'REFUNDED')],
      appointments: [apt('a1', 'expired', 'refund_denied'), apt('a2', 'expired', 'refund_requested')]
    });
    const res = await quiet(() => event(db2, 1, 'PAYMENT_REFUNDED'));
    check(res.newAppointmentPaymentStatus === 'refunded' && ps(db2) === 'a1=expired/refunded a2=expired/refunded',
      `4b. todas as parcelas REFUNDED pelo gateway: aulas passam a refunded [${ps(db2)}]`);
    check(db2.orFilters.length === 0, '4c. projecao refunded nao e\' filtrada');
  }

  // --------------------------------------------------------------------------
  // 5. Reembolso em analise
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      payment_installments: [inst(1, 'RECEIVED'), inst(2, 'CONFIRMED')],
      appointments: [apt('a1', 'expired', 'refund_requested')]
    });
    await quiet(() => event(db, 2, 'PAYMENT_RECEIVED'));
    check(ps(db) === 'a1=expired/refund_requested', `5. reembolso em analise preservado apos nova parcela [${ps(db)}]`);
  }

  // --------------------------------------------------------------------------
  // 6. Tentativa de reembolso recusada: a recusa nunca vira pagamento concluido
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      payment_installments: [inst(1, 'CONFIRMED')],
      appointments: [apt('a1', 'cancelled', 'refund_denied')]
    });
    const res = await quiet(() => event(db, 1, 'PAYMENT_RECEIVED'));
    check(res.newAppointmentPaymentStatus === 'paid' && ps(db) === 'a1=cancelled/refund_denied', `6a. projecao calculada = paid, mas refund_denied nao e' substituido [${ps(db)}]`);
    check(db.tables.payment_installments[0].status === 'RECEIVED', '6b. a parcela legitima nao e\' bloqueada');
  }

  // --------------------------------------------------------------------------
  // 7. Preservacao do estado apos multiplas atualizacoes
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      payment_installments: [inst(1, 'PENDING'), inst(2, 'PENDING'), inst(3, 'PENDING'), inst(4, 'PENDING')],
      appointments: [apt('a1', 'expired', 'refund_denied'), apt('a2', 'cancelled', 'refund_requested'), apt('a3', 'cancelled', 'refunded'), apt('a4', 'confirmed', 'pending')]
    });
    const seq: Array<[number, string]> = [
      [1, 'PAYMENT_CONFIRMED'], [2, 'PAYMENT_CONFIRMED'], [3, 'PAYMENT_CONFIRMED'], [4, 'PAYMENT_CONFIRMED'],
      [1, 'PAYMENT_RECEIVED'], [1, 'PAYMENT_RECEIVED'], [2, 'PAYMENT_RECEIVED'], [3, 'PAYMENT_RECEIVED'], [4, 'PAYMENT_RECEIVED']
    ];
    let kept = true;
    for (const [n, ev] of seq) {
      await quiet(() => event(db, n, ev));
      const a = db.tables.appointments;
      if (a[0].payment_status !== 'refund_denied' || a[1].payment_status !== 'refund_requested' || a[2].payment_status !== 'refunded') kept = false;
    }
    check(kept, '7a. 9 eventos de parcela (com reentrega): estados de reembolso preservados a cada passo');
    check(ps(db) === 'a1=expired/refund_denied a2=cancelled/refund_requested a3=cancelled/refunded a4=confirmed/paid', `7b. estado final: reembolsos intactos, aula ativa paid [${ps(db)}]`);
    check(db.tables.payment_installments.every((i: Row) => i.status === 'RECEIVED'), '7c. todas as parcelas processadas (RECEIVED)');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
