\set ON_ERROR_STOP on
SET TIME ZONE 'America/Sao_Paulo';

CREATE TABLE IF NOT EXISTS _t (n text, ok boolean, detail text);
TRUNCATE _t;

CREATE OR REPLACE FUNCTION t(p_n text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE sql AS $$ INSERT INTO _t VALUES (p_n, p_ok, p_detail) $$;

DO $BODY$
DECLARE
  I  uuid := '11111111-1111-1111-1111-111111111111';
  I2 uuid := '11111111-1111-1111-1111-111111111112';
  S  uuid := '22222222-2222-2222-2222-222222222222';
  S2 uuid := '22222222-2222-2222-2222-222222222223';
  X  uuid := '33333333-3333-3333-3333-333333333333';  -- terceiro
  G  uuid := '44444444-4444-4444-4444-444444444444';
  A uuid; B uuid; C uuid; OTHER uuid;
  dA date; dB date; dC date; dD date; dSun date;
  r jsonb;
  n int;
  v_date date; v_start time; v_end time;
BEGIN
  PERFORM set_config('test.role','authenticated', false);

  -- datas seguras: segunda-feira futura
  dA := current_date + 20; WHILE EXTRACT(dow FROM dA) <> 1 LOOP dA := dA + 1; END LOOP;
  dB := dA + 7; dC := dA + 14; dD := dA + 2;        -- dD = quarta
  dSun := dA + 6;                                    -- domingo

  INSERT INTO public.instructors (id, has_night_lessons, work_saturday_afternoon,
                                  lunch_active, lunch_start_slot, lunch_duration)
  VALUES (I, false, false, true, '12:00', 2), (I2, false, false, false, NULL, 0);

  -- ===== COMBO de 3 aulas, mesmo group_id, datas diferentes =====
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, dA, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO A;
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, dB, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO B;
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, dC, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO C;

  ------------------------------------------------------------------ 13. sem auth
  PERFORM set_config('test.uid','', false);
  r := public.propose_reschedule(ARRAY[B], dD, '14:00');
  PERFORM t('01 NOT_AUTHENTICATED', r->>'code' = 'NOT_AUTHENTICATED', r::text);

  ------------------------------------------------------------ 13. usuario errado
  PERFORM set_config('test.uid', X::text, false);
  r := public.propose_reschedule(ARRAY[B], dD, '14:00');
  PERFORM t('02 NOT_OWNER (terceiro)', r->>'code' = 'NOT_OWNER', r::text);

  --------------------------------------------------- 12/grade: domingo e almoco
  PERFORM set_config('test.uid', S::text, false);
  r := public.propose_reschedule(ARRAY[B], dSun, '14:00');
  PERFORM t('03 grade domingo', r->>'code'='SLOT_NOT_IN_GRID' AND r->>'reason'='sunday', r::text);

  r := public.propose_reschedule(ARRAY[B], dD, '12:00');
  PERFORM t('04 grade almoco', r->>'code'='SLOT_NOT_IN_GRID' AND r->>'reason'='lunch', r::text);

  r := public.propose_reschedule(ARRAY[B], dD, '19:00');
  PERFORM t('05 grade noite', r->>'code'='SLOT_NOT_IN_GRID' AND r->>'reason'='night_not_allowed', r::text);

  r := public.propose_reschedule(ARRAY[B], dD, '10:30');
  PERFORM t('06 grade slot quebrado', r->>'code'='SLOT_NOT_IN_GRID'
            AND r->>'reason'='outside_agenda_slots', r::text);

  r := public.propose_reschedule(ARRAY[B], current_date - 1, '10:00');
  PERFORM t('07 NEW_SLOT_IN_PAST', r->>'code'='NEW_SLOT_IN_PAST', r::text);

  ------------------------------------------------- 2/6/7. ALUNO <=24h PROPOE
  r := public.propose_reschedule(ARRAY[B], dD, '14:00');
  PERFORM t('08 aluno propoe OK', r->>'status'='ok' AND r->>'proposed_by_role'='student', r::text);

  -- 7. proposta pendente PRESERVA o horario vigente
  SELECT date, start_time INTO v_date, v_start FROM public.appointments WHERE id = B;
  PERFORM t('09 proposta nao move a aula', v_date = dB AND v_start = '10:00', v_date::text||' '||v_start::text);

  SELECT proposal_status, proposed_date, proposed_start_time, proposed_end_time
    INTO r, v_date, v_start, v_end FROM (
      SELECT to_jsonb(proposal_status) AS proposal_status, proposed_date,
             proposed_start_time, proposed_end_time
      FROM public.appointments WHERE id = B) q;
  PERFORM t('10 proposta gravada', r #>> '{}' = 'pending' AND v_date = dD
            AND v_start='14:00' AND v_end='15:00', v_date::text);

  -- 17. NENHUMA outra aula do combo mudou
  SELECT count(*) INTO n FROM public.appointments
   WHERE id IN (A,C) AND (proposal_status IS NOT NULL OR date <> (CASE WHEN id=A THEN dA ELSE dC END));
  PERFORM t('11 combo: A e C intactas apos proposta', n = 0, n::text);

  -- 18. segunda proposta sobre a mesma aula e' bloqueada
  r := public.propose_reschedule(ARRAY[B], dD, '15:00');
  PERFORM t('12 PROPOSAL_ALREADY_PENDING', r->>'code'='PROPOSAL_ALREADY_PENDING', r::text);

  -- proponente nao aceita a propria proposta
  r := public.accept_reschedule(ARRAY[B]);
  PERFORM t('13 NOT_COUNTERPARTY (proponente)', r->>'code'='NOT_COUNTERPARTY', r::text);

  -- terceiro nao aceita
  PERFORM set_config('test.uid', X::text, false);
  r := public.accept_reschedule(ARRAY[B]);
  PERFORM t('14 NOT_OWNER no accept', r->>'code'='NOT_OWNER', r::text);

  ------------------------------------------------------ 10. INSTRUTOR ACEITA
  PERFORM set_config('test.uid', I::text, false);
  r := public.accept_reschedule(ARRAY[B]);
  PERFORM t('15 instrutor aceita', r->>'status'='ok', r::text);

  SELECT date, start_time, end_time INTO v_date, v_start, v_end
    FROM public.appointments WHERE id = B;
  PERFORM t('16 aula B movida', v_date = dD AND v_start='14:00' AND v_end='15:00',
            v_date::text||' '||v_start::text);

  -- 13/16/17. SOMENTE a aula B mudou
  SELECT count(*) INTO n FROM public.appointments WHERE id = A AND date = dA AND start_time='10:00';
  PERFORM t('17 combo: aula A permanece', n = 1, n::text);
  SELECT count(*) INTO n FROM public.appointments WHERE id = C AND date = dC AND start_time='10:00';
  PERFORM t('18 combo: aula C permanece', n = 1, n::text);

  SELECT count(*) INTO n FROM public.appointments WHERE id = B AND proposal_status='accepted'
     AND proposal_resolved_at IS NOT NULL;
  PERFORM t('19 proposta encerrada como accepted', n = 1, n::text);

  -- 15. proposta ja resolvida
  r := public.accept_reschedule(ARRAY[B]);
  PERFORM t('20 PROPOSAL_NOT_PENDING apos aceite', r->>'code'='PROPOSAL_NOT_PENDING', r::text);

  ------------------------------------------- 6/11. INSTRUTOR PROPOE, ALUNO RECUSA
  PERFORM set_config('test.uid', I::text, false);
  r := public.propose_reschedule(ARRAY[C], dD, '16:00');
  PERFORM t('21 instrutor propoe OK', r->>'status'='ok' AND r->>'proposed_by_role'='instructor', r::text);

  SELECT date, start_time INTO v_date, v_start FROM public.appointments WHERE id = C;
  PERFORM t('22 proposta do instrutor nao move a aula', v_date = dC AND v_start='10:00', v_date::text);

  -- instrutor nao recusa a propria proposta
  r := public.reject_reschedule(ARRAY[C]);
  PERFORM t('23 NOT_COUNTERPARTY no reject', r->>'code'='NOT_COUNTERPARTY', r::text);

  PERFORM set_config('test.uid', S::text, false);
  r := public.reject_reschedule(ARRAY[C]);
  PERFORM t('24 aluno recusa', r->>'status'='ok', r::text);

  SELECT count(*) INTO n FROM public.appointments
   WHERE (id=A AND date=dA AND start_time='10:00')
      OR (id=B AND date=dD AND start_time='14:00')
      OR (id=C AND date=dC AND start_time='10:00');
  PERFORM t('25 recusa: NENHUMA aula mudou', n = 3, n::text);

  ------------------------------------------------- 14. proposta inexistente
  r := public.accept_reschedule(ARRAY[A]);
  PERFORM t('26 PROPOSAL_NOT_PENDING sem proposta', r->>'code'='PROPOSAL_NOT_PENDING', r::text);

  r := public.reject_reschedule(ARRAY['99999999-9999-9999-9999-999999999999'::uuid]);
  PERFORM t('27 APPOINTMENT_NOT_FOUND', r->>'code'='APPOINTMENT_NOT_FOUND', r::text);

  ------------------------------------------------- cancel_reschedule_proposal
  r := public.propose_reschedule(ARRAY[A], dD, '17:00');
  PERFORM t('28 aluno propoe em A', r->>'status'='ok', r::text);
  PERFORM set_config('test.uid', I::text, false);
  r := public.cancel_reschedule_proposal(ARRAY[A]);
  PERFORM t('29 NOT_PROPOSER', r->>'code'='NOT_PROPOSER', r::text);
  PERFORM set_config('test.uid', S::text, false);
  r := public.cancel_reschedule_proposal(ARRAY[A]);
  PERFORM t('30 proponente cancela', r->>'status'='ok', r::text);
  SELECT count(*) INTO n FROM public.appointments WHERE id=A AND proposal_status='cancelled'
    AND date = dA AND start_time='10:00';
  PERFORM t('31 cancelamento nao move a aula', n=1, n::text);

  ------------------------------------------------- 18. DUAS remarcacoes da MESMA aula
  r := public.propose_reschedule(ARRAY[A], dD, '17:00');
  PERFORM t('32 2a proposta na mesma aula permitida apos resolucao', r->>'status'='ok', r::text);
  PERFORM set_config('test.uid', I::text, false);
  r := public.accept_reschedule(ARRAY[A]);
  PERFORM t('33 2o aceite da mesma aula', r->>'status'='ok', r::text);

  ------------------------------------------------- 12. CONFLITO
  -- outro aluno ocupa um slot do instrutor
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status)
  VALUES (S2, I, dD, '09:00','10:00', 100, 'confirmed');
  PERFORM set_config('test.uid', S::text, false);
  r := public.propose_reschedule(ARRAY[C], dD, '09:00');
  PERFORM t('34 SLOT_TAKEN instrutor', r->>'code'='SLOT_TAKEN' AND r->>'scope'='instructor', r::text);

  ------------------------------------------------- 3/4. status invalido
  PERFORM set_config('test.role','service_role', false);
  UPDATE public.appointments SET status='pending' WHERE id=C;
  PERFORM set_config('test.role','authenticated', false);
  r := public.propose_reschedule(ARRAY[C], dD, '15:00');
  PERFORM t('35 INVALID_STATUS (pending)', r->>'code'='INVALID_STATUS', r::text);
  PERFORM set_config('test.role','service_role', false);
  UPDATE public.appointments SET status='scheduled' WHERE id=C;
  PERFORM set_config('test.role','authenticated', false);
  r := public.propose_reschedule(ARRAY[C], dD, '15:00');
  PERFORM t('36 scheduled aceito', r->>'status'='ok', r::text);
  PERFORM set_config('test.uid', I::text, false);
  PERFORM public.accept_reschedule(ARRAY[C]);
  SELECT count(*) INTO n FROM public.appointments WHERE id=C AND status='scheduled' AND date=dD;
  PERFORM t('37 aceite preserva status scheduled', n=1, n::text);

  ------------------------------------------------- GROUP_MISMATCH real
  -- aula de OUTRO grupo no mesmo array => recusado
  PERFORM set_config('test.role','service_role', false);
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, dD, '08:00','09:00', 100, 'confirmed',
          '88888888-8888-8888-8888-888888888888') RETURNING id INTO OTHER;
  PERFORM set_config('test.role','authenticated', false);
  PERFORM set_config('test.uid', S::text, false);
  r := public.propose_reschedule(ARRAY[A, OTHER], dD, '07:00');
  PERFORM t('38 GROUP_MISMATCH entre grupos distintos', r->>'code'='GROUP_MISMATCH', r::text);

