-- =============================================================================
-- AP-05 / TRILHA A — FERIAS DO INSTRUTOR (liga/desliga manual)
-- =============================================================================
--
-- DECISOES APROVADAS (2026-09-25)
--   - Modelo: liga/desliga manual, sem datas.
--   - Checkout iniciado ANTES das ferias pode concluir: nada aqui consulta
--     on_vacation em UPDATE de pagamento/confirmacao, nem invalida linhas
--     existentes. A barreira e' so na CRIACAO de nova appointment.
--   - Remarcacao durante ferias: NAO. Sem datas de fim, qualquer nova data
--     cai nas ferias -> toda remarcacao das aulas do instrutor fica bloqueada
--     enquanto on_vacation = true (aluno e instrutor; propose/accept/direta).
--     A aula original nunca e' alterada por isso.
--   - Vitrine: instrutor em ferias sai da listagem (a linha permanece).
--   - Link direto: perfil acessivel, "Instrutor em ferias", sem horarios.
--
-- CAMADAS NO BANCO
--   1. instructors.on_vacation / vacation_changed_at.
--   2. Guarda de coluna: client (anon/authenticated) nao altera esses campos
--      por INSERT/UPDATE direto; so pela RPC.
--   3. RPC set_instructor_vacation(p_active): so o proprio instrutor; registra
--      o evento em public.instructor_vacation_events (tabela propria,
--      imutavel, fail-closed). NAO usa security_audit_logs: seus CHECK
--      constraints de producao (environment in production/preview/development;
--      event_type in LOGIN_FAILED/UNAUTHORIZED_ACCESS/BANK_INFO_CHANGE/
--      ROLE_CHANGE) recusam eventos de ferias, e nao sao alterados aqui.
--   4. Autoridade de INSERT em appointments (AP-01) + ferias: para QUALQUER
--      role, inclusive service_role, nova appointment para instrutor em ferias
--      e' recusada, exceto bloqueio de horario (status blocked, sem aluno).
--   5. get_instructor_availability: instrutor em ferias devolve todos os
--      horarios da grade como 'unavailable' para quem nao e' o instrutor.
--   6. reschedule_grid_violation: 'instructor_on_vacation' (propose/accept).
--   7. Trigger BEFORE UPDATE OF date, start_time em appointments: nenhuma
--      remarcacao efetiva durante ferias (cobre a RPC direta e qualquer outro
--      caminho de UPDATE).
--   8. instructors_public: expoe on_vacation.
--
-- O QUE ESTA MIGRATION NAO TOCA
--   appointments existentes, transactions, payment_installments,
--   payment_settlements, refund_operations, valores, repasses, FKs,
--   BookingCancellationCore, check_appointments_update_security (AP-03/AP-11),
--   security_audit_logs (tabela, CHECKs, registros e prevent_security_audit_mutation).
--   Adicionar coluna com DEFAULT false nao reescreve dados de negocio.
--
-- APLICACAO: NAO APLICADA. Aplicacao manual apos validacao.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Colunas
-- -----------------------------------------------------------------------------
ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS on_vacation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vacation_changed_at timestamptz;

COMMENT ON COLUMN public.instructors.on_vacation IS
  'AP-05/A: ferias do instrutor (liga/desliga manual). Alteravel somente via set_instructor_vacation().';

-- -----------------------------------------------------------------------------
-- 2. Guarda de coluna — client nao altera ferias por escrita direta
-- -----------------------------------------------------------------------------
-- NAO e' SECURITY DEFINER de proposito: current_user precisa ser o role do
-- chamador. Dentro da RPC (SECURITY DEFINER) current_user e' o owner e a
-- escrita passa; via PostgREST current_user e' anon/authenticated e e' negada.
CREATE OR REPLACE FUNCTION public.guard_instructor_vacation_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.on_vacation IS TRUE OR NEW.vacation_changed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Ferias so podem ser alteradas por set_instructor_vacation(). (AP-05)';
      END IF;
    ELSIF NEW.on_vacation IS DISTINCT FROM OLD.on_vacation
       OR NEW.vacation_changed_at IS DISTINCT FROM OLD.vacation_changed_at THEN
      RAISE EXCEPTION 'Ferias so podem ser alteradas por set_instructor_vacation(). (AP-05)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS instructors_vacation_guard_trigger ON public.instructors;
