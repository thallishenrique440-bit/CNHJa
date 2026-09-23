/**
 * RefundHardeningP1201B.unit.test.ts
 *
 * P-1.20.1B — hardening do motor de cancelamento/refund.
 *
 * Cobre os 13 requisitos da fase. Nenhuma rede, nenhum Supabase real, nenhum
 * Asaas: o Core recebe `httpFetch` por parametro e o banco e' um mock em memoria
 * que IMPLEMENTA DE VERDADE o CAS otimista — sem isso o defeito original
 * (versao obsoleta no CAS) passaria despercebido, como de fato passou.
 */
// SEGURANCA: lib/NotificationService.ts cria um cliente Supabase NO IMPORT, com
// a URL de producao como fallback. Estes valores sao fixados ANTES de qualquer
// import do Core (por isso os imports abaixo sao dinamicos, dentro de main()):
// o host e' nao roteavel, de modo que nenhuma chamada pode alcancar producao.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-dummy-key-not-a-secret';

type CoreModule = typeof import('../BookingCancellationCore.js');
type RepoModule = typeof import('../RefundOperationRepository.js');
type ErrModule = typeof import('../RefundOperationErrors.js');

let BookingCancellationCore: CoreModule['BookingCancellationCore'];
let REASON_ALLOWED_STATUSES: CoreModule['REASON_ALLOWED_STATUSES'];
let ACCEPTED_STATUSES: CoreModule['ACCEPTED_STATUSES'];
let CancellationNotAllowedError: CoreModule['CancellationNotAllowedError'];
let RefundOperationRepository: RepoModule['RefundOperationRepository'];
let RefundOperationClaimLostError: ErrModule['RefundOperationClaimLostError'];
let RefundOperationVersionConflictError: ErrModule['RefundOperationVersionConflictError'];

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`PASS: ${msg}`); }
  else { failures.push(msg); console.error(`FAIL: ${msg}`); }
}
async function expectThrow(fn: () => Promise<any>, pred: (e: any) => boolean, msg: string) {
  try { await fn(); check(false, `${msg} (nao lancou)`); }
  catch (e: any) { check(pred(e), `${msg} (lancou ${e?.name}: ${e?.message})`); }
}

// ---------------------------------------------------------------------------
// Mock de banco com CAS real
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

function createDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map(r => ({ ...r }));

  function builder(table: string) {
    let rows = () => tables[table] || (tables[table] = []);
    const filters: Array<(r: Row) => boolean> = [];
    let mode: 'select' | 'update' | 'upsert' | null = null;
    let payload: Row = {};

    const api: any = {
      select() { if (!mode) mode = 'select'; return api; },
      eq(col: string, val: any) { filters.push(r => r[col] === val); return api; },
      is(col: string, val: any) { filters.push(r => (r[col] ?? null) === val); return api; },
      in(col: string, vals: any[]) { filters.push(r => vals.includes(r[col])); return api; },
      neq(col: string, val: any) { filters.push(r => r[col] !== val); return api; },
      lt(col: string, val: any) { filters.push(r => r[col] < val); return api; },
      or() { return api; },
      update(p: Row) { mode = 'update'; payload = p; return api; },
      upsert(p: Row, _o?: any) { mode = 'upsert'; payload = p; return api; },
      _matched() { return rows().filter(r => filters.every(f => f(r))); },
      _apply() {
        if (mode === 'update') {
          const hit = api._matched();
          hit.forEach((r: Row) => Object.assign(r, payload));
          return hit;
        }
        if (mode === 'upsert') {
          const key = payload.operation_key;
          const existing = rows().find(r => r.operation_key === key);
          if (existing) return [];                       // ignoreDuplicates
          const created = { version: 1, attempt: 0, owner_id: null, lease_until: null, sent_at: null, provider_refund_id: null, completed_amount_cents: null, ...payload, id: payload.id || `op_${rows().length + 1}` };
          rows().push(created);
          return [created];
        }
        return api._matched();
      },
      async maybeSingle() { const r = api._apply(); return { data: r[0] ? { ...r[0] } : null, error: null }; },
      async single() { const r = api._apply(); return { data: r[0] ? { ...r[0] } : null, error: r[0] ? null : { message: 'Not found' } }; },
      then(res: any) { const r = api._apply(); return Promise.resolve({ data: r.map((x: Row) => ({ ...x })), error: null }).then(res); }
    };
    return api;
  }

  return { tables, from: (t: string) => builder(t) };
}

