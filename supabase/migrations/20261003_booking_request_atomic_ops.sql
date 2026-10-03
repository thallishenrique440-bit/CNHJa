-- =============================================================================
-- FASE 2 — novo fluxo de agendamento: integridade e operacoes atomicas
-- =============================================================================
--
-- APLICADA EM PRODUCAO em 2026-10-03 15:23:49 UTC (projeto ohftsqsxymtrclnpadam),
-- pela API de migrations, com autorizacao do proprietario. Registro no
-- historico remoto: 20261003152349 booking_request_atomic_ops. NAO reaplicar
-- sem necessidade (e' idempotente, mas o historico ja' a registra).
--
-- NOVO FLUXO (ainda NAO ativado; nenhuma tela ou backend usa estas funcoes)
--   pedido sem pagamento -> aceite do instrutor -> janela de pagamento ->
--   pagamento confirmado pelo provedor -> aula confirmada.
--
--   status:  pending --aceite--> reserved --inicio do pagamento--> awaiting_payment
--                                   \                                   |
--                                    +------- confirmacao do pagamento -+--> confirmed
--            pending --recusa--> cancelled (cancelled_reason = instructor_rejected)
--            pending --cancelamento do aluno--> cancelled (cancelled_reason = student_cancelled)
--            pending|reserved|awaiting_payment --prazo vencido--> expired
--
-- O QUE FAZ
--   1. `appointments.booking_flow` ('legacy' | 'request'), NOT NULL DEFAULT
--      'legacy'. Toda linha existente vira 'legacy'; o fluxo atual nao muda.
--      As funcoes abaixo so' tocam linhas 'request'.
--   2. `appointments.accepted_at` (momento do aceite). So' em linhas 'request'.
--   3. Trigger que impede o cliente (anon/authenticated) de gravar essas duas
--      colunas e de mudar o STATUS de linhas 'request' (no novo fluxo toda
--      transicao passa pelas funcoes abaixo, que tratam o grupo inteiro e
--      disputam o mesmo bloqueio). A service role nao e' afetada.
--   4. Sete funcoes atomicas (uma instrucao condicional por transicao, com
--      bloqueio das linhas do grupo), executaveis SOMENTE pela service role:
--        booking_request_accept, booking_request_reject,
--        booking_request_cancel_by_student,
--        booking_request_start_payment, booking_request_attach_payment,
--        booking_request_confirm_payment, booking_request_expire.
--      Cada uma devolve jsonb {ok, outcome, ...}. Repetir a chamada devolve o
--      mesmo resultado sem nova escrita (idempotencia).
--   5. `get_instructor_availability`: pedido do proprio aluno no novo fluxo
--      aparece como 'my_request' (nao como 'my_reservation', que a tela trata
--      como horario livre para nova tentativa). Restante identico ao de producao.
--
-- O QUE NAO FAZ
--   - Nao altera o CHECK de status (usa apenas status ja' permitidos).
--   - Nao altera os indices unicos: eles continuam sendo a garantia contra
--     reserva dupla (instrutor e aluno), tambem para o novo fluxo.
--   - Nao cria nem cancela cobranca, nao chama o provedor, nao toca em
--     transactions, payment_installments, payouts, estornos ou split.
--   - Nao altera as funcoes AP-01/AP-03 existentes.
--
-- DECISOES EMBUTIDAS (ver relatorio da Fase 2)
--   - Grupo (combo) e' aceito, recusado, pago e expirado INTEIRO.
--   - Janela de pagamento padrao: 15 min a partir do aceite, no relogio do banco.
--   - Aceite exige que TODAS as aulas comecem depois do fim da janela.
--   - Recusa sem pagamento: status `cancelled` + cancelled_reason
--     `instructor_rejected` (o CHECK de producao nao tem `rejected`).
--   - Confirmacao nao depende do relogio: reserva ainda ATIVA (o cron nao a
--     expirou) aceita o pagamento — o horario continua protegido pelo indice.
--
-- EXECUCAO REPETIDA
--   Idempotente (IF NOT EXISTS, CREATE OR REPLACE, verificacao de constraint).
--
-- ROLLBACK (somente se nenhuma linha 'request' existir)
--   DROP FUNCTION IF EXISTS public.booking_request_accept(uuid, uuid, integer);
--   DROP FUNCTION IF EXISTS public.booking_request_reject(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.booking_request_cancel_by_student(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.booking_request_start_payment(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.booking_request_attach_payment(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.booking_request_confirm_payment(uuid, text);
--   DROP FUNCTION IF EXISTS public.booking_request_expire(uuid, boolean);
--   DROP TRIGGER IF EXISTS appointments_booking_flow_guard_trigger ON public.appointments;
--   DROP FUNCTION IF EXISTS public.guard_appointments_booking_flow_columns();
--   DROP INDEX IF EXISTS public.idx_appointments_request_active_expiry;
--   ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_accepted_at_flow_check;
--   ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_booking_flow_check;
--   ALTER TABLE public.appointments DROP COLUMN IF EXISTS accepted_at;
--   ALTER TABLE public.appointments DROP COLUMN IF EXISTS booking_flow;
--   e reaplicar a definicao anterior de get_instructor_availability (sem o
--   ramo 'my_request').
-- =============================================================================

-- 1. Colunas ------------------------------------------------------------------
-- ADD COLUMN com DEFAULT constante nao reescreve a tabela (PostgreSQL >= 11).
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS booking_flow text NOT NULL DEFAULT 'legacy';
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.appointments'::regclass
                    AND conname = 'appointments_booking_flow_check') THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_booking_flow_check
      CHECK (booking_flow IN ('legacy', 'request'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.appointments'::regclass
                    AND conname = 'appointments_accepted_at_flow_check') THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_accepted_at_flow_check
      CHECK (accepted_at IS NULL OR booking_flow = 'request');
  END IF;
END;
$$;

COMMENT ON COLUMN public.appointments.booking_flow IS
  'Fase 2: fluxo de origem. legacy = paga antes do aceite (atual); request = pedido sem pagamento, pagamento so'' apos o aceite.';
COMMENT ON COLUMN public.appointments.accepted_at IS
  'Fase 2: momento do aceite do instrutor (somente booking_flow = request).';

-- Pedidos ativos por prazo: usado pela expiracao do novo fluxo.
CREATE INDEX IF NOT EXISTS idx_appointments_request_active_expiry
  ON public.appointments (expires_at)
  WHERE booking_flow = 'request' AND status IN ('pending', 'reserved', 'awaiting_payment');

-- 2. Protecao das colunas novas contra o cliente ------------------------------
CREATE OR REPLACE FUNCTION public.guard_appointments_booking_flow_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.booking_flow IS DISTINCT FROM 'legacy' OR NEW.accepted_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_flow/accepted_at nao podem ser definidos via client. (Fase 2)';
      END IF;
    ELSIF NEW.booking_flow IS DISTINCT FROM OLD.booking_flow
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
      RAISE EXCEPTION 'booking_flow/accepted_at nao podem ser alterados via client. (Fase 2)';
    ELSIF OLD.booking_flow = 'request' AND NEW.status IS DISTINCT FROM OLD.status THEN
      -- Novo fluxo: aceite, recusa, cancelamento, pagamento e expiracao so'
      -- pelas funcoes booking_request_* (grupo inteiro, mesmo bloqueio). Um
      -- UPDATE direto do cliente poderia cancelar uma aula de um combo, ou
      -- correr em paralelo com o aceite sem disputar o bloqueio do grupo.
      RAISE EXCEPTION 'Status de pedido do novo fluxo nao pode ser alterado via client. Use o backend. (Fase 2)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS appointments_booking_flow_guard_trigger ON public.appointments;
CREATE TRIGGER appointments_booking_flow_guard_trigger
  BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_appointments_booking_flow_columns();

-- 3. Operacoes atomicas --------------------------------------------------------
-- Padrao comum: bloqueia (FOR UPDATE) as linhas 'request' do grupo, avalia o
-- estado de TODAS, e aplica UMA instrucao UPDATE condicional. Se o numero de
-- linhas alteradas divergir do esperado, a funcao aborta (RAISE) e a
-- transacao inteira e' desfeita: nunca fica um grupo pela metade.

-- 3.1 Aceite: pending -> reserved, abre a janela de pagamento.
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
  v_now       timestamptz := now();
  v_deadline  timestamptz;
  v_total     integer;
  v_pending   integer;
  v_accepted  integer;
  v_foreign   integer;
  v_req_late  integer;
  v_too_late  integer;
  v_updated   integer;
BEGIN
  IF p_group_id IS NULL OR p_instructor_id IS NULL
     OR p_payment_window_minutes IS NULL OR p_payment_window_minutes < 1 OR p_payment_window_minutes > 120 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;
  v_deadline := v_now + make_interval(mins => p_payment_window_minutes);

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status IN ('reserved', 'awaiting_payment', 'confirmed') AND accepted_at IS NOT NULL),
         count(*) FILTER (WHERE instructor_id IS DISTINCT FROM p_instructor_id),
         count(*) FILTER (WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= v_now),
         count(*) FILTER (WHERE ((date + start_time) AT TIME ZONE 'America/Sao_Paulo') <= v_deadline)
    INTO v_total, v_pending, v_accepted, v_foreign, v_req_late, v_too_late
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
  IF v_too_late > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'TOO_LATE');
  END IF;

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

-- 3.2 Recusa sem dinheiro: pending -> cancelled (instructor_rejected).
CREATE OR REPLACE FUNCTION public.booking_request_reject(
  p_group_id uuid,
  p_instructor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now      timestamptz := now();
  v_total    integer;
  v_pending  integer;
  v_rejected integer;
  v_foreign  integer;
  v_money    integer;
  v_updated  integer;
BEGIN
  IF p_group_id IS NULL OR p_instructor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'cancelled' AND cancelled_reason = 'instructor_rejected'),
         count(*) FILTER (WHERE instructor_id IS DISTINCT FROM p_instructor_id),
         count(*) FILTER (WHERE provider_payment_id IS NOT NULL OR payment_intent_id IS NOT NULL
                             OR COALESCE(payment_status, 'pending') <> 'pending')
    INTO v_total, v_pending, v_rejected, v_foreign, v_money
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'FORBIDDEN');
  END IF;
  IF v_rejected = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_REJECTED', 'lessons', v_total);
  END IF;
  IF v_pending <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_STATE');
  END IF;
  -- Pedido pendente nunca tem cobranca no novo fluxo. Se tiver, a recusa
  -- envolve dinheiro e NAO e' feita aqui.
  IF v_money > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'HAS_PAYMENT');
  END IF;

  UPDATE public.appointments
     SET status = 'cancelled', cancelled_reason = 'instructor_rejected',
         payment_status = 'released', updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request' AND status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RAISE EXCEPTION 'booking_request_reject: % de % aulas atualizadas (grupo %)', v_updated, v_total, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'REJECTED', 'lessons', v_total);
END;
$function$;

-- 3.2b Cancelamento pelo aluno enquanto aguarda o instrutor: pending -> cancelled.
-- Disputa com o aceite: as duas funcoes bloqueiam as MESMAS linhas (FOR
-- UPDATE) antes de avaliar o estado. A que chegar primeiro vence; a outra ve
-- o estado novo e devolve INVALID_STATE, sem escrever. Nunca ha' grupo meio
-- aceito e meio cancelado.
CREATE OR REPLACE FUNCTION public.booking_request_cancel_by_student(
  p_group_id uuid,
  p_student_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now       timestamptz := now();
  v_total     integer;
  v_pending   integer;
  v_cancelled integer;
  v_foreign   integer;
  v_money     integer;
  v_updated   integer;
BEGIN
  IF p_group_id IS NULL OR p_student_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'cancelled' AND cancelled_reason = 'student_cancelled'),
         count(*) FILTER (WHERE student_id IS DISTINCT FROM p_student_id),
         count(*) FILTER (WHERE provider_payment_id IS NOT NULL OR payment_intent_id IS NOT NULL
                             OR COALESCE(payment_status, 'pending') <> 'pending')
    INTO v_total, v_pending, v_cancelled, v_foreign, v_money
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'FORBIDDEN');
  END IF;
  IF v_cancelled = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_CANCELLED', 'lessons', v_total);
  END IF;
  IF v_pending <> v_total THEN
    -- Ja' aceito, recusado ou expirado: o cancelamento nao se aplica.
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_STATE');
  END IF;
  IF v_money > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'HAS_PAYMENT');
  END IF;

  UPDATE public.appointments
     SET status = 'cancelled', cancelled_reason = 'student_cancelled',
         payment_status = 'released', updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request' AND status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RAISE EXCEPTION 'booking_request_cancel_by_student: % de % aulas atualizadas (grupo %)', v_updated, v_total, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'CANCELLED', 'lessons', v_total);
