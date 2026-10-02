-- =============================================================================
-- FASE 0 — agendamento da conciliacao financeira (sync-payment-status)
-- =============================================================================
--
-- PROPOSTA. NAO APLICADA. Aplicacao somente com autorizacao do proprietario.
--
-- PROBLEMA
--   A Edge Function `sync-payment-status` existe e esta' publicada, mas nenhum
--   job a aciona. Em producao (cron.job, 2026-10-01) ha' quatro jobs:
--   check-expired-bookings, notification-worker, auto-complete-lessons e
--   sync-gateway-fees. Toda a conciliacao de pagamentos e de estornos so' roda
--   se alguem a chamar manualmente.
--
-- O QUE FAZ
--   Cria UM job pg_cron que chama a funcao a cada 5 minutos, pelo mesmo
--   mecanismo dos demais jobs: `public.invoke_edge_function_cron`, que le o
--   `cron_secret` do Supabase Vault e faz o POST via pg_net com
--   `Authorization: Bearer <CRON_SECRET>`. Nenhum segredo neste arquivo.
--
-- O QUE NAO FAZ
--   Nao altera tabelas, dados, funcoes nem os jobs existentes.
--
-- PRE-REQUISITOS (conferir ANTES de aplicar)
--   1. `sync-payment-status` publicada com a versao da Fase 0.
--   2. O segredo `CRON_SECRET` da funcao igual ao `cron_secret` do Vault (e' o
--      mesmo usado pelos outros jobs; se eles respondem 200, esta' correto).
--   3. `notification_config.app_base_url` preenchido (a funcao delega a
--      liquidacao a `<app_base_url>/api/reconcile-payment`).
--   4. Escopo: a funcao so' processa registros com obrigacao operacional
--      vigente (aula futura, em andamento ou encerrada ha' menos de 24 h; ver
--      supabase/functions/_shared/syncPaymentDecision.ts). Aulas passadas sao
--      ignoradas, sem consulta ao gateway e sem escrita. Para um corte fixo,
--      definir SYNC_MIN_LESSON_DATE=AAAA-MM-DD nos segredos da funcao.
--      Simulacao da primeira execucao sobre os dados de 02/10/2026: nenhum
--      registro processado (ver docs/auditorias/FASE0_CONFIABILIDADE_OPERACIONAL_CNHJA.md).
--
-- FREQUENCIA
--   A cada 5 minutos. A funcao consulta o Asaas (GET) por grupo elegivel e por
--   operacao de estorno parada; 5 minutos limita o volume de chamadas e ainda
--   e' menor que o prazo de 10 minutos a partir do qual uma operacao PENDING
--   entra na conciliacao.
--
-- EXECUCAO REPETIDA
--   Idempotente: remove o job de mesmo nome, se existir, antes de recriar.
--
-- ROLLBACK
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-payment-status-job';
-- =============================================================================

DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'sync-payment-status-job' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'sync-payment-status-job',
  '*/5 * * * *',
  $$SELECT public.invoke_edge_function_cron('sync-payment-status');$$
);

-- =============================================================================
-- VERIFICACAO — DEPOIS DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- a) O job existe e esta' ativo
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'sync-payment-status-job';
--
-- -- b) Execucoes registradas
-- SELECT d.status, d.start_time, d.return_message
--   FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--  WHERE j.jobname = 'sync-payment-status-job'
--  ORDER BY d.start_time DESC LIMIT 5;
--
-- -- c) Resposta da funcao (pg_net guarda por poucas horas)
-- SELECT created, status_code, left(content, 400)
--   FROM net._http_response
--  WHERE content ILIKE '%Sync job%' OR content ILIKE '%refund_reconciliation%'
--  ORDER BY created DESC LIMIT 5;
-- =============================================================================
