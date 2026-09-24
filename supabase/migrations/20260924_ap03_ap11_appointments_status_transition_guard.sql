-- =============================================================================
-- AP-03 + AP-11 — Guarda de transicao de status em public.appointments
-- =============================================================================
--
-- ORIGEM
--   MASTER-CORRECTION-PLAN v1.1, itens F1-04 e F1-05.
--   Aprovacoes AP-03 (aluno nao altera status operacional) e AP-11 (regra de
--   produto: depois do aceite nao ha cancelamento, so remarcacao).
--
-- PROBLEMA CORRIGIDO
--   A versao anterior de public.check_appointments_update_security() validava
--   APENAS `NEW.status`, contra uma lista fixa:
--
--       IF NEW.status NOT IN ('cancelled','completed','no_show','pending_approval')
--
--   Nunca olhava `OLD.status` nem QUEM era o ator. Consequencias confirmadas
--   por leitura do catalogo em 2026-09-24:
--
--   (a) AP-11 violado — `confirmed -> cancelled` era aceito. A regra "aula
--       aceita nao pode ser cancelada, so remarcada" existia apenas na camada
--       de aplicacao (supabase/functions/cancel-booking/index.ts:93-104 e
--       lib/payments/BookingCancellationCore.ts:58-65,203-217) e era
--       contornavel por UPDATE direto via PostgREST.
--
--   (b) AP-03 violado — o ALUNO podia gravar `completed` e `no_show`. O
--       frontend fazia exatamente isso em pages/student/Lessons.tsx:672-679,
--       em lote (.in('id', lessonIds)) e sem CAS. `completed` e' o gatilho de
--       liberacao de repasse ao instrutor.
--
--   (c) `pending_approval` era alcancavel a partir de QUALQUER status,
--       inclusive `completed` ou `cancelled` — reabrindo aula encerrada.
--       Nenhum caminho de cliente grava `pending_approval`: os dois
--       produtores sao api/asaas-webhook.ts:895 e
--       supabase/functions/sync-payment-status/index.ts:362, ambos
--       service_role. Passa a ser negado para `authenticated`.
--
-- ESCOPO DESTA MIGRATION
--   SOMENTE o trigger BEFORE UPDATE. Nada aqui toca INSERT, policies, grants
--   ou qualquer outra tabela.
--   O endurecimento do INSERT em appointments (F1-01) depende da aprovacao
--   AP-01, que permanece ABERTA. Nao antecipar.
--
-- O QUE NAO MUDA
--   - As 7 guardas de colunas financeiras (payment_status, payment_intent_id,
--     provider_payment_id, purchase_id, payment_id, price, provider_name)
--     sao preservadas palavra por palavra.
--   - service_role continua irrestrito: todo o ciclo de vida oficial passa por
--     BookingCancellationCore, approve-booking, reject-booking, cancel-booking,
--     check-expired-bookings, sync-payment-status e asaas-webhook, que usam
--     SUPABASE_SERVICE_ROLE_KEY e nao sao afetados por este trigger.
--   - As 5 RPCs de remarcacao (propose_reschedule, accept_reschedule,
--     reject_reschedule, cancel_reschedule_proposal,
--     reschedule_appointment_direct) NAO escrevem `status` — verificado linha a
--     linha no prosrc. Continuam funcionando sem alteracao.
--   - auto_complete_lessons e' SECURITY DEFINER com EXECUTE apenas para
--     postgres e service_role. Nao afetada.
--
-- MATRIZ AUTORIZADA PARA auth.role() = 'authenticated'
--
--   OLD.status              NEW.status     ATOR PERMITIDO   REGRA
--   ----------------------  -------------  ---------------  ------------------
--   confirmed | scheduled   completed      instrutor        AP-03
--   confirmed | scheduled   no_show        instrutor        AP-03
--   confirmed | scheduled   cancelled      NINGUEM          AP-11
--   confirmed | scheduled   qualquer outro NINGUEM          AP-11
--   pending | pending_approval             aluno|instrutor  pre-aceite
--     | awaiting_payment | reserved  -> cancelled
--   qualquer outro          qualquer       NINGUEM          fail-closed
--
--   `cancelled` a partir dos estados pre-aceite permanece permitido para
--   ambas as partes de forma conservadora: e' o unico caminho que a policy
--   "Student can cancel appointment" poderia legitimamente exercer. O
--   cancelamento real de producao ocorre via Edge Function (service_role) e
--   nao depende desta clausula.
--
-- APLICACAO
--   NAO APLICADA POR CLAUDE. Aplicacao manual pelo proprietario, apos revisao.
--   Ver bloco de VERIFICACAO ANTES / DEPOIS e ROLLBACK ao final do arquivo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_appointments_update_security()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid           uuid;
  v_is_student    boolean;
  v_is_instructor boolean;