END $BODY$;

-- ===================== 19. NOTIFICACOES SEM COLISAO =====================
DO $BODY$
DECLARE
  I uuid := '11111111-1111-1111-1111-111111111111';
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.notifications WHERE type='reschedule_requested';
  PERFORM t('39 notificacoes reschedule_requested criadas (>=4)', n >= 4, n::text);

  SELECT count(*) INTO n FROM public.notifications WHERE type='reschedule_accepted';
  PERFORM t('40 notificacoes reschedule_accepted criadas (>=3)', n >= 3, n::text);

  SELECT count(*) INTO n FROM public.notifications WHERE type='reschedule_rejected';
  PERFORM t('41 notificacao reschedule_rejected criada', n >= 1, n::text);

  -- a prova da nao-deduplicacao: mesmo type + mesmo user + mesmo appointment, 2 linhas
  SELECT count(*) INTO n FROM (
    SELECT type, user_id, appointment_id FROM public.notifications
    WHERE type LIKE 'reschedule%'
    GROUP BY 1,2,3 HAVING count(*) > 1) q;
  PERFORM t('42 duas notificacoes da MESMA aula coexistem (sem dedupe silencioso)', n >= 1, n::text);

  -- toda notificacao gerou job FCM
  SELECT count(*) INTO n FROM public.notifications x
   WHERE x.type LIKE 'reschedule%'
     AND NOT EXISTS (SELECT 1 FROM public.notification_jobs j WHERE j.notification_id = x.id);
  PERFORM t('43 todas as notificacoes enfileiraram job', n = 0, n::text);

  -- nenhuma notificacao de remarcacao carrega group_id
  SELECT count(*) INTO n FROM public.notifications WHERE type LIKE 'reschedule%' AND group_id IS NOT NULL;
  PERFORM t('44 notificacoes de remarcacao nao usam group_id', n = 0, n::text);

  -- nenhum tipo 'system' usado como workaround
  SELECT count(*) INTO n FROM public.notifications WHERE type = 'system';
  PERFORM t('45 zero workaround via type=system', n = 0, n::text);
