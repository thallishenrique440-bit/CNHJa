-- Migration: Onboarding Profile Completion
-- This migration adds a column to track profile completion and updates RLS policies.

-- 1. Add is_profile_complete column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_profile_complete BOOLEAN DEFAULT FALSE;

-- 2. Create function to calculate profile completion
-- Only full_name, city, and phone are required for now.
CREATE OR REPLACE FUNCTION public.calculate_profile_completion(
  p_full_name TEXT,
  p_city TEXT,
  p_phone TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN (
    p_full_name IS NOT NULL AND p_full_name <> '' AND
    p_city IS NOT NULL AND p_city <> '' AND
    p_phone IS NOT NULL AND p_phone <> ''
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. Create trigger function to update is_profile_complete
CREATE OR REPLACE FUNCTION public.handle_profile_completion_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_profile_complete := public.calculate_profile_completion(NEW.full_name, NEW.city, NEW.phone);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Create trigger on profiles
DROP TRIGGER IF EXISTS tr_update_profile_completion ON public.profiles;
CREATE TRIGGER tr_update_profile_completion
BEFORE INSERT OR UPDATE OF full_name, city, phone
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.handle_profile_completion_update();

-- 5. Backfill existing profiles
UPDATE public.profiles
SET is_profile_complete = public.calculate_profile_completion(full_name, city, phone);

-- 6. Update RLS Policies for appointments
-- Drop existing policies from previous migrations and schema
DROP POLICY IF EXISTS "Students can book appointments" ON public.appointments;
DROP POLICY IF EXISTS "Users can update their own appointments" ON public.appointments;

-- Recreate "Students can book appointments" with is_profile_complete check
CREATE POLICY "Students can book appointments"
ON public.appointments FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = student_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND is_profile_complete = TRUE
  )
);

-- Recreate "Users can update their own appointments" with is_profile_complete check for students
CREATE POLICY "Users can update their own appointments"
ON public.appointments FOR UPDATE
TO authenticated
USING (
  auth.uid() = instructor_id OR 
  (auth.uid() = student_id AND EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND is_profile_complete = TRUE
  ))
);

-- 7. Update RLS Policies for reviews
DROP POLICY IF EXISTS "Students can create reviews for their own finished lessons" ON public.reviews;

CREATE POLICY "Students can create reviews for their own finished lessons"
ON public.reviews FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = student_id AND
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND is_profile_complete = TRUE
  )
);

-- 8. Cleanup old function if it exists (from 20260404_enforce_student_profile_completion.sql)
DROP FUNCTION IF EXISTS public.is_student_profile_complete(UUID);
