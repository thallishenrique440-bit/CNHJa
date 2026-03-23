-- ==========================================
-- CONFIGURAÇÃO DO CRON AUTOMÁTICO
-- Função: auto-complete-lessons
-- Frequência: A cada 5 minutos
-- ==========================================

-- 1. Habilitar extensões necessárias (se não estiverem)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Limpar job anterior (Idempotência)
-- Evita duplicidade se o script for rodado mais de uma vez
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'auto-complete-lessons-job';

-- 3. Agendar o novo Job
-- IMPORTANTE:
-- <PROJECT_REF>: Substitua pelo ID do seu projeto Supabase (ex: abcdefghijklm)
-- <CRON_SECRET>: Substitua pelo segredo que você definiu na Edge Function
SELECT
  cron.schedule(
    'auto-complete-lessons-job',
    '*/5 * * * *', -- Executa a cada 5 minutos
    $$
    SELECT
      net.http_post(
          url:='https://<PROJECT_REF>.supabase.co/functions/v1/auto-complete-lessons',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer <CRON_SECRET>"}'::jsonb,
          body:='{}'::jsonb
      ) AS request_id;
    $$
  );

-- ==========================================
-- COMO TESTAR E MONITORAR:
-- ==========================================
-- 1. Verificar se o job foi agendado:
--    SELECT * FROM cron.job WHERE jobname = 'auto-complete-lessons-job';
--
-- 2. Ver histórico de execuções (sucesso/erro):
--    SELECT * FROM cron.job_run_details 
--    WHERE jobname = 'auto-complete-lessons-job' 
--    ORDER BY start_time DESC LIMIT 10;
--
-- 3. Ver logs da Edge Function:
--    Acesse o Dashboard do Supabase -> Edge Functions -> auto-complete-lessons -> Logs
-- ==========================================