END;
$function$;

-- 3.3 Inicio do pagamento: reserved -> awaiting_payment, dentro da janela.
CREATE OR REPLACE FUNCTION public.booking_request_start_payment(
  p_group_id uuid,
  p_student_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now       timestamptz := now();
  v_total     integer;
  v_reserved  integer;
  v_awaiting  integer;
  v_foreign   integer;
  v_late      integer;
  v_deadline  timestamptz;
  v_updated   integer;
BEGIN
  IF p_group_id IS NULL OR p_student_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'reserved'),
         count(*) FILTER (WHERE status = 'awaiting_payment'),
         count(*) FILTER (WHERE student_id IS DISTINCT FROM p_student_id),
         count(*) FILTER (WHERE expires_at IS NULL OR expires_at <= v_now),
         min(expires_at)
    INTO v_total, v_reserved, v_awaiting, v_foreign, v_late, v_deadline
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'FORBIDDEN');
  END IF;
  IF v_reserved + v_awaiting <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_STATE');
  END IF;
  IF v_late > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'RESERVATION_EXPIRED');
  END IF;
  IF v_awaiting = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_STARTED', 'lessons', v_total, 'payment_deadline', v_deadline);
  END IF;

  UPDATE public.appointments
     SET status = 'awaiting_payment', updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request'
     AND status = 'reserved' AND expires_at > v_now;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_reserved THEN
    RAISE EXCEPTION 'booking_request_start_payment: % de % aulas atualizadas (grupo %)', v_updated, v_reserved, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'PAYMENT_STARTED', 'lessons', v_total, 'payment_deadline', v_deadline);
