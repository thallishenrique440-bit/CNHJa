-- Migration: Create mark_notification_job_sent RPC for atomic finalization
-- Author: Principal Distributed Systems Engineer & PostgreSQL Specialist
-- Date: 2026-07-10

CREATE OR REPLACE FUNCTION public.mark_notification_job_sent(
  p_notification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated BOOLEAN := FALSE;
BEGIN
  UPDATE public.notification_jobs
  SET
    status = 'sent',
    completed_at = clock_timestamp(),
    last_error = NULL
  WHERE
    notification_id = p_notification_id
    AND status = 'processing';
    
  IF FOUND THEN
    v_updated := TRUE;
  END IF;
  
  RETURN v_updated;
END;
$$;

-- Revoke all default privileges from public for security hardening
REVOKE ALL ON FUNCTION public.mark_notification_job_sent(UUID) FROM PUBLIC;

-- Grant appropriate permissions for execution exclusively to service_role
GRANT EXECUTE ON FUNCTION public.mark_notification_job_sent(UUID) TO service_role;

-- Attach auto-documentation to the Postgres function
COMMENT ON FUNCTION public.mark_notification_job_sent(UUID) IS 'Atomically finalizes a notification job by setting its status to sent.';