END $BODY$;

-- ============ P-1.20.4 CORRIGIDA: colisao de idempotencia resolvida ============
DO $BODY$
DECLARE
  I uuid := '55555555-5555-5555-5555-555555555555';
  S uuid := '66666666-6666-6666-6666-666666666666';
  G uuid := '77777777-7777-7777-7777-777777777777';
  L uuid; d0 date; dN date; r jsonb; n int;
BEGIN
  PERFORM set_config('test.role','authenticated', false);
  INSERT INTO public.instructors (id, has_night_lessons, work_saturday_afternoon,
                                  lunch_active, lunch_start_slot, lunch_duration)
  VALUES (I, false, false, false, NULL, 0);

  d0 := current_date + 30; WHILE EXTRACT(dow FROM d0) <> 2 LOOP d0 := d0 + 1; END LOOP;
  dN := d0 + 1;

  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, d0, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO L;

  -- reproduz o estado de producao: notificacao booking_request da COMPRA
  INSERT INTO public.notifications (user_id, title, message, type, entity_type,
                                    target_screen, combo_count, group_id, appointment_id, payload_version)
  VALUES (I, 'Nova solicitacao de aula', '...', 'booking_request', 'lesson',
          'instructor_agenda', 1, G, L, 1);

  PERFORM set_config('test.uid', S::text, false);
  r := public.reschedule_appointment_direct(ARRAY[L], dN, '15:00');
  PERFORM t('46 P-1.20.4 remarcacao direta OK', r->>'status'='ok', r::text);

  SELECT count(*) INTO n FROM public.notifications
   WHERE user_id = I AND type = 'reschedule_applied' AND appointment_id = L;
  PERFORM t('47 P-1.20.4 NOTIFICOU (colisao resolvida)', n = 1, n::text);

  SELECT count(*) INTO n FROM public.notification_jobs j
    JOIN public.notifications x ON x.id = j.notification_id
   WHERE x.type = 'reschedule_applied';
  PERFORM t('48 P-1.20.4 job FCM enfileirado', n = 1, n::text);

  -- segunda remarcacao da MESMA aula tambem notifica
  r := public.reschedule_appointment_direct(ARRAY[L], dN, '16:00');
  SELECT count(*) INTO n FROM public.notifications
   WHERE user_id = I AND type = 'reschedule_applied' AND appointment_id = L;
  PERFORM t('49 2a remarcacao direta tambem notifica', n = 2, n::text);
