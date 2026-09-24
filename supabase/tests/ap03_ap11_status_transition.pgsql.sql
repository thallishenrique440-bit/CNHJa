-- =============================================================================
-- AP-03 + AP-11 — Bateria da matriz de transicao de status em appointments
-- =============================================================================
--
-- ALVO: public.check_appointments_update_security(), na versao da migration
--       20260924_ap03_ap11_appointments_status_transition_guard.sql
--
-- COMO EXECUTAR (PostgreSQL efemero, NUNCA producao):
--   psql -f supabase/tests/p1205_harness.pgsql.sql
--   psql -f supabase/migrations/20260924_ap03_ap11_appointments_status_transition_guard.sql
--   psql -f supabase/tests/ap03_ap11_status_transition.pgsql.sql
--
--   O harness p1205_harness.pgsql.sql ja' cria public.appointments,
--   public.instructors, os indices unicos, auth.uid() e auth.role() lidos de
--   current_setting('test.uid') / current_setting('test.role'), e o trigger
--   BEFORE UPDATE (no harness chamado check_appointments_update_security; em
--   producao, appointments_security_check_trigger) — ambos apontam para a
--   mesma funcao que a migration substitui.
--
-- ESTA BATERIA NAO ESCREVE EM PRODUCAO. Nenhum comando aqui e' destinado ao
-- projeto ohftsqsxymtrclnpadam.
-- =============================================================================

\set ON_ERROR_STOP on

-- Atores fixos usados em toda a bateria:
--   aluno     = 11111111-1111-1111-1111-111111111111
--   instrutor = 22222222-2222-2222-2222-222222222222
--   terceiro  = 33333333-3333-3333-3333-333333333333
DO $$
BEGIN
  RAISE NOTICE '======================================================';
  RAISE NOTICE 'AP-03 / AP-11 — matriz de transicao de status';
  RAISE NOTICE '======================================================';
END $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- Cada seed ocupa um DIA distinto: o harness tem indices unicos de slot ativo
-- (idx_unique_active_slot / idx_unique_student_active_slot) e varias linhas
-- desta bateria permanecem ativas (confirmed, completed...). Com data fixa, o
-- segundo seed violaria o indice e abortaria a bateria inteira.
CREATE TEMP SEQUENCE t_slot_seq;

