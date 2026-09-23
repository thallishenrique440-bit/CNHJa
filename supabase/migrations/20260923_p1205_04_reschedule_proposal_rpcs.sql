-- =============================================================================
-- P-1.20.5 FASES C/D/E — RPCs DE PROPOSTA DE REMARCACAO
--
-- REGRA DE NEGOCIO FECHADA (P-1.20.5):
--
--   ACEITE INICIAL DO COMBO  = combo inteiro  (fluxo existente, NAO tocado aqui)
--   REMARCACAO APOS O ACEITE = UMA aula       (este arquivo)
--
-- ESCOPO DA OPERACAO — por que a assinatura recebe uuid[] e nao uuid:
--
--   pages/student/Lessons.tsx:1088-1160 monta os grupos da UI por
--   CONTIGUIDADE NO MESMO DIA (`currentGroup.endTime === next.time`), nao por
--   group_id. Um combo com aulas em 05/10, 12/10 e 19/10 produz TRES grupos de
--   uma aula cada. O unico caso em que `ids` tem mais de um elemento e' o bloco
--   CONTIGUO comprado no mesmo dia (ex.: 10:00 + 11:00), que o aluno vive como
--   UMA sessao de duas horas. Essa e' a "evidencia no codigo de um caso
--   legitimo diferente": o array descreve um BLOCO CONTIGUO, nunca o combo.
--
--   Nenhuma destas RPCs alcanca aulas fora de p_appointment_ids. group_id e'
--   usado somente para CONFERIR coerencia (todas do mesmo grupo) e para o
--   texto da notificacao. Ele NUNCA amplia o escopo.
--
-- AUTORIDADE DE GRADE: replicada de api/create-booking-intent.ts:314-360, a
-- unica validacao de grade server-side existente no projeto — e identica a
-- adotada na P-1.20.4. Nenhuma regra nova de grade e' inventada.
--
-- NEUTRALIDADE FINANCEIRA: estas funcoes escrevem EXCLUSIVAMENTE
--   proposed_date, proposed_start_time, proposed_end_time, proposed_by,
--   proposal_status, proposal_created_at, proposal_resolved_at,
--   date, start_time, end_time, rescheduled_at, reschedule_requested_at,
--   updated_at.
-- Nao tocam status, payment_status, price, installments, transactions,
-- refund_operations, nem chamam Asaas.
--
-- DEPENDE DE:
--   20260923_p1205_01_reschedule_proposal_model.sql
--   20260923_p1205_02_reschedule_notification_types.sql
--
-- NAO APLICADA. Revisar antes de executar.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- HELPER 1 — violacao de grade para UM slot.
-- Retorna NULL quando o slot e' valido, ou o motivo ('sunday', 'lunch', ...).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reschedule_grid_violation(
  p_instructor_id uuid,
  p_date          date,
  p_start_time    time
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
         GREATEST(COALESCE(i.lunch_duration, 2), 0)
    INTO v_has_night, v_work_sat, v_lunch_active, v_lunch_start, v_lunch_dur
  FROM public.instructors i
  WHERE i.id = p_instructor_id;

  IF NOT FOUND THEN
    RETURN 'instructor_not_found';
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

