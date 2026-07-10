-- Migration: Create notification_jobs table for asynchronous worker
-- Author: Principal Software Engineer
-- Date: 2026-07-10

-- 1. Create the notification_jobs table
CREATE TABLE IF NOT EXISTS public.notification_jobs (
    notification_id uuid NOT NULL PRIMARY KEY REFERENCES public.notifications(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry', 'failed', 'sent', 'dead', 'cancelled', 'expired')),
    priority integer NOT NULL DEFAULT 0,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    locked_at timestamp with time zone,
    locked_by text,
    next_run_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamp with time zone,
    last_error text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);

-- 2. Enable Row Level Security (RLS) to keep it safe from unauthorized users
ALTER TABLE public.notification_jobs ENABLE ROW LEVEL SECURITY;

-- 3. Create RLS Policy for Service Role to have full access (Worker operates as service_role)
DROP POLICY IF EXISTS "Service role has full control on notification_jobs" ON public.notification_jobs;
CREATE POLICY "Service role has full control on notification_jobs"
ON public.notification_jobs
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 4. Create indexes for performance and lock execution
-- Index for polling pending/retry jobs efficiently
CREATE INDEX IF NOT EXISTS idx_notification_jobs_polling 
ON public.notification_jobs (status, next_run_at) 
WHERE status IN ('pending', 'retry');

-- Index for Lock Reclamation (stuck processing jobs)
CREATE INDEX IF NOT EXISTS idx_notification_jobs_lock_reclamation
ON public.notification_jobs (locked_at)
WHERE status = 'processing';

-- 5. Create trigger to keep updated_at automatically updated
CREATE OR REPLACE FUNCTION public.update_notification_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_update_notification_jobs_updated_at ON public.notification_jobs;
CREATE TRIGGER tr_update_notification_jobs_updated_at
BEFORE UPDATE ON public.notification_jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_notification_jobs_updated_at();

-- 6. Grant appropriate permissions
GRANT ALL ON public.notification_jobs TO service_role;
