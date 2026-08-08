-- Migration: 20260808_fix_cron_execution_infrastructure.sql
-- Purpose: Fix Edge Function cron dispatch infrastructure (check-expired-bookings, notification-worker, auto-complete-lessons)
-- Author: AI Coding Agent
-- Date: 2026-08-08

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Helper function to securely invoke Edge Functions from pg_cron without hardcoding secrets or project refs
CREATE OR REPLACE FUNCTION public.invoke_edge_function_cron(p_function_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_base_url text;
  v_secret text;
  v_request_id bigint;
BEGIN
  -- 1. Retrieve base Edge Function URL securely
  SELECT value INTO v_base_url FROM public.notification_config WHERE key = 'edge_function_url';
  IF v_base_url IS NULL OR v_base_url = '' OR v_base_url LIKE '%<%' THEN
    v_base_url := 'https://ohftsqsxymtrclnpadam.supabase.co/functions/v1';
  END IF;

  v_base_url := rtrim(v_base_url, '/');
  IF NOT (v_base_url LIKE '%/' || ltrim(p_function_name, '/')) THEN
    v_base_url := v_base_url || '/' || ltrim(p_function_name, '/');
  END IF;

  -- 2. Retrieve secret securely from Supabase Vault (decrypted_secrets)
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret';

  -- 3. Execute HTTP POST request asynchronously via pg_net
  v_request_id := net.http_post(
    url := v_base_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_secret, '')
    ),
    body := '{}'::jsonb
  );

  RETURN v_request_id;
END;
$$;

-- Explicitly revoke public execution permissions and grant only to administrative roles (postgres, service_role)
REVOKE EXECUTE ON FUNCTION public.invoke_edge_function_cron(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function_cron(text) TO postgres, service_role;

-- Unschedule existing cron jobs to ensure clean, idempotent setup
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname IN ('check-expired-bookings-job', 'notification-worker-job', 'auto-complete-lessons-job', 'cleanup_reserved_slots', 'cleanup_reserved_slots_job') LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END;
$$;

-- Schedule check-expired-bookings-job (every minute)
SELECT cron.schedule(
  'check-expired-bookings-job',
  '* * * * *',
  $$SELECT public.invoke_edge_function_cron('check-expired-bookings');$$
);

-- Schedule notification-worker-job (every minute)
SELECT cron.schedule(
  'notification-worker-job',
  '* * * * *',
  $$SELECT public.invoke_edge_function_cron('notification-worker');$$
);

-- Schedule auto-complete-lessons-job (every 5 minutes)
SELECT cron.schedule(
  'auto-complete-lessons-job',
  '*/5 * * * *',
  $$SELECT public.invoke_edge_function_cron('auto-complete-lessons');$$
);
