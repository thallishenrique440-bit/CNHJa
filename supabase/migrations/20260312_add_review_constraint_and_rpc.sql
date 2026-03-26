-- 1. Add unique constraint to ensure one review per student-instructor pair
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS unique_student_instructor_review;
ALTER TABLE public.reviews ADD CONSTRAINT unique_student_instructor_review UNIQUE (student_id, instructor_id);

-- 2. Add UPDATE policy so students can edit their own reviews
DROP POLICY IF EXISTS "Students can update their own reviews" ON public.reviews;
CREATE POLICY "Students can update their own reviews"
ON public.reviews FOR UPDATE
USING (auth.uid() = student_id)
WITH CHECK (auth.uid() = student_id);

-- 3. Create RPC to check for pending reviews
-- Returns the first completed appointment for an instructor that hasn't been reviewed yet
CREATE OR REPLACE FUNCTION public.get_pending_review(p_student_id UUID)
RETURNS TABLE (
  appointment_id UUID,
  instructor_id UUID,
  instructor_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id as appointment_id,
    a.instructor_id,
    p.full_name as instructor_name
  FROM public.appointments a
  JOIN public.profiles p ON a.instructor_id = p.id
  WHERE a.student_id = p_student_id
    AND (
      a.status = 'completed' 
      OR (
        a.status IN ('confirmed', 'scheduled') 
        AND a.start_time_utc < (now() - interval '50 minutes')
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.reviews r 
      WHERE r.student_id = p_student_id 
        AND r.instructor_id = a.instructor_id
    )
  ORDER BY a.date DESC, a.start_time DESC
  LIMIT 1;
END;
$$;