CREATE TRIGGER instructors_vacation_guard_trigger
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_instructor_vacation_columns();

-- -----------------------------------------------------------------------------
-- 2b. Historico de ferias — tabela propria, imutavel, fail-closed
-- -----------------------------------------------------------------------------
-- SEM foreign key, de proposito: com o trigger de imutabilidade, uma FK com
-- ON DELETE CASCADE/SET NULL para instructors ou auth.users faria a exclusao
-- do usuario FALHAR (mesmo padrao ja' documentado para security_audit_logs no
-- AP-05). O destino deste historico na exclusao de conta e' decisao da
-- Trilha B (retencao), nao desta migration.
CREATE TABLE IF NOT EXISTS public.instructor_vacation_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id uuid        NOT NULL,
  active        boolean     NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid        NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instructor_vacation_events_instructor
  ON public.instructor_vacation_events (instructor_id, changed_at DESC);

COMMENT ON TABLE public.instructor_vacation_events IS
  'AP-05/A: historico imutavel de ativacao/desativacao de ferias. Escrita somente por set_instructor_vacation(). Sem acesso de client (RLS sem policies + REVOKE). Sem FK por desenho (ver migration).';

-- RLS fail-closed: habilitado e SEM nenhuma policy.
ALTER TABLE public.instructor_vacation_events ENABLE ROW LEVEL SECURITY;

-- Nenhum privilegio para client (o Supabase concede ALL por default privileges).
REVOKE ALL ON public.instructor_vacation_events FROM PUBLIC, anon, authenticated;

-- Imutabilidade: UPDATE, DELETE e TRUNCATE recusados para qualquer role.
CREATE OR REPLACE FUNCTION public.prevent_instructor_vacation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'instructor_vacation_events e'' imutavel: UPDATE/DELETE/TRUNCATE nao sao permitidos. (AP-05)';
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_instructor_vacation_events_immutable_row ON public.instructor_vacation_events;
CREATE TRIGGER trg_instructor_vacation_events_immutable_row
  BEFORE UPDATE OR DELETE ON public.instructor_vacation_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_instructor_vacation_event_mutation();

DROP TRIGGER IF EXISTS trg_instructor_vacation_events_immutable_stmt ON public.instructor_vacation_events;
CREATE TRIGGER trg_instructor_vacation_events_immutable_stmt
  BEFORE TRUNCATE ON public.instructor_vacation_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_instructor_vacation_event_mutation();

