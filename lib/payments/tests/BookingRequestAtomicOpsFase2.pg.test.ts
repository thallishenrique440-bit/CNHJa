/**
 * FASE 2 — operacoes atomicas do novo fluxo, executadas em PostgreSQL REAL.
 *
 * COMO
 *   PGlite (PostgreSQL 18 compilado para WebAssembly, em memoria). O teste cria
 *   um esquema minimo equivalente ao de producao (colunas, CHECK de status e de
 *   payment_status, indices unicos, triggers AP-01/AP-03 a partir das
 *   migrations do repositorio, stub de auth.role()/auth.uid()) e aplica o
 *   ARQUIVO da migration da Fase 2 sem alteracoes.
 *
 * O QUE ISTO VALIDA
 *   O SQL da migration: sintaxe, constraints, indices, triggers, privilegios
 *   das funcoes e o comportamento de cada transicao.
 *
 * O QUE ISTO NAO VALIDA
 *   - Producao (PostgreSQL 17.6 do Supabase, com os objetos reais).
 *   - Disputa real de bloqueio entre DUAS sessoes simultaneas: o PGlite tem uma
 *     unica conexao. As chamadas "concorrentes" aqui sao sequenciais; a
 *     serializacao entre sessoes vem do FOR UPDATE + UPDATE condicional e do
 *     indice unico, e precisa de teste com duas conexoes em banco real.
 *
 * Uso: npx tsx lib/payments/tests/BookingRequestAtomicOpsFase2.pg.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failures.push(label); console.error(`  ❌ ${label}`); }
};
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');
const MIGRATION = 'supabase/migrations/20261003_booking_request_atomic_ops.sql';

const INSTR = '10000000-0000-4000-8000-000000000001';
const INSTR2 = '10000000-0000-4000-8000-000000000002';
const STUD = '20000000-0000-4000-8000-000000000001';
const STUD2 = '20000000-0000-4000-8000-000000000002';
let seq = 0;
const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// Esquema minimo equivalente ao de producao (lido do catalogo em 2026-10-03).
const BASE_SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
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
  category text CHECK (category = ANY (ARRAY['A','B'])),
  price integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  cancelled_reason text, purchase_id uuid, expires_at timestamptz,
  payment_id text, payment_intent_id text, payment_status text DEFAULT 'pending',
  updated_at timestamptz DEFAULT now(), group_id uuid,
  provider_name text, provider_payment_id text, proposal_status text,
  CONSTRAINT appointments_status_check CHECK (status = ANY (ARRAY['pending','pending_approval','confirmed','scheduled','completed','cancelled','expired','no_show','reserved','awaiting_payment','blocked','cancelling'])),
  CONSTRAINT appointments_payment_status_check CHECK (payment_status = ANY (ARRAY['pending','paid','failed','refunded','authorized','released','refund_requested','refund_denied']))
);
CREATE UNIQUE INDEX idx_unique_active_slot ON public.appointments (instructor_id, date, start_time)
  WHERE status <> ALL (ARRAY['cancelled','failed','rejected','expired']);
CREATE UNIQUE INDEX idx_unique_student_active_slot ON public.appointments (student_id, date, start_time)
  WHERE (status <> ALL (ARRAY['cancelled','failed','rejected','expired'])) AND student_id IS NOT NULL;
CREATE TABLE public.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount integer, status text);
CREATE TABLE public.payment_installments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_payment_id text, status text);
INSERT INTO public.instructors (id) VALUES ('${INSTR}'), ('${INSTR2}');
INSERT INTO public.transactions (amount, status) VALUES (12000, 'completed');
INSERT INTO public.payment_installments (provider_payment_id, status) VALUES ('pay_legacy', 'RECEIVED');
`;

async function main() {
  console.log('=== FASE 2 — operacoes atomicas em PostgreSQL real (PGlite) ===\n');
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  // Triggers existentes de producao, a partir das migrations do repositorio.
  await db.exec(src('supabase/migrations/20260924_ap03_ap11_appointments_status_transition_guard.sql'));
  await db.exec(`CREATE TRIGGER appointments_security_check_trigger BEFORE UPDATE ON public.appointments
                 FOR EACH ROW EXECUTE FUNCTION public.check_appointments_update_security();`);
  await db.exec(src('supabase/migrations/20260925_ap01_appointments_insert_authority.sql'));

  const q = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows as any[];
  const one = async (sql: string, params: any[] = []) => (await q(sql, params))[0];
  const asClient = async (role: string, sub: string | null, sql: string, params: any[] = []) => {
    await db.exec(`SELECT set_config('request.jwt.claim.role', '${role}', false), set_config('request.jwt.claim.sub', '${sub ?? ''}', false)`);
    try { await db.query(sql, params); return null; }
    catch (e: any) { return String(e?.message ?? e); }
    finally { await db.exec(`SELECT set_config('request.jwt.claim.role', '', false), set_config('request.jwt.claim.sub', '', false)`); }
  };
  const call = async (fn: string, args: any[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(', ');
    return (await one(`SELECT public.${fn}(${ph}) AS r`, args)).r as { ok: boolean; outcome: string; [k: string]: any };
  };
  const rowsOf = (group: string) => q(`SELECT * FROM public.appointments WHERE group_id = $1 ORDER BY start_time`, [group]);
  const snapshot = async () => JSON.stringify(await q(`SELECT * FROM public.appointments ORDER BY id`));
  const finSnapshot = async () => JSON.stringify(await q(`SELECT * FROM public.transactions ORDER BY id`)) + JSON.stringify(await q(`SELECT * FROM public.payment_installments ORDER BY id`));

  // Pedido do novo fluxo: dias no futuro, hora em Brasilia.
  const insertRequest = async (o: { group?: string; instructor?: string; student?: string; day?: number; time?: string; status?: string; expiresInMin?: number | null } = {}) => {
    const group = o.group ?? uuid('30000000');
    const expires = o.expiresInMin === null ? null : `now() + interval '${o.expiresInMin ?? 120} minutes'`;
    await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status, payment_status, group_id, booking_flow, expires_at)
             VALUES ($1, $2, current_date + $3::int, $4::time, $4::time + interval '50 minutes', 12000, $5, 'pending', $6, 'request', ${expires ?? 'NULL'})`,
      [o.student ?? STUD, o.instructor ?? INSTR, o.day ?? 5, o.time ?? '10:00', o.status ?? 'pending', group]);
    return group;
  };

  // --------------------------------------------------------------------------
  // A. Migration sobre dados existentes: preservacao e idempotencia
  // --------------------------------------------------------------------------
  const legacyGroup = uuid('40000000');
  await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, payment_status, group_id, provider_payment_id)
           VALUES ($1, $2, current_date + 3, '09:00', 12000, 'pending_approval', 'paid', $3, 'pay_legacy'),
                  ($1, $2, current_date + 4, '09:00', 12000, 'confirmed', 'paid', $3, 'pay_legacy'),
                  ($1, $2, current_date - 2, '09:00', 12000, 'expired', 'refund_denied', NULL, NULL),
                  (NULL, $2, current_date + 6, '15:00', 0, 'blocked', 'pending', NULL, NULL)`, [STUD, INSTR, legacyGroup]);
  const beforeMigration = await q(`SELECT * FROM public.appointments ORDER BY id`);
  await db.exec(src(MIGRATION));
  const afterMigration = await q(`SELECT * FROM public.appointments ORDER BY id`);
  check(afterMigration.every((r) => r.booking_flow === 'legacy' && r.accepted_at === null), 'A1. linhas existentes recebem booking_flow=legacy e accepted_at nulo');
  const strip = (r: any) => { const { booking_flow, accepted_at, ...rest } = r; return rest; };
  check(JSON.stringify(afterMigration.map(strip)) === JSON.stringify(beforeMigration), 'A2. nenhuma outra coluna das linhas existentes mudou');
  let rerunError: string | null = null;
  try { await db.exec(src(MIGRATION)); } catch (e: any) { rerunError = String(e?.message ?? e); }
  const cons = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.appointments'::regclass AND contype = 'c' AND conname LIKE 'appointments_%flow%'`);
  check(rerunError === null && cons.length === 2, `A3. migration reaplicada sem erro e sem duplicar constraints${rerunError ? ' — ' + rerunError : ''}`);
  const badFlow = await q(`SELECT 1`).then(async () => { try { await q(`UPDATE public.appointments SET booking_flow = 'x' WHERE group_id = $1`, [legacyGroup]); return null; } catch (e: any) { return String(e.message); } });
  const badAccepted = await (async () => { try { await q(`UPDATE public.appointments SET accepted_at = now() WHERE group_id = $1`, [legacyGroup]); return null; } catch (e: any) { return String(e.message); } })();
  check(!!badFlow && /booking_flow_check/.test(badFlow) && !!badAccepted && /accepted_at_flow_check/.test(badAccepted), 'A4. CHECK: booking_flow so\' legacy/request; accepted_at so\' em linhas request');
  const legacySnap = JSON.stringify(await rowsOf(legacyGroup));

  // --------------------------------------------------------------------------
  // B. Solicitacoes simultaneas para o mesmo horario
  // --------------------------------------------------------------------------
  {
    await insertRequest({ day: 7, time: '08:00' });
    let dupInstr: string | null = null;
    try { await insertRequest({ day: 7, time: '08:00', student: STUD2 }); } catch (e: any) { dupInstr = String(e.message); }
    check(!!dupInstr && /idx_unique_active_slot/.test(dupInstr), 'B1. segundo pedido para o mesmo horario do instrutor: recusado pelo indice unico');
    let dupStud: string | null = null;
    try { await insertRequest({ day: 7, time: '08:00', instructor: INSTR2 }); } catch (e: any) { dupStud = String(e.message); }
    check(!!dupStud && /idx_unique_student_active_slot/.test(dupStud), 'B2. mesmo aluno, mesmo horario, outro instrutor: recusado pelo indice do aluno');
    let vsLegacy: string | null = null;
    try { await insertRequest({ day: 3, time: '09:00', student: STUD2 }); } catch (e: any) { vsLegacy = String(e.message); }
    check(!!vsLegacy && /idx_unique_active_slot/.test(vsLegacy), 'B3. pedido novo contra horario ocupado por aula do fluxo atual: recusado');
  }

  // --------------------------------------------------------------------------
  // C. Aceite
  // --------------------------------------------------------------------------
  {
    const g = await insertRequest({ day: 10, time: '10:00' });
    await insertRequest({ group: g, day: 11, time: '10:00' }); // combo de 2 aulas
    const r1 = await call('booking_request_accept', [g, INSTR, 15]);
    const rows = await rowsOf(g);
    const deadlineOk = rows.every((r) => Math.abs(new Date(r.expires_at).getTime() - (new Date(r.accepted_at).getTime() + 15 * 60000)) < 1000);
    check(r1.ok && r1.outcome === 'ACCEPTED' && r1.lessons === 2 && rows.every((r) => r.status === 'reserved' && r.accepted_at), 'C1. aceite: as 2 aulas do grupo vao para reserved com accepted_at');
    check(deadlineOk, 'C2. prazo de pagamento = aceite + 15 min, no relogio do banco');
    const snap = JSON.stringify(rows);
    const r2 = await call('booking_request_accept', [g, INSTR, 15]);
    check(r2.ok && r2.outcome === 'ALREADY_ACCEPTED' && JSON.stringify(await rowsOf(g)) === snap, 'C3. aceite repetido: ALREADY_ACCEPTED, nenhuma escrita (prazo nao e\' renovado)');

    const g2 = await insertRequest({ day: 12, time: '10:00' });
    const s2 = JSON.stringify(await rowsOf(g2));
    const f = await call('booking_request_accept', [g2, INSTR2, 15]);
    check(!f.ok && f.outcome === 'FORBIDDEN' && JSON.stringify(await rowsOf(g2)) === s2, 'C4. instrutor de outra aula: FORBIDDEN, nada muda');
    const lg = await call('booking_request_accept', [legacyGroup, INSTR, 15]);
    check(!lg.ok && lg.outcome === 'NOT_FOUND' && JSON.stringify(await rowsOf(legacyGroup)) === legacySnap, 'C5. grupo do fluxo atual: NOT_FOUND, nada muda');

    const gLate = uuid('30000000');
    await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, group_id, booking_flow, expires_at)
             SELECT $1, $2, (now() AT TIME ZONE 'America/Sao_Paulo' + interval '10 minutes')::date,
                    date_trunc('minute', now() AT TIME ZONE 'America/Sao_Paulo' + interval '10 minutes')::time, 12000, 'pending', $3, 'request', now() + interval '1 hour'`, [STUD2, INSTR2, gLate]);
    const tl = await call('booking_request_accept', [gLate, INSTR2, 15]);
    check(!tl.ok && tl.outcome === 'TOO_LATE' && (await rowsOf(gLate))[0].status === 'pending', 'C6. aula comeca antes do fim da janela de pagamento: TOO_LATE, continua pending');

    const gExp = await insertRequest({ day: 13, time: '10:00', expiresInMin: -1 });
    const re = await call('booking_request_accept', [gExp, INSTR, 15]);
    check(!re.ok && re.outcome === 'REQUEST_EXPIRED' && (await rowsOf(gExp))[0].status === 'pending', 'C7. prazo de resposta vencido: REQUEST_EXPIRED, sem aceite');
    const bad = await call('booking_request_accept', [g2, INSTR, 0]);
    check(!bad.ok && bad.outcome === 'INVALID_ARGUMENT', 'C8. janela invalida: INVALID_ARGUMENT');

    // Grupo inconsistente (uma aula cancelada): nenhuma linha muda.
    const gMix = await insertRequest({ day: 14, time: '10:00' });
    await insertRequest({ group: gMix, day: 15, time: '10:00', status: 'cancelled' });
    const sm = JSON.stringify(await rowsOf(gMix));
    const mx = await call('booking_request_accept', [gMix, INSTR, 15]);
    check(!mx.ok && mx.outcome === 'INVALID_STATE' && JSON.stringify(await rowsOf(gMix)) === sm, 'C9. grupo com aula fora de pending: INVALID_STATE, nenhuma aula aceita (tudo ou nada)');
  }

  // --------------------------------------------------------------------------
  // D. Aceite x recusa (chamadas em sequencia sobre o mesmo pedido)
  // --------------------------------------------------------------------------
  {
    const g = await insertRequest({ day: 16, time: '10:00' });
    const a = await call('booking_request_accept', [g, INSTR, 15]);
    const s = JSON.stringify(await rowsOf(g));
    const r = await call('booking_request_reject', [g, INSTR]);
    check(a.outcome === 'ACCEPTED' && !r.ok && r.outcome === 'INVALID_STATE' && JSON.stringify(await rowsOf(g)) === s, 'D1. aceite primeiro: a recusa seguinte e\' recusada, a reserva permanece');

    const g2 = await insertRequest({ day: 17, time: '10:00' });
    const r2 = await call('booking_request_reject', [g2, INSTR]);
    const row = (await rowsOf(g2))[0];
    check(r2.ok && r2.outcome === 'REJECTED' && row.status === 'cancelled' && row.cancelled_reason === 'instructor_rejected' && row.payment_status === 'released',
      'D2. recusa: cancelled / instructor_rejected / released, sem cobranca');
    const a2 = await call('booking_request_accept', [g2, INSTR, 15]);
    check(!a2.ok && a2.outcome === 'INVALID_STATE' && (await rowsOf(g2))[0].status === 'cancelled', 'D3. recusa primeiro: o aceite seguinte e\' recusado');
    const r3 = await call('booking_request_reject', [g2, INSTR]);
    check(r3.ok && r3.outcome === 'ALREADY_REJECTED', 'D4. recusa repetida: ALREADY_REJECTED');
    const free = await insertRequest({ day: 17, time: '10:00', student: STUD2 }).then(() => true).catch(() => false);
    check(free, 'D5. horario recusado fica livre para novo pedido');

    const g3 = await insertRequest({ day: 18, time: '10:00' });
    await q(`UPDATE public.appointments SET provider_payment_id = 'pay_x' WHERE group_id = $1`, [g3]);
    const r4 = await call('booking_request_reject', [g3, INSTR]);
    check(!r4.ok && r4.outcome === 'HAS_PAYMENT' && (await rowsOf(g3))[0].status === 'pending', 'D6. pedido com cobranca vinculada: HAS_PAYMENT (recusa com dinheiro nao e\' feita aqui)');
  }

  // --------------------------------------------------------------------------
  // D'. Cancelamento pelo aluno x aceite do instrutor (decisao de 03/10)
  // --------------------------------------------------------------------------
  {
    const g = await insertRequest({ day: 30, time: '10:00' });
    await insertRequest({ group: g, day: 31, time: '10:00' });
    const c1 = await call('booking_request_cancel_by_student', [g, STUD]);
    const rows = await rowsOf(g);
    check(c1.ok && c1.outcome === 'CANCELLED' && c1.lessons === 2 && rows.every((r) => r.status === 'cancelled' && r.cancelled_reason === 'student_cancelled' && r.payment_status === 'released'),
      'D7. cancelamento do aluno: o grupo inteiro vai para cancelled / student_cancelled / released');
    const a = await call('booking_request_accept', [g, INSTR, 15]);
    check(!a.ok && a.outcome === 'INVALID_STATE' && (await rowsOf(g)).every((r) => r.status === 'cancelled' && r.accepted_at === null), 'D8. cancelamento primeiro: o aceite seguinte e\' recusado, nada e\' aceito');
    const c2 = await call('booking_request_cancel_by_student', [g, STUD]);
    check(c2.ok && c2.outcome === 'ALREADY_CANCELLED', 'D9. cancelamento repetido: ALREADY_CANCELLED');
    const free = await insertRequest({ day: 30, time: '10:00', student: STUD2 }).then(() => true).catch(() => false);
    check(free, 'D10. horario liberado imediatamente para novo pedido');

    const g2 = await insertRequest({ day: 32, time: '10:00' });
    await insertRequest({ group: g2, day: 33, time: '10:00' });
    const a2 = await call('booking_request_accept', [g2, INSTR, 15]);
    const s = JSON.stringify(await rowsOf(g2));
    const c3 = await call('booking_request_cancel_by_student', [g2, STUD]);
    check(a2.outcome === 'ACCEPTED' && !c3.ok && c3.outcome === 'INVALID_STATE' && JSON.stringify(await rowsOf(g2)) === s, 'D11. aceite primeiro: o cancelamento seguinte e\' recusado, a reserva fica intacta');
    const f = await call('booking_request_cancel_by_student', [g2, STUD2]);
    check(!f.ok && f.outcome === 'FORBIDDEN', 'D12. outro aluno nao cancela o pedido');
    const mix = await rowsOf(g2);
    check(mix.every((r) => r.status === 'reserved'), 'D13. nenhum grupo fica meio aceito e meio cancelado');
  }

  // --------------------------------------------------------------------------
  // E-G. Pagamento: inicio, vinculo da cobranca e confirmacao
  // --------------------------------------------------------------------------
  {
    const g = await insertRequest({ day: 20, time: '10:00' });
    const early = await call('booking_request_start_payment', [g, STUD]);
    check(!early.ok && early.outcome === 'INVALID_STATE', 'E1. pagar antes do aceite: INVALID_STATE');
    const earlyConfirm = await call('booking_request_confirm_payment', [g, 'pay_1']);
    check(!earlyConfirm.ok && earlyConfirm.outcome === 'NOT_ACTIVE' && (await rowsOf(g))[0].status === 'pending', 'E2. confirmar pagamento de pedido NAO aceito: NOT_ACTIVE, nada muda');

    await call('booking_request_accept', [g, INSTR, 15]);
    const fs = await call('booking_request_start_payment', [g, STUD2]);
    check(!fs.ok && fs.outcome === 'FORBIDDEN', 'E3. outro aluno: FORBIDDEN');
    const attachEarly = await call('booking_request_attach_payment', [g, 'asaas', 'pay_1']);
    check(!attachEarly.ok && attachEarly.outcome === 'INVALID_STATE', 'F0. vincular cobranca antes de iniciar o pagamento: INVALID_STATE');
    const s1 = await call('booking_request_start_payment', [g, STUD]);
    const s2 = await call('booking_request_start_payment', [g, STUD]);
    check(s1.ok && s1.outcome === 'PAYMENT_STARTED' && s2.ok && s2.outcome === 'ALREADY_STARTED' && (await rowsOf(g))[0].status === 'awaiting_payment', 'E4. inicio do pagamento e repeticao idempotente');

    const at1 = await call('booking_request_attach_payment', [g, 'asaas', 'pay_1']);
    const at2 = await call('booking_request_attach_payment', [g, 'asaas', 'pay_1']);
    const at3 = await call('booking_request_attach_payment', [g, 'asaas', 'pay_2']);
    check(at1.outcome === 'ATTACHED' && at2.outcome === 'ALREADY_ATTACHED' && !at3.ok && at3.outcome === 'PAYMENT_CONFLICT' && (await rowsOf(g))[0].provider_payment_id === 'pay_1',
      'F1. uma cobranca por reserva: vinculo idempotente; segunda cobranca recusada');

    const mm = await call('booking_request_confirm_payment', [g, 'pay_2']);
    check(!mm.ok && mm.outcome === 'PAYMENT_MISMATCH' && (await rowsOf(g))[0].status === 'awaiting_payment', 'G1. confirmacao com outro pagamento: PAYMENT_MISMATCH');
    const fin0 = await finSnapshot();
    const c1 = await call('booking_request_confirm_payment', [g, 'pay_1']);
    const after = (await rowsOf(g))[0];
    const c2 = await call('booking_request_confirm_payment', [g, 'pay_1']);
    check(c1.ok && c1.outcome === 'CONFIRMED' && after.status === 'confirmed' && after.payment_status === 'paid', 'G2. confirmacao: confirmed / paid');
    check(c2.ok && c2.outcome === 'ALREADY_CONFIRMED' && JSON.stringify((await rowsOf(g))[0]) === JSON.stringify(after), 'G3. evento repetido: ALREADY_CONFIRMED, nenhuma escrita');
    check(await finSnapshot() === fin0, 'G4. a confirmacao nao toca em transactions nem payment_installments');

    // Reserva com prazo vencido, mas ainda ATIVA (cron atrasado): aceita o pagamento.
    const gl = await insertRequest({ day: 21, time: '10:00' });
    await call('booking_request_accept', [gl, INSTR, 15]);
    await q(`UPDATE public.appointments SET expires_at = now() - interval '1 minute' WHERE group_id = $1`, [gl]);
    const sp = await call('booking_request_start_payment', [gl, STUD]);
    check(!sp.ok && sp.outcome === 'RESERVATION_EXPIRED', 'E5. janela vencida: nao inicia novo pagamento');
    const cl = await call('booking_request_confirm_payment', [gl, 'pay_late']);
    check(cl.ok && cl.outcome === 'CONFIRMED', 'G5. pagamento recebido com a reserva ainda ativa (cron atrasado): confirmado — o horario seguia protegido');
  }

  // --------------------------------------------------------------------------
  // H. Expiracao
  // --------------------------------------------------------------------------
  {
    const g = await insertRequest({ day: 22, time: '10:00', expiresInMin: 30 });
    const nd = await call('booking_request_expire', [g, false]);
    check(!nd.ok && nd.outcome === 'NOT_DUE' && (await rowsOf(g))[0].status === 'pending', 'H1. antes do prazo: NOT_DUE');
    await q(`UPDATE public.appointments SET expires_at = now() - interval '1 second' WHERE group_id = $1`, [g]);
    const ex = await call('booking_request_expire', [g, false]);
    const row = (await rowsOf(g))[0];
    const ex2 = await call('booking_request_expire', [g, false]);
    check(ex.ok && ex.outcome === 'EXPIRED' && row.status === 'expired' && row.payment_status === 'released' && ex2.outcome === 'ALREADY_EXPIRED',
      'H2. prazo vencido: expired / released; repeticao idempotente');
    const late = await call('booking_request_confirm_payment', [g, 'pay_after']);
    check(!late.ok && late.outcome === 'NOT_ACTIVE' && (await rowsOf(g))[0].status === 'expired', 'H3. pagamento depois da expiracao: NOT_ACTIVE (vira excecao da Fase 1), aula nao reativada');
    const reuse = await insertRequest({ day: 22, time: '10:00', student: STUD2 }).then(() => true).catch(() => false);
    check(reuse, 'H4. horario expirado fica livre para novo pedido');

    const gc = await insertRequest({ day: 23, time: '10:00' });
    await call('booking_request_accept', [gc, INSTR, 15]);
    await call('booking_request_start_payment', [gc, STUD]);
    await call('booking_request_attach_payment', [gc, 'asaas', 'pay_c']);
    await q(`UPDATE public.appointments SET expires_at = now() - interval '1 second' WHERE group_id = $1`, [gc]);
    const ng = await call('booking_request_expire', [gc, false]);
    check(!ng.ok && ng.outcome === 'NEEDS_GATEWAY_CHECK' && (await rowsOf(gc))[0].status === 'awaiting_payment', 'H5. com cobranca vinculada: so\' expira depois da verificacao do provedor');
    const ok = await call('booking_request_expire', [gc, true]);
    check(ok.ok && ok.outcome === 'EXPIRED', 'H6. cobranca verificada/cancelada pelo chamador: expira');

    const gConf = await insertRequest({ day: 24, time: '10:00' });
    await call('booking_request_accept', [gConf, INSTR, 15]);
    await call('booking_request_confirm_payment', [gConf, 'pay_conf']);
    await q(`UPDATE public.appointments SET expires_at = now() - interval '1 second' WHERE group_id = $1`, [gConf]);
    const ec = await call('booking_request_expire', [gConf, true]);
    check(!ec.ok && ec.outcome === 'INVALID_STATE' && (await rowsOf(gConf))[0].status === 'confirmed', 'H7. aula confirmada nunca expira');
  }

  // --------------------------------------------------------------------------
  // I. Seguranca
  // --------------------------------------------------------------------------
  {
    const fns = ['booking_request_accept', 'booking_request_reject', 'booking_request_cancel_by_student', 'booking_request_start_payment', 'booking_request_attach_payment', 'booking_request_confirm_payment', 'booking_request_expire'];
    const priv = await q(`SELECT p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can
                            FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(rolname)
                           WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'booking_request_%'`);
    check(fns.every((f) => priv.some((p) => p.proname === f)), 'I1. as sete funcoes existem');
    check(priv.filter((p) => p.rolname !== 'service_role').every((p) => p.can === false)
      && priv.filter((p) => p.rolname === 'service_role').every((p) => p.can === true), 'I2. EXECUTE so\' para service_role; anon e authenticated sem acesso');
    const secdef = await q(`SELECT proname, prosecdef, array_to_string(proconfig, ',') AS cfg FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'booking_request_%'`);
    check(secdef.every((s) => s.prosecdef && /search_path=public/.test(s.cfg)), 'I3. SECURITY DEFINER com search_path fixo');

    const g = await insertRequest({ day: 25, time: '10:00' });
    const e1 = await asClient('authenticated', INSTR, `UPDATE public.appointments SET accepted_at = now() WHERE group_id = $1`, [g]);
    const e2 = await asClient('authenticated', STUD, `UPDATE public.appointments SET booking_flow = 'legacy' WHERE group_id = $1`, [g]);
    const e3 = await asClient('authenticated', INSTR, `INSERT INTO public.appointments (instructor_id, date, start_time, price, status, payment_status, booking_flow) VALUES ($1, current_date + 30, '07:00', 0, 'blocked', 'pending', 'request')`, [INSTR]);
    const e4 = await asClient('authenticated', INSTR, `INSERT INTO public.appointments (instructor_id, date, start_time, price, status, payment_status) VALUES ($1, current_date + 30, '07:00', 0, 'blocked', 'pending')`, [INSTR]);
    check(!!e1 && /Fase 2/.test(e1) && !!e2 && /Fase 2/.test(e2), 'I4. cliente nao altera accepted_at nem booking_flow');
    check(!!e3 && /Fase 2/.test(e3) && e4 === null, 'I5. cliente nao cria linha request; o bloqueio de horario do instrutor (fluxo atual) continua funcionando');
    const e5 = await asClient('authenticated', STUD, `UPDATE public.appointments SET status = 'cancelled' WHERE group_id = $1`, [g]);
    const e6 = await asClient('authenticated', INSTR, `UPDATE public.appointments SET status = 'reserved' WHERE group_id = $1`, [g]);
    check(!!e5 && /novo fluxo/.test(e5) && !!e6 && /novo fluxo|AP-0/.test(e6) && (await rowsOf(g))[0].status === 'pending',
      'I6. cliente nao muda status de pedido do novo fluxo (aluno e instrutor): transicoes so\' pelo backend');
    const legacyG = uuid('40000000');
    await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, group_id) VALUES ($1, $2, current_date + 40, '10:00', 12000, 'pending_approval', $3)`, [STUD2, INSTR2, legacyG]);
    const e7 = await asClient('authenticated', STUD2, `UPDATE public.appointments SET status = 'cancelled' WHERE group_id = $1`, [legacyG]);
    check(e7 === null && (await rowsOf(legacyG))[0].status === 'cancelled', 'I7. fluxo atual preservado: regra AP-03 continua permitindo o aluno cancelar antes do aceite');
  }

  // --------------------------------------------------------------------------
  // J. Disponibilidade
  // --------------------------------------------------------------------------
  {
    const g = await insertRequest({ day: 26, time: '11:00' });
    const gLegacy = uuid('40000000');
    await q(`INSERT INTO public.appointments (student_id, instructor_id, date, start_time, price, status, group_id) VALUES ($1, $2, current_date + 26, '12:00', 12000, 'awaiting_payment', $3)`, [STUD, INSTR, gLegacy]);
    const avail = async (sub: string | null) => {
      await db.exec(`SELECT set_config('request.jwt.claim.sub', '${sub ?? ''}', false)`);
      const r = await q(`SELECT start_time::text AS t, status FROM public.get_instructor_availability($1, current_date + 26, current_date + 26) ORDER BY 1`, [INSTR]);
      await db.exec(`SELECT set_config('request.jwt.claim.sub', '', false)`);
      return r.map((x) => `${x.t}=${x.status}`).join(',');
    };
    check(await avail(STUD) === '11:00:00=my_request,12:00:00=my_reservation', 'J1. aluno ve o proprio pedido como my_request; reserva do fluxo atual segue my_reservation');
    check(await avail(STUD2) === '11:00:00=unavailable,12:00:00=unavailable', 'J2. outro aluno ve os dois horarios como indisponiveis');
    await q(`UPDATE public.instructors SET on_vacation = true WHERE id = $1`, [INSTR]);
    const vac = await avail(STUD2);
    await q(`UPDATE public.instructors SET on_vacation = false WHERE id = $1`, [INSTR]);
    check(vac.split(',').length === 16 && vac.split(',').every((s) => s.endsWith('=unavailable')), 'J3. ramo de ferias (AP-05/A) preservado');
    void g;
  }

  // --------------------------------------------------------------------------
  // K. Sem efeitos financeiros e fluxo atual intocado
  // --------------------------------------------------------------------------
  {
    check(JSON.stringify(await rowsOf(legacyGroup)) === legacySnap, 'K1. aulas do fluxo atual nao foram alteradas por nenhuma operacao');
    check(JSON.stringify(await q(`SELECT amount, status FROM public.transactions`)) === JSON.stringify([{ amount: 12000, status: 'completed' }])
      && JSON.stringify(await q(`SELECT provider_payment_id, status FROM public.payment_installments`)) === JSON.stringify([{ provider_payment_id: 'pay_legacy', status: 'RECEIVED' }]),
      'K2. transactions e payment_installments intactos apos todas as operacoes');
    const sql = src(MIGRATION).replace(/^\s*--.*$/gm, '');
    const fnBodies = sql.split('CREATE OR REPLACE FUNCTION public.booking_request_').slice(1).map((b) => b.slice(0, b.indexOf('$function$;')));
    check(fnBodies.length === 7 && fnBodies.every((b) => !/transactions|payment_installments|payment_settlements|payouts|refund_|payment_exceptions/i.test(b)),
      'K3. [fonte] nenhuma funcao referencia tabelas financeiras');
    check(fnBodies.every((b) => /booking_flow = 'request'/.test(b.slice(b.indexOf('UPDATE public.appointments')))),
      'K4. [fonte] todo UPDATE das funcoes se limita a linhas booking_flow = request');
    check(!/ALTER TABLE public\.appointments\s+(DROP|ALTER COLUMN)|DROP INDEX(?! IF EXISTS public\.idx_appointments_request)|DELETE FROM|TRUNCATE|appointments_status_check/i.test(sql),
      'K5. [fonte] migration aditiva: sem DROP/ALTER de coluna existente, sem DELETE, sem mexer no CHECK de status');
  }

  await db.close();
  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
