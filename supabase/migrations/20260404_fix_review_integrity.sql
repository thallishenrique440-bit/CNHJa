
-- 1. Cleanup: Keep only the latest review per (student_id, instructor_id)
DELETE FROM public.reviews
WHERE id NOT IN (
    SELECT DISTINCT ON (student_id, instructor_id) id
    FROM public.reviews
    ORDER BY student_id, instructor_id, created_at DESC
);

-- 2. Drop the old appointment-based constraint (no longer needed as student-instructor is more restrictive)
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS unique_appointment_id;

-- 3. Add the new integrity constraint: One review per student-instructor pair
ALTER TABLE public.reviews ADD CONSTRAINT unique_student_instructor_review UNIQUE (student_id, instructor_id);

-- 4. Re-verify/Update RLS Policies to ensure they align with the new constraint
-- (Already handled in previous steps, but good for completeness)
DROP POLICY IF EXISTS "Students can create reviews for their own finished lessons" ON public.reviews;
CREATE POLICY "Students can create reviews for their own finished lessons"
ON public.reviews FOR INSERT
WITH CHECK (
  auth.uid() = student_id 
  AND EXISTS (
    SELECT 1 FROM public.appointments 
    WHERE id = appointment_id 
    AND student_id = auth.uid() 
    AND status = 'completed'
  )
);
