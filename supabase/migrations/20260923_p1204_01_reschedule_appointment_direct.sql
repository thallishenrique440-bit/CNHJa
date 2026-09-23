-- =============================================================================
-- P-1.20.4 FASE 1 — REMARCACAO DIRETA DO ALUNO (>24h)
--
-- Move para o servidor o UPDATE que hoje o cliente faz direto em
-- pages/student/Lessons.tsx:955-961. Aquele caminho grava `date`,
-- `start_time`, `end_time` e `rescheduled_at` sem nenhuma validacao
-- server-side: o trigger `check_appointments_update_security` protege apenas as
-- 7 colunas financeiras, e a policy `Users can update their own appointments`
-- tem `WITH CHECK` nulo. Propriedade, status, regra das 24h e conflito sao hoje
-- verificados somente na UI.
--
-- Alem disso, a checagem de conflito e o UPDATE sao hoje DUAS chamadas
-- separadas (`check_appointment_conflict` em :916, UPDATE em :955) — uma janela
-- TOCTOU. Aqui as duas acontecem na MESMA transacao.
--
-- REGRA DE NEGOCIO (fechada): aula ja aceita (`confirmed`/`scheduled`) com mais
-- de 24h e remarcada DIRETAMENTE, com o mesmo instrutor, sem novo aceite. O
-- instrutor apenas e notificado.
--
-- NEUTRALIDADE FINANCEIRA: esta funcao escreve EXCLUSIVAMENTE `date`,
-- `start_time`, `end_time`, `rescheduled_at` e `updated_at`. Nao toca `status`,
-- `payment_status`, `price` nem qualquer coluna ou tabela financeira.
--
-- NAO APLICADA. Revisar antes de executar.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reschedule_appointment_direct(
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
  c_tz            constant text := 'America/Sao_Paulo';
  v_uid           uuid := auth.uid();
  v_ids           uuid[];
  v_total         int;
  v_not_owner     int;
  v_bad_status    int;
  v_pending_req   int;
  v_groups        int;
  v_null_groups   int;
  v_instructors   int;
  v_instructor    uuid;
  v_group_id      uuid;
  v_student_id    uuid;
  v_earliest      timestamptz;
  v_now           timestamptz := clock_timestamp();
  v_new_start_ts  timestamptz;
  v_dow           int;
  v_minutes       int;
  v_sat_limit     int;
  v_has_night     boolean;
  v_work_sat      boolean;
  v_lunch_active  boolean;
  v_lunch_start   time;
  v_lunch_dur     int;
  v_lunch_end     time;
  v_cursor        time;
  v_rec           record;
  v_new_start     time;
  v_new_end       time;
  v_dur           interval;
  v_conflict      boolean;
  v_student_busy  boolean;
  v_changed       int := 0;
  v_updated       int := 0;
BEGIN
  ------------------------------------------------------------------ 0. entrada
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','error','code','NOT_AUTHENTICATED');
  END IF;

  IF p_appointment_ids IS NULL OR p_new_date IS NULL OR p_new_start_time IS NULL THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_appointment_ids) AS x;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_INPUT');
  END IF;

  -- Trava as linhas ate o fim da transacao. Sem isso, dois pedidos simultaneos
  -- poderiam passar pela mesma validacao e colidir so no indice unico.
  PERFORM 1 FROM public.appointments WHERE id = ANY(v_ids) FOR UPDATE;

  ------------------------------------------------- 1-4,7. validacoes agregadas
  SELECT
    count(*),
    count(*) FILTER (WHERE a.student_id IS DISTINCT FROM v_uid),
    count(*) FILTER (WHERE a.status NOT IN ('confirmed','scheduled')),
    count(*) FILTER (WHERE a.reschedule_requested_at IS NOT NULL),
    count(DISTINCT a.group_id),
    count(*) FILTER (WHERE a.group_id IS NULL),
    count(DISTINCT a.instructor_id),
    -- min() nao existe para uuid; array_agg()[1] e o equivalente seguro aqui,
    -- porque as validacoes de grupo/instrutor abaixo garantem valor unico.
    (array_agg(a.instructor_id))[1],
    (array_agg(a.group_id) FILTER (WHERE a.group_id IS NOT NULL))[1],
    (array_agg(a.student_id))[1],
    min((a.date + a.start_time) AT TIME ZONE c_tz)
  INTO
    v_total, v_not_owner, v_bad_status, v_pending_req,
    v_groups, v_null_groups, v_instructors,
    v_instructor, v_group_id, v_student_id, v_earliest
  FROM public.appointments a
  WHERE a.id = ANY(v_ids);

  IF v_total = 0 OR v_total <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('status','error','code','APPOINTMENT_NOT_FOUND');
  END IF;

  -- 1. propriedade: auth.uid() precisa ser o student_id de TODAS as linhas
  IF v_not_owner > 0 THEN
    RETURN jsonb_build_object('status','error','code','NOT_OWNER');
  END IF;

  -- 3. somente aula ja aceita pode ser remarcada diretamente
  IF v_bad_status > 0 THEN
    RETURN jsonb_build_object('status','error','code','INVALID_STATUS');
  END IF;

  -- 4. proposta pendente bloqueia a remarcacao direta
  IF v_pending_req > 0 THEN
    RETURN jsonb_build_object('status','error','code','RESCHEDULE_PENDING');
  END IF;

  -- 2. todas as linhas no mesmo grupo (uma aula avulsa tem group_id nulo)
  IF v_total > 1 AND (v_null_groups > 0 OR v_groups <> 1) THEN
    RETURN jsonb_build_object('status','error','code','GROUP_MISMATCH');
  END IF;

  -- 7. mesmo instrutor, derivado do banco (nunca recebido do cliente)
  IF v_instructors <> 1 THEN
    RETURN jsonb_build_object('status','error','code','INSTRUCTOR_MISMATCH');
  END IF;

  ------------------------------------------------------------- 5. regra das 24h
  -- Calculada no servidor, em America/Sao_Paulo, sobre o horario ORIGINAL mais
  -- proximo do grupo. O relogio do cliente nunca participa.
  IF v_earliest IS NULL OR v_earliest <= v_now + interval '24 hours' THEN
    RETURN jsonb_build_object(
      'status','error','code','UNDER_24H',
      'hours_remaining', round(extract(epoch FROM (v_earliest - v_now)) / 3600.0, 2)
    );
  END IF;

  ------------------------------------------------------ 6. novo horario futuro
  v_new_start_ts := (p_new_date + p_new_start_time) AT TIME ZONE c_tz;
  IF v_new_start_ts <= v_now THEN
    RETURN jsonb_build_object('status','error','code','NEW_SLOT_IN_PAST');
  END IF;

  ------------------------------------------- 8. grade: configuracao do instrutor
  -- Fonte da verdade: api/create-booking-intent.ts:314-360, que e a UNICA
  -- validacao de grade server-side ja existente no projeto. Ela percorre
  -- `for (const lesson of lessons)` — ou seja, valida CADA aula do pacote
  -- individualmente. Esta RPC faz o mesmo, no loop por slot abaixo.
  --
  -- O almoco NAO e' 12:00/13:00 fixo: vem de `instructors.lunch_active`,
  -- `lunch_start_slot` e `lunch_duration` (defaults true / '12:00' / 2).
  SELECT COALESCE(i.has_night_lessons, false),
         COALESCE(i.work_saturday_afternoon, false),
         COALESCE(i.lunch_active, false),
         NULLIF(i.lunch_start_slot, '')::time,
         GREATEST(COALESCE(i.lunch_duration, 2), 0)
    INTO v_has_night, v_work_sat, v_lunch_active, v_lunch_start, v_lunch_dur
  FROM public.instructors i WHERE i.id = v_instructor;

  -- AGENDA_SLOTS (lib/slots.ts) e horaria e vai de 07:00 a 22:00, entao a fatia
  -- slice(idx, idx + lunch_duration) equivale a [inicio, inicio + duracao h).
  IF COALESCE(v_lunch_active, false) AND v_lunch_start IS NOT NULL
     AND v_lunch_start >= time '07:00' AND v_lunch_start <= time '22:00'
     AND EXTRACT(minute FROM v_lunch_start) = 0 AND v_lunch_dur > 0 THEN
    v_lunch_end := v_lunch_start + (v_lunch_dur || ' hours')::interval;
  ELSE
    v_lunch_end := NULL;  -- mesmo efeito do startIndex === -1 no TypeScript
  END IF;

  -- Domingo e regra de data, nao de slot: vale para o grupo inteiro.
  v_dow := EXTRACT(dow FROM p_new_date);
  IF v_dow = 0 THEN
    RETURN jsonb_build_object('status','error','code','SLOT_NOT_IN_GRID','reason','sunday');
  END IF;

  ------------------------------------ 13. idempotencia + 9. conflito por slot
  -- Slots consecutivos a partir de p_new_start_time, preservando a duracao
  -- individual de cada aula (end_time - start_time da linha atual).
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

    -- 8. grade, aula por aula (espelha create-booking-intent.ts:314-360)
    v_minutes := EXTRACT(hour FROM v_new_start) * 60 + EXTRACT(minute FROM v_new_start);

    IF EXTRACT(minute FROM v_new_start) <> 0
       OR EXTRACT(second FROM v_new_start) <> 0
       OR EXTRACT(hour FROM v_new_start) < 7
       OR EXTRACT(hour FROM v_new_start) > 22 THEN
      RETURN jsonb_build_object('status','error','code','SLOT_NOT_IN_GRID','reason','outside_agenda_slots',
                                'start_time', v_new_start);
    END IF;

    -- noite: create-booking-intent bloqueia a partir das 18:00
    IF NOT v_has_night AND v_minutes >= 18 * 60 THEN
      RETURN jsonb_build_object('status','error','code','SLOT_NOT_IN_GRID','reason','night_not_allowed',
                                'start_time', v_new_start);
    END IF;

    -- sabado: 17:00 com work_saturday_afternoon, senao 11:10
    IF v_dow = 6 THEN
      v_sat_limit := CASE WHEN v_work_sat THEN 17 * 60 ELSE 11 * 60 + 10 END;
      IF v_minutes > v_sat_limit THEN
        RETURN jsonb_build_object('status','error','code','SLOT_NOT_IN_GRID','reason','saturday_limit',
                                  'start_time', v_new_start);
      END IF;
    END IF;

    -- almoco configurado pelo instrutor
    IF v_lunch_end IS NOT NULL AND v_new_start >= v_lunch_start AND v_new_start < v_lunch_end THEN
      RETURN jsonb_build_object('status','error','code','SLOT_NOT_IN_GRID','reason','lunch',
                                'start_time', v_new_start);
    END IF;

    IF v_rec.date IS DISTINCT FROM p_new_date
       OR v_rec.start_time IS DISTINCT FROM v_new_start
       OR v_rec.end_time IS DISTINCT FROM v_new_end THEN
      v_changed := v_changed + 1;
    END IF;

    -- 9. conflito do INSTRUTOR, reaproveitando a RPC existente
    SELECT public.check_appointment_conflict(v_instructor, p_new_date, v_new_start, v_ids)
      INTO v_conflict;
    IF COALESCE(v_conflict, true) THEN
      RETURN jsonb_build_object('status','error','code','SLOT_TAKEN','scope','instructor',
                                'date', p_new_date, 'start_time', v_new_start);
    END IF;

    -- conflito do ALUNO (idx_unique_student_active_slot). A RPC de conflito so
    -- olha o instrutor; o aluno tem indice unico proprio.
    SELECT EXISTS (
      SELECT 1 FROM public.appointments b
      WHERE b.student_id = v_student_id
        AND b.date = p_new_date
        AND b.start_time = v_new_start
        AND b.status <> ALL (ARRAY['cancelled','failed','rejected','expired'])
        AND NOT (b.id = ANY(v_ids))
    ) INTO v_student_busy;
    IF v_student_busy THEN
      RETURN jsonb_build_object('status','error','code','SLOT_TAKEN','scope','student',
                                'date', p_new_date, 'start_time', v_new_start);
    END IF;

    v_cursor := v_new_end;
  END LOOP;

  -- 13. ja esta exatamente no horario pedido: nada a escrever, nada a notificar
  IF v_changed = 0 THEN
    RETURN jsonb_build_object('status','no_op','reason','already_at_requested_slot');
  END IF;

  ------------------------------------------------------------------ 10. UPDATE
  -- O bloco EXCEPTION cria um savepoint: se a segunda aula do grupo violar o
  -- indice unico, a primeira tambem e desfeita. O indice continua sendo a
  -- garantia final; aqui ele apenas deixa de vazar 23505 bruto para a UI.
  BEGIN
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
         SET date           = p_new_date,
             start_time     = v_new_start,
             end_time       = v_new_end,
             rescheduled_at = pg_catalog.now(),
             updated_at     = pg_catalog.now()
       WHERE a.id = v_rec.id
         AND a.student_id = v_uid
         AND a.status IN ('confirmed','scheduled');

      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated = 0 THEN
        RETURN jsonb_build_object('status','error','code','STATE_CHANGED');
      END IF;

      v_cursor := v_new_end;
    END LOOP;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('status','error','code','SLOT_TAKEN','scope','unique_index');
  END;

  ------------------------------------------------------------ notificacao
  -- Emitida pelo SERVIDOR. Antes o cliente chamava create_unified_notification
  -- diretamente e podia forjar o conteudo. Falha de notificacao nao desfaz a
  -- remarcacao: a aula ja foi movida.
  BEGIN
    PERFORM public.create_unified_notification(
      v_instructor,
      '📅 Aula remarcada',
      'O aluno remarcou a aula para ' || to_char(p_new_date, 'DD/MM') ||
        ' as ' || to_char(p_new_start_time, 'HH24:MI') || '.',
      'booking_request',
      CASE WHEN v_total > 1 THEN 'package' ELSE 'lesson' END,
      'instructor_agenda',
      v_total,
      v_group_id,
      v_ids[1]
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[reschedule_appointment_direct] notificacao falhou: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'status','ok',
    'updated', v_total,
    'group_id', v_group_id,
    'new_date', p_new_date,
    'new_start_time', p_new_start_time
  );
END;
$function$;

-- Mesmo padrao de check_appointment_conflict e claim_refund_operation.
REVOKE ALL ON FUNCTION public.reschedule_appointment_direct(uuid[], date, time) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reschedule_appointment_direct(uuid[], date, time) FROM anon;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment_direct(uuid[], date, time) TO authenticated;

COMMENT ON FUNCTION public.reschedule_appointment_direct(uuid[], date, time) IS
  'P-1.20.4: remarcacao direta do aluno (>24h) com autoridade server-side. '
  'Escreve somente date/start_time/end_time/rescheduled_at/updated_at. '
  'Zero efeitos financeiros: nao toca status, payment_status, price nem tabelas financeiras.';
