-- Migration: Enforce complete student profile for bookings
-- This ensures that a student can only create appointments if their profile is complete.

-- 1. Create a function to check if a student profile is complete
CREATE OR REPLACE FUNCTION public.is_student_profile_complete(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_complete BOOLEAN;
BEGIN
  SELECT 
    (
      full_name IS NOT NULL AND full_name <> '' AND
      phone IS NOT NULL AND length(phone) >= 10 AND
      city IS NOT NULL AND city <> '' AND
      experience_level IS NOT NULL AND experience_level <> '' AND
      cnh_process_type IS NOT NULL AND cnh_process_type <> ''
    ) INTO v_complete
  FROM public.profiles
  WHERE id = p_user_id;
  
  RETURN COALESCE(v_complete, FALSE);
END;
$$;

-- 2. Update RLS policy for appointments insertion
-- We need to drop the old policy and create a new one that includes the profile check
DROP POLICY IF EXISTS "Students can book appointments" ON public.appointments;

CREATE POLICY "Students can book appointments"
ON public.appointments FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = student_id AND 
  public.is_student_profile_complete(auth.uid())
);

-- 3. Update RLS policy for appointments update (to prevent status changes if profile is incomplete)
-- Note: We allow updates if the user is the instructor, or if the student is complete.
DROP POLICY IF EXISTS "Users can update their own appointments" ON public.appointments;

CREATE POLICY "Users can update their own appointments"
ON public.appointments FOR UPDATE
TO authenticated
USING (
  auth.uid() = instructor_id OR 
  (auth.uid() = student_id AND public.is_student_profile_complete(auth.uid()))
);
