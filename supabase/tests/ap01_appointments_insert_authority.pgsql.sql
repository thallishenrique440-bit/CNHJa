-- =============================================================================
-- AP-01 / BL-01 — Bateria da autoridade de INSERT em appointments
-- =============================================================================
--
-- ALVO: public.check_appointments_insert_authority(), na versao da migration
--       20260925_ap01_appointments_insert_authority.sql
--
-- COMO EXECUTAR (PostgreSQL efemero, NUNCA producao):
--   psql -f supabase/tests/p1205_harness.pgsql.sql
--   psql -f supabase/migrations/20260925_ap01_appointments_insert_authority.sql
--   psql -f supabase/tests/ap01_appointments_insert_authority.pgsql.sql
--
--   O harness nao cria os roles anon/authenticated nem as policies: esta
--   bateria cobre o TRIGGER. Grants e policies sao verificados pelo bloco
--   "VERIFICACAO — DEPOIS" da migration, via catalogo.
--   Se o harness nao tiver os roles anon/authenticated, os REVOKE da migration
--   falham: crie-os antes (CREATE ROLE anon; CREATE ROLE authenticated;).
-- =============================================================================

\set ON_ERROR_STOP on

-- Atores:
--   instrutor A = 22222222-2222-2222-2222-222222222222 (existe em instructors)
--   instrutor B = 44444444-4444-4444-4444-444444444444 (existe em instructors)
--   aluno       = 11111111-1111-1111-1111-111111111111 (NAO e instrutor)
INSERT INTO public.instructors (id) VALUES
  ('22222222-2222-2222-2222-222222222222'),
  ('44444444-4444-4444-4444-444444444444')
ON CONFLICT DO NOTHING;

CREATE TEMP SEQUENCE t_slot_seq;

-- Tenta um INSERT como (role, uid). Devolve NULL em sucesso ou SQLERRM.
CREATE OR REPLACE FUNCTION pg_temp.t_ins(
  p_role text, p_uid uuid,
  p_student uuid, p_instructor uuid, p_status text, p_price int,
  p_payment_status text DEFAULT NULL, p_provider_payment_id text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.role', p_role, true);
  PERFORM set_config('test.uid', coalesce(p_uid::text, ''), true);
  BEGIN
    INSERT INTO public.appointments
      (student_id, instructor_id, date, start_time, end_time, price, status,
       payment_status, provider_payment_id)
    VALUES
      (p_student, p_instructor, current_date + 30 + nextval('t_slot_seq')::int,
       '10:00', '11:00', p_price, p_status,
       coalesce(p_payment_status, 'pending'), p_provider_payment_id);
    RETURN NULL;
  EXCEPTION WHEN others THEN
    RETURN SQLERRM;
  END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.t_assert(p_cond boolean, p_name text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond THEN RAISE NOTICE '  [PASS] %', p_name;
  ELSE RAISE EXCEPTION '  [FAIL] %', p_name; END IF;
END $$;

DO $$
DECLARE
  A  uuid := '22222222-2222-2222-2222-222222222222';
  B  uuid := '44444444-4444-4444-4444-444444444444';
  S  uuid := '11111111-1111-1111-1111-111111111111';
  e  text;
BEGIN
  RAISE NOTICE 'AP-01 — autoridade de INSERT';

  -- Caminho legitimo
  e := pg_temp.t_ins('authenticated', A, NULL, A, 'blocked', 0);
  PERFORM pg_temp.t_assert(e IS NULL, '1  instrutor bloqueia o proprio horario: PERMITIDO');

  -- BL-01: aluno criando aula
  e := pg_temp.t_ins('authenticated', S, S, A, 'confirmed', 1);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '2  aluno insere confirmed/price=1: NEGADO');
  e := pg_temp.t_ins('authenticated', S, S, A, 'reserved', 10000);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '3  aluno insere reserved com preco "correto": NEGADO (compra e backend)');
  e := pg_temp.t_ins('authenticated', S, S, A, 'pending', 10000);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '4  aluno insere pending: NEGADO');

  -- Nao-instrutor tentando se passar por instrutor
  e := pg_temp.t_ins('authenticated', S, NULL, S, 'blocked', 0);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '5  nao-instrutor insere blocked para si: NEGADO');

  -- Instrutor fora do formato de bloqueio
  e := pg_temp.t_ins('authenticated', A, S, A, 'confirmed', 10000);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '6  instrutor cria aula confirmed para aluno: NEGADO');
  e := pg_temp.t_ins('authenticated', A, S, A, 'blocked', 0);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '7  instrutor bloqueio com student_id: NEGADO');
  e := pg_temp.t_ins('authenticated', A, NULL, A, 'blocked', 5000);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '8  instrutor bloqueio com price<>0: NEGADO');
  e := pg_temp.t_ins('authenticated', A, NULL, B, 'blocked', 0);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '9  instrutor bloqueia agenda de OUTRO instrutor: NEGADO');
  e := pg_temp.t_ins('authenticated', A, NULL, A, 'blocked', 0, 'paid');
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '10 bloqueio com payment_status=paid: NEGADO');
  e := pg_temp.t_ins('authenticated', A, NULL, A, 'blocked', 0, NULL, 'pay_x');
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '11 bloqueio com provider_payment_id: NEGADO');

  -- anon
  e := pg_temp.t_ins('anon', NULL, NULL, A, 'blocked', 0);
  PERFORM pg_temp.t_assert(e LIKE '%AP-01%', '12 anon (sem uid): NEGADO');

  -- Nao-regressao: backend oficial
  e := pg_temp.t_ins('service_role', NULL, S, A, 'awaiting_payment', 10199);
  PERFORM pg_temp.t_assert(e IS NULL, '13 service_role cria aula (create-booking-intent): PERMITIDO');

  RAISE NOTICE 'AP-01 — TODAS AS ASSERCOES PASSARAM';
END $$;
