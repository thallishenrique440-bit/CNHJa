-- =============================================================================
-- AP-05 / TRILHA A — Bateria de ferias do instrutor
-- =============================================================================
--
-- COMO EXECUTAR (PostgreSQL efemero, NUNCA producao):
--   psql -f supabase/tests/p1205_harness.pgsql.sql
--   psql -f supabase/tests/ap05a_harness_ext.pgsql.sql
--   psql -f supabase/migrations/20260923_p1204_01_reschedule_appointment_direct.sql
--   psql -f supabase/migrations/20260923_p1205_01 ... _05 (remarcacao)
--   psql -f supabase/migrations/20260924_ap03_ap11_appointments_status_transition_guard.sql
--   psql -f supabase/migrations/20260925_ap01_appointments_insert_authority.sql
--   psql -f supabase/migrations/20260925_ap02_profiles_instructors_minimal_exposure.sql
--   psql -f supabase/migrations/20260925_ap05a_instructor_vacation.sql
--   psql -f supabase/tests/ap05a_instructor_vacation.pgsql.sql
--
-- Itens da especificacao cobertos aqui: A-O, R-U. P, Q, V, W (UI/API) estao
-- em lib/payments/tests/InstructorVacationAP05A.unit.test.ts.
-- =============================================================================

\set ON_ERROR_STOP on
SET TIME ZONE 'America/Sao_Paulo';