END;
$function$;

-- 3.4 Vinculo da cobranca criada no provedor (uma cobranca por reserva).
CREATE OR REPLACE FUNCTION public.booking_request_attach_payment(
  p_group_id uuid,
  p_provider_name text,
  p_provider_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now      timestamptz := now();
  v_total    integer;
  v_awaiting integer;
  v_same     integer;
  v_other    integer;
  v_late     integer;
  v_updated  integer;
BEGIN
  IF p_group_id IS NULL OR NULLIF(btrim(p_provider_payment_id), '') IS NULL OR NULLIF(btrim(p_provider_name), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'awaiting_payment'),
         count(*) FILTER (WHERE provider_payment_id = p_provider_payment_id),
         count(*) FILTER (WHERE provider_payment_id IS NOT NULL AND provider_payment_id <> p_provider_payment_id),
         count(*) FILTER (WHERE expires_at IS NULL OR expires_at <= v_now)
    INTO v_total, v_awaiting, v_same, v_other, v_late
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_other > 0 THEN
    -- Ja' existe OUTRA cobranca para esta reserva.
    RETURN jsonb_build_object('ok', false, 'outcome', 'PAYMENT_CONFLICT');
  END IF;
  IF v_same = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_ATTACHED', 'lessons', v_total);
  END IF;
  IF v_awaiting <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_STATE');
  END IF;
  IF v_late > 0 THEN
    -- A cobranca foi criada tarde demais: o chamador deve cancela-la.
    RETURN jsonb_build_object('ok', false, 'outcome', 'RESERVATION_EXPIRED');
  END IF;

  UPDATE public.appointments
     SET provider_name = p_provider_name, provider_payment_id = p_provider_payment_id, updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request'
     AND status = 'awaiting_payment' AND provider_payment_id IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RAISE EXCEPTION 'booking_request_attach_payment: % de % aulas atualizadas (grupo %)', v_updated, v_total, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'ATTACHED', 'lessons', v_total);
