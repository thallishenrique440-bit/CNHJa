/**
 * FASE 3 — backend do novo fluxo sobre o contrato da Fase 2, em PostgreSQL 17 REAL.
 *
 * COMO
 *   `embedded-postgres` sobe um servidor PostgreSQL 17.9 local, temporario.
 *   O esquema minimo equivalente ao de producao e' criado (colunas, CHECKs,
 *   indices unicos, triggers AP-01/AP-03 das migrations do repositorio) e o
 *   ARQUIVO da migration da Fase 2 e' aplicado sem alteracao.
 *   O `BookingRequestService` (o mesmo modulo usado pelo endpoint da Vercel e
 *   pelas Edge Functions) e' executado contra esse banco por um adaptador
 *   minimo que traduz `.rpc()` e a consulta do ciclo de expiracao.
 *
 * CONCORRENCIA REAL
 *   As disputas usam CONEXOES INDEPENDENTES (pg.Client) com transacoes
 *   abertas: a sessao A trava o grupo e a sessao B fica bloqueada no mesmo
 *   bloqueio ate' A terminar. Ha' tambem rodadas com as duas chamadas
 *   disparadas ao mesmo tempo em sessoes diferentes.
 *
 * NAO COBERTO AQUI
 *   Os handlers HTTP (Vercel/Edge) nao sao executados; o provedor de pagamento
 *   e' simulado nas funcoes injetadas do ciclo de expiracao.
 *
 * Uso: npx tsx lib/payments/tests/BookingRequestFase3.pg.test.ts
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error -- o moduleResolution do projeto nao le os tipos deste pacote (so' usado em teste)
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { BookingRequestService, runRequestExpiryCycle, requestResponseDeadlineIso } from '../BookingRequestService.js';

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failures.push(label); console.error(`  ❌ ${label}`); }
};
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const PORT = 55000 + Math.floor(Math.random() * 3000);
const INSTR = '10000000-0000-4000-8000-000000000001';
const INSTR2 = '10000000-0000-4000-8000-000000000002';
const STUD = '20000000-0000-4000-8000-000000000001';
const STUD2 = '20000000-0000-4000-8000-000000000002';
let seq = 0;
const uuid = (p: string) => `${p}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const BASE_SCHEMA = `
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'service_role') $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.instructors (id uuid PRIMARY KEY, on_vacation boolean NOT NULL DEFAULT false);
CREATE TABLE public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  student_id uuid, instructor_id uuid, date date, start_time time, end_time time,
  category text, price integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending',
  cancelled_reason text, purchase_id uuid, expires_at timestamptz,
  payment_id text, payment_intent_id text, payment_status text DEFAULT 'pending',
  updated_at timestamptz DEFAULT now(), group_id uuid, provider_name text, provider_payment_id text, proposal_status text,
  CONSTRAINT appointments_status_check CHECK (status = ANY (ARRAY['pending','pending_approval','confirmed','scheduled','completed','cancelled','expired','no_show','reserved','awaiting_payment','blocked','cancelling'])),
  CONSTRAINT appointments_payment_status_check CHECK (payment_status = ANY (ARRAY['pending','paid','failed','refunded','authorized','released','refund_requested','refund_denied']))
);
CREATE UNIQUE INDEX idx_unique_active_slot ON public.appointments (instructor_id, date, start_time)
  WHERE status <> ALL (ARRAY['cancelled','failed','rejected','expired']);
CREATE UNIQUE INDEX idx_unique_student_active_slot ON public.appointments (student_id, date, start_time)
  WHERE (status <> ALL (ARRAY['cancelled','failed','rejected','expired'])) AND student_id IS NOT NULL;
CREATE TABLE public.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid, amount integer, status text);
CREATE TABLE public.payment_installments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_payment_id text, status text);
INSERT INTO public.instructors (id) VALUES ('${INSTR}'), ('${INSTR2}');
INSERT INTO public.transactions (amount, status) VALUES (12000, 'completed');
INSERT INTO public.payment_installments (provider_payment_id, status) VALUES ('pay_legacy', 'RECEIVED');
`;

// Adaptador minimo: o que o BookingRequestService usa do cliente Supabase.
function makeDb(pool: pg.Pool) {
  return {
    async rpc(fn: string, args: Record<string, any>) {
      const keys = Object.keys(args);
      const sql = `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`;
      try { const r = await pool.query(sql, keys.map((k) => args[k])); return { data: r.rows[0].r, error: null }; }
      catch (e: any) { return { data: null, error: { message: e.message } }; }
    },
    from(table: string) {
      let cols = '*'; const where: string[] = []; const params: any[] = []; let order = ''; let lim = '';
      const api: any = {
        select(c: string) { cols = c; return api; },
        eq(c: string, v: any) { params.push(v); where.push(`${c} = $${params.length}`); return api; },
        lt(c: string, v: any) { params.push(v); where.push(`${c} < $${params.length}`); return api; },
        in(c: string, vs: any[]) { params.push(vs); where.push(`${c} = ANY($${params.length})`); return api; },
        order(c: string, o: any) { order = ` ORDER BY ${c} ${o?.ascending === false ? 'DESC' : 'ASC'}`; return api; },
        limit(n: number) { lim = ` LIMIT ${n}`; return api; },
        then(res: any, rej: any) {
          return pool.query(`SELECT ${cols} FROM public.${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${order}${lim}`, params)
            .then((r) => ({ data: r.rows, error: null }), (e) => ({ data: null, error: { message: e.message } })).then(res, rej);
        },
      };
      return api;
    },
  } as any;
}

async function main() {
  console.log('=== FASE 3 — backend do novo fluxo em PostgreSQL 17 real (embedded-postgres) ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'cnhja-f3-'));
  const ep = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await ep.initialise();
  await ep.start();
  const cfg = { host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' };
  const pool = new pg.Pool({ ...cfg, max: 10 });
  const session = async () => { const c = new pg.Client(cfg); await c.connect(); return c; };

  try {
    await pool.query(BASE_SCHEMA);
    await pool.query(src('supabase/migrations/20260924_ap03_ap11_appointments_status_transition_guard.sql'));
    await pool.query(`CREATE TRIGGER appointments_security_check_trigger BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.check_appointments_update_security();`);
    await pool.query(src('supabase/migrations/20260925_ap01_appointments_insert_authority.sql'));
    // Linha do fluxo atual ANTES da migration (como em producao).
    const legacyGroup = uuid('40000000');
    await pool.query(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, payment_status, group_id, provider_payment_id, expires_at)
                      VALUES ($1, $2, current_date + 2, '09:00', 12000, 'awaiting_payment', 'pending', $3, 'pay_legacy_open', now() - interval '1 minute')`, [STUD, INSTR, legacyGroup]);
    await pool.query(src('supabase/migrations/20261003_booking_request_atomic_ops.sql'));
    await pool.query(src('supabase/migrations/20261003_booking_request_accept_deadline.sql'));

    const db = makeDb(pool);
    const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows as any[];
    const rowsOf = (g: string) => q(`SELECT * FROM public.appointments WHERE group_id = $1 ORDER BY date, start_time`, [g]);
    const finHash = async () => JSON.stringify(await q(`SELECT * FROM public.transactions ORDER BY id`)) + JSON.stringify(await q(`SELECT * FROM public.payment_installments ORDER BY id`));
    const fin0 = await finHash();
    const legacySnap = JSON.stringify(await rowsOf(legacyGroup));

    // Pedido como o create-booking-intent grava no modo pedido: status pending,
    // booking_flow request, prazo de resposta = inicio da primeira aula, sem cobranca.
    const createRequest = async (o: { days: number[]; time?: string; student?: string; instructor?: string }) => {
      const g = uuid('30000000');
      const lessons = o.days.map((d) => ({ d, time: o.time ?? '10:00' }));
      const dates = (await q(`SELECT (current_date + d)::text AS date FROM unnest($1::int[]) d`, [o.days])).map((r) => r.date);
      const deadline = requestResponseDeadlineIso(dates.map((date: string) => ({ date, startTime: o.time ?? '10:00' })));
      for (let i = 0; i < lessons.length; i++) {
        await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status, booking_flow, group_id, expires_at)
                 VALUES ($1, $2, $3::date, $4::time, $4::time + interval '50 minutes', 12000, 'pending', 'request', $5, $6)`,
          [o.student ?? STUD, o.instructor ?? INSTR, dates[i], o.time ?? '10:00', g, deadline]);
      }
      return g;
    };

    // ------------------------------------------------------------------------
    // 1. Solicitacao sem cobranca
    // ------------------------------------------------------------------------
    {
      const g = await createRequest({ days: [3, 4] });
      const rows = await rowsOf(g);
      const firstStart = new Date(`${rows[0].date.toISOString().slice(0, 10)}T10:00:00-03:00`).getTime();
      check(rows.length === 2 && rows.every((r) => r.status === 'pending' && r.booking_flow === 'request' && !r.provider_payment_id && !r.payment_intent_id && r.payment_status === 'pending'),
        '1a. pedido: aulas pending, booking_flow request, sem cobranca vinculada');
      check(rows.every((r) => new Date(r.expires_at).getTime() === firstStart), '1b. prazo de resposta = inicio da primeira aula do pedido');
      check(await finHash() === fin0, '1c. nenhum registro em transactions nem payment_installments');
    }

    // ------------------------------------------------------------------------
    // 2-3. Aceite e recusa
    // ------------------------------------------------------------------------
    {
      const g = await createRequest({ days: [3], time: '11:00' });
      const r = await BookingRequestService.accept(db, g, INSTR);
      const row = (await rowsOf(g))[0];
      check(r.ok && r.outcome === 'ACCEPTED' && row.status === 'reserved' && !!row.accepted_at
        && Math.abs(new Date(row.expires_at).getTime() - new Date(row.accepted_at).getTime() - 15 * 60000) < 1000,
        '2. aceite valido: reserved, accepted_at, prazo de pagamento de 15 min');

      const g2 = await createRequest({ days: [3], time: '12:00' });
      const fin = await finHash();
      const rj = await BookingRequestService.reject(db, g2, INSTR);
      const r2 = (await rowsOf(g2))[0];
      const reuse = await createRequest({ days: [3], time: '12:00', student: STUD2 }).then(() => true).catch(() => false);
      check(rj.ok && rj.outcome === 'REJECTED' && r2.status === 'cancelled' && r2.cancelled_reason === 'instructor_rejected' && reuse,
        '3. recusa: cancelled / instructor_rejected e horario liberado');
      check(await finHash() === fin && r2.payment_status === 'released', '19. recusa sem nenhum efeito financeiro');
    }

    // ------------------------------------------------------------------------
    // 4. Cancelamento do aluno pendente
    // ------------------------------------------------------------------------
    {
      const g = await createRequest({ days: [3], time: '13:00' });
      const c = await BookingRequestService.cancelByStudent(db, g, STUD);
      check(c.ok && c.outcome === 'CANCELLED' && (await rowsOf(g))[0].cancelled_reason === 'student_cancelled', '4. cancelamento do aluno com o pedido pendente');
    }

    // ------------------------------------------------------------------------
    // 5-7. Concorrencia REAL (sessoes independentes)
    // ------------------------------------------------------------------------
    const lockedRace = async (first: string, firstArgs: string, second: string, secondArgs: string, g: string) => {
      const a = await session(); const b = await session();
      try {
        await a.query('BEGIN');
        const ra = (await a.query(`SELECT public.${first}(${firstArgs}) AS r`, [g])).rows[0].r;
        // B fica BLOQUEADO no FOR UPDATE ate' A terminar.
        let bDone = false;
        const pb = b.query(`SELECT public.${second}(${secondArgs}) AS r`, [g]).then((x) => { bDone = true; return x.rows[0].r; });
        await new Promise((r) => setTimeout(r, 400));
        const blocked = !bDone;
        await a.query('COMMIT');
        const rb = await pb;
        return { ra, rb, blocked };
      } finally { await a.end(); await b.end(); }
    };
    {
      const g = await createRequest({ days: [5], time: '10:00' });
      const x = await lockedRace('booking_request_accept', `$1, '${INSTR}', 15`, 'booking_request_cancel_by_student', `$1, '${STUD}'`, g);
      const st = (await rowsOf(g))[0];
      check(x.blocked && x.ra.outcome === 'ACCEPTED' && x.rb.outcome === 'INVALID_STATE' && st.status === 'reserved',
        '5a. [2 sessoes] aceite trava o grupo; o cancelamento espera o bloqueio e e\' recusado; reserva intacta');

      const g2 = await createRequest({ days: [5], time: '11:00' });
      const y = await lockedRace('booking_request_cancel_by_student', `$1, '${STUD}'`, 'booking_request_accept', `$1, '${INSTR}', 15`, g2);
      const st2 = (await rowsOf(g2))[0];
      check(y.blocked && y.ra.outcome === 'CANCELLED' && y.rb.outcome === 'INVALID_STATE' && st2.status === 'cancelled' && st2.accepted_at === null,
        '5b. [2 sessoes] cancelamento primeiro: o aceite espera e e\' recusado; nada aceito');

      const g3 = await createRequest({ days: [5], time: '12:00' });
      const z = await lockedRace('booking_request_accept', `$1, '${INSTR}', 15`, 'booking_request_reject', `$1, '${INSTR}'`, g3);
      const g4 = await createRequest({ days: [5], time: '13:00' });
      const w = await lockedRace('booking_request_reject', `$1, '${INSTR}'`, 'booking_request_accept', `$1, '${INSTR}', 15`, g4);
      check(z.blocked && z.ra.outcome === 'ACCEPTED' && z.rb.outcome === 'INVALID_STATE' && w.blocked && w.ra.outcome === 'REJECTED' && w.rb.outcome === 'INVALID_STATE',
        '6. [2 sessoes] aceite x recusa nas duas ordens: o segundo espera e e\' recusado');

      // Disparo simultaneo, sem ordem imposta, 15 rodadas com combo de 3 aulas.
      let consistent = 0; let oneWinner = 0;
      for (let i = 0; i < 15; i++) {
        const gc = await createRequest({ days: [6, 7, 8], time: `${String(7 + (i % 11)).padStart(2, '0')}:${i < 11 ? '00' : '30'}` });
        const a = await session(); const b = await session();
        try {
          const [ra, rb] = await Promise.all([
            a.query(`SELECT public.booking_request_accept($1, $2, 15) AS r`, [gc, INSTR]).then((x) => x.rows[0].r),
            b.query(`SELECT public.booking_request_cancel_by_student($1, $2) AS r`, [gc, STUD]).then((x) => x.rows[0].r),
          ]);
          const sts = (await rowsOf(gc)).map((r) => r.status);
          if (new Set(sts).size === 1 && sts.length === 3) consistent++;
          if ([ra, rb].filter((r) => r.ok).length === 1) oneWinner++;
        } finally { await a.end(); await b.end(); }
      }
      check(consistent === 15 && oneWinner === 15, `7. [2 sessoes, disparo simultaneo x15] combo de 3 aulas: sempre um unico vencedor e grupo inteiro no mesmo estado (${consistent}/15, ${oneWinner}/15)`);
    }

    // ------------------------------------------------------------------------
    // 8-12. Pagamento
    // ------------------------------------------------------------------------
    {
      const g = await createRequest({ days: [9], time: '10:00' });
      await BookingRequestService.accept(db, g, INSTR);
      const s1 = await BookingRequestService.startPayment(db, g, STUD);
      const at = await BookingRequestService.attachPayment(db, g, 'asaas', 'pay_ok');
      const cf = await BookingRequestService.confirmPayment(db, g, 'pay_ok');
      const row = (await rowsOf(g))[0];
      check(s1.outcome === 'PAYMENT_STARTED' && at.outcome === 'ATTACHED' && cf.outcome === 'CONFIRMED' && row.status === 'confirmed' && row.payment_status === 'paid',
        '8. pagamento dentro do prazo: confirmed / paid');

      // 12. webhook duplicado: sequencial e simultaneo
      const dup = await BookingRequestService.confirmPayment(db, g, 'pay_ok');
      const g2 = await createRequest({ days: [9], time: '11:00' });
      await BookingRequestService.accept(db, g2, INSTR);
      await BookingRequestService.startPayment(db, g2, STUD);
      await BookingRequestService.attachPayment(db, g2, 'asaas', 'pay_dup');
      const a = await session(); const b = await session();
      const [c1, c2] = await Promise.all([
        a.query(`SELECT public.booking_request_confirm_payment($1, 'pay_dup') AS r`, [g2]).then((x) => x.rows[0].r),
        b.query(`SELECT public.booking_request_confirm_payment($1, 'pay_dup') AS r`, [g2]).then((x) => x.rows[0].r),
      ]);
      await a.end(); await b.end();
      check(dup.outcome === 'ALREADY_CONFIRMED' && [c1.outcome, c2.outcome].sort().join(',') === 'ALREADY_CONFIRMED,CONFIRMED',
        '12. webhook duplicado (sequencial e em 2 sessoes simultaneas): uma confirmacao, a outra ALREADY_CONFIRMED');

      // 11. idempotencia da cobranca: duas cobrancas disputando o vinculo
      const g3 = await createRequest({ days: [9], time: '12:00' });
      await BookingRequestService.accept(db, g3, INSTR);
      await BookingRequestService.startPayment(db, g3, STUD);
      const a2 = await session(); const b2 = await session();
      const [x1, x2] = await Promise.all([
        a2.query(`SELECT public.booking_request_attach_payment($1, 'asaas', 'pay_A') AS r`, [g3]).then((x) => x.rows[0].r),
        b2.query(`SELECT public.booking_request_attach_payment($1, 'asaas', 'pay_B') AS r`, [g3]).then((x) => x.rows[0].r),
      ]);
      await a2.end(); await b2.end();
      const again = await BookingRequestService.attachPayment(db, g3, 'asaas', (await rowsOf(g3))[0].provider_payment_id);
      check([x1.outcome, x2.outcome].sort().join(',') === 'ATTACHED,PAYMENT_CONFLICT' && again.outcome === 'ALREADY_ATTACHED',
        '11. [2 sessoes] duas cobrancas para o mesmo pedido: uma vinculada, a outra recusada (o endpoint cancela a recusada); repeticao idempotente');

      // 9. pagamento depois da expiracao
      const g4 = await createRequest({ days: [9], time: '13:00' });
      await BookingRequestService.accept(db, g4, INSTR);
      await q(`UPDATE public.appointments SET expires_at = now() - interval '1 second' WHERE group_id = $1`, [g4]);
      const sp = await BookingRequestService.startPayment(db, g4, STUD);
      const rep = await runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), getGatewayStatus: async () => null, cancelCharge: async () => true });
      const late = await BookingRequestService.confirmPayment(db, g4, 'pay_late');
      check(sp.outcome === 'RESERVATION_EXPIRED' && rep.expiredGroups.some((e) => e.groupId === g4) && late.outcome === 'NOT_ACTIVE' && (await rowsOf(g4))[0].status === 'expired',
        '9. prazo vencido: pagamento nao inicia; expira; pagamento tardio NAO reativa (NOT_ACTIVE -> excecao da Fase 1)');
    }

    // ------------------------------------------------------------------------
    // 10. Prazo definitivo: min(aceite + 15 min, inicio da aula)
    // ------------------------------------------------------------------------
    {
      // Aula que comeca em `secs` segundos (hora com segundos, horario de Brasilia).
      const lessonIn = async (secs: number, student = STUD2, instructor = INSTR2, pendingDeadlineSecs?: number) => {
        const g = uuid('30000000');
        await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, booking_flow, group_id, expires_at)
                 SELECT $1, $2, ((now() + make_interval(secs => $4)) AT TIME ZONE 'America/Sao_Paulo')::date,
                        date_trunc('second', (now() + make_interval(secs => $4)) AT TIME ZONE 'America/Sao_Paulo')::time,
                        12000, 'pending', 'request', $3, now() + make_interval(secs => $5)`,
          [student, instructor, g, secs, pendingDeadlineSecs ?? secs]);
        return g;
      };
      const startOf = async (g: string) => new Date((await q(`SELECT ((date + start_time) AT TIME ZONE 'America/Sao_Paulo') AS s FROM public.appointments WHERE group_id = $1`, [g]))[0].s).getTime();

      const g6 = await lessonIn(6 * 60);
      const r6 = await BookingRequestService.accept(db, g6, INSTR2);
      const row6 = (await rowsOf(g6))[0];
      check(r6.ok && r6.outcome === 'ACCEPTED' && new Date(row6.expires_at).getTime() === await startOf(g6),
        '10a. aceite 6 min antes da aula: aceito, sem antecedencia minima; prazo = inicio da aula');
      const p6 = await BookingRequestService.startPayment(db, g6, STUD2);
      check(p6.ok && p6.outcome === 'PAYMENT_STARTED', '10b. pagamento permitido dentro desses 6 min');

      const g30 = await lessonIn(30 * 60, STUD, INSTR2);
      await BookingRequestService.accept(db, g30, INSTR2);
      const row30 = (await rowsOf(g30))[0];
      check(Math.abs(new Date(row30.expires_at).getTime() - new Date(row30.accepted_at).getTime() - 15 * 60000) < 1000,
        '10c. aula em 30 min: prazo = aceite + 15 min (o limite do inicio nao atua)');

      // Prazo EXATAMENTE no inicio da aula: aula em 3 s.
      const gEdge = await lessonIn(3, STUD2, INSTR);
      const rEdge = await BookingRequestService.accept(db, gEdge, INSTR);
      const rowEdge = (await rowsOf(gEdge))[0];
      const edgeOk = rEdge.outcome === 'ACCEPTED' && new Date(rowEdge.expires_at).getTime() === await startOf(gEdge);
      await new Promise((r) => setTimeout(r, 3500));
      const pEdge = await BookingRequestService.startPayment(db, gEdge, STUD2);
      const eEdge = await runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), getGatewayStatus: async () => null, cancelCharge: async () => true });
      check(edgeOk && pEdge.outcome === 'RESERVATION_EXPIRED' && eEdge.expiredGroups.some((e) => e.groupId === gEdge) && (await rowsOf(gEdge))[0].status === 'expired',
        '10d. prazo exatamente no inicio da aula: depois do inicio nao inicia pagamento e a reserva expira');

      // Aceite depois do inicio (prazo de resposta artificialmente aberto para isolar a regra).
      const gStarted = await lessonIn(-60, STUD, INSTR, 600);
      const rStarted = await BookingRequestService.accept(db, gStarted, INSTR);
      check(!rStarted.ok && rStarted.outcome === 'TOO_LATE' && (await rowsOf(gStarted))[0].status === 'pending',
        '10e. aceite depois do inicio da aula: recusado (TOO_LATE), nada muda');

      // Combo: o prazo e' o inicio da PRIMEIRA aula.
      const gCombo = uuid('30000000');
      await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, booking_flow, group_id, expires_at)
               SELECT $1, $2, ((now() + make_interval(secs => s)) AT TIME ZONE 'America/Sao_Paulo')::date,
                      date_trunc('second', (now() + make_interval(secs => s)) AT TIME ZONE 'America/Sao_Paulo')::time,
                      12000, 'pending', 'request', $3, now() + interval '5 minutes'
                 FROM unnest(ARRAY[300, 86400]) AS s`, [STUD, INSTR, gCombo]);
      await BookingRequestService.accept(db, gCombo, INSTR);
      const comboRows = await rowsOf(gCombo);
      const firstStart = Math.min(...(await q(`SELECT ((date + start_time) AT TIME ZONE 'America/Sao_Paulo') AS s FROM public.appointments WHERE group_id = $1`, [gCombo])).map((r) => new Date(r.s).getTime()));
      check(comboRows.every((r) => r.status === 'reserved' && new Date(r.expires_at).getTime() === firstStart),
        '10f. combo: grupo inteiro aceito, prazo unico = inicio da primeira aula');

      const sec = (await q(`SELECT prosecdef, array_to_string(proconfig, ',') AS cfg,
                                   has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                                   has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                                   has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
                              FROM pg_proc p WHERE p.oid = 'public.booking_request_accept(uuid,uuid,integer)'::regprocedure`))[0];
      check(sec.prosecdef && /search_path=public/.test(sec.cfg) && !sec.anon && !sec.auth && sec.svc,
        '10g. funcao alterada mantem SECURITY DEFINER, search_path fixo e EXECUTE so\' para service_role');
    }

    // ------------------------------------------------------------------------
    // 13, 17. Cron de expiracao: repeticao, concorrencia e falhas do provedor
    // ------------------------------------------------------------------------
    {
      const gNo = await createRequest({ days: [10], time: '10:00' });           // sem cobranca
      const gPaid = await createRequest({ days: [10], time: '11:00' });         // provedor diz pago
      const gUnpaid = await createRequest({ days: [10], time: '12:00' });       // provedor diz pendente
      const gDown = await createRequest({ days: [10], time: '13:00' });         // provedor fora
      for (const g of [gPaid, gUnpaid, gDown]) {
        await BookingRequestService.accept(db, g, INSTR);
        await BookingRequestService.startPayment(db, g, STUD);
      }
      await BookingRequestService.attachPayment(db, gPaid, 'asaas', 'pay_paid');
      await BookingRequestService.attachPayment(db, gUnpaid, 'asaas', 'pay_unpaid');
      await BookingRequestService.attachPayment(db, gDown, 'asaas', 'pay_down');
      await q(`UPDATE public.appointments SET expires_at = now() - interval '1 second' WHERE group_id = ANY($1)`, [[gNo, gPaid, gUnpaid, gDown]]);

      const cancelled: string[] = [];
      const deps = {
        getGatewayStatus: async (id: string) => (id === 'pay_paid' ? 'RECEIVED' : id === 'pay_unpaid' ? 'PENDING' : null),
        cancelCharge: async (id: string) => { cancelled.push(id); return true; },
      };
      const [r1, r2] = await Promise.all([
        runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), ...deps }),
        runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), ...deps }),
      ]);
      const r3 = await runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), ...deps });
      const st = async (g: string) => (await rowsOf(g))[0].status;
      const expiredTotal = [r1, r2, r3].reduce((n, r) => n + r.expiredGroups.filter((e) => [gNo, gUnpaid].includes(e.groupId)).length, 0);
      check(await st(gNo) === 'expired' && await st(gUnpaid) === 'expired' && expiredTotal === 2,
        '13. cron executado 3 vezes (2 em paralelo): cada pedido expira UMA vez (uma notificacao por grupo)');
      check(await st(gPaid) === 'awaiting_payment' && !cancelled.includes('pay_paid'),
        '17a. provedor diz PAGO: nao expira e nao cancela a cobranca (aguarda a confirmacao)');
      check(await st(gDown) === 'awaiting_payment' && !cancelled.includes('pay_down') && r3.retryLater >= 1,
        '17b. provedor indisponivel: nada muda, nova tentativa no proximo ciclo');
      check(cancelled.includes('pay_unpaid'), '17c. cobranca nao paga e\' cancelada ANTES de expirar');
      const gFail = await createRequest({ days: [10], time: '14:00' });
      await BookingRequestService.accept(db, gFail, INSTR);
      await BookingRequestService.startPayment(db, gFail, STUD);
      await BookingRequestService.attachPayment(db, gFail, 'asaas', 'pay_cancel_fails');
      await q(`UPDATE public.appointments SET expires_at = now() - interval '1 second' WHERE group_id = $1`, [gFail]);
      const rf = await runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), getGatewayStatus: async () => 'PENDING', cancelCharge: async () => false });
      check(await st(gFail) === 'awaiting_payment' && rf.retryLater >= 1, '17d. falha ao cancelar a cobranca: NAO expira (o horario continua protegido)');
    }

    // ------------------------------------------------------------------------
    // 14, 18. Isolamento do fluxo atual e integridade financeira
    // ------------------------------------------------------------------------
    {
      const lg = await BookingRequestService.accept(db, legacyGroup, INSTR);
      const le = await BookingRequestService.expire(db, legacyGroup, true);
      await runRequestExpiryCycle({ db, nowIso: new Date().toISOString(), getGatewayStatus: async () => 'PENDING', cancelCharge: async () => true });
      check(lg.outcome === 'NOT_FOUND' && le.outcome === 'NOT_FOUND' && JSON.stringify(await rowsOf(legacyGroup)) === legacySnap,
        '14a. reserva do fluxo atual (vencida) nao e\' tocada pelas funcoes nem pelo ciclo do novo fluxo');
      check(await finHash() === fin0, '18. transactions e payment_installments intactos em todo o fluxo (a cobranca real fica a cargo do provedor e do webhook)');
    }
  } finally {
    await pool.end();
    await ep.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temporario */ }
  }

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
