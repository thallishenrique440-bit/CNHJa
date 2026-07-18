-- Migration: Create secure RPC for retrieving completed instructor lessons count (Phase 1.2)
-- Target: return the count of completed lessons safely without requiring open read access to public.appointments.
-- Created: 2026-07-18

-- ==========================================
-- PERFORMANCE OPTIMIZATION INDEX
-- ==========================================
-- Create a partial index specifically targeting completed appointments for instructors.
-- This index:
-- 1. Filters only status = 'completed', which is highly space-efficient.
-- 2. Provides direct O(log N) lookup path for counting an instructor's completed lessons.
-- 3. Avoids reading general composite indexes starting with other attributes.
CREATE INDEX IF NOT EXISTS idx_appointments_instructor_completed
ON public.appointments (instructor_id)
WHERE status = 'completed';

-- ==========================================
-- STABLE INTERNAL API CONTRACT
-- ==========================================
-- This RPC acts as a strict secure wrapper to calculate the total lessons taught.
-- It bypasses RLS using SECURITY DEFINER, allowing us to safely revoke the wide
-- read policy on public.appointments.
--
-- By architecture, this function MUST NEVER return:
-- 1. Raw records from public.appointments
-- 2. Sensitive identifiers like student_id, purchase_id, payment_id
-- 3. Transaction prices, commissions, dates, or timings
-- ==========================================

CREATE OR REPLACE FUNCTION public.get_instructor_lessons_count(
  p_instructor_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- If p_instructor_id is NULL, the query naturally and safely returns 0, 
  -- preventing unneeded exception handling or crashes in the frontend client.
  SELECT COUNT(*)::INTEGER
  INTO v_count
  FROM public.appointments
  WHERE instructor_id = p_instructor_id
    AND status = 'completed';

  RETURN v_count;
END;
$$;

-- Revoke default public/anon privileges first to ensure tight security controls
REVOKE ALL ON FUNCTION public.get_instructor_lessons_count(UUID) FROM PUBLIC;

-- Grant execution specifically to authenticated user roles only (minimizing privileges)
GRANT EXECUTE ON FUNCTION public.get_instructor_lessons_count(UUID) TO authenticated;

-- Document function metadata in database catalog
COMMENT ON FUNCTION public.get_instructor_lessons_count(UUID) IS 
'Safely retrieves the count of completed lessons for a specific instructor. Bypasses general appointments RLS without exposing any row data.';