END;
$function$;

-- 3.5 Confirmacao financeira: reserved|awaiting_payment -> confirmed/paid.
-- Chamada SOMENTE depois do retorno efetivo do provedor (decisao do chamador).
CREATE OR REPLACE FUNCTION public.booking_request_confirm_payment(
  p_group_id uuid,
  p_provider_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now       timestamptz := now();
  v_total     integer;
  v_active    integer;
  v_confirmed integer;
  v_mismatch  integer;
  v_updated   integer;
BEGIN
  IF p_group_id IS NULL OR NULLIF(btrim(p_provider_payment_id), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status IN ('reserved', 'awaiting_payment')),
         count(*) FILTER (WHERE status = 'confirmed' AND payment_status = 'paid' AND provider_payment_id = p_provider_payment_id),
         count(*) FILTER (WHERE provider_payment_id IS NOT NULL AND provider_payment_id <> p_provider_payment_id)
    INTO v_total, v_active, v_confirmed, v_mismatch
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_confirmed = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_CONFIRMED', 'lessons', v_total);
  END IF;
  IF v_mismatch > 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'PAYMENT_MISMATCH');
  END IF;
  IF v_active <> v_total THEN
    -- Reserva encerrada (expirada, cancelada, recusada) ou ainda nao aceita:
    -- o pagamento vira ocorrencia em payment_exceptions (Fase 1), nunca aula.
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_ACTIVE');
  END IF;

  UPDATE public.appointments
     SET status = 'confirmed', payment_status = 'paid',
         provider_payment_id = p_provider_payment_id, updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request'
     AND status IN ('reserved', 'awaiting_payment');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RAISE EXCEPTION 'booking_request_confirm_payment: % de % aulas atualizadas (grupo %)', v_updated, v_total, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'CONFIRMED', 'lessons', v_total);
