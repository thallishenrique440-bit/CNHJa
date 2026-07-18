-- Migration: Create secure RPC for checking rescheduling appointment conflicts (Phase 2)
-- Target: check for appointment conflicts securely without requiring read access to public.appointments.
-- Created: 2026-07-18

-- ==========================================
-- STABLE INTERNAL API CONTRACT
-- ==========================================
-- This RPC acts as a secure validation endpoint to verify slot availability.
-- It bypasses general appointments RLS using SECURITY DEFINER, allowing the
-- application to safely revoke public select policies on the appointments table.
--
-- By design, it returns ONLY a BOOLEAN value (TRUE if a conflict exists, FALSE if available).
-- This strictly conforms to the Principle of Least Privilege:
-- - No row information is ever returned.
-- - No IDs or names are exposed to the authenticated user.
-- ==========================================

CREATE OR REPLACE FUNCTION public.check_appointment_conflict(
  p_instructor_id UUID,
  p_date DATE,
  p_start_time TIME,
  p_exclude_appointment_ids UUID[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_has_conflict BOOLEAN;
BEGIN
  -- We query whether any overlapping appointment exists matching the criteria.
  -- Statuses list exactly matches active/uncompleted bookings that reserve the slot:
  -- 'pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment'
  SELECT EXISTS (
    SELECT 1
    FROM public.appointments
    WHERE instructor_id = p_instructor_id
      AND date = p_date
      AND start_time = p_start_time
      AND status IN ('pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment')
      AND (
        p_exclude_appointment_ids IS NULL 
        OR NOT (id = ANY(p_exclude_appointment_ids))
      )
  ) INTO v_has_conflict;

  RETURN v_has_conflict;
END;
$$;

-- Revoke default public/anon execute privileges for tight security controls
REVOKE ALL ON FUNCTION public.check_appointment_conflict(UUID, DATE, TIME, UUID[]) FROM PUBLIC;

-- Grant execution specifically to authenticated user roles only
GRANT EXECUTE ON FUNCTION public.check_appointment_conflict(UUID, DATE, TIME, UUID[]) TO authenticated;

-- Document function metadata in database catalog
COMMENT ON FUNCTION public.check_appointment_conflict(UUID, DATE, TIME, UUID[]) IS 
'Safely checks if an appointment slot is already occupied by another active booking for the given instructor.';
