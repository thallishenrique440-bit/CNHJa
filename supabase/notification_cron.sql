-- ==========================================
-- CONFIGURAÇÃO DO CRON AUTOMÁTICO DE NOTIFICAÇÕES
-- Função: notification-worker
-- Frequência: A cada 1 minuto (* * * * *)
-- ==========================================

-- 1. Habilitar extensões necessárias (se não estiverem ativas)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Limpar job anterior (Garantia de Idempotência)
-- Evita duplicidade se o script for executado novamente
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'notification-worker-job';

-- 3. Agendar o novo Job do Worker de Notificações
-- IMPORTANTE:
-- <PROJECT_REF>: Substitua pelo ID do projeto Supabase (ex: abcdefghijklm)
-- <CRON_SECRET>: Substitua pelo segredo configurado nas variáveis da Edge Function
SELECT
  cron.schedule(
    'notification-worker-job',
    '* * * * *', -- Executa a cada 1 minuto
    $$
    SELECT
      net.http_post(
          url:='https://<PROJECT_REF>.supabase.co/functions/v1/notification-worker',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer <CRON_SECRET>"}'::jsonb,
          body:='{}'::jsonb
      ) AS request_id;
    $$
  );

-- ==========================================
-- MONITORAMENTO E TELEMETRIA:
-- ==========================================
-- 1. Verificar se o job foi agendado:
--    SELECT * FROM cron.job WHERE jobname = 'notification-worker-job';
--
-- 2. Ver histórico detalhado de execuções (status/duração/logs):
--    SELECT * FROM cron.job_run_details 
--    WHERE jobname = 'notification-worker-job' 
--    ORDER BY start_time DESC LIMIT 10;
--
-- 3. Ver logs da Edge Function:
--    Acesse Dashboard do Supabase -> Edge Functions -> notification-worker -> Logs
-- ==========================================
