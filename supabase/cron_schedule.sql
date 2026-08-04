-- Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Safely remove existing job to prevent duplicates (Idempotent)
-- This query selects the jobid for the specific job name and unschedules it if it exists.
select cron.unschedule(jobid)
from cron.job
where jobname = 'check-expired-bookings-job';

-- Schedule the job to run every 1 minute
-- IMPORTANT: 
-- 1. Replace <PROJECT_REF> with your Supabase Project ID (found in Project Settings)
-- 2. Replace <SUPABASE_ANON_KEY> with your Anon Public Key (found in API Settings)
select
  cron.schedule(
    'check-expired-bookings-job',
    '* * * * *',
    $$
    select
      net.http_post(
          url:='https://<PROJECT_REF>.supabase.co/functions/v1/check-expired-bookings',
          headers:='{"Content-Type": "application/json", "Authorization": "Bearer <SUPABASE_ANON_KEY>"}'::jsonb,
          body:='{}'::jsonb
      ) as request_id;
    $$
  );
