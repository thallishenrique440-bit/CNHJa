-- Fix: Allow authenticated users to view all appointments to check for availability
-- This is necessary so students can see 'blocked' or 'occupied' slots.

-- 1. Drop the restrictive policy for SELECT
DROP POLICY IF EXISTS "Users can view their own appointments" ON public.appointments;

-- 2. Create a new permissive policy for SELECT
CREATE POLICY "Authenticated users can view all appointments"
ON public.appointments FOR SELECT
TO authenticated
USING (true);

-- Note: Insert/Update/Delete policies remain restrictive (owner only)