-- -----------------------------------------------------------------------------
-- 3. RPC — liga/desliga ferias
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_instructor_vacation(p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_previous boolean;
  v_now      timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Ferias exigem usuario autenticado. (AP-05)';
  END IF;

  IF p_active IS NULL THEN
    RAISE EXCEPTION 'p_active nao pode ser nulo. (AP-05)';
  END IF;

  -- O ator so altera a PROPRIA linha, e precisa ser instrutor.
  SELECT i.on_vacation INTO v_previous
    FROM public.instructors i
   WHERE i.id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Somente instrutores podem entrar ou sair de ferias. (AP-05)';
  END IF;

  IF v_previous = p_active THEN
    RETURN jsonb_build_object('status', 'unchanged', 'on_vacation', v_previous);
  END IF;

  UPDATE public.instructors
     SET on_vacation = p_active,
         vacation_changed_at = v_now
   WHERE id = v_uid;

  INSERT INTO public.instructor_vacation_events (instructor_id, active, changed_at, actor_user_id)
  VALUES (v_uid, p_active, v_now, v_uid);

  RETURN jsonb_build_object('status', 'ok', 'on_vacation', p_active, 'changed_at', v_now);
END;
$function$;

COMMENT ON FUNCTION public.set_instructor_vacation(boolean) IS
  'AP-05/A: o proprio instrutor liga/desliga ferias. Registra o evento em instructor_vacation_events. Nao altera nenhuma aula.';

REVOKE ALL ON FUNCTION public.set_instructor_vacation(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_instructor_vacation(boolean) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Autoridade de INSERT em appointments (AP-01) + ferias
-- -----------------------------------------------------------------------------
-- Corpo AP-01 preservado integralmente; o bloco de ferias e' acrescentado ao
-- final e vale para QUALQUER role (inclusive service_role).
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

  -- AP-05/A — ferias: nenhuma NOVA aula para instrutor em ferias, por nenhum
  -- caminho. O unico INSERT aceito e' o bloqueio de horario (sem aluno).
  IF NOT (NEW.status = 'blocked' AND NEW.student_id IS NULL)
     AND EXISTS (SELECT 1 FROM public.instructors i
                  WHERE i.id = NEW.instructor_id AND i.on_vacation) THEN
    RAISE EXCEPTION
      'INSTRUCTOR_ON_VACATION: este instrutor esta em ferias e nao esta aceitando novas aulas. (AP-05)';
  END IF;

  RETURN NEW;

END;
$function$;

COMMENT ON FUNCTION public.check_appointments_insert_authority() IS
  'AP-01/BL-01 + AP-05/A: via client so bloqueio de horario do proprio instrutor; para qualquer role, nenhuma nova aula (exceto bloqueio) para instrutor em ferias. service_role segue criando reservas legitimas fora das ferias.';

-- -----------------------------------------------------------------------------
-- 5. Disponibilidade
-- -----------------------------------------------------------------------------
-- Corpo original preservado. Acrescentado: instrutor em ferias devolve TODOS
-- os horarios da grade (07:00-22:00, AGENDA_SLOTS de lib/slots.ts) como
-- 'unavailable' para qualquer chamador que nao seja o proprio instrutor. O
-- formato de retorno nao muda, entao o cliente atual ja' mostra tudo ocupado.
CREATE OR REPLACE FUNCTION public.get_instructor_availability(p_instructor_id uuid, p_start_date date, p_end_date date)
RETURNS TABLE(date date, start_time time without time zone, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID;
BEGIN
  -- 1. Parameters Validation
  IF p_instructor_id IS NULL THEN
    RAISE EXCEPTION 'p_instructor_id cannot be null';
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'p_start_date and p_end_date cannot be null';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'p_start_date cannot be after p_end_date';
  END IF;

  -- Limit query interval to a maximum of 31 days to avoid massive scraping/harvesting
  IF (p_end_date - p_start_date) > 31 THEN
    RAISE EXCEPTION 'Query interval cannot exceed 31 days';
  END IF;

  -- 2. Extract authentic user identity directly from secure JWT session context
  v_caller_id := auth.uid();

  -- AP-05/A — instrutor em ferias: nenhum horario livre para terceiros.
  IF v_caller_id IS DISTINCT FROM p_instructor_id
     AND EXISTS (SELECT 1 FROM public.instructors i
                  WHERE i.id = p_instructor_id AND i.on_vacation) THEN
    RETURN QUERY
    SELECT d::date,
           (time '07:00' + make_interval(hours => h))::time,
           'unavailable'::text
      FROM generate_series(p_start_date, p_end_date, interval '1 day') AS d,
           generate_series(0, 15) AS h;
    RETURN;
  END IF;

  -- 3. Fetch and return masked data using an explicit Allowlist for occupied states
  RETURN QUERY
  SELECT
    a.date,
    a.start_time,
    CASE
      -- If the slot belongs to the authenticated caller and is in a retryable state,
      -- we flag it as 'my_reservation' so the client knows they can retry/manage it.
      WHEN v_caller_id IS NOT NULL
           AND a.student_id = v_caller_id
           AND a.status IN ('reserved', 'awaiting_payment') THEN 'my_reservation'
      -- Any other valid, active slot is returned under a generic neutral 'unavailable' state.
      ELSE 'unavailable'
    END::TEXT AS status
  FROM public.appointments a
  WHERE a.instructor_id = p_instructor_id
    AND a.date >= p_start_date
    AND a.date <= p_end_date
    -- Explicit Allowlist of occupied statuses:
    -- If a slot is in any of these statuses, it is considered occupied/unavailable to others.
    -- Unlisted statuses (like 'cancelled', 'failed', 'expired', 'rejected') represent open/free slots,
    -- which are omitted from this result (hence, are available).
    AND a.status IN (
      'pending',
      'scheduled',
      'confirmed',
      'in_progress',
      'completed',
      'blocked',
      'reserved',
      'pending_approval',
      'no_show',
      'awaiting_payment'
    );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Grade de remarcacao (propose_reschedule / accept_reschedule)
-- -----------------------------------------------------------------------------
-- Corpo original preservado; acrescentado o motivo 'instructor_on_vacation'.
-- reschedule_slot_violation devolve SLOT_NOT_IN_GRID com esse reason.
CREATE OR REPLACE FUNCTION public.reschedule_grid_violation(p_instructor_id uuid, p_date date, p_start_time time without time zone)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_has_night    boolean;
  v_work_sat     boolean;
  v_lunch_active boolean;
  v_lunch_start  time;
  v_lunch_dur    int;
  v_lunch_end    time;
  v_dow          int;
  v_minutes      int;
  v_sat_limit    int;
  v_on_vacation  boolean;
BEGIN
  IF p_instructor_id IS NULL OR p_date IS NULL OR p_start_time IS NULL THEN
    RETURN 'invalid_input';
  END IF;

  -- domingo e' regra de data
  v_dow := EXTRACT(dow FROM p_date);
  IF v_dow = 0 THEN
    RETURN 'sunday';
  END IF;

  -- AGENDA_SLOTS (lib/slots.ts): horario cheio, 07:00 a 22:00
  IF EXTRACT(minute FROM p_start_time) <> 0
     OR EXTRACT(second FROM p_start_time) <> 0
     OR EXTRACT(hour FROM p_start_time) < 7
     OR EXTRACT(hour FROM p_start_time) > 22 THEN
    RETURN 'outside_agenda_slots';
  END IF;

  SELECT COALESCE(i.has_night_lessons, false),
         COALESCE(i.work_saturday_afternoon, false),
         COALESCE(i.lunch_active, false),
         NULLIF(i.lunch_start_slot, '')::time,
         GREATEST(COALESCE(i.lunch_duration, 2), 0),
         COALESCE(i.on_vacation, false)
    INTO v_has_night, v_work_sat, v_lunch_active, v_lunch_start, v_lunch_dur, v_on_vacation
  FROM public.instructors i
  WHERE i.id = p_instructor_id;

  IF NOT FOUND THEN
    RETURN 'instructor_not_found';
  END IF;

  -- AP-05/A — sem datas de fim, toda nova data cai nas ferias.
  IF v_on_vacation THEN
    RETURN 'instructor_on_vacation';
  END IF;

  v_minutes := EXTRACT(hour FROM p_start_time) * 60 + EXTRACT(minute FROM p_start_time);

  -- noite: create-booking-intent bloqueia a partir das 18:00
  IF NOT v_has_night AND v_minutes >= 18 * 60 THEN
    RETURN 'night_not_allowed';
  END IF;

  -- sabado: 17:00 com work_saturday_afternoon, senao 11:10
  IF v_dow = 6 THEN
    v_sat_limit := CASE WHEN v_work_sat THEN 17 * 60 ELSE 11 * 60 + 10 END;
    IF v_minutes > v_sat_limit THEN
      RETURN 'saturday_limit';
    END IF;
  END IF;

  -- almoco configurado pelo instrutor (nao e' 12:00/13:00 fixo)
  IF v_lunch_active AND v_lunch_start IS NOT NULL
     AND v_lunch_start >= time '07:00' AND v_lunch_start <= time '22:00'
     AND EXTRACT(minute FROM v_lunch_start) = 0 AND v_lunch_dur > 0 THEN
    v_lunch_end := v_lunch_start + (v_lunch_dur || ' hours')::interval;
    IF p_start_time >= v_lunch_start AND p_start_time < v_lunch_end THEN
      RETURN 'lunch';
    END IF;
  END IF;

  RETURN NULL;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Remarcacao efetiva durante ferias (qualquer caminho de UPDATE)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_appointment_vacation_reschedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF (NEW.date IS DISTINCT FROM OLD.date OR NEW.start_time IS DISTINCT FROM OLD.start_time)
     AND OLD.status IS DISTINCT FROM 'blocked'
     AND EXISTS (SELECT 1 FROM public.instructors i
                  WHERE i.id = NEW.instructor_id AND i.on_vacation) THEN
    RAISE EXCEPTION
      'INSTRUCTOR_ON_VACATION: o instrutor esta em ferias; a aula nao pode ser remarcada agora. A aula original foi mantida. (AP-05)';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS appointments_vacation_reschedule_trigger ON public.appointments;
CREATE TRIGGER appointments_vacation_reschedule_trigger
  BEFORE UPDATE OF date, start_time ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_appointment_vacation_reschedule();

-- -----------------------------------------------------------------------------
-- 8. Vitrine — expoe on_vacation (coluna nova sempre ao final)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.instructors_public AS
  SELECT i.id,
         i.public_id,
         i.credential_number,
         i.base_price,
         i.night_price,
         i.has_night_lessons,
         i.categories,
         i.meeting_point,
         i.meeting_point_lat,
         i.meeting_point_lng,
         i.meeting_point_place_id,
         i.work_saturday_afternoon,
         i.lunch_active,
         i.lunch_start_slot,
         i.lunch_duration,
         (i.whatsapp IS NOT NULL AND btrim(i.whatsapp) <> '') AS has_whatsapp,
         p.full_name,
         p.avatar_url,
         p.city,
         i.on_vacation
    FROM public.instructors i
    JOIN public.profiles p ON p.id = i.id;

-- CREATE OR REPLACE VIEW preserva os grants; reafirmados por idempotencia.
REVOKE ALL ON public.instructors_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.instructors_public TO anon, authenticated;


-- =============================================================================
-- VERIFICACAO — ANTES (somente SELECT)
-- =============================================================================
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='instructors' AND column_name IN ('on_vacation','vacation_changed_at'); -- 0
-- SELECT md5(pg_get_functiondef('public.check_appointments_update_security()'::regprocedure)); -- AP-03 intacta
-- SELECT count(*) FROM public.security_audit_logs;                     -- guardar (nao pode mudar)
-- SELECT to_regclass('public.instructor_vacation_events');             -- NULL
-- SELECT count(*), sum(price) FROM public.appointments;                -- guardar
-- SELECT count(*) FROM public.transactions; SELECT count(*) FROM public.payment_installments;
-- SELECT count(*) FROM public.payment_settlements; SELECT count(*) FROM public.refund_operations;
--
-- =============================================================================
-- VERIFICACAO — DEPOIS (somente SELECT)
-- =============================================================================
--   colunas presentes; todos os instrutores com on_vacation = false
--   triggers: instructors_vacation_guard_trigger, appointments_vacation_reschedule_trigger
--   md5 de check_appointments_update_security IDENTICO ao de antes
--   contagens de appointments/transactions/installments/settlements/refunds IDENTICAS
--   security_audit_logs: mesma contagem (esta migration nao escreve nela)
--   instructor_vacation_events: existe, RLS on, 0 policies, 0 linhas,
--     anon/authenticated sem privilegio, 2 triggers de imutabilidade
--   bateria: supabase/tests/ap05a_instructor_vacation.pgsql.sql
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
--   Reaplicar as definicoes anteriores de check_appointments_insert_authority
--   (migration 20260925_ap01), get_instructor_availability e
--   reschedule_grid_violation (capturar pg_get_functiondef ANTES de aplicar) e
--   instructors_public (migration 20260925_ap02); depois:
-- DROP TRIGGER IF EXISTS appointments_vacation_reschedule_trigger ON public.appointments;
-- DROP FUNCTION IF EXISTS public.guard_appointment_vacation_reschedule();
-- DROP FUNCTION IF EXISTS public.set_instructor_vacation(boolean);
--   instructor_vacation_events: remover so apos decisao de retencao (o
--   historico e' imutavel por desenho); DROP TABLE nao dispara os triggers de
--   linha, mas exige autorizacao explicita.
-- DROP TRIGGER IF EXISTS instructors_vacation_guard_trigger ON public.instructors;
-- DROP FUNCTION IF EXISTS public.guard_instructor_vacation_columns();
--   As colunas on_vacation/vacation_changed_at podem permanecer (inertes) ou
--   ser removidas com ALTER TABLE ... DROP COLUMN apos recriar a view sem elas.
--   security_audit_logs nao e' tocada por esta migration.
-- =============================================================================
