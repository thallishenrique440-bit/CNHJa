-- Migration: Create claim_notification_jobs RPC for atomic queue claims with FOR UPDATE SKIP LOCKED
-- Author: Principal Distributed Systems Engineer & PostgreSQL Specialist
-- Date: 2026-07-10

CREATE OR REPLACE FUNCTION public.claim_notification_jobs(
  p_worker_id TEXT,
  p_batch_size INTEGER
)
RETURNS TABLE (
  notification_id UUID,
  status TEXT,
  priority INTEGER,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validate p_worker_id
  IF p_worker_id IS NULL OR trim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker_id required';
  END IF;

  -- Validate p_batch_size
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'Invalid batch size';
  END IF;

  RETURN QUERY
  WITH locked_rows AS (
    SELECT nj.notification_id
    FROM public.notification_jobs nj
    WHERE nj.status = 'pending'
      AND nj.next_run_at <= clock_timestamp()
    ORDER BY nj.priority DESC, nj.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_jobs nj_target
  SET
    status = 'processing',
    locked_at = clock_timestamp(),
    locked_by = trim(p_worker_id)
  FROM locked_rows lr
  WHERE nj_target.notification_id = lr.notification_id
  RETURNING 
    nj_target.notification_id,
    nj_target.status,
    nj_target.priority,
    nj_target.created_at;
END;
$$;

-- Revoke all default privileges from public for security hardening
REVOKE ALL ON FUNCTION public.claim_notification_jobs(text, integer) FROM PUBLIC;

-- Grant appropriate permissions for execution exclusively to service_role
GRANT EXECUTE ON FUNCTION public.claim_notification_jobs(TEXT, INTEGER) TO service_role;

-- Attach auto-documentation to the Postgres function
COMMENT ON FUNCTION public.claim_notification_jobs(text, integer) IS 'Atomic claim of notification jobs using FOR UPDATE SKIP LOCKED.';