CREATE OR REPLACE FUNCTION pg_temp.t_seed(p_status text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('test.role', 'service_role', true);
  INSERT INTO public.appointments
    (student_id, instructor_id, date, start_time, end_time, category, price, status)
  VALUES
    ('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222',
     current_date + 7 + nextval('t_slot_seq')::int, '10:00', '11:00', 'B', 10000, p_status)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Tenta a transicao como o ator informado. Devolve NULL em sucesso ou o
-- SQLERRM em caso de excecao.
CREATE OR REPLACE FUNCTION pg_temp.t_try(p_id uuid, p_new_status text, p_uid uuid)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.role', 'authenticated', true);
  PERFORM set_config('test.uid', p_uid::text, true);
  BEGIN
    UPDATE public.appointments SET status = p_new_status WHERE id = p_id;
    RETURN NULL;
  EXCEPTION WHEN others THEN
    RETURN SQLERRM;
  END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.t_assert(p_cond boolean, p_name text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond THEN
    RAISE NOTICE '  [PASS] %', p_name;
  ELSE
    RAISE EXCEPTION '  [FAIL] %', p_name;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 1 — AP-03: completed / no_show sao exclusivos do instrutor
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_id uuid; v_err text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'GRUPO 1 — AP-03: completed / no_show';

  -- 1.1 instrutor pode concluir aula aceita
  v_id := pg_temp.t_seed('confirmed');
  v_err := pg_temp.t_try(v_id, 'completed', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NULL,
    '1.1 instrutor: confirmed -> completed PERMITIDO');
  PERFORM pg_temp.t_assert(
    (SELECT status FROM public.appointments WHERE id = v_id) = 'completed',
    '1.1b status gravado como completed');

  -- 1.2 ALUNO NAO pode concluir  <-- a falha que AP-03 fecha
  v_id := pg_temp.t_seed('confirmed');
  v_err := pg_temp.t_try(v_id, 'completed', '11111111-1111-1111-1111-111111111111');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '1.2 aluno: confirmed -> completed NEGADO');
  PERFORM pg_temp.t_assert(v_err LIKE '%AP-03%',
    '1.2b mensagem cita AP-03');
  PERFORM pg_temp.t_assert(
    (SELECT status FROM public.appointments WHERE id = v_id) = 'confirmed',
    '1.2c status permanece confirmed');

  -- 1.3 instrutor pode registrar falta
  v_id := pg_temp.t_seed('scheduled');
  v_err := pg_temp.t_try(v_id, 'no_show', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NULL,
    '1.3 instrutor: scheduled -> no_show PERMITIDO');

  -- 1.4 ALUNO NAO pode registrar falta
  v_id := pg_temp.t_seed('confirmed');
  v_err := pg_temp.t_try(v_id, 'no_show', '11111111-1111-1111-1111-111111111111');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '1.4 aluno: confirmed -> no_show NEGADO');

  -- 1.5 concluir aula NAO aceita e' negado mesmo para o instrutor
  v_id := pg_temp.t_seed('reserved');
  v_err := pg_temp.t_try(v_id, 'completed', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '1.5 instrutor: reserved -> completed NEGADO (aula nao aceita)');

  -- 1.6 reconcluir aula ja concluida e' negado (idempotencia dura)
  v_id := pg_temp.t_seed('completed');
  v_err := pg_temp.t_try(v_id, 'no_show', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '1.6 instrutor: completed -> no_show NEGADO');

  -- 1.7 terceiro que nao e' parte da aula
  v_id := pg_temp.t_seed('confirmed');
  v_err := pg_temp.t_try(v_id, 'completed', '33333333-3333-3333-3333-333333333333');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '1.7 terceiro: confirmed -> completed NEGADO');
  PERFORM pg_temp.t_assert(v_err LIKE '%nao e parte%',
    '1.7b mensagem indica que nao e parte da aula');
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 2 — AP-11: depois do aceite nao ha cancelamento, ha remarcacao
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_id uuid; v_err text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'GRUPO 2 — AP-11: cancelamento apos o aceite';

  -- 2.1 ALUNO nao cancela aula aceita  <-- a falha que AP-11 fecha
  v_id := pg_temp.t_seed('confirmed');
  v_err := pg_temp.t_try(v_id, 'cancelled', '11111111-1111-1111-1111-111111111111');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '2.1 aluno: confirmed -> cancelled NEGADO');
  PERFORM pg_temp.t_assert(v_err LIKE '%AP-11%',
    '2.1b mensagem cita AP-11');
  PERFORM pg_temp.t_assert(v_err LIKE '%remarcacao%',
    '2.1c mensagem direciona para remarcacao');
  PERFORM pg_temp.t_assert(
    (SELECT status FROM public.appointments WHERE id = v_id) = 'confirmed',
    '2.1d status permanece confirmed');

  -- 2.2 INSTRUTOR tambem nao cancela aula aceita
  v_id := pg_temp.t_seed('scheduled');
  v_err := pg_temp.t_try(v_id, 'cancelled', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '2.2 instrutor: scheduled -> cancelled NEGADO');

  -- 2.3 cancelamento PRE-ACEITE continua permitido (nao regride o fluxo atual)
  DECLARE v_pre text;
  BEGIN
    FOREACH v_pre IN ARRAY ARRAY['pending','pending_approval','awaiting_payment','reserved']
    LOOP
      v_id := pg_temp.t_seed(v_pre);
      PERFORM pg_temp.t_assert(
        pg_temp.t_try(v_id, 'cancelled', '11111111-1111-1111-1111-111111111111') IS NULL,
        format('2.3 aluno: %s -> cancelled PERMITIDO (pre-aceite)', v_pre));
    END LOOP;
  END;
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 3 — fail-closed: transicoes que deixam de ser alcancaveis pelo cliente
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_id uuid; v_err text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'GRUPO 3 — fail-closed';

  -- 3.1 pending_approval deixa de ser alcancavel pelo cliente
  v_id := pg_temp.t_seed('completed');
  v_err := pg_temp.t_try(v_id, 'pending_approval', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '3.1 completed -> pending_approval NEGADO (nao reabre aula encerrada)');

  v_id := pg_temp.t_seed('cancelled');
  v_err := pg_temp.t_try(v_id, 'pending_approval', '11111111-1111-1111-1111-111111111111');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '3.2 cancelled -> pending_approval NEGADO');

  -- 3.3 status fora da matriz
  v_id := pg_temp.t_seed('confirmed');
  v_err := pg_temp.t_try(v_id, 'expired', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '3.3 confirmed -> expired NEGADO ao cliente');

  v_id := pg_temp.t_seed('reserved');
  v_err := pg_temp.t_try(v_id, 'confirmed', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v_err IS NOT NULL,
    '3.4 reserved -> confirmed NEGADO ao cliente (aceite e do backend)');
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 4 — nao-regressao: o que ja funcionava continua funcionando
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_id uuid; v_err text; v_before text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'GRUPO 4 — nao-regressao';

  -- 4.1 UPDATE sem mudanca de status nao e' bloqueado
  v_id := pg_temp.t_seed('confirmed');
  PERFORM set_config('test.role', 'authenticated', true);
  PERFORM set_config('test.uid', '22222222-2222-2222-2222-222222222222', true);
  BEGIN
    UPDATE public.appointments
       SET reschedule_requested_at = NULL, updated_at = now()
     WHERE id = v_id;
    v_err := NULL;
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.t_assert(v_err IS NULL,
    '4.1 UPDATE sem mudanca de status PERMITIDO');

  -- 4.2 colunas financeiras continuam bloqueadas
  -- t_seed troca test.role para service_role; sem restaurar 'authenticated'
  -- os UPDATEs abaixo passariam pelo bypass e 4.2/4.3 falhariam por engano.
  v_id := pg_temp.t_seed('confirmed');
  PERFORM set_config('test.role', 'authenticated', true);
  PERFORM set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    UPDATE public.appointments SET price = 1 WHERE id = v_id;
    v_err := NULL;
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.t_assert(v_err IS NOT NULL AND v_err LIKE '%price%',
    '4.2 alteracao de price NEGADA (guarda preservada)');

  BEGIN
    UPDATE public.appointments SET payment_status = 'paid' WHERE id = v_id;
    v_err := NULL;
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.t_assert(v_err IS NOT NULL AND v_err LIKE '%payment_status%',
    '4.3 alteracao de payment_status NEGADA (guarda preservada)');

  -- 4.4 service_role nao e' afetado por nada disso
  v_id := pg_temp.t_seed('confirmed');
  PERFORM set_config('test.role', 'service_role', true);
  BEGIN
    UPDATE public.appointments
       SET status = 'cancelled', payment_status = 'refunded'
     WHERE id = v_id;
    v_err := NULL;
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.t_assert(v_err IS NULL,
    '4.4 service_role: confirmed -> cancelled PERMITIDO (backend oficial)');
  PERFORM pg_temp.t_assert(
    (SELECT status FROM public.appointments WHERE id = v_id) = 'cancelled',
    '4.4b service_role gravou o status');
END $$;

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '======================================================';
  RAISE NOTICE 'AP-03 / AP-11 — TODAS AS ASSERCOES PASSARAM';
  RAISE NOTICE '======================================================';
END $$;