END;
$function$;

-- 3.6 Expiracao: pending|reserved|awaiting_payment -> expired, prazo vencido.
-- Com cobranca vinculada, so' expira depois de o chamador verificar o
-- provedor e cancelar a cobranca (p_charge_settled = true).
CREATE OR REPLACE FUNCTION public.booking_request_expire(
  p_group_id uuid,
  p_charge_settled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now     timestamptz := now();
  v_total   integer;
  v_active  integer;
  v_due     integer;
  v_expired integer;
  v_charge  integer;
  v_updated integer;
BEGIN
  IF p_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_ARGUMENT');
  END IF;

  PERFORM 1 FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request'
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status IN ('pending', 'reserved', 'awaiting_payment')),
         count(*) FILTER (WHERE status IN ('pending', 'reserved', 'awaiting_payment') AND expires_at IS NOT NULL AND expires_at <= v_now),
         count(*) FILTER (WHERE status = 'expired'),
         count(*) FILTER (WHERE provider_payment_id IS NOT NULL)
    INTO v_total, v_active, v_due, v_expired, v_charge
    FROM public.appointments
   WHERE group_id = p_group_id AND booking_flow = 'request';

  IF v_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_FOUND');
  END IF;
  IF v_expired = v_total THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'ALREADY_EXPIRED', 'lessons', v_total);
  END IF;
  IF v_active <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'INVALID_STATE');
  END IF;
  IF v_due <> v_total THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NOT_DUE');
  END IF;
  IF v_charge > 0 AND NOT COALESCE(p_charge_settled, false) THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'NEEDS_GATEWAY_CHECK');
  END IF;

  UPDATE public.appointments
     SET status = 'expired',
         payment_status = CASE WHEN COALESCE(payment_status, 'pending') = 'pending' THEN 'released' ELSE payment_status END,
         updated_at = v_now
   WHERE group_id = p_group_id AND booking_flow = 'request'
     AND status IN ('pending', 'reserved', 'awaiting_payment') AND expires_at <= v_now;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_total THEN
    RAISE EXCEPTION 'booking_request_expire: % de % aulas atualizadas (grupo %)', v_updated, v_total, p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'EXPIRED', 'lessons', v_total);