REVOKE ALL ON FUNCTION public.reschedule_grid_violation(uuid, date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reschedule_grid_violation(uuid, date, time) FROM anon;
GRANT EXECUTE ON FUNCTION public.reschedule_grid_violation(uuid, date, time) TO authenticated;


-- ---------------------------------------------------------------------------
-- HELPER 2 — grade + conflitos para UM slot. NULL = ok, ou jsonb de erro.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reschedule_slot_violation(
  p_exclude_ids   uuid[],
  p_instructor_id uuid,
  p_student_id    uuid,
  p_date          date,
  p_start_time    time
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_reason  text;
  v_busy    boolean;
BEGIN
  v_reason := public.reschedule_grid_violation(p_instructor_id, p_date, p_start_time);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('status','error','code','SLOT_NOT_IN_GRID',
                              'reason', v_reason, 'start_time', p_start_time);
  END IF;

  -- conflito do INSTRUTOR, reaproveitando a RPC existente
  SELECT public.check_appointment_conflict(p_instructor_id, p_date, p_start_time, p_exclude_ids)
    INTO v_busy;
  IF COALESCE(v_busy, true) THEN
    RETURN jsonb_build_object('status','error','code','SLOT_TAKEN','scope','instructor',
                              'date', p_date, 'start_time', p_start_time);
  END IF;

  -- conflito do ALUNO (idx_unique_student_active_slot)
  SELECT EXISTS (
    SELECT 1 FROM public.appointments b
    WHERE b.student_id = p_student_id
      AND b.date = p_date
      AND b.start_time = p_start_time
      AND b.status <> ALL (ARRAY['cancelled','failed','rejected','expired'])
      AND NOT (b.id = ANY(p_exclude_ids))
  ) INTO v_busy;
  IF v_busy THEN
    RETURN jsonb_build_object('status','error','code','SLOT_TAKEN','scope','student',
                              'date', p_date, 'start_time', p_start_time);
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.reschedule_slot_violation(uuid[], uuid, uuid, date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reschedule_slot_violation(uuid[], uuid, uuid, date, time) FROM anon;
GRANT EXECUTE ON FUNCTION public.reschedule_slot_violation(uuid[], uuid, uuid, date, time) TO authenticated;


-- ---------------------------------------------------------------------------
-- FASES C e D — propose_reschedule
--
-- Uma unica RPC serve aluno (<=24h) e instrutor (iniciativa propria). O papel
-- e' DERIVADO do banco a partir de auth.uid(); nunca recebido do cliente.
--
-- A proposta NAO altera o horario vigente. date/start_time/end_time ficam
-- intactos ate que a contraparte aceite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_reschedule(
  p_appointment_ids uuid[],
  p_new_date        date,
  p_new_start_time  time
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_tz           constant text := 'America/Sao_Paulo';
  v_uid          uuid := auth.uid();
  v_ids          uuid[];
  v_total        int;
  v_bad_status   int;
  v_has_proposal int;
  v_groups       int;
  v_null_groups  int;
  v_instructors  int;
  v_students     int;
  v_instructor   uuid;
  v_student      uuid;
  v_group_id     uuid;
  v_now          timestamptz := clock_timestamp();
  v_role         text;
  v_target       uuid;
  v_screen       text;
  v_rec          record;
  v_cursor       time;
  v_new_start    time;
  v_new_end      time;
  v_dur          interval;
  v_err          jsonb;
  v_changed      int := 0;
  v_updated      int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','error','code','NOT_AUTHENTICATED');
  END IF;

  IF p_appointment_ids IS NULL OR p_new_date IS NULL OR p_new_start_time IS NULL THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_appointment_ids) AS x;
  IF v_ids IS NULL OR COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  -- Trava as linhas: fecha a janela TOCTOU entre validar e gravar.
  PERFORM 1 FROM public.appointments WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT
    count(*),
    count(*) FILTER (WHERE a.status NOT IN ('confirmed','scheduled')),
    count(*) FILTER (WHERE a.proposal_status = 'pending'),
    count(DISTINCT a.group_id),
    count(*) FILTER (WHERE a.group_id IS NULL),
    count(DISTINCT a.instructor_id),
    count(DISTINCT a.student_id),
    (array_agg(a.instructor_id))[1],
    (array_agg(a.student_id))[1],
    (array_agg(a.group_id) FILTER (WHERE a.group_id IS NOT NULL))[1]
  INTO
    v_total, v_bad_status, v_has_proposal, v_groups, v_null_groups,
    v_instructors, v_students, v_instructor, v_student, v_group_id
  FROM public.appointments a
  WHERE a.id = ANY(v_ids);

  IF v_total = 0 OR v_total <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('status','error','code','APPOINTMENT_NOT_FOUND');
  END IF;

  IF v_instructors <> 1 THEN
    RETURN jsonb_build_object('status','error','code','INSTRUCTOR_MISMATCH');
  END IF;
  IF v_students <> 1 THEN
    RETURN jsonb_build_object('status','error','code','STUDENT_MISMATCH');
  END IF;

  -- bloco contiguo: ou tudo do mesmo grupo, ou aula avulsa unica
  IF v_total > 1 AND (v_null_groups > 0 OR v_groups <> 1) THEN
    RETURN jsonb_build_object('status','error','code','GROUP_MISMATCH');
  END IF;

  -- papel derivado do banco
  IF v_uid = v_student THEN
    v_role   := 'student';
    v_target := v_instructor;
    v_screen := 'instructor_agenda';
  ELSIF v_uid = v_instructor THEN
    v_role   := 'instructor';
    v_target := v_student;
    v_screen := 'student_lessons';
  ELSE
    RETURN jsonb_build_object('status','error','code','NOT_OWNER');
  END IF;

  -- so aula ja aceita entra em remarcacao
  IF v_bad_status > 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_STATUS');
  END IF;

  -- uma aula nao pode ter duas propostas pendentes
  IF v_has_proposal > 0 THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_ALREADY_PENDING');
  END IF;

  -- horario proposto precisa ser futuro (America/Sao_Paulo, relogio do servidor)
  IF ((p_new_date + p_new_start_time) AT TIME ZONE c_tz) <= v_now THEN
    RETURN jsonb_build_object('status','error','code','NEW_SLOT_IN_PAST');
  END IF;

  ------------------------------------------------- validacao slot a slot
  v_cursor := p_new_start_time;

  FOR v_rec IN
    SELECT a.id, a.date, a.start_time, a.end_time
    FROM public.appointments a
    WHERE a.id = ANY(v_ids)
    ORDER BY a.date, a.start_time, a.id
  LOOP
    v_dur       := COALESCE(v_rec.end_time - v_rec.start_time, interval '60 minutes');
    v_new_start := v_cursor;
    v_new_end   := v_cursor + v_dur;

    v_err := public.reschedule_slot_violation(v_ids, v_instructor, v_student,
                                              p_new_date, v_new_start);
    IF v_err IS NOT NULL THEN
      RETURN v_err;
    END IF;

    IF v_rec.date IS DISTINCT FROM p_new_date
       OR v_rec.start_time IS DISTINCT FROM v_new_start
       OR v_rec.end_time IS DISTINCT FROM v_new_end THEN
      v_changed := v_changed + 1;
    END IF;

    v_cursor := v_new_end;
  END LOOP;

  -- idempotencia: propor o horario em que a aula ja esta nao gera proposta
  IF v_changed = 0 THEN
    RETURN jsonb_build_object('status','no_op','reason','already_at_requested_slot');
  END IF;

  ------------------------------------------------------------ gravacao
  v_cursor := p_new_start_time;

  FOR v_rec IN
    SELECT a.id, a.start_time, a.end_time
    FROM public.appointments a
    WHERE a.id = ANY(v_ids)
    ORDER BY a.date, a.start_time, a.id
  LOOP
    v_dur       := COALESCE(v_rec.end_time - v_rec.start_time, interval '60 minutes');
    v_new_start := v_cursor;
    v_new_end   := v_cursor + v_dur;

    UPDATE public.appointments a
       SET proposed_date        = p_new_date,
           proposed_start_time  = v_new_start,
           proposed_end_time    = v_new_end,
           proposed_by          = v_uid,
           proposal_status      = 'pending',
           proposal_created_at  = pg_catalog.now(),
           proposal_resolved_at = NULL,
           updated_at           = pg_catalog.now()
     WHERE a.id = v_rec.id
       AND a.status IN ('confirmed','scheduled')
       AND a.proposal_status IS DISTINCT FROM 'pending';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RETURN jsonb_build_object('status','error','code','STATE_CHANGED');
    END IF;

    v_cursor := v_new_end;
  END LOOP;

  ------------------------------------------------------------ notificacao
  BEGIN
    PERFORM public.create_unified_notification(
      v_target,
      '📅 Solicitação de remarcação',
      CASE WHEN v_role = 'student'
           THEN 'O aluno propôs remarcar a aula para '
           ELSE 'O instrutor propôs remarcar a aula para ' END
        || to_char(p_new_date, 'DD/MM') || ' às '
        || to_char(p_new_start_time, 'HH24:MI')
        || '. O horário atual continua valendo até você responder.',
      'reschedule_requested',
      CASE WHEN v_total > 1 THEN 'package' ELSE 'lesson' END,
      v_screen,
      v_total,
      NULL,          -- ver 20260923_p1205_02: group_id colide com a compra
      v_ids[1]
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[propose_reschedule] notificacao falhou: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'status','ok',
    'proposed', v_total,
    'proposed_by_role', v_role,
    'group_id', v_group_id,
    'proposed_date', p_new_date,
    'proposed_start_time', p_new_start_time
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.propose_reschedule(uuid[], date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.propose_reschedule(uuid[], date, time) FROM anon;
GRANT EXECUTE ON FUNCTION public.propose_reschedule(uuid[], date, time) TO authenticated;

COMMENT ON FUNCTION public.propose_reschedule(uuid[], date, time) IS
  'P-1.20.5: cria proposta de remarcacao (aluno <=24h ou instrutor). Nao altera '
  'o horario vigente. Escopo restrito a p_appointment_ids. Zero efeito financeiro.';


-- ---------------------------------------------------------------------------
-- FASE E — accept_reschedule
--
-- Somente a CONTRAPARTE de proposed_by aceita. O aceite revalida grade e
-- conflitos porque o mundo pode ter mudado entre a proposta e a resposta.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_reschedule(
  p_appointment_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_tz          constant text := 'America/Sao_Paulo';
  v_uid         uuid := auth.uid();
  v_ids         uuid[];
  v_total       int;
  v_not_pending int;
  v_bad_status  int;
  v_proposers   int;
  v_proposer    uuid;
  v_instructors int;
  v_students    int;
  v_instructor  uuid;
  v_student     uuid;
  v_group_id    uuid;
  v_prop_date   date;
  v_prop_start  time;
  v_now         timestamptz := clock_timestamp();
  v_target      uuid;
  v_screen      text;
  v_rec         record;
  v_err         jsonb;
  v_updated     int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','error','code','NOT_AUTHENTICATED');
  END IF;
  IF p_appointment_ids IS NULL THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_appointment_ids) AS x;
  IF v_ids IS NULL OR COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  PERFORM 1 FROM public.appointments WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT
    count(*),
    count(*) FILTER (WHERE a.proposal_status IS DISTINCT FROM 'pending'),
    count(*) FILTER (WHERE a.status NOT IN ('confirmed','scheduled')),
    count(DISTINCT a.proposed_by),
    (array_agg(a.proposed_by))[1],
    count(DISTINCT a.instructor_id),
    count(DISTINCT a.student_id),
    (array_agg(a.instructor_id))[1],
    (array_agg(a.student_id))[1],
    (array_agg(a.group_id) FILTER (WHERE a.group_id IS NOT NULL))[1],
    (array_agg(a.proposed_date))[1],
    min(a.proposed_start_time)
  INTO
    v_total, v_not_pending, v_bad_status, v_proposers, v_proposer,
    v_instructors, v_students, v_instructor, v_student, v_group_id,
    v_prop_date, v_prop_start
  FROM public.appointments a
  WHERE a.id = ANY(v_ids);

  IF v_total = 0 OR v_total <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('status','error','code','APPOINTMENT_NOT_FOUND');
  END IF;
  IF v_instructors <> 1 OR v_students <> 1 THEN
    RETURN jsonb_build_object('status','error','code','GROUP_MISMATCH');
  END IF;

  -- parte da aula?
  IF v_uid <> v_student AND v_uid <> v_instructor THEN
    RETURN jsonb_build_object('status','error','code','NOT_OWNER');
  END IF;

  IF v_not_pending > 0 THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_NOT_PENDING');
  END IF;
  IF v_proposers <> 1 THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_MISMATCH');
  END IF;

  -- quem propos nao aceita a propria proposta
  IF v_uid = v_proposer THEN
    RETURN jsonb_build_object('status','error','code','NOT_COUNTERPARTY');
  END IF;

  IF v_bad_status > 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_STATUS');
  END IF;

  IF ((v_prop_date + v_prop_start) AT TIME ZONE c_tz) <= v_now THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_EXPIRED');
  END IF;

  -- revalida grade e conflitos com os valores GRAVADOS em cada linha
  FOR v_rec IN
    SELECT a.id, a.proposed_date, a.proposed_start_time
    FROM public.appointments a
    WHERE a.id = ANY(v_ids)
    ORDER BY a.proposed_date, a.proposed_start_time, a.id
  LOOP
    v_err := public.reschedule_slot_violation(v_ids, v_instructor, v_student,
                                              v_rec.proposed_date, v_rec.proposed_start_time);
    IF v_err IS NOT NULL THEN
      RETURN v_err;
    END IF;
  END LOOP;

  ------------------------------------------------------------ aplicacao
  BEGIN
    UPDATE public.appointments a
       SET date                   = a.proposed_date,
           start_time             = a.proposed_start_time,
           end_time               = a.proposed_end_time,
           rescheduled_at         = pg_catalog.now(),
           reschedule_requested_at = NULL,
           proposal_status        = 'accepted',
           proposal_resolved_at   = pg_catalog.now(),
           updated_at             = pg_catalog.now()
     WHERE a.id = ANY(v_ids)
       AND a.proposal_status = 'pending'
       AND a.status IN ('confirmed','scheduled');

    GET DIAGNOSTICS v_updated = ROW_COUNT;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('status','error','code','SLOT_TAKEN','scope','unique_index');
  END;

  IF v_updated <> v_total THEN
    RETURN jsonb_build_object('status','error','code','STATE_CHANGED');
  END IF;

  IF v_uid = v_student THEN
    v_target := v_instructor; v_screen := 'instructor_agenda';
  ELSE
    v_target := v_student;    v_screen := 'student_lessons';
  END IF;

  BEGIN
    PERFORM public.create_unified_notification(
      v_target,
      '📅 Remarcação aprovada',
      'A remarcação foi aceita. A aula passou para '
        || to_char(v_prop_date, 'DD/MM') || ' às '
        || to_char(v_prop_start, 'HH24:MI') || '.',
      'reschedule_accepted',
      CASE WHEN v_total > 1 THEN 'package' ELSE 'lesson' END,
      v_screen,
      v_total,
      NULL,
      v_ids[1]
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[accept_reschedule] notificacao falhou: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'status','ok',
    'updated', v_total,
    'group_id', v_group_id,
    'new_date', v_prop_date,
    'new_start_time', v_prop_start
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_reschedule(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_reschedule(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(uuid[]) TO authenticated;


-- ---------------------------------------------------------------------------
-- FASE E — reject_reschedule
-- Mantem o horario original. Nao escreve date/start_time/end_time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_reschedule(
  p_appointment_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_ids         uuid[];
  v_total       int;
  v_not_pending int;
  v_proposers   int;
  v_proposer    uuid;
  v_instructor  uuid;
  v_student     uuid;
  v_instructors int;
  v_students    int;
  v_group_id    uuid;
  v_target      uuid;
  v_screen      text;
  v_updated     int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','error','code','NOT_AUTHENTICATED');
  END IF;
  IF p_appointment_ids IS NULL THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_appointment_ids) AS x;
  IF v_ids IS NULL OR COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  PERFORM 1 FROM public.appointments WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT
    count(*),
    count(*) FILTER (WHERE a.proposal_status IS DISTINCT FROM 'pending'),
    count(DISTINCT a.proposed_by),
    (array_agg(a.proposed_by))[1],
    count(DISTINCT a.instructor_id),
    count(DISTINCT a.student_id),
    (array_agg(a.instructor_id))[1],
    (array_agg(a.student_id))[1],
    (array_agg(a.group_id) FILTER (WHERE a.group_id IS NOT NULL))[1]
  INTO
    v_total, v_not_pending, v_proposers, v_proposer,
    v_instructors, v_students, v_instructor, v_student, v_group_id
  FROM public.appointments a
  WHERE a.id = ANY(v_ids);

  IF v_total = 0 OR v_total <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('status','error','code','APPOINTMENT_NOT_FOUND');
  END IF;
  IF v_instructors <> 1 OR v_students <> 1 THEN
    RETURN jsonb_build_object('status','error','code','GROUP_MISMATCH');
  END IF;
  IF v_uid <> v_student AND v_uid <> v_instructor THEN
    RETURN jsonb_build_object('status','error','code','NOT_OWNER');
  END IF;
  IF v_not_pending > 0 THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_NOT_PENDING');
  END IF;
  IF v_proposers <> 1 THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_MISMATCH');
  END IF;
  IF v_uid = v_proposer THEN
    RETURN jsonb_build_object('status','error','code','NOT_COUNTERPARTY');
  END IF;

  UPDATE public.appointments a
     SET proposal_status        = 'rejected',
         proposal_resolved_at   = pg_catalog.now(),
         reschedule_requested_at = NULL,
         updated_at             = pg_catalog.now()
   WHERE a.id = ANY(v_ids)
     AND a.proposal_status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RETURN jsonb_build_object('status','error','code','STATE_CHANGED');
  END IF;

  IF v_uid = v_student THEN
    v_target := v_instructor; v_screen := 'instructor_agenda';
  ELSE
    v_target := v_student;    v_screen := 'student_lessons';
  END IF;

  BEGIN
    PERFORM public.create_unified_notification(
      v_target,
      '📅 Remarcação não aprovada',
      'A proposta de remarcação foi recusada. A aula permanece no horário original.',
      'reschedule_rejected',
      CASE WHEN v_total > 1 THEN 'package' ELSE 'lesson' END,
      v_screen,
      v_total,
      NULL,
      v_ids[1]
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[reject_reschedule] notificacao falhou: %', SQLERRM;
  END;

  RETURN jsonb_build_object('status','ok','rejected', v_total, 'group_id', v_group_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.reject_reschedule(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_reschedule(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_reschedule(uuid[]) TO authenticated;


-- ---------------------------------------------------------------------------
-- cancel_reschedule_proposal — somente QUEM PROPOS retira a propria proposta.
-- Nao notifica: nada mudou para a contraparte, o horario nunca saiu do lugar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_reschedule_proposal(
  p_appointment_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_ids         uuid[];
  v_total       int;
  v_not_pending int;
  v_not_mine    int;
  v_updated     int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','error','code','NOT_AUTHENTICATED');
  END IF;
  IF p_appointment_ids IS NULL THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_appointment_ids) AS x;
  IF v_ids IS NULL OR COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  PERFORM 1 FROM public.appointments WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE a.proposal_status IS DISTINCT FROM 'pending'),
         count(*) FILTER (WHERE a.proposed_by IS DISTINCT FROM v_uid)
    INTO v_total, v_not_pending, v_not_mine
  FROM public.appointments a
  WHERE a.id = ANY(v_ids);

  IF v_total = 0 OR v_total <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('status','error','code','APPOINTMENT_NOT_FOUND');
  END IF;
  IF v_not_pending > 0 THEN
    RETURN jsonb_build_object('status','error','code','PROPOSAL_NOT_PENDING');
  END IF;
  IF v_not_mine > 0 THEN
    RETURN jsonb_build_object('status','error','code','NOT_PROPOSER');
  END IF;

  UPDATE public.appointments a
     SET proposal_status      = 'cancelled',
         proposal_resolved_at = pg_catalog.now(),
         updated_at           = pg_catalog.now()
   WHERE a.id = ANY(v_ids)
     AND a.proposal_status = 'pending'
     AND a.proposed_by = v_uid;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RETURN jsonb_build_object('status','error','code','STATE_CHANGED');
  END IF;

  RETURN jsonb_build_object('status','ok','cancelled', v_total);
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_reschedule_proposal(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_reschedule_proposal(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_reschedule_proposal(uuid[]) TO authenticated;