END $BODY$;

-- ====== 13/16/17. COMBO: remarcacao direta >24h move SOMENTE a aula escolhida ======
DO $BODY$
DECLARE
  I uuid := '99999999-9999-9999-9999-999999999991';
  S uuid := '99999999-9999-9999-9999-999999999992';
  G uuid := '99999999-9999-9999-9999-999999999993';
  L1 uuid; L2 uuid; L3 uuid; d1 date; d2 date; d3 date; dNew date; r jsonb; n int;
BEGIN
  PERFORM set_config('test.role','authenticated', false);
  INSERT INTO public.instructors (id, has_night_lessons, work_saturday_afternoon,
                                  lunch_active, lunch_start_slot, lunch_duration)
  VALUES (I, false, false, false, NULL, 0);

  d1 := current_date + 40; WHILE EXTRACT(dow FROM d1) <> 1 LOOP d1 := d1 + 1; END LOOP;
  d2 := d1 + 7; d3 := d1 + 14; dNew := d1 + 9;   -- dNew = quarta da 2a semana

  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, d1, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO L1;
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, d2, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO L2;
  INSERT INTO public.appointments (student_id, instructor_id, date, start_time, end_time,
                                   price, status, group_id)
  VALUES (S, I, d3, '10:00','11:00', 100, 'confirmed', G) RETURNING id INTO L3;

  PERFORM set_config('test.uid', S::text, false);
  r := public.reschedule_appointment_direct(ARRAY[L2], dNew, '14:00');
  PERFORM t('52 combo >24h: remarcacao da aula 2 OK', r->>'status'='ok', r::text);

  SELECT count(*) INTO n FROM public.appointments WHERE id=L1 AND date=d1 AND start_time='10:00';
  PERFORM t('53 combo >24h: aula 1 = horario A', n=1, n::text);
  SELECT count(*) INTO n FROM public.appointments WHERE id=L2 AND date=dNew AND start_time='14:00';
  PERFORM t('54 combo >24h: aula 2 = horario D', n=1, n::text);
  SELECT count(*) INTO n FROM public.appointments WHERE id=L3 AND date=d3 AND start_time='10:00';
  PERFORM t('55 combo >24h: aula 3 = horario C', n=1, n::text);

  -- proposta pendente bloqueia a remarcacao direta
  r := public.propose_reschedule(ARRAY[L1], dNew, '15:00');
  PERFORM t('56 proposta criada em L1', r->>'status'='ok', r::text);
  r := public.reschedule_appointment_direct(ARRAY[L1], dNew, '16:00');
  PERFORM t('57 remarcacao direta nao passa por cima de proposta',
            r->>'status'='error', r::text);
END $BODY$;

-- ===================== 20. ZERO ALTERACAO FINANCEIRA =====================
DO $BODY$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.appointments
   WHERE payment_status IS DISTINCT FROM 'pending' OR price IS DISTINCT FROM 100
      OR payment_id IS NOT NULL OR payment_intent_id IS NOT NULL
      OR provider_payment_id IS NOT NULL OR purchase_id IS NOT NULL
      OR provider_name IS DISTINCT FROM 'asaas';
  PERFORM t('50 zero alteracao financeira em appointments', n = 0, n::text);

  SELECT count(*) INTO n FROM public.appointments WHERE status NOT IN ('confirmed','scheduled');
  PERFORM t('51 nenhum status alterado pelas RPCs', n = 0, n::text);
END $BODY$;

\echo ''
\echo '================= RESULTADO ================='
SELECT n AS teste, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS r, detail FROM _t WHERE NOT ok;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail, count(*) AS total FROM _t;
