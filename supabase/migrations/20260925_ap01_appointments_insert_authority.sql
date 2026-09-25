-- =============================================================================
-- AP-01 / F1-01 / BL-01 — Autoridade de CRIACAO em public.appointments
--                          + C-09 (grants excessivos)
-- =============================================================================
--
-- PROBLEMA (catalogo de producao, leitura em 2026-09-25)
--   (a) Nao existe trigger BEFORE INSERT em appointments.
--   (b) Tres policies de INSERT permissivas:
--         "Students can create appointments"  CHECK (auth.uid() = student_id)
--         "Students can book appointments"    CHECK (auth.uid() = student_id AND perfil completo)
--         "Instructors can block slots"       CHECK (auth.uid() = instructor_id AND termos aceitos)
--       Nenhuma restringe price, status, payment_status, student_id ou colunas
--       de pagamento. Um aluno insere status='confirmed', price=1; um instrutor
--       insere uma aula 'confirmed' em nome de QUALQUER aluno.
--   (c) C-09: anon e authenticated possuem SELECT, INSERT, UPDATE, DELETE,
--       TRUNCATE, TRIGGER e REFERENCES. TRUNCATE ignora RLS por definicao.
--
-- CAMINHOS LEGITIMOS DE CRIACAO (mapeados no codigo)
--   - Compra de aula: api/create-booking-intent.ts -> service_role. Nao afetado.
--   - Bloqueio de horario do instrutor: pages/InstructorAgenda.tsx ->
--       insert({ instructor_id: uid, status: 'blocked', price: 0, date,
--                start_time, end_time })  com JWT do instrutor.
--     E' o UNICO INSERT feito com JWT de usuario. Continua permitido.
--   - Nenhuma funcao/RPC do schema public faz INSERT em appointments.
--
-- CORRECAO
--   1. Trigger BEFORE INSERT: para auth.role() IN ('authenticated','anon')
--      so e' aceito o formato exato de um bloqueio de horario do proprio
--      instrutor. Qualquer outra linha e' recusada. service_role nao e afetado.
--   2. Drop das duas policies de INSERT de ALUNO: nenhum fluxo do produto as
--      usa (compra e' 100% backend) e, com o trigger, ficariam inalcancaveis.
--   3. REVOKE: anon perde toda escrita; anon e authenticated perdem TRUNCATE,
--      TRIGGER e REFERENCES. SELECT/INSERT/UPDATE/DELETE de authenticated
--      permanecem (bloqueio, CAS de status do instrutor, desbloqueio via
--      DELETE, remarcacao); anon mantem SELECT (RLS retorna 0 linhas).
--
-- FORA DO ESCOPO (nao alterado aqui)
--   - check_appointments_update_security (AP-03/AP-11) — intocada.
--   - Policies de UPDATE/SELECT/DELETE — intocadas.
--   - Edge Function create-booking (C-08): usa service_role e NAO e' coberta
--     por nenhuma regra de banco. Tratada no codigo (fail-closed) e exige
--     deploy/undeploy separado.
--
-- APLICACAO: NAO APLICADA. Aplicacao manual apos autorizacao.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_appointments_insert_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
BEGIN

  IF auth.role() IN ('authenticated', 'anon') THEN

    v_uid := auth.uid();

    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'Criacao de aula exige usuario autenticado. (AP-01)';
    END IF;

    -- Unico formato aceito via client: bloqueio de horario do proprio instrutor.
    IF NEW.status IS DISTINCT FROM 'blocked' THEN
      RAISE EXCEPTION
        'Criacao de aula via client nao permitida (status %). Use o fluxo de compra. (AP-01)',
        NEW.status;
    END IF;

    IF NEW.instructor_id IS DISTINCT FROM v_uid
       OR NOT EXISTS (SELECT 1 FROM public.instructors i WHERE i.id = v_uid) THEN
      RAISE EXCEPTION 'Somente o proprio instrutor pode bloquear horario. (AP-01)';
    END IF;

    IF NEW.student_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bloqueio de horario nao pode ter aluno. (AP-01)';
    END IF;

    IF NEW.price IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Bloqueio de horario deve ter price = 0. (AP-01)';
    END IF;

    IF NEW.payment_status IS NOT NULL AND NEW.payment_status <> 'pending' THEN
      RAISE EXCEPTION 'payment_status nao pode ser definido via client. (AP-01)';
    END IF;

    IF NEW.payment_intent_id   IS NOT NULL
       OR NEW.provider_payment_id IS NOT NULL
       OR NEW.purchase_id         IS NOT NULL
       OR NEW.payment_id          IS NOT NULL
       OR NEW.group_id            IS NOT NULL
       OR NEW.expires_at          IS NOT NULL
       OR NEW.proposal_status     IS NOT NULL THEN
      RAISE EXCEPTION 'Colunas de pagamento/agrupamento/proposta nao podem ser definidas via client. (AP-01)';
    END IF;

  END IF;

  RETURN NEW;

END;
$function$;

COMMENT ON FUNCTION public.check_appointments_insert_authority() IS
  'AP-01/BL-01: para auth.role() authenticated/anon, INSERT em appointments so aceita bloqueio de horario do proprio instrutor (status=blocked, price=0, sem aluno, sem colunas de pagamento). service_role nao e afetado.';

DROP TRIGGER IF EXISTS appointments_insert_authority_trigger ON public.appointments;
CREATE TRIGGER appointments_insert_authority_trigger
  BEFORE INSERT ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_appointments_insert_authority();

-- Policies de INSERT de aluno: sem uso legitimo (compra e' via service_role).
DROP POLICY IF EXISTS "Students can create appointments" ON public.appointments;
DROP POLICY IF EXISTS "Students can book appointments"   ON public.appointments;

-- C-09: privilegios excessivos.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.appointments FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES
  ON public.appointments FROM authenticated;


-- =============================================================================
-- VERIFICACAO — ANTES (somente SELECT)
-- =============================================================================
-- SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.role_table_grants
--  WHERE table_schema='public' AND table_name='appointments' GROUP BY 1;
--   -- esperado hoje: anon e authenticated com os 7 privilegios
-- SELECT polname, polcmd FROM pg_policy
--  WHERE polrelid='public.appointments'::regclass ORDER BY 1;   -- 8 policies
-- SELECT tgname FROM pg_trigger
--  WHERE tgrelid='public.appointments'::regclass AND NOT tgisinternal;
--   -- appointments_security_check_trigger, tr_set_updated_by
-- SELECT status, count(*) FROM public.appointments GROUP BY 1;
--
-- =============================================================================
-- VERIFICACAO — DEPOIS (somente SELECT)
-- =============================================================================
--   grants: anon = SELECT; authenticated = DELETE,INSERT,SELECT,UPDATE
--   policies: 6 (sem as 2 de INSERT de aluno; "Instructors can block slots" mantida)
--   triggers: + appointments_insert_authority_trigger (BEFORE INSERT, habilitado)
--   distribuicao de status: identica a de antes
--   bateria funcional: supabase/tests/ap01_appointments_insert_authority.pgsql.sql
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- DROP TRIGGER IF EXISTS appointments_insert_authority_trigger ON public.appointments;
-- DROP FUNCTION IF EXISTS public.check_appointments_insert_authority();
-- CREATE POLICY "Students can create appointments" ON public.appointments
--   FOR INSERT TO public WITH CHECK (auth.uid() = student_id);
-- CREATE POLICY "Students can book appointments" ON public.appointments
--   FOR INSERT TO authenticated WITH CHECK ((auth.uid() = student_id) AND
--   ((SELECT profiles.is_profile_complete FROM profiles WHERE profiles.id = auth.uid()) = true));
-- GRANT INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.appointments TO anon;
-- GRANT TRUNCATE, TRIGGER, REFERENCES ON public.appointments TO authenticated;
--   (o rollback reabre BL-01; usar somente em caso de regressao comprovada)
-- =============================================================================
