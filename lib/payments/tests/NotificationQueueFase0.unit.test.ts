/**
 * NotificationQueueFase0.unit.test.ts
 *
 * FASE 0 — fila de notificacoes push.
 *
 * Defeito de producao: 13 jobs presos em `processing` com `attempts = 0`. O
 * worker reivindicava o job, o envio falhava (HTTP 401 do
 * `send-push-notification`) e nada devolvia o job a fila; a RPC de
 * reivindicacao so' le `pending`.
 *
 * Executa o modulo real `supabase/functions/_shared/notificationQueue.ts`
 * (o mesmo que o worker usa) sobre um banco em memoria que reproduz as RPCs
 * `claim_notification_jobs` e `mark_notification_job_sent`. Nenhuma rede,
 * nenhum Supabase, nenhum FCM.
 */
export {};

const {
  runNotificationCycle, recoverStaleJobs, decideRecovery, interpretDispatchResponse, retryDelayMs, DEFAULT_QUEUE_CONFIG,
  isTimeCritical, maxAgeMsFor
} = await import('../../../supabase/functions/_shared/notificationQueue.js');

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, name: string) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ FAIL: ${name}`); }
};
const origError = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.error = () => {};
  try { return await fn(); } finally { console.error = origError; }
};

type Row = Record<string, any>;
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-01T22:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

// ============================================================================
// Banco em memoria (tabelas + as duas RPCs, com a mesma semantica do Postgres)
// ============================================================================
function createDb(seed: { jobs?: Row[]; notifications?: Row[] }) {
  const tables: Record<string, Row[]> = {
    notification_jobs: (seed.jobs || []).map((r) => ({ ...r })),
    notifications: (seed.notifications || []).map((r) => ({ ...r }))
  };
  const clock = { now: T0 };
  const failNextUpdate = { count: 0 };

  function from(table: string) {
    let op = 'select'; let payload: any = null; let returning = false; let lim = Infinity;
    const filters: Array<(r: Row) => boolean> = [];
    let orderCol: string | null = null;
    const api: any = {
      select() { if (op !== 'select') returning = true; return api; },
      update(p: any) { op = 'update'; payload = p; return api; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return api; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return api; },
      lt(c: string, v: any) { filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] < v); return api; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return api; },
      order(c: string) { orderCol = c; return api; },
      limit(n: number) { lim = n; return api; },
      then(res: any, rej: any) { return exec().then(res, rej); }
    };
    async function exec(): Promise<any> {
      await Promise.resolve(); // cede o event loop: corridas ficam observaveis
      let rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (op === 'select') {
        if (orderCol) rows = [...rows].sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])));
        return { data: rows.slice(0, lim).map((r) => JSON.parse(JSON.stringify(r))), error: null };
      }
      if (failNextUpdate.count > 0) { failNextUpdate.count--; return { data: null, error: { message: 'simulated write failure' } }; }
      for (const r of rows) Object.assign(r, JSON.parse(JSON.stringify(payload)));
      return { data: returning ? rows.map((r) => ({ notification_id: r.notification_id })) : null, error: null };
    }
    return api;
  }

  async function rpc(name: string, args: Row): Promise<any> {
    if (name === 'claim_notification_jobs') {
      // UPDATE ... WHERE status='pending' AND next_run_at <= now ... SKIP LOCKED: atomico.
      const nowIso = iso(clock.now);
      const picked = tables.notification_jobs
        .filter((j) => j.status === 'pending' && j.next_run_at <= nowIso)
        .sort((a, b) => (b.priority - a.priority) || String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, args.p_batch_size);
      for (const j of picked) { j.status = 'processing'; j.locked_at = nowIso; j.locked_by = args.p_worker_id; }
      return { data: picked.map((j) => ({ notification_id: j.notification_id, status: j.status, priority: j.priority, created_at: j.created_at })), error: null };
    }
    if (name === 'mark_notification_job_sent') {
      const j = tables.notification_jobs.find((x) => x.notification_id === args.p_notification_id && x.status === 'processing');
      if (!j) return { data: false, error: null };
      j.status = 'sent'; j.completed_at = iso(clock.now); j.last_error = null;
      return { data: true, error: null };
    }
    return { data: null, error: { message: `rpc desconhecida: ${name}` } };
  }
  return { from, rpc, tables, clock, failNextUpdate };
}

const JOB = (id: string, over: Row = {}): Row => ({
  notification_id: id, status: 'pending', priority: 0, attempts: 0, max_attempts: 5, locked_at: null, locked_by: null,
  next_run_at: iso(T0 - MIN), completed_at: null, last_error: null, metadata: {}, created_at: iso(T0 - MIN), ...over
});
const NOTIF = (id: string, createdMs = T0 - MIN, type = 'booking_expired'): Row => ({ id, created_at: iso(createdMs), user_id: 'u1', type });
const job = (db: any, id: string) => db.tables.notification_jobs.find((j: Row) => j.notification_id === id);

/** Dispatcher simulado: conta envios por notificacao e devolve o desfecho programado. */
function dispatcher(plan: (id: string, call: number) => any) {
  const calls: string[] = [];
  const fn = async (id: string) => {
    calls.push(id);
    const outcome = plan(id, calls.filter((c) => c === id).length);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { fn, calls, count: (id: string) => calls.filter((c) => c === id).length };
}
const DELIVERED = { kind: 'delivered', delivered: 1, failed: 0 };
const TRANSIENT = { kind: 'transient_failure', error: 'HTTP 401' };
const cycle = (db: any, d: any, workerId = 'w1', nowMs?: number, config: Row = {}) =>
  runNotificationCycle({ db, dispatch: d.fn, workerId, nowMs: nowMs ?? db.clock.now, config });

async function main() {
  console.log('\n=== FASE 0: fila de notificacoes — recuperacao, tentativas e idempotencia ===\n');

  // --------------------------------------------------------------------------
  // 1. Notificacao pendente normal
  // --------------------------------------------------------------------------
  {
    const db = createDb({ jobs: [JOB('n1')], notifications: [NOTIF('n1')] });
    const d = dispatcher(() => DELIVERED);
    const r = await cycle(db, d);
    const j = job(db, 'n1');
    check(r.claimed === 1 && r.sent === 1 && d.count('n1') === 1, '1a. pendente normal: reivindicada, enviada uma vez');
    check(j.status === 'sent' && !!j.completed_at && j.attempts === 1 && j.last_error === null, '1b. job sent, tentativa contada, sem erro');
    check(!!j.metadata.dispatch_confirmed_at && j.metadata.delivered_devices === 1, '1c. confirmacao do provedor registrada no job');
  }

  // --------------------------------------------------------------------------
  // 2. Worker interrompido apos marcar processing + 3. recuperacao apos timeout
  // --------------------------------------------------------------------------
  {
    // estado deixado pelo worker antigo: processing, attempts 0, sem marcador de envio
    const stuck = JOB('n1', { status: 'processing', locked_at: iso(T0), locked_by: 'edge-cron-morto' });
    const db = createDb({ jobs: [stuck], notifications: [NOTIF('n1', T0)] });
    const d = dispatcher(() => DELIVERED);

    db.clock.now = T0 + 5 * MIN; // ainda dentro do prazo seguro
    const early = await cycle(db, d);
    check(early.claimed === 0 && d.calls.length === 0 && job(db, 'n1').status === 'processing', '2a. job em processing recente NAO e\' tocado (o worker pode estar vivo)');

    db.clock.now = T0 + 11 * MIN; // passou o prazo de 10 min
    const r = await cycle(db, d);
    const j = job(db, 'n1');
    check(r.recovered.requeued === 1, '3a. apos o prazo: job abandonado e\' devolvido a fila');
    check(r.sent === 1 && d.count('n1') === 1 && j.status === 'sent', '3b. e enviado no mesmo ciclo, uma unica vez');
    check(j.attempts === 2 && j.metadata.recovered_from_lock === 'edge-cron-morto', '3c. tentativas contadas (abandono + envio) e origem da recuperacao registrada');

    // interrompido DEPOIS de iniciar o envio: desfecho desconhecido
    const db2 = createDb({
      jobs: [JOB('n2', { status: 'processing', locked_at: iso(T0), locked_by: 'w-morto', metadata: { dispatch_started_at: iso(T0) } })],
      notifications: [NOTIF('n2', T0)]
    });
    const d2 = dispatcher(() => DELIVERED);
    db2.clock.now = T0 + 11 * MIN;
    const r2 = await cycle(db2, d2);
    const j2 = job(db2, 'n2');
    check(r2.recovered.failedUnknown === 1 && d2.calls.length === 0, '3d. envio de desfecho desconhecido NAO e\' reenviado');
    check(j2.status === 'failed' && j2.last_error === 'dispatch_outcome_unknown', '3e. e NAO e\' marcado como entregue: fica failed, com motivo');

    // envio confirmado, marcacao final nao gravada
    const db3 = createDb({
      jobs: [JOB('n3', { status: 'processing', locked_at: iso(T0), locked_by: 'w-morto', attempts: 1, metadata: { dispatch_started_at: iso(T0), dispatch_confirmed_at: iso(T0) } })],
      notifications: [NOTIF('n3', T0)]
    });
    const d3 = dispatcher(() => DELIVERED);
    db3.clock.now = T0 + 11 * MIN;
    const r3 = await cycle(db3, d3);
    check(r3.recovered.confirmedSent === 1 && d3.calls.length === 0 && job(db3, 'n3').status === 'sent', '3f. envio ja\' confirmado: concluido como sent, sem reenvio');
  }

  // --------------------------------------------------------------------------
  // 4. Duas execucoes concorrentes
  // --------------------------------------------------------------------------
  {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const db = createDb({ jobs: ids.map((i) => JOB(i)), notifications: ids.map((i) => NOTIF(i)) });
    const d = dispatcher(() => DELIVERED);
    const [r1, r2] = await Promise.all([cycle(db, d, 'w1', undefined, { batchSize: 4 }), cycle(db, d, 'w2', undefined, { batchSize: 4 })]);
    check(r1.claimed + r2.claimed === 6 && ids.every((i) => d.count(i) === 1), '4a. dois workers simultaneos: cada notificacao enviada exatamente uma vez');
    check(db.tables.notification_jobs.every((j: Row) => j.status === 'sent'), '4b. todos os jobs concluidos');

    // recuperacao concorrente do MESMO job abandonado
    const dbR = createDb({ jobs: [JOB('s', { status: 'processing', locked_at: iso(T0 - 20 * MIN), locked_by: 'w-morto' })], notifications: [NOTIF('s', T0 - 20 * MIN)] });
    const [a, b] = await Promise.all([recoverStaleJobs(dbR, T0, DEFAULT_QUEUE_CONFIG), recoverStaleJobs(dbR, T0, DEFAULT_QUEUE_CONFIG)]);
    check(a.requeued + b.requeued === 1 && job(dbR, 's').attempts === 1 && job(dbR, 's').status === 'pending', '4c. duas recuperacoes simultaneas: uma unica transicao, tentativa contada uma vez');
  }

  // --------------------------------------------------------------------------
  // 5. Falha temporaria do provedor
  // --------------------------------------------------------------------------
  {
    const db = createDb({ jobs: [JOB('n1')], notifications: [NOTIF('n1')] });
    const d = dispatcher((_id, call) => (call === 1 ? TRANSIENT : DELIVERED));
    const r = await cycle(db, d);
    let j = job(db, 'n1');
    check(r.retried === 1 && j.status === 'pending' && j.attempts === 1 && j.locked_by === null, '5a. falha temporaria: job volta a pending, tentativa contada, trava liberada');
    check(j.last_error === 'HTTP 401' && j.next_run_at === iso(T0 + 1 * MIN) && !j.metadata.dispatch_started_at, '5b. erro registrado, nova tentativa agendada, sem marcador de envio');
    const tooSoon = await cycle(db, d);
    check(tooSoon.claimed === 0 && d.count('n1') === 1, '5c. antes do horario agendado o job nao e\' reenviado');
    db.clock.now = T0 + 2 * MIN;
    const again = await cycle(db, d);
    j = job(db, 'n1');
    check(again.sent === 1 && j.status === 'sent' && j.attempts === 2 && j.last_error === null, '5d. na nova tentativa: enviado e concluido');
    // excecao lancada pelo envio (rede) tambem e' falha temporaria
    const dbX = createDb({ jobs: [JOB('x')], notifications: [NOTIF('x')] });
    const rx = await cycle(dbX, dispatcher(() => new Error('socket hang up')));
    check(rx.retried === 1 && job(dbX, 'x').status === 'pending' && job(dbX, 'x').last_error === 'socket hang up', '5e. excecao no envio: tratada como falha temporaria');
  }

  // --------------------------------------------------------------------------
  // 6. Falha permanente
  // --------------------------------------------------------------------------
  {
    const db = createDb({ jobs: [JOB('n1'), JOB('n2')], notifications: [NOTIF('n1'), NOTIF('n2')] });
    const d = dispatcher((id) => (id === 'n1' ? { kind: 'permanent_failure', error: 'all_device_tokens_invalid' } : { kind: 'no_recipient_devices' }));
    const r = await cycle(db, d);
    check(r.failed === 1 && job(db, 'n1').status === 'failed' && job(db, 'n1').last_error === 'all_device_tokens_invalid', '6a. falha permanente: failed, com motivo');
    check(r.noDevices === 1 && job(db, 'n2').status === 'cancelled' && job(db, 'n2').last_error === 'no_recipient_devices', '6b. destinatario sem aparelho: cancelled (NAO sent)');
    db.clock.now = T0 + 30 * MIN;
    await cycle(db, d);
    check(d.count('n1') === 1 && d.count('n2') === 1, '6c. nenhuma nova tentativa para falha permanente');
  }

  // --------------------------------------------------------------------------
  // 7. Notificacao ja' entregue + 8. idempotencia
  // --------------------------------------------------------------------------
  {
    const db = createDb({
      jobs: [JOB('s1', { status: 'sent', completed_at: iso(T0 - 60 * MIN), attempts: 1, locked_at: iso(T0 - 60 * MIN), locked_by: 'w-antigo' })],
      notifications: [NOTIF('s1', T0 - 61 * MIN)]
    });
    const d = dispatcher(() => DELIVERED);
    db.clock.now = T0 + 60 * MIN;
    const r = await cycle(db, d);
    check(r.claimed === 0 && d.calls.length === 0 && job(db, 's1').status === 'sent' && job(db, 's1').attempts === 1, '7. job ja\' sent nunca e\' reivindicado, recuperado nem reenviado');

    const db2 = createDb({ jobs: [JOB('n1')], notifications: [NOTIF('n1')] });
    const d2 = dispatcher(() => DELIVERED);
    await cycle(db2, d2); await cycle(db2, d2); await cycle(db2, d2);
    check(d2.count('n1') === 1 && job(db2, 'n1').attempts === 1, '8a. ciclos repetidos: um unico envio');
    const { data: marked } = await db2.rpc('mark_notification_job_sent', { p_notification_id: 'n1' });
    check(marked === false, '8b. marcar como sent duas vezes nao tem efeito');
  }

  // --------------------------------------------------------------------------
  // 9. Limite de tentativas
  // --------------------------------------------------------------------------
  {
    const db = createDb({ jobs: [JOB('n1')], notifications: [NOTIF('n1')] });
    const d = dispatcher(() => TRANSIENT);
    const cfg = { maxNotificationAgeMs: 24 * 60 * MIN }; // isola o limite de tentativas da expiracao
    const deadReport: any[] = [];
    const waits: number[] = [];
    let last: any = null;
    await quiet(async () => {
      for (let i = 0; i < 8; i++) {
        last = await cycle(db, d, 'w1', undefined, cfg);
        deadReport.push(...last.deadIds.map((id: string) => ({ id, critical: last.criticalUndelivered })));
        const j = job(db, 'n1');
        if (j.status === 'pending') { waits.push(Date.parse(j.next_run_at) - db.clock.now); db.clock.now = Date.parse(j.next_run_at); }
      }
    });
    const j = job(db, 'n1');
    check(d.count('n1') === 5 && j.status === 'dead' && j.attempts === 5, '9a. cinco falhas temporarias: job dead apos max_attempts, sem sexta tentativa');
    check(JSON.stringify(waits) === JSON.stringify([1 * MIN, 2 * MIN, 4 * MIN, 8 * MIN]), '9b. espera crescente entre tentativas (1, 2, 4, 8 min)');
    check(j.last_error === 'HTTP 401' && !!j.completed_at && last.claimed === 0, '9c. ultimo erro preservado; job morto sai da fila');
    check(retryDelayMs(20, DEFAULT_QUEUE_CONFIG) === 15 * MIN, '9d. espera tem teto (15 min)');
    check(deadReport.length === 1 && deadReport[0].id === 'n1' && deadReport[0].critical.length === 1
      && deadReport[0].critical[0].outcome === 'dead' && deadReport[0].critical[0].type === 'booking_expired',
      '9e. job morto e\' reportado uma vez (deadIds) e, sendo critico, entra em criticalUndelivered');
  }

  // --------------------------------------------------------------------------
  // 10. Registros historicos inconsistentes
  // --------------------------------------------------------------------------
  {
    // retrato do que existe em producao: 1 job de agosto + 12 recentes, todos processing/attempts 0
    const snapshot: Array<[string, number]> = [
      ['ago', T0 - 1210 * 60 * MIN], ['d26a', T0 - 26 * 60 * MIN], ['d26b', T0 - 26 * 60 * MIN], ['d26c', T0 - 26 * 60 * MIN],
      ['d14', T0 - 14 * 60 * MIN], ['d10', T0 - 10 * 60 * MIN], ['h2a', T0 - 2 * 60 * MIN], ['h2b', T0 - 2 * 60 * MIN],
      ['h2c', T0 - 2 * 60 * MIN], ['h2d', T0 - 2 * 60 * MIN], ['h2e', T0 - 2 * 60 * MIN], ['h2f', T0 - 2 * 60 * MIN], ['h2g', T0 - 2 * 60 * MIN]
    ];
    const db = createDb({
      jobs: snapshot.map(([id, ms]) => JOB(id, { status: 'processing', locked_at: iso(ms + MIN), locked_by: 'edge-cron-antigo', created_at: iso(ms) })),
      notifications: snapshot.map(([id, ms]) => NOTIF(id, ms))
    });
    const d = dispatcher(() => DELIVERED);
    const r = await cycle(db, d);
    check(r.recovered.expired === 13 && d.calls.length === 0, '10a. os 13 jobs presos de producao: todos antigos demais -> expired, NENHUM push atrasado e\' enviado');
    check(db.tables.notification_jobs.every((j: Row) => j.status === 'expired' && j.last_error === 'expired_before_delivery' && j.locked_by === null), '10b. ficam em estado final, com motivo e sem trava');

    // com janela maior (configuravel), os recentes voltam a fila e os antigos expiram
    const db2 = createDb({
      jobs: snapshot.map(([id, ms]) => JOB(id, { status: 'processing', locked_at: iso(ms + MIN), locked_by: 'edge-cron-antigo', created_at: iso(ms) })),
      notifications: snapshot.map(([id, ms]) => NOTIF(id, ms))
    });
    const r2 = await recoverStaleJobs(db2, T0, { ...DEFAULT_QUEUE_CONFIG, maxNotificationAgeMs: 3 * 60 * MIN });
    check(r2.requeued === 7 && r2.expired === 6, '10c. com limite de 3 h: 7 recentes voltam a fila, 6 antigos expiram');

    // notificacao apagada, trava sem dono, job pendente velho, job em status nao previsto
    const db3 = createDb({
      jobs: [
        JOB('orfao', { status: 'processing', locked_at: iso(T0 - 20 * MIN), locked_by: 'w-morto' }),
        JOB('semdono', { status: 'processing', locked_at: iso(T0 - 20 * MIN), locked_by: null }),
        JOB('velho', { status: 'pending', created_at: iso(T0 - 5 * 60 * MIN) }),
        JOB('retry', { status: 'retry' })
      ],
      notifications: [NOTIF('semdono', T0 - 20 * MIN), NOTIF('velho', T0 - 5 * 60 * MIN), NOTIF('retry')]
    });
    const d3 = dispatcher(() => DELIVERED);
    const r3 = await cycle(db3, d3);
    check(job(db3, 'orfao').status === 'expired' && d3.count('orfao') === 0, '10d. job cuja notificacao nao existe mais: encerrado, sem envio');
    check(job(db3, 'semdono').status === 'sent' && d3.count('semdono') === 1, '10e. job abandonado sem locked_by: recuperado e enviado');
    check(job(db3, 'velho').status === 'expired' && d3.count('velho') === 0 && r3.expired === 1, '10f. job pendente antigo demais: expired ao ser reivindicado, sem envio');
    check(job(db3, 'retry').status === 'retry' && d3.count('retry') === 0, '10g. status que a RPC nao seleciona (retry) permanece intocado — nenhum codigo o produz');
  }

  // --------------------------------------------------------------------------
  // 11. Interpretacao da resposta do send-push-notification
  // --------------------------------------------------------------------------
  {
    const I = interpretDispatchResponse;
    check(I(false, { error: 'Unauthorized' }, 'HTTP 401').kind === 'transient_failure', '11a. HTTP 401 (o defeito de producao) = falha temporaria, com nova tentativa');
    check(I(false, null, 'HTTP 500').kind === 'transient_failure' && I(false, { success: false, error: 'boom' }).kind === 'transient_failure', '11b. HTTP 5xx / corpo ausente = falha temporaria');
    check(I(false, { success: false, error: 'Notification not found' }).kind === 'permanent_failure', '11c. notificacao inexistente = falha permanente');
    check(I(true, { success: true, results: [] }).kind === 'no_recipient_devices', '11d. sucesso sem aparelhos = nada a entregar (nao e\' "enviado")');
    const mixed = I(true, { success: true, results: [{ success: true, messageId: 'm' }, { success: false, error: { status: 'NOT_FOUND' } }] });
    check(mixed.kind === 'delivered' && (mixed as any).delivered === 1 && (mixed as any).failed === 1, '11e. ao menos um aparelho aceitou = entregue');
    check(I(true, { success: true, results: [{ success: false, error: { status: 'NOT_FOUND' } }, { success: false, error: { details: [{ errorCode: 'UNREGISTERED' }] } }] }).kind === 'permanent_failure',
      '11f. todos os aparelhos com token invalido = falha permanente');
    check(I(true, { success: true, results: [{ success: false, error: { status: 'UNAVAILABLE' } }] }).kind === 'transient_failure', '11g. provedor indisponivel = falha temporaria (NAO marca como enviado)');
    check(I(true, { success: false, error: 'x' }).kind === 'transient_failure', '11h. success=false em HTTP 200 = falha');
    check(decideRecovery({ attempts: 4, max_attempts: 5, metadata: {} }, iso(T0), T0, DEFAULT_QUEUE_CONFIG) === 'dead', '11i. abandono na ultima tentativa permitida = dead');
  }

  // --------------------------------------------------------------------------
  // 12. Falha ao gravar o desfecho nao perde nem duplica
  // --------------------------------------------------------------------------
  {
    const db = createDb({ jobs: [JOB('n1')], notifications: [NOTIF('n1')] });
    const d = dispatcher(() => DELIVERED);
    // 1a escrita (marcador de inicio) passa; a 2a (confirmacao) falha; mark_sent conclui mesmo assim
    const origFrom = db.from; let updates = 0;
    (db as any).from = (t: string) => {
      const api = origFrom(t); const u = api.update.bind(api);
      api.update = (p: any) => { if (t === 'notification_jobs' && ++updates === 2) db.failNextUpdate.count = 1; return u(p); };
      return api;
    };
    const r = await quiet(() => cycle(db, d));
    check(r.sent === 1 && job(db, 'n1').status === 'sent' && d.count('n1') === 1, '12a. falha ao gravar a confirmacao intermediaria: job ainda termina sent, um envio');

    // worker morre logo apos o envio confirmado, antes de qualquer gravacao posterior
    const db2 = createDb({ jobs: [JOB('n2')], notifications: [NOTIF('n2')] });
    const d2 = dispatcher(() => DELIVERED);
    const origRpc = db2.rpc;
    (db2 as any).rpc = async (name: string, args: Row) => (name === 'mark_notification_job_sent' ? { data: null, error: { message: 'connection reset' } } : origRpc(name, args));
    const r2 = await quiet(() => cycle(db2, d2));
    check(r2.unresolved === 1 && job(db2, 'n2').status === 'processing' && !!job(db2, 'n2').metadata.dispatch_confirmed_at, '12b. marcacao final falhou: job fica processing COM a confirmacao registrada');
    (db2 as any).rpc = origRpc;
    db2.clock.now = T0 + 11 * MIN;
    const r3 = await cycle(db2, d2);
    check(r3.recovered.confirmedSent === 1 && job(db2, 'n2').status === 'sent' && d2.count('n2') === 1, '12c. a recuperacao conclui como sent, sem reenviar');
  }

  // --------------------------------------------------------------------------
  // 13. Tratamento diferenciado: notificacoes temporalmente criticas x demais
  // --------------------------------------------------------------------------
  {
    check(['booking_request', 'booking_accepted', 'booking_rejected', 'booking_cancelled', 'booking_expired'].every(isTimeCritical)
      && !['tip', 'payment_released', 'reminder', 'system', 'reschedule_request', '', null].some((t) => isTimeCritical(t as any)),
      '13a. criticas = pedido, aceite, recusa, cancelamento e expiracao de agendamento; demais tipos nao');
    check(maxAgeMsFor('booking_accepted', DEFAULT_QUEUE_CONFIG) === 60 * MIN && maxAgeMsFor('tip', DEFAULT_QUEUE_CONFIG) === 24 * 60 * MIN
      && maxAgeMsFor(undefined, DEFAULT_QUEUE_CONFIG) === 24 * 60 * MIN, '13b. validade do push: 60 min para criticas, 24 h para as demais');

    // mesma idade (2 h): a critica expira; a comum ainda e' enviada
    const db = createDb({
      jobs: [JOB('crit', { created_at: iso(T0 - 120 * MIN) }), JOB('tip', { created_at: iso(T0 - 120 * MIN) })],
      notifications: [NOTIF('crit', T0 - 120 * MIN, 'booking_accepted'), NOTIF('tip', T0 - 120 * MIN, 'tip')]
    });
    const d = dispatcher(() => DELIVERED);
    const r = await cycle(db, d);
    check(job(db, 'crit').status === 'expired' && d.count('crit') === 0 && job(db, 'tip').status === 'sent' && d.count('tip') === 1,
      '13c. com 2 h de atraso: aviso critico NAO e\' enviado (expired); aviso comum ainda e\' entregue');
    check(r.criticalUndelivered.length === 1 && r.criticalUndelivered[0].id === 'crit' && r.criticalUndelivered[0].outcome === 'expired',
      '13d. a critica nao entregue e\' reportada; a comum entregue nao');

    // falha permanente: critica entra no alerta, comum nao
    const db2 = createDb({ jobs: [JOB('c2'), JOB('t2')], notifications: [NOTIF('c2', T0 - MIN, 'booking_request'), NOTIF('t2', T0 - MIN, 'tip')] });
    const r2 = await cycle(db2, dispatcher(() => ({ kind: 'permanent_failure', error: 'all_device_tokens_invalid' })));
    check(r2.failed === 2 && r2.criticalUndelivered.length === 1 && r2.criticalUndelivered[0].id === 'c2', '13e. falha permanente: so\' a critica entra em criticalUndelivered');

    // destinatario sem aparelho nao e' "critica nao entregue" (nao ha' o que entregar)
    const db3 = createDb({ jobs: [JOB('c3')], notifications: [NOTIF('c3', T0 - MIN, 'booking_accepted')] });
    const r3 = await cycle(db3, dispatcher(() => ({ kind: 'no_recipient_devices' })));
    check(r3.noDevices === 1 && r3.criticalUndelivered.length === 0, '13f. usuario sem aparelho registrado: cancelled, sem alerta de critica');

    // recuperacao de job critico abandonado e ja' vencido tambem e' reportada
    const db4 = createDb({
      jobs: [JOB('c4', { status: 'processing', locked_at: iso(T0 - 90 * MIN), locked_by: 'w-morto' })],
      notifications: [NOTIF('c4', T0 - 90 * MIN, 'booking_request')]
    });
    const r4 = await cycle(db4, dispatcher(() => DELIVERED));
    check(r4.recovered.expired === 1 && r4.criticalUndelivered.length === 1 && r4.criticalUndelivered[0].outcome === 'expire', '13g. critica abandonada e vencida: expired na recuperacao e reportada');
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
