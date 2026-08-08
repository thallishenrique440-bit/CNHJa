-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Safely remove existing job to prevent duplicates (Idempotent)
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'check-expired-bookings-job';

-- Schedule the job to run every 1 minute securely using vault secrets
SELECT cron.schedule(
  'check-expired-bookings-job',
  '* * * * *',
  $$SELECT public.invoke_edge_function_cron('check-expired-bookings');$$
);