CREATE TABLE IF NOT EXISTS _t5 (n text, ok boolean, detail text);
TRUNCATE _t5;
GRANT ALL ON _t5 TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION pg_temp.t(p_n text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE sql AS $$ INSERT INTO _t5 VALUES (p_n, coalesce(p_ok, false), p_detail) $$;

-- Troca o ator: role efetivo (SET ROLE) + auth.role()/auth.uid() do harness.
CREATE OR REPLACE FUNCTION pg_temp.as_actor(p_role text, p_uid text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('test.role', p_role, false);
  PERFORM set_config('test.uid', coalesce(p_uid, ''), false);
  IF p_role IN ('anon', 'authenticated') THEN
    EXECUTE format('SET ROLE %I', p_role);
  END IF;
END $$;

-- Executa SQL; NULL em sucesso, SQLERRM em erro.
CREATE OR REPLACE FUNCTION pg_temp.try(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;

-- Retrato de uma tabela (para provar que nada muda).
CREATE OR REPLACE FUNCTION pg_temp.snap(p_table text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT md5(coalesce(string_agg(t::text, ''|'' ORDER BY t::text), '''')) FROM %s t', p_table)
    INTO v;
  RETURN v;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.t(text, boolean, text), pg_temp.as_actor(text, text),
                          pg_temp.try(text), pg_temp.snap(text) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Dados
--   V1 instrutor que entra em ferias   V2 outro instrutor
--   S  aluno                           D  segunda-feira futura (> 24h)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  V1 uuid := '11111111-1111-1111-1111-111111111111';
  V2 uuid := '11111111-1111-1111-1111-111111111112';
  S  uuid := '22222222-2222-2222-2222-222222222222';
  D  date := current_date + 20;
BEGIN
  WHILE EXTRACT(dow FROM D) <> 1 LOOP D := D + 1; END LOOP;
  PERFORM set_config('t5.day', D::text, false);

  INSERT INTO public.profiles (id, full_name, role, city, is_profile_complete) VALUES
    (V1, 'Instrutor Ferias', 'instructor', 'Cidade', true),
    (V2, 'Instrutor Dois',   'instructor', 'Cidade', true),
    (S,  'Aluno',            'student',    'Cidade', true);

  INSERT INTO public.instructors (id, has_night_lessons, work_saturday_afternoon,
                                  lunch_active, lunch_start_slot, lunch_duration, base_price)
  VALUES (V1, false, false, false, NULL, 0, 10000),
         (V2, false, false, false, NULL, 0, 10000);

  PERFORM set_config('test.role', 'service_role', false);
  -- aula paga e aceita de V1 (existente)
  INSERT INTO public.appointments (id, student_id, instructor_id, date, start_time, end_time,
                                   price, status, payment_status)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', S, V1, D, '10:00', '11:00', 10000, 'confirmed', 'paid');
  -- checkout iniciado ANTES das ferias (R)
  INSERT INTO public.appointments (id, student_id, instructor_id, date, start_time, end_time,
                                   price, status, payment_status, expires_at)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000002', S, V1, D, '15:00', '16:00', 10000,
          'awaiting_payment', 'pending', now() + interval '5 minutes');
  -- aula de V1 com proposta de remarcacao pendente (S — accept)
  INSERT INTO public.appointments (id, student_id, instructor_id, date, start_time, end_time,
                                   price, status, payment_status)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000003', S, V1, D + 7, '10:00', '11:00', 10000, 'confirmed', 'paid');

  INSERT INTO public.transactions (appointment_id, instructor_id, student_id, type, status, gross_amount, net_amount, platform_fee)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', V1, S, 'payment', 'completed', 10199, 9000, 1000);
  INSERT INTO public.payment_installments (appointment_id, instructor_id, student_id, installment_number, status,
                                           gross_amount, net_amount, platform_fee, fee_amount, provider_payment_id)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', V1, S, 1, 'RECEIVED', 10199, 9000, 1000, 199, 'pay_synthetic_fixture_0001');
  INSERT INTO public.payment_settlements (instructor_id, student_id, settlement_type, gross_amount, net_amount, platform_fee, fee_amount)
  VALUES (V1, S, 'PAYMENT', 10199, 9000, 1000, 199);
  INSERT INTO public.refund_operations (appointment_id, status, requested_amount_cents)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'REQUESTED', 10000);
END $$;

-- proposta pendente criada ANTES das ferias (pelo aluno) para o accept de S2
DO $$
DECLARE r jsonb; D date := current_setting('t5.day')::date;
BEGIN
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  RESET ROLE;  -- RPCs de remarcacao: auth.* do harness, execucao como owner (padrao p1205)
  r := public.propose_reschedule(ARRAY['aaaaaaaa-0000-4000-8000-000000000003'::uuid], D + 8, '10:00');
  PERFORM pg_temp.t('00 setup: proposta pendente criada antes das ferias', r->>'status' = 'ok', r::text);
END $$;

-- Retratos ANTES
DO $$
BEGIN
  PERFORM set_config('t5.appt_pre', (
    SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.appointments t
     WHERE t.id IN ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002',
                    'aaaaaaaa-0000-4000-8000-000000000003')), false);
  PERFORM set_config('t5.tx',    pg_temp.snap('public.transactions'), false);
  PERFORM set_config('t5.inst',  pg_temp.snap('public.payment_installments'), false);
  PERFORM set_config('t5.sett',  pg_temp.snap('public.payment_settlements'), false);
  PERFORM set_config('t5.ref',   pg_temp.snap('public.refund_operations'), false);
  -- linha VALIDA pelos CHECK reais (torna o teste de imutabilidade significativo)
  INSERT INTO public.security_audit_logs (environment, event_type, details)
  VALUES ('preview', 'LOGIN_FAILED', '{"fixture":"ap05a"}'::jsonb);
  PERFORM set_config('t5.audit0', (SELECT count(*)::text FROM public.security_audit_logs), false);
END $$;

-- -----------------------------------------------------------------------------
-- D, E, F, G, I — quem pode ligar ferias
-- -----------------------------------------------------------------------------
DO $$
DECLARE e text; v boolean;
BEGIN
  -- F. anon
  PERFORM pg_temp.as_actor('anon', NULL);
  e := pg_temp.try('SELECT public.set_instructor_vacation(true)');
  PERFORM pg_temp.t('F  anon liga ferias: DENY', e LIKE '%permission denied%', e);

  -- D. aluno
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  e := pg_temp.try('SELECT public.set_instructor_vacation(true)');
  PERFORM pg_temp.t('D  aluno liga ferias: DENY', e LIKE '%Somente instrutores%', e);

  -- E. outro instrutor: a RPC so age sobre a propria linha; V1 nao muda
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111112');
  e := pg_temp.try('SELECT public.set_instructor_vacation(true)');
  PERFORM pg_temp.as_actor('service_role', NULL);
  SELECT on_vacation INTO v FROM public.instructors WHERE id = '11111111-1111-1111-1111-111111111111';
  PERFORM pg_temp.t('E  outro instrutor nao consegue ligar ferias de V1', v = false, coalesce(e, 'ok'));
  -- desfaz a ferias do proprio V2 pela via legitima
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111112');
  PERFORM public.set_instructor_vacation(false);

  -- I. UPDATE direto pelo client
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  e := pg_temp.try($q$UPDATE public.instructors SET on_vacation = true WHERE id = '11111111-1111-1111-1111-111111111111'$q$);
  PERFORM pg_temp.t('I  UPDATE direto de on_vacation pelo client: DENY', e LIKE '%AP-05%', e);
  e := pg_temp.try($q$UPDATE public.instructors SET vacation_changed_at = now() WHERE id = '11111111-1111-1111-1111-111111111111'$q$);
  PERFORM pg_temp.t('I2 UPDATE direto de vacation_changed_at: DENY', e LIKE '%AP-05%', e);
  e := pg_temp.try($q$UPDATE public.instructors SET lunch_active = false WHERE id = '11111111-1111-1111-1111-111111111111'$q$);
  PERFORM pg_temp.t('I3 salvar perfil (outras colunas) continua PERMITIDO', e IS NULL, coalesce(e, 'ok'));
  PERFORM pg_temp.as_actor('authenticated', '33333333-3333-3333-3333-333333333333');
  e := pg_temp.try($q$INSERT INTO public.instructors (id, on_vacation) VALUES ('33333333-3333-3333-3333-333333333333', true)$q$);
  PERFORM pg_temp.t('I4 INSERT de instrutor ja em ferias pelo client: DENY', e LIKE '%AP-05%', e);

  -- G. proprio instrutor liga
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  e := pg_temp.try('SELECT public.set_instructor_vacation(true)');
  PERFORM pg_temp.as_actor('service_role', NULL);
  SELECT on_vacation INTO v FROM public.instructors WHERE id = '11111111-1111-1111-1111-111111111111';
  PERFORM pg_temp.t('G  proprio instrutor liga ferias: ALLOW', e IS NULL AND v, coalesce(e, 'ok'));
  PERFORM pg_temp.t('G2 vacation_changed_at registrado',
    (SELECT vacation_changed_at IS NOT NULL FROM public.instructors WHERE id = '11111111-1111-1111-1111-111111111111'));
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- A, B, C — criacao de nova appointment durante ferias
-- -----------------------------------------------------------------------------
DO $$
DECLARE e text; D date := current_setting('t5.day')::date;
BEGIN
  -- A. authenticated (aluno)
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  e := pg_temp.try(format($q$INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status)
                             VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111', %L, '08:00','09:00', 10000, 'awaiting_payment')$q$, D + 1));
  PERFORM pg_temp.t('A  authenticated cria aula para instrutor em ferias: DENY', e IS NOT NULL, e);

  -- B. service_role (create-booking-intent)
  PERFORM pg_temp.as_actor('service_role', NULL);
  e := pg_temp.try(format($q$INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status, expires_at)
                             VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111', %L, '08:00','09:00', 10000, 'awaiting_payment', now())$q$, D + 1));
  PERFORM pg_temp.t('B  service_role cria aula para instrutor em ferias: DENY', e LIKE '%INSTRUCTOR_ON_VACATION%', e);
  e := pg_temp.try(format($q$INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status)
                             VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111', %L, '09:00','10:00', 0, 'blocked')$q$, D + 1));
  PERFORM pg_temp.t('B2 service_role "bloqueio" com aluno durante ferias: DENY', e LIKE '%INSTRUCTOR_ON_VACATION%', e);
  e := pg_temp.try(format($q$INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status)
                             VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111112', %L, '08:00','09:00', 10000, 'awaiting_payment')$q$, D + 1));
  PERFORM pg_temp.t('B3 service_role cria aula para instrutor FORA de ferias: ALLOW (AP-01 preservado)', e IS NULL, coalesce(e, 'ok'));

  -- C. proprio instrutor bloqueia horario durante ferias
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  e := pg_temp.try(format($q$INSERT INTO public.appointments (instructor_id, date, start_time, end_time, price, status)
                             VALUES ('11111111-1111-1111-1111-111111111111', %L, '11:00','12:00', 0, 'blocked')$q$, D + 1));
  PERFORM pg_temp.t('C  proprio instrutor cria bloqueio durante ferias: ALLOW', e IS NULL, coalesce(e, 'ok'));
  e := pg_temp.try(format($q$INSERT INTO public.appointments (instructor_id, date, start_time, end_time, price, status)
                             VALUES ('11111111-1111-1111-1111-111111111111', %L, '13:00','14:00', 5000, 'blocked')$q$, D + 1));
  PERFORM pg_temp.t('C2 bloqueio com price<>0 continua negado (AP-01)', e LIKE '%AP-01%', e);
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- O — disponibilidade durante ferias
-- -----------------------------------------------------------------------------
DO $$
DECLARE n int; nu int; D date := current_setting('t5.day')::date;
BEGIN
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  SELECT count(*), count(*) FILTER (WHERE status = 'unavailable') INTO n, nu
    FROM public.get_instructor_availability('11111111-1111-1111-1111-111111111111', D, D);
  PERFORM pg_temp.t('O  aluno: todos os 16 horarios do dia indisponiveis (0 livres)', n = 16 AND nu = 16, n||'/'||nu);

  PERFORM pg_temp.as_actor('anon', NULL);
  SELECT count(*) INTO n FROM public.get_instructor_availability('11111111-1111-1111-1111-111111111111', D, D + 6);
  PERFORM pg_temp.t('O2 anon: 7 dias x 16 horarios indisponiveis', n = 112, n::text);

  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  SELECT count(*) INTO n FROM public.get_instructor_availability('11111111-1111-1111-1111-111111111111', D, D);
  PERFORM pg_temp.t('O3 o proprio instrutor continua vendo sua agenda real', n = 2, n::text);

  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  SELECT count(*) INTO n FROM public.get_instructor_availability('11111111-1111-1111-1111-111111111112', D + 1, D + 1);
  PERFORM pg_temp.t('O4 outro instrutor (fora de ferias) mantem o comportamento atual', n = 1, n::text);
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- R — checkout iniciado antes das ferias conclui normalmente
-- -----------------------------------------------------------------------------
DO $$
DECLARE e text; s text;
BEGIN
  PERFORM pg_temp.as_actor('service_role', NULL);
  e := pg_temp.try($q$UPDATE public.appointments SET status = 'pending_approval', payment_status = 'paid'
                      WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$);
  SELECT status||'/'||payment_status INTO s FROM public.appointments WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  PERFORM pg_temp.t('R  pagamento de checkout pre-ferias confirma normalmente', e IS NULL AND s = 'pending_approval/paid', coalesce(e, s));
  -- devolve ao estado original para os retratos (simulacao, nao regra de negocio)
  UPDATE public.appointments SET status = 'awaiting_payment', payment_status = 'pending'
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- S — remarcacao durante ferias
-- -----------------------------------------------------------------------------
DO $$
DECLARE r jsonb; e text; n int; D date := current_setting('t5.day')::date;
BEGIN
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  RESET ROLE;

  -- direta (> 24h): o trigger recusa a escrita
  BEGIN
    r := public.reschedule_appointment_direct(ARRAY['aaaaaaaa-0000-4000-8000-000000000001'::uuid], D + 2, '10:00');
    e := r::text;
  EXCEPTION WHEN others THEN e := SQLERRM; r := NULL;
  END;
  PERFORM pg_temp.t('S  remarcacao direta durante ferias: DENY',
    (r IS NULL AND e LIKE '%INSTRUCTOR_ON_VACATION%') OR (r->>'status' = 'error'), e);

  -- proposta
  r := public.propose_reschedule(ARRAY['aaaaaaaa-0000-4000-8000-000000000001'::uuid], D + 2, '10:00');
  PERFORM pg_temp.t('S2 proposta de remarcacao durante ferias: DENY (instructor_on_vacation)',
    r->>'status' = 'error' AND r->>'reason' = 'instructor_on_vacation', r::text);

  -- aceite de proposta criada antes das ferias (pelo instrutor)
  PERFORM set_config('test.uid', '11111111-1111-1111-1111-111111111111', false);
  BEGIN
    r := public.accept_reschedule(ARRAY['aaaaaaaa-0000-4000-8000-000000000003'::uuid]);
    e := r::text;
  EXCEPTION WHEN others THEN e := SQLERRM; r := NULL;
  END;
  PERFORM pg_temp.t('S3 aceite de proposta durante ferias: DENY',
    (r IS NULL AND e LIKE '%INSTRUCTOR_ON_VACATION%') OR (r->>'status' = 'error'), e);

  -- UPDATE direto de data (qualquer caminho) tambem e' recusado
  PERFORM set_config('test.role', 'service_role', false);
  e := pg_temp.try(format($q$UPDATE public.appointments SET date = %L WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, D + 3));
  PERFORM pg_temp.t('S4 UPDATE de data durante ferias (qualquer role): DENY', e LIKE '%INSTRUCTOR_ON_VACATION%', e);

  -- aula original intacta, nao cancelada
  SELECT count(*) INTO n FROM public.appointments
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001' AND date = D AND start_time = '10:00' AND status = 'confirmed';
  PERFORM pg_temp.t('S5 aula original permanece no horario e status originais', n = 1, n::text);
  SELECT count(*) INTO n FROM public.appointments
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003' AND date = D + 7 AND status = 'confirmed';
  PERFORM pg_temp.t('S6 aula com proposta recusada nao e cancelada', n = 1, n::text);
END $$;

-- -----------------------------------------------------------------------------
-- Retrato das 3 aulas pre-existentes DURANTE as ferias (apos A-S)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('t5.appt_now', (
    SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.appointments t
     WHERE t.id IN ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002',
                    'aaaaaaaa-0000-4000-8000-000000000003')), false);
END $$;

-- -----------------------------------------------------------------------------
-- H, U, T — sair das ferias
-- -----------------------------------------------------------------------------
DO $$
DECLARE e text; v boolean; n int; r jsonb; D date := current_setting('t5.day')::date;
BEGIN
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  e := pg_temp.try('SELECT public.set_instructor_vacation(false)');
  PERFORM pg_temp.as_actor('service_role', NULL);
  SELECT on_vacation INTO v FROM public.instructors WHERE id = '11111111-1111-1111-1111-111111111111';
  PERFORM pg_temp.t('H  proprio instrutor desliga ferias: ALLOW', e IS NULL AND NOT v, coalesce(e, 'ok'));

  -- idempotencia: repetir o mesmo estado nao gera evento
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  r := public.set_instructor_vacation(false);
  PERFORM pg_temp.t('H2 repetir o mesmo estado e no-op (unchanged)', r->>'status' = 'unchanged', r::text);

  -- U. disponibilidade restaurada
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  SELECT count(*) INTO n FROM public.get_instructor_availability('11111111-1111-1111-1111-111111111111', D, D);
  PERFORM pg_temp.t('U  sair de ferias restaura a disponibilidade (so horarios realmente ocupados)', n = 2, n::text);

  -- T. remarcacao em periodo normal: comportamento atual preservado
  RESET ROLE;
  PERFORM set_config('test.role', 'authenticated', false);
  PERFORM set_config('test.uid', '22222222-2222-2222-2222-222222222222', false);
  r := public.propose_reschedule(ARRAY['aaaaaaaa-0000-4000-8000-000000000001'::uuid], D + 2, '10:00');
  PERFORM pg_temp.t('T  proposta fora de ferias: comportamento atual (ok)', r->>'status' = 'ok', r::text);

  -- nova reserva volta a ser aceita
  PERFORM set_config('test.role', 'service_role', false);
  e := pg_temp.try(format($q$INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time, price, status, expires_at)
                             VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111', %L, '16:00','17:00', 10000, 'awaiting_payment', now())$q$, D + 1));
  PERFORM pg_temp.t('U2 fora de ferias, nova reserva volta a ser aceita', e IS NULL, coalesce(e, 'ok'));
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- J — historico de ferias (instructor_vacation_events)
-- -----------------------------------------------------------------------------
DO $$
DECLARE n_on int; n_off int; n_total int; e text; n int;
BEGIN
  RESET ROLE;
  SELECT count(*) FILTER (WHERE instructor_id = '11111111-1111-1111-1111-111111111111'
                            AND actor_user_id = '11111111-1111-1111-1111-111111111111' AND active),
         count(*) FILTER (WHERE instructor_id = '11111111-1111-1111-1111-111111111111'
                            AND actor_user_id = '11111111-1111-1111-1111-111111111111' AND NOT active),
         count(*)
    INTO n_on, n_off, n_total
    FROM public.instructor_vacation_events;
  PERFORM pg_temp.t('J  evento de ativacao registrado para V1', n_on = 1, n_on::text);
  PERFORM pg_temp.t('J2 evento de desativacao registrado para V1', n_off = 1, n_off::text);
  -- V2: on + off (E) ; V1: on + off ; no-op nao registra
  PERFORM pg_temp.t('J3 total de eventos = 4 (no-op nao registra)', n_total = 4, n_total::text);
  PERFORM pg_temp.t('J4 changed_at preenchido em todos os eventos',
    (SELECT bool_and(changed_at IS NOT NULL) FROM public.instructor_vacation_events));

  -- imutabilidade (mesmo para o owner / backend)
  e := pg_temp.try('UPDATE public.instructor_vacation_events SET active = NOT active');
  PERFORM pg_temp.t('J5 UPDATE no historico: DENY (imutavel)', e LIKE '%imutavel%', e);
  e := pg_temp.try('DELETE FROM public.instructor_vacation_events');
  PERFORM pg_temp.t('J6 DELETE no historico: DENY (imutavel)', e LIKE '%imutavel%', e);
  e := pg_temp.try('TRUNCATE public.instructor_vacation_events');
  PERFORM pg_temp.t('J7 TRUNCATE no historico: DENY (imutavel)', e LIKE '%imutavel%', e);

  -- RLS fail-closed
  PERFORM pg_temp.t('J8 RLS habilitado e sem nenhuma policy',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.instructor_vacation_events'::regclass)
    AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.instructor_vacation_events'::regclass) = 0);

  -- client: nenhum acesso
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  e := pg_temp.try('SELECT 1 FROM public.instructor_vacation_events');
  PERFORM pg_temp.t('J9 authenticated: SELECT DENY', e LIKE '%permission denied%', e);
  e := pg_temp.try($q$INSERT INTO public.instructor_vacation_events (instructor_id, active, actor_user_id)
                      VALUES ('11111111-1111-1111-1111-111111111111', true, '11111111-1111-1111-1111-111111111111')$q$);
  PERFORM pg_temp.t('J10 authenticated: INSERT direto DENY', e LIKE '%permission denied%', e);
  e := pg_temp.try('UPDATE public.instructor_vacation_events SET active = true');
  PERFORM pg_temp.t('J11 authenticated: UPDATE DENY', e LIKE '%permission denied%', e);
  e := pg_temp.try('DELETE FROM public.instructor_vacation_events');
  PERFORM pg_temp.t('J12 authenticated: DELETE DENY', e LIKE '%permission denied%', e);
  e := pg_temp.try('TRUNCATE public.instructor_vacation_events');
  PERFORM pg_temp.t('J13 authenticated: TRUNCATE DENY', e LIKE '%permission denied%', e);
  PERFORM pg_temp.as_actor('anon', NULL);
  e := pg_temp.try('SELECT 1 FROM public.instructor_vacation_events');
  PERFORM pg_temp.t('J14 anon: SELECT DENY', e LIKE '%permission denied%', e);
  e := pg_temp.try($q$INSERT INTO public.instructor_vacation_events (instructor_id, active, actor_user_id)
                      VALUES ('11111111-1111-1111-1111-111111111111', true, '11111111-1111-1111-1111-111111111111')$q$);
  PERFORM pg_temp.t('J15 anon: INSERT direto DENY', e LIKE '%permission denied%', e);
  RESET ROLE;
  SELECT count(*) INTO n FROM public.instructor_vacation_events;
  PERFORM pg_temp.t('J16 historico intacto apos todas as tentativas', n = 4, n::text);
END $$;

-- -----------------------------------------------------------------------------
-- J-SAL — security_audit_logs: fidelidade do harness e nao-alteracao
-- -----------------------------------------------------------------------------
DO $$
DECLARE e text; n int;
BEGIN
  RESET ROLE;
  -- o harness reproduz os CHECK reais: os valores da implementacao anterior sao recusados
  e := pg_temp.try($q$INSERT INTO public.security_audit_logs (environment, event_type) VALUES ('database', 'LOGIN_FAILED')$q$);
  PERFORM pg_temp.t('SAL1 CHECK real: environment=''database'' recusado', e LIKE '%chk_security_audit_environment%', e);
  e := pg_temp.try($q$INSERT INTO public.security_audit_logs (environment, event_type) VALUES ('production', 'instructor_vacation_on')$q$);
  PERFORM pg_temp.t('SAL2 CHECK real: event_type=''instructor_vacation_on'' recusado', e LIKE '%chk_security_audit_event_type%', e);
  e := pg_temp.try($q$INSERT INTO public.security_audit_logs (environment, event_type) VALUES ('production', 'instructor_vacation_off')$q$);
  PERFORM pg_temp.t('SAL3 CHECK real: event_type=''instructor_vacation_off'' recusado', e LIKE '%chk_security_audit_event_type%', e);

  SELECT count(*) INTO n FROM public.security_audit_logs;
  PERFORM pg_temp.t('SAL4 ferias nao escreveram em security_audit_logs',
    n = current_setting('t5.audit0')::int, n::text);
  e := pg_temp.try($q$UPDATE public.security_audit_logs SET ip_address = 'x'$q$);
  PERFORM pg_temp.t('SAL5 security_audit_logs continua imutavel', e LIKE '%imut%', e);
  PERFORM pg_temp.t('SAL6 CHECKs de security_audit_logs inalterados (2, mesmos nomes)',
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.security_audit_logs'::regclass
        AND contype = 'c' AND conname IN ('chk_security_audit_environment','chk_security_audit_event_type')) = 2);
END $$;

-- -----------------------------------------------------------------------------
-- K, L, M, N — ferias nao alteraram aulas existentes nem dados financeiros
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.t('K  entrar em ferias nao altera appointments existentes',
    current_setting('t5.appt_now') = current_setting('t5.appt_pre'), '');
  PERFORM pg_temp.t('L  transactions inalteradas',
    pg_temp.snap('public.transactions') = current_setting('t5.tx'), '');
  PERFORM pg_temp.t('M  payment_installments inalteradas',
    pg_temp.snap('public.payment_installments') = current_setting('t5.inst'), '');
  PERFORM pg_temp.t('N  payment_settlements inalteradas',
    pg_temp.snap('public.payment_settlements') = current_setting('t5.sett'), '');
  PERFORM pg_temp.t('N2 refund_operations inalteradas',
    pg_temp.snap('public.refund_operations') = current_setting('t5.ref'), '');
END $$;

\echo '================= RESULTADO AP-05/A ================='
SELECT n AS teste, detail FROM _t5 WHERE NOT ok ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail, count(*) AS total FROM _t5;