END;
$function$;

-- Somente o backend (service role) executa as operacoes.
REVOKE ALL ON FUNCTION public.booking_request_accept(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_request_reject(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_request_cancel_by_student(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_request_start_payment(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_request_attach_payment(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_request_confirm_payment(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_request_expire(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_request_accept(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_request_reject(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_request_cancel_by_student(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_request_start_payment(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_request_attach_payment(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_request_confirm_payment(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_request_expire(uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.guard_appointments_booking_flow_columns() FROM PUBLIC, anon, authenticated;

-- 4. Disponibilidade -----------------------------------------------------------
-- Copia da definicao de PRODUCAO (lida em 2026-10-03, inclui AP-05/A ferias),
-- com UM ramo novo: pedido do proprio aluno no novo fluxo = 'my_request'.
-- CREATE OR REPLACE preserva os privilegios atuais da funcao.
CREATE OR REPLACE FUNCTION public.get_instructor_availability(p_instructor_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(date date, start_time time without time zone, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID;
BEGIN
  IF p_instructor_id IS NULL THEN
    RAISE EXCEPTION 'p_instructor_id cannot be null';
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'p_start_date and p_end_date cannot be null';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'p_start_date cannot be after p_end_date';
  END IF;

  IF (p_end_date - p_start_date) > 31 THEN
    RAISE EXCEPTION 'Query interval cannot exceed 31 days';
  END IF;

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

  RETURN QUERY
  SELECT
    a.date,
    a.start_time,
    CASE
      -- Fase 2: pedido do proprio aluno no novo fluxo. NAO e' horario livre
      -- para nova tentativa (diferente de 'my_reservation').
      WHEN v_caller_id IS NOT NULL
           AND a.student_id = v_caller_id
           AND a.booking_flow = 'request'
           AND a.status IN ('pending', 'reserved', 'awaiting_payment') THEN 'my_request'
      WHEN v_caller_id IS NOT NULL
           AND a.student_id = v_caller_id
           AND a.status IN ('reserved', 'awaiting_payment') THEN 'my_reservation'
      ELSE 'unavailable'
    END::TEXT AS status
  FROM public.appointments a
  WHERE a.instructor_id = p_instructor_id
    AND a.date >= p_start_date
    AND a.date <= p_end_date
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

-- =============================================================================
-- VERIFICACAO — DEPOIS DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- a) Linhas existentes continuam no fluxo atual
-- SELECT booking_flow, count(*), count(accepted_at) FROM public.appointments GROUP BY 1;
--
-- -- b) Funcoes executaveis so' pela service role
-- SELECT p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE')
--   FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(rolname)
--  WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'booking_request_%'
--  ORDER BY 1, 2;
--
-- -- c) Constraints e trigger novos
-- SELECT conname FROM pg_constraint WHERE conrelid = 'public.appointments'::regclass
--    AND conname IN ('appointments_booking_flow_check', 'appointments_accepted_at_flow_check');
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.appointments'::regclass
--    AND tgname = 'appointments_booking_flow_guard_trigger';
-- =============================================================================
