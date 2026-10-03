-- =============================================================================
-- FASE 3 — prazo definitivo de pagamento do novo fluxo (booking_request_accept)
-- =============================================================================
--
-- PROPOSTA. NAO APLICADA. Aplicacao somente com autorizacao do proprietario.
-- Depende de 20261003_booking_request_atomic_ops.sql (aplicada em 03/10/2026).
--
-- DECISAO DE NEGOCIO (03/10/2026)
--   expires_at = min(accepted_at + 15 minutos, inicio da primeira aula do grupo)
--   - o prazo conta do registro do aceite no servidor (relogio do banco);
--   - sem antecedencia minima: aceite 6 min antes da aula = 6 min para pagar;
--   - aceite NAO permitido depois do inicio da aula.
--
-- O QUE MUDA (somente esta funcao; mesma assinatura)
--   Antes: recusava (TOO_LATE) se alguma aula comecasse antes de aceite + 15 min,
--          e gravava expires_at = aceite + 15 min.
--   Agora: recusa (TOO_LATE) so' se a primeira aula ja' comecou, e grava
--          expires_at = least(aceite + 15 min, inicio da primeira aula).
--   Inalterado: bloqueio do grupo inteiro (FOR UPDATE), avaliacao de TODAS as
--   aulas, UPDATE condicional unico, conferencia de linhas (RAISE desfaz tudo),
--   idempotencia (ALREADY_ACCEPTED), SECURITY DEFINER, search_path, EXECUTE so'
--   para service_role. Nenhuma tabela, coluna, CHECK ou outra funcao muda.
--
-- EFEITO NAS DEMAIS FUNCOES (sem alteracao)
--   start_payment / attach_payment exigem expires_at > now(): nao ha' inicio de
--   pagamento depois do prazo, e portanto depois do inicio da aula.
--   expire exige expires_at <= now(): a expiracao acontece no inicio da aula.
--
-- ROLLBACK
--   Reaplicar a definicao de booking_request_accept de
--   20261003_booking_request_atomic_ops.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.booking_request_accept(
  p_group_id uuid,
  p_instructor_id uuid,
  p_payment_window_minutes integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_deadline    timestamptz;
  v_first_start timestamptz;
  v_total       integer;
  v_pending     integer;
  v_accepted    integer;
  v_foreign     integer;
  v_req_late    integer;
  v_updated     integer;
BEGIN
  IF p_group_id IS NULL OR p_instructor_id IS NULL
     OR p_payment_window_minutes IS NULL OR p_payment_window_minutes < 1 OR p_payment_window_minutes > 120 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status IN ('reserved', 'awaiting_payment', 'confirmed') AND accepted_at IS NOT NULL),
         count(*) FILTER (WHERE instructor_id IS DISTINCT FROM p_instructor_id),
         count(*) FILTER (WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= v_now),
         min((date + start_time) AT TIME ZONE 'America/Sao_Paulo')
    INTO v_total, v_pending, v_accepted, v_foreign, v_req_late, v_first_start
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'FORBIDDEN');
  END IF;
  IF v_accepted = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_ACCEPTED', 'lessons', v_total);
  END IF;
  IF v_pending <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_STATE');
  END IF;
  IF v_req_late > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'REQUEST_EXPIRED');
  END IF;
  -- Aula sem data/hora valida ou ja' iniciada: nao aceita.
  IF v_first_start IS NULL OR v_first_start <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'TOO_LATE');
  END IF;

  -- Prazo: 15 min a partir do aceite, nunca depois do inicio da primeira aula.
  v_deadline := LEAST(v_now + make_interval(mins => p_payment_window_minutes), v_first_start);

  UPDATE public.appointments
     SET status = 'reserved', accepted_at = v_now, expires_at = v_deadline, updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request' AND status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RAISE EXCEPTION 'booking_request_accept: % de % aulas atualizadas (grupo %)', v_updated, v_total, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'ACCEPTED', 'lessons', v_total,
                            'accepted_at', v_now, 'payment_deadline', v_deadline);
END;
$function$;

REVOKE ALL ON FUNCTION public.booking_request_accept(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_request_accept(uuid, uuid, integer) TO service_role;

-- =============================================================================
-- VERIFICACAO — DEPOIS DE APLICAR (somente SELECT)
-- =============================================================================
-- SELECT has_function_privilege('anon', 'public.booking_request_accept(uuid,uuid,integer)', 'EXECUTE') AS anon,
--        has_function_privilege('authenticated', 'public.booking_request_accept(uuid,uuid,integer)', 'EXECUTE') AS auth,
--        has_function_privilege('service_role', 'public.booking_request_accept(uuid,uuid,integer)', 'EXECUTE') AS service;
-- SELECT prosecdef, proconfig, position('LEAST(' in prosrc) > 0 AS regra_nova
--   FROM pg_proc WHERE oid = 'public.booking_request_accept(uuid,uuid,integer)'::regprocedure;
-- =============================================================================