BEGIN

  IF auth.role() = 'authenticated' THEN

    -- ---------------------------------------------------------------------
    -- 1. Colunas financeiras — preservadas integralmente da versao anterior
    -- ---------------------------------------------------------------------
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
      RAISE EXCEPTION 'Alteracao de payment_status nao permitida via client.';
    END IF;

    IF NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
      RAISE EXCEPTION 'Alteracao de payment_intent_id nao permitida via client.';
    END IF;

    IF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
      RAISE EXCEPTION 'Alteracao de provider_payment_id nao permitida via client.';
    END IF;

    IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id THEN
      RAISE EXCEPTION 'Alteracao de purchase_id nao permitida via client.';
    END IF;

    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
      RAISE EXCEPTION 'Alteracao de payment_id nao permitida via client.';
    END IF;

    IF NEW.price IS DISTINCT FROM OLD.price THEN
      RAISE EXCEPTION 'Alteracao de price nao permitida via client.';
    END IF;

    IF NEW.provider_name IS DISTINCT FROM OLD.provider_name THEN
      RAISE EXCEPTION 'Alteracao de provider_name nao permitida via client.';
    END IF;

    -- ---------------------------------------------------------------------
    -- 2. Transicao de status — matriz (OLD, NEW, ator)
    -- ---------------------------------------------------------------------
    IF NEW.status IS DISTINCT FROM OLD.status THEN

      v_uid := auth.uid();

      IF v_uid IS NULL THEN
        RAISE EXCEPTION
          'Alteracao de status exige usuario autenticado.';
      END IF;

      v_is_student    := (v_uid = OLD.student_id);
      v_is_instructor := (v_uid = OLD.instructor_id);

      IF NOT (v_is_student OR v_is_instructor) THEN
        RAISE EXCEPTION
          'Alteracao de status negada: usuario nao e parte desta aula.';
      END IF;

      -- AP-03 — conclusao e falta sao decisao operacional do INSTRUTOR.
      IF NEW.status IN ('completed', 'no_show') THEN

        IF NOT v_is_instructor THEN
          RAISE EXCEPTION
            'Somente o instrutor pode registrar a aula como "%". (AP-03)',
            NEW.status;
        END IF;

        IF OLD.status NOT IN ('confirmed', 'scheduled') THEN
          RAISE EXCEPTION
            'Transicao de status nao permitida: % -> %. A aula precisa estar aceita.',
            OLD.status, NEW.status;
        END IF;

      -- AP-11 — depois do aceite nao ha cancelamento; ha REMARCACAO.
      ELSIF NEW.status = 'cancelled' THEN

        IF OLD.status IN ('confirmed', 'scheduled') THEN
          RAISE EXCEPTION
            'Esta aula ja foi aceita pelo instrutor e nao pode mais ser cancelada. Use a remarcacao. (AP-11)';
        END IF;

        IF OLD.status NOT IN ('pending', 'pending_approval', 'awaiting_payment', 'reserved') THEN
          RAISE EXCEPTION
            'Transicao de status nao permitida: % -> cancelled.',
            OLD.status;
        END IF;

      -- Fail-closed: qualquer outra transicao e' negada ao cliente.
      ELSE
        RAISE EXCEPTION
          'Alteracao de status nao autorizada ou invalida via client: % -> %.',
          OLD.status, NEW.status;

      END IF;

    END IF;

  END IF;

  RETURN NEW;

END;
$function$;

COMMENT ON FUNCTION public.check_appointments_update_security() IS
  'AP-03/AP-11: valida o par (OLD.status, NEW.status) e o ator em UPDATE de appointments para auth.role()=authenticated. completed/no_show sao exclusivos do instrutor e exigem aula aceita; cancelled e negado apos o aceite. Colunas financeiras permanecem bloqueadas ao cliente. service_role nao e afetado.';


-- =============================================================================
-- VERIFICACAO — EXECUTAR ANTES DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- a) Corpo atual da funcao (guardar a saida: e' o material de rollback)
-- SELECT prosrc FROM pg_proc WHERE proname = 'check_appointments_update_security';
--
-- -- b) O trigger existe, esta habilitado e e' BEFORE UPDATE?
-- SELECT t.tgname, t.tgenabled, p.proname,
--        (t.tgtype::int & 2) > 0 AS is_before,
--        (t.tgtype::int & 16) > 0 AS on_update,
--        (t.tgtype::int & 4)  > 0 AS on_insert
--   FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
--  WHERE t.tgrelid = 'public.appointments'::regclass AND NOT t.tgisinternal;
--   -- esperado: appointments_security_check_trigger | O | is_before=t | on_update=t | on_insert=f
--
-- -- c) Distribuicao de status (para conferir que nada muda de estado)
-- SELECT status, count(*) FROM public.appointments GROUP BY 1 ORDER BY 1;
--
-- =============================================================================
-- VERIFICACAO — EXECUTAR DEPOIS DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- d) A funcao foi substituida e mantem SECURITY DEFINER + search_path
-- SELECT prosecdef, proconfig
--   FROM pg_proc WHERE proname = 'check_appointments_update_security';
--   -- esperado: prosecdef = true, proconfig = {search_path=public}
--
-- -- e) O novo corpo contem a matriz
-- SELECT prosrc LIKE '%AP-03%' AS tem_ap03,
--        prosrc LIKE '%AP-11%' AS tem_ap11,
--        prosrc LIKE '%OLD.status%' AS olha_old_status
--   FROM pg_proc WHERE proname = 'check_appointments_update_security';
--   -- esperado: t | t | t
--
-- -- f) Nenhuma linha mudou de estado (comparar com (c))
-- SELECT status, count(*) FROM public.appointments GROUP BY 1 ORDER BY 1;
--
-- -- g) Bateria funcional: supabase/tests/ap03_ap11_status_transition.pgsql.sql
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
--
--   Esta migration e' um CREATE OR REPLACE FUNCTION puro: nao cria, altera nem
--   remove tabela, coluna, indice, policy ou grant. Nenhum dado e' tocado.
--
--   Para reverter, execute CREATE OR REPLACE FUNCTION com o corpo capturado no
--   passo (a) acima, preservando LANGUAGE plpgsql, SECURITY DEFINER e
--   SET search_path TO 'public'.
--
--   O trigger appointments_security_check_trigger continua apontando para a
--   mesma funcao pelo OID; nao e' necessario recria-lo em nenhum dos sentidos.
-- =============================================================================
