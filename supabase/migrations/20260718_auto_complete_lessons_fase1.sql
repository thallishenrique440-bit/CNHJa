-- Migration: Update auto_complete_lessons function to use correct business logic (Phase 1)
-- Target: Automatically persist status 'completed' when lessons end, considering only eligible statuses and exclusions.
-- Created: 2026-07-18

CREATE OR REPLACE FUNCTION public.auto_complete_lessons()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer := 0;
BEGIN
  -- 1. Update Appointments to 'completed'
  -- Eligible statuses: 'confirmed', 'scheduled'
  -- Exclusions: reschedule_requested_at IS NOT NULL (pending reschedule)
  -- Time condition: current time >= lesson end time in Brazil's timezone (America/Sao_Paulo)
  UPDATE public.appointments
  SET 
    status = 'completed',
    updated_at = now()
  WHERE 
    status IN ('confirmed', 'scheduled')
    AND reschedule_requested_at IS NULL
    AND now() >= ((date + end_time) AT TIME ZONE 'America/Sao_Paulo');
    
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  -- 2. Update Transactions (captured -> completed)
  -- Only for transactions linked to appointments that are now completed
  UPDATE public.transactions t
  SET 
    status = 'completed',
    description = 'Aula Concluída'
  FROM public.appointments a
  WHERE t.appointment_id = a.id
    AND a.status = 'completed'
    AND t.status = 'pending';

  RETURN updated_count;
END;
$$;

-- Ensure execute permissions
GRANT EXECUTE ON FUNCTION public.auto_complete_lessons() TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_complete_lessons() TO authenticated;

COMMENT ON FUNCTION public.auto_complete_lessons() IS 
'Automatically completes confirmed and scheduled lessons that have reached their end time and have no pending reschedule requests.';