const OP_SEED = (over: Row = {}): Row => ({
  id: 'op_1', operation_key: 'k1', provider: 'asaas', provider_payment_id: 'pay_1',
  scope: 'SINGLE_APPOINTMENT', status: 'REQUESTED', requested_amount_cents: 10000,
  completed_amount_cents: null, currency: 'BRL', version: 1, owner_id: null,
  lease_until: null, attempt: 0, provider_refund_id: null, sent_at: null,
  unknown_since: null, metadata: {}, created_at: 'x', updated_at: 'x', ...over
});

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

// ===========================================================================
async function main() {
  console.log('\n=== P-1.20.1B — hardening cancelamento/refund ===\n');

  const core = await import('../BookingCancellationCore.js');
  const repo = await import('../RefundOperationRepository.js');
  const errs = await import('../RefundOperationErrors.js');
  BookingCancellationCore = core.BookingCancellationCore;
  REASON_ALLOWED_STATUSES = core.REASON_ALLOWED_STATUSES;
  ACCEPTED_STATUSES = core.ACCEPTED_STATUSES;
  CancellationNotAllowedError = core.CancellationNotAllowedError;
  RefundOperationRepository = repo.RefundOperationRepository;
  RefundOperationClaimLostError = errs.RefundOperationClaimLostError;
  RefundOperationVersionConflictError = errs.RefundOperationVersionConflictError;

  // ---- 1. claim REQUESTED -> PENDING -----------------------------------
  {
    const db = createDb({ refund_operations: [OP_SEED()] });
    const res = await RefundOperationRepository.claim(db as any, 'op_1', 'worker-A', future());
    check(res.claimed === true, '1. claim bem-sucedido');
    check(res.operation.status === 'PENDING', '1. claim transiciona REQUESTED -> PENDING num unico UPDATE');
    check(res.operation.owner_id === 'worker-A', '1. dono gravado pelo claim');
    check(!!res.operation.sent_at, '1. sent_at e\' carimbado no claim (PENDING = pode ter chegado ao gateway)');
    check(res.operation.attempt === 1, '1. attempt incrementado');
  }

  // ---- 2. versao correta devolvida --------------------------------------
  {
    const db = createDb({ refund_operations: [OP_SEED()] });
    const res = await RefundOperationRepository.claim(db as any, 'op_1', 'worker-A', future());
    check(res.operation.version === 2, '2. claim devolve a NOVA versao (1 -> 2)');
    const next = await RefundOperationRepository.transition(db as any, 'op_1', 'worker-A', res.operation.version, 'COMPLETED', { completed_amount_cents: 10000 });
    check(next.version === 3, '2. transicao seguinte usa a versao devolvida e produz 3');
    check(next.status === 'COMPLETED', '2. estado terminal alcancado');
  }

  // ---- 2b. regressao exata do defeito C1 --------------------------------
  {
    const db = createDb({ refund_operations: [OP_SEED()] });
    const opBefore = { ...db.tables.refund_operations[0] };           // version 1
    await RefundOperationRepository.claim(db as any, 'op_1', 'worker-A', future());
    await expectThrow(
      () => RefundOperationRepository.transition(db as any, 'op_1', 'worker-A', opBefore.version, 'COMPLETED', {}),
      e => e instanceof RefundOperationVersionConflictError,
      '2b. usar a versao PRE-claim falha como VersionConflict, nao como "owned by another worker"'
    );
  }

  // ---- 3. segundo worker perde a concorrencia ---------------------------
  {
    const db = createDb({ refund_operations: [OP_SEED()] });
    const a = await RefundOperationRepository.claim(db as any, 'op_1', 'worker-A', future());
    const b = await RefundOperationRepository.claim(db as any, 'op_1', 'worker-B', future());
    check(a.claimed === true && b.claimed === false, '3. apenas o primeiro worker claima');
    check(b.operation.owner_id === 'worker-A', '3. o segundo ve o dono real');
    await expectThrow(
      () => RefundOperationRepository.transition(db as any, 'op_1', 'worker-B', b.operation.version, 'COMPLETED', {}),
      e => e instanceof RefundOperationClaimLostError,
      '3. dono errado com versao certa lanca ClaimLost (concorrencia real nao e\' mascarada)'
    );
  }

  // ---- 4. recuperacao de lease vencido ----------------------------------
  {
    // 4a. PENDING vencido -> UNKNOWN (so evidencia externa fecha)
    const db1 = createDb({ refund_operations: [OP_SEED({ status: 'PENDING', owner_id: 'worker-morto', lease_until: past(), version: 2 })] });
    const r1 = await RefundOperationRepository.claim(db1 as any, 'op_1', 'worker-B', future());
    check(r1.claimed === false && r1.operation.status === 'UNKNOWN', '4a. PENDING com lease vencido vira UNKNOWN e nao e\' re-claimavel localmente');

    // 4b. PENDING com lease VIVO nao e' tocado
    const db2 = createDb({ refund_operations: [OP_SEED({ status: 'PENDING', owner_id: 'worker-vivo', lease_until: future(), version: 2 })] });
    const r2 = await RefundOperationRepository.claim(db2 as any, 'op_1', 'worker-B', future());
    check(r2.claimed === false && r2.operation.status === 'PENDING', '4b. lease vivo e\' respeitado');

    // 4c. REQUESTED com claim morto (o estado exato das 2 operacoes do incidente)
    const db3 = createDb({ refund_operations: [OP_SEED({ status: 'REQUESTED', owner_id: 'worker-949ed449', lease_until: past(), version: 2 })] });
    const r3 = await RefundOperationRepository.claim(db3 as any, 'op_1', 'worker-B', future());
    check(r3.claimed === true && r3.operation.status === 'PENDING',
      '4c. REQUESTED com claim morto e\' liberado e re-claimado — nenhuma operacao fica estruturalmente irrecuperavel');
    check(r3.operation.version === 4, '4c. versao avanca pela liberacao (3) e pelo claim (4)');
  }

  // ---- 5. nenhuma versao calculada manualmente --------------------------
  {
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/payments/BookingCancellationCore.ts', 'utf-8');
    check(!/op\.version\s*\+\s*1/.test(src), '5. o Core nao contem nenhum `op.version + 1`');
    check(!/cancelling/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
      '5. o Core nao escreve `cancelling` (fora de comentarios)');
  }

  // ---- Core: cenario pago ------------------------------------------------
  const APT = (over: Row = {}): Row => ({
    id: 'apt_1', status: 'pending_approval', instructor_id: 'i1', student_id: 's1',
    payment_intent_id: 'pay_1', provider_payment_id: 'pay_1', provider_name: 'asaas',
    payment_status: 'paid', cancelled_reason: null, group_id: null, price: 10000, ...over
  });

  // D4: `getResponse` permite falhar o GET /payments/{id}. Por padrao ele
  // responde RECEIVED, que e' o cenario dos testes 6 a 12.
  function gateway(
    refundResponse: { ok: boolean; status: number; body?: any; throws?: any },
    getResponse?: { ok?: boolean; status?: number; throws?: any }
  ) {
    const calls: string[] = [];
    const fn = async (url: string, init?: any) => {
      calls.push(`${init?.method || 'GET'} ${url}`);
      if ((init?.method || 'GET') === 'GET') {
        if (getResponse?.throws) throw getResponse.throws;
        if (getResponse && getResponse.ok === false) {
          return { ok: false, status: getResponse.status || 500, json: async () => ({}), text: async () => 'gateway indisponivel' };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'RECEIVED', value: 100, split: [] }), text: async () => '' };
      }
      if (refundResponse.throws) throw refundResponse.throws;
      return {
        ok: refundResponse.ok, status: refundResponse.status,
        json: async () => refundResponse.body || {}, text: async () => JSON.stringify(refundResponse.body || {})
      };
    };
    return { fn, calls };
  }

  // ---- 6. refund COMPLETED -> appointment terminal -----------------------
  {
    const db = createDb({ appointments: [APT()], refund_operations: [], payment_installments: [], transactions: [] });
    const gw = gateway({ ok: true, status: 200, body: { id: 'ref_1' } });
    const res = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
      asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any
    });
    check(res.success === true && res.status === 'cancelled', '6. refund COMPLETED -> resultado cancelled');
    check(db.tables.appointments[0].status === 'cancelled', '6. appointment atinge o estado terminal');
    check(db.tables.appointments[0].payment_status === 'refunded', '6. payment_status refunded');
    check(db.tables.refund_operations[0].status === 'COMPLETED', '6. operacao COMPLETED');
    check(gw.calls.filter(c => c.startsWith('POST')).length === 1, '6. exatamente um POST /refund');
  }

  // ---- 7. refund recusado (4xx) -> appointment INTACTO -------------------
  {
    const db = createDb({ appointments: [APT()], refund_operations: [], payment_installments: [], transactions: [] });
    const gw = gateway({ ok: false, status: 400, body: { errors: [{ description: 'nope' }] } });
    await expectThrow(
      () => BookingCancellationCore.processCancellation({
        appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
        asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any
      }),
      () => true,
      '7. refund 4xx propaga erro'
    );
    check(db.tables.appointments[0].status === 'pending_approval', '7. appointment permanece INTACTO apos refund recusado');
    check(db.tables.appointments[0].payment_status === 'paid', '7. payment_status intacto');
    check(db.tables.refund_operations[0].status === 'DENIED', '7. operacao DENIED');
  }

  // ---- 8. timeout/5xx -> UNKNOWN, reconciliavel, appointment intacto -----
  {
    for (const [label, gwCfg] of [
      ['5xx', { ok: false, status: 503, body: { msg: 'boom' } }],
      ['timeout', { ok: false, status: 0, throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]
    ] as any[]) {
      const db = createDb({ appointments: [APT()], refund_operations: [], payment_installments: [], transactions: [] });
      const gw = gateway(gwCfg);
      await expectThrow(
        () => BookingCancellationCore.processCancellation({
          appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
          asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any
        }),
        () => true,
        `8. ${label} propaga erro`
      );
      const op = db.tables.refund_operations[0];
      check(op.status === 'UNKNOWN', `8. ${label} -> operacao UNKNOWN (nunca "nao aconteceu")`);
      check(!!op.sent_at, `8. ${label} preserva sent_at: pode ter chegado ao gateway`);
      check(db.tables.appointments[0].status === 'pending_approval', `8. ${label} appointment intacto`);
    }
  }

  // ---- 8b. UNKNOWN nao emite segundo refund ------------------------------
  {
    const db = createDb({
      appointments: [APT()],
      refund_operations: [], payment_installments: [], transactions: []
    });
    const gw = gateway({ ok: false, status: 503, body: {} });
    try {
      await BookingCancellationCore.processCancellation({ appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db, asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any });
    } catch { /* esperado */ }
    const gw2 = gateway({ ok: true, status: 200, body: { id: 'ref_x' } });
    const res2 = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
      asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw2.fn as any
    });
    check(gw2.calls.filter(c => c.startsWith('POST')).length === 0, '8b. operacao UNKNOWN BLOQUEIA um segundo POST /refund');
    check(res2.status === 'pending_refund', '8b. resultado sinaliza estorno em processamento');
    check(db.tables.appointments[0].status === 'pending_approval', '8b. appointment segue intacto');
  }

  // ---- D4. GET /payments/{id} sem resposta valida -> NADA e' escrito --------
  //
  // Cobre `gatewayStateKnown`. Antes desta fase um GET com falha deixava
  // `isPaid = false` e o agendamento era cancelado COMO SE NUNCA TIVESSE SIDO
  // PAGO, retendo o dinheiro do aluno em silencio. Nao saber nao e' o mesmo que
  // nao ter sido pago.
  {
    const scenarios: Array<[string, any, any]> = [
      ['GET nao-2xx', { ok: false, status: 502 }, undefined],
      ['GET timeout', { throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, undefined],
      // Terceiro cenario: ASAAS_API_KEY vazia. O bloco do gateway nem executa,
      // logo `gatewayStateKnown` continua falso. Era a brecha D3.
      ['ASAAS_API_KEY vazia', undefined, '']
    ];

    for (const [label, getCfg, apiKeyOverride] of scenarios) {
      const db = createDb({
        appointments: [APT()],
        refund_operations: [],
        payment_installments: [{ id: 'pi_1', provider_payment_id: 'pay_1', status: 'RECEIVED', gross_amount: 10199 }],
        transactions: [{ id: 'tx_1', appointment_id: 'apt_1', type: 'lesson_payment', status: 'completed', amount: 10000 }]
      });
      const gw = gateway({ ok: true, status: 200, body: { id: 'ref_nope' } }, getCfg);

      await expectThrow(
        () => BookingCancellationCore.processCancellation({
          appointmentId: 'apt_1', reason: 'student_cancelled', adminClient: db,
          asaasApiKey: apiKeyOverride !== undefined ? apiKeyOverride : 'k',
          asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any
        }),
        (e: any) => /Nao foi possivel confirmar o estado do pagamento/.test(String(e?.message)),
        `D4 ${label}: erro explicito de estado nao confirmado`
      );

      check(db.tables.refund_operations.length === 0, `D4 ${label}: nenhuma refund_operation criada`);
      check(db.tables.appointments[0].status === 'pending_approval', `D4 ${label}: appointment.status intacto`);
      check(db.tables.appointments[0].payment_status === 'paid', `D4 ${label}: appointment.payment_status intacto`);
      check(db.tables.payment_installments[0].status === 'RECEIVED', `D4 ${label}: payment_installments intactas`);
      check(db.tables.transactions.length === 1 && db.tables.transactions[0].status === 'completed', `D4 ${label}: transactions intactas`);
      check(gw.calls.filter(c => c.startsWith('POST')).length === 0, `D4 ${label}: nenhum POST /refund emitido`);
    }
  }

  // ---- 9 e 10. aula aceita nao pode ser cancelada ------------------------
  {
    for (const status of ACCEPTED_STATUSES) {
      for (const reason of ['student_cancelled', 'instructor_rejected', 'auto_expired'] as const) {
        const db = createDb({ appointments: [APT({ status })], refund_operations: [], payment_installments: [], transactions: [] });
        const gw = gateway({ ok: true, status: 200, body: { id: 'r' } });
        await expectThrow(
          () => BookingCancellationCore.processCancellation({
            appointmentId: 'apt_1', reason, adminClient: db,
            asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any
          }),
          e => e instanceof CancellationNotAllowedError,
          `9/10. ${reason} sobre '${status}' e' recusado pelo Core`
        );
        check(db.tables.appointments[0].status === status, `9/10. ${reason}/${status}: appointment intacto`);
        check(gw.calls.length === 0, `9/10. ${reason}/${status}: o gateway nem e' consultado`);
      }
    }
    check(!REASON_ALLOWED_STATUSES.student_cancelled.includes('confirmed'), '9. matriz: aluno nao cancela confirmed');
    check(!REASON_ALLOWED_STATUSES.instructor_rejected.includes('confirmed'), '10. matriz: instrutor nao cancela confirmed');
    check(!REASON_ALLOWED_STATUSES.instructor_rejected.includes('scheduled'), '10. matriz: instrutor nao cancela scheduled');
  }

  // ---- 11. pending_approval segue elegivel -------------------------------
  {
    for (const reason of ['student_cancelled', 'instructor_rejected', 'auto_expired'] as const) {
      check(REASON_ALLOWED_STATUSES[reason].includes('pending_approval'), `11. matriz: ${reason} aceita pending_approval`);
    }
    // Modulo B do cron: pending_approval + paid -> auto_expired -> refund
    const db = createDb({ appointments: [APT({ status: 'pending_approval' })], refund_operations: [], payment_installments: [], transactions: [] });
    const gw = gateway({ ok: true, status: 200, body: { id: 'ref_b' } });
    const res = await BookingCancellationCore.processCancellation({
      appointmentId: 'apt_1', reason: 'auto_expired', adminClient: db,
      asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any
    });
    check(res.status === 'expired' && db.tables.appointments[0].status === 'expired', '11. Modulo B continua funcionando (pending_approval -> expired com refund)');
  }

  // ---- 12. idempotencia: sem refund duplicado ----------------------------
  {
    const db = createDb({ appointments: [APT()], refund_operations: [], payment_installments: [], transactions: [] });
    const gw = gateway({ ok: true, status: 200, body: { id: 'ref_1' } });
    const opts = { appointmentId: 'apt_1', reason: 'student_cancelled' as const, adminClient: db, asaasApiKey: 'k', asaasApiUrl: 'https://sandbox', httpFetch: gw.fn as any };
    await BookingCancellationCore.processCancellation(opts);
    const second = await BookingCancellationCore.processCancellation(opts);
    check(gw.calls.filter(c => c.startsWith('POST')).length === 1, '12. a segunda execucao NAO emite um segundo POST /refund');
    check(second.alreadyProcessed === true, '12. segunda execucao reportada como ja processada');
    check(db.tables.refund_operations.length === 1, '12. uma unica operacao de refund (operation_key deterministico)');
  }

  // ---- 13. _shared nao diverge de lib/payments ---------------------------
  {
    const fs = await import('node:fs');
    const { transform, GENERATED_FILES } = await import('../../../scripts/sync-shared.js') as any;
    let allSynced = true;
    for (const f of GENERATED_FILES) {
      const src = fs.readFileSync(`lib/payments/${f}`, 'utf-8');
      const cur = fs.readFileSync(`supabase/functions/_shared/${f}`, 'utf-8');
      if (transform(src, `lib/payments/${f}`) !== cur) { allSynced = false; console.error(`  divergente: ${f}`); }
    }
    check(allSynced, '13. supabase/functions/_shared esta sincronizado com lib/payments');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length) { failures.forEach(f => console.error(` - ${f}`)); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
