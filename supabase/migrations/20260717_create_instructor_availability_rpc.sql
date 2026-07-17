-- Migration: Create secure RPC for instructor availability querying (Phase 1.1)
-- Target: return availability slots safely without exposing any sensitive database data.
-- Created: 2026-07-17

-- Ensure we clean up the previous 4-argument version from Phase 1 to prevent overloaded lingering functions.
DROP FUNCTION IF EXISTS public.get_instructor_availability(UUID, DATE, DATE, UUID);

-- ==========================================
-- STABLE INTERNAL API CONTRACT
-- ==========================================
-- This RPC acts as a strict secure wrapper around public.appointments.
-- By architecture, this function MUST NEVER return:
-- 1. appointment_id / id
-- 2. student_id
-- 3. purchase_id
-- 4. payment_id
-- 5. Financial values (price, discount, commissions, fees)
-- 6. User personal data (names, emails, phones, documents)
-- 7. Any other sensitive database internal identifier.
--
-- The exclusive and restricted purpose of this RPC is to output anonymized 
-- slot availability metadata ('unavailable' or 'my_reservation').
-- ==========================================

CREATE OR REPLACE FUNCTION public.get_instructor_availability(
  p_instructor_id UUID,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS TABLE (
  date DATE,
  start_time TIME,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  -- 1. Parameters Validation
  IF p_instructor_id IS NULL THEN
    RAISE EXCEPTION 'p_instructor_id cannot be null';
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'p_start_date and p_end_date cannot be null';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'p_start_date cannot be after p_end_date';
  END IF;

  -- Limit query interval to a maximum of 31 days to avoid massive scraping/harvesting
  IF (p_end_date - p_start_date) > 31 THEN
    RAISE EXCEPTION 'Query interval cannot exceed 31 days';
  END IF;

  -- 2. Extract authentic user identity directly from secure JWT session context
  v_caller_id := auth.uid();

  -- 3. Fetch and return masked data using an explicit Allowlist for occupied states
  RETURN QUERY
  SELECT 
    a.date,
    a.start_time,
    CASE 
      -- If the slot belongs to the authenticated caller and is in a retryable state,
      -- we flag it as 'my_reservation' so the client knows they can retry/manage it.
      WHEN v_caller_id IS NOT NULL 
           AND a.student_id = v_caller_id 
           AND a.status IN ('reserved', 'awaiting_payment') THEN 'my_reservation'
      -- Any other valid, active slot is returned under a generic neutral 'unavailable' state.
      ELSE 'unavailable'
    END::TEXT AS status
  FROM public.appointments a
  WHERE a.instructor_id = p_instructor_id
    AND a.date >= p_start_date
    AND a.date <= p_end_date
    -- Explicit Allowlist of occupied statuses:
    -- If a slot is in any of these statuses, it is considered occupied/unavailable to others.
    -- Unlisted statuses (like 'cancelled', 'failed', 'expired', 'rejected') represent open/free slots,
    -- which are omitted from this result (hence, are available).
    AND a.status IN (
      'pending', 
      'scheduled', 
      'confirmed', 
      'in_progress', 
      'completed', 
      'blocked', 
      'reserved', 
      'pending_approval', 
      'no_show', 
      'awaiting_payment'
    );
END;
$$;

-- Revoke default public execute privileges for security
REVOKE ALL ON FUNCTION public.get_instructor_availability(UUID, DATE, DATE) FROM PUBLIC;

-- Grant execution specifically to authenticated user roles only (revoke from anon)
GRANT EXECUTE ON FUNCTION public.get_instructor_availability(UUID, DATE, DATE) TO authenticated;

-- Document function metadata
COMMENT ON FUNCTION public.get_instructor_availability(UUID, DATE, DATE) IS 
'Safely queries instructor slot availability without exposing student_id, purchase_id, price or other sensitive fields. Masking states into "unavailable" and "my_reservation".';
