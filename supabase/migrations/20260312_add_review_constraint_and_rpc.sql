-- 1. Adjust unique constraint to ensure one review per appointment
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS unique_student_instructor_review;
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS unique_appointment_id;
ALTER TABLE public.reviews ADD CONSTRAINT unique_appointment_id UNIQUE (appointment_id);

-- 2. Add UPDATE policy so students can edit their own reviews
DROP POLICY IF EXISTS "Students can update their own reviews" ON public.reviews;
CREATE POLICY "Students can update their own reviews"
ON public.reviews FOR UPDATE
USING (auth.uid() = student_id)
WITH CHECK (auth.uid() = student_id);

-- 3. Create RPC to check for pending reviews
-- Returns the first completed or past due appointment for an instructor that hasn't been reviewed yet
-- UX Rule: If another appointment from the same purchase group was reviewed, don't prompt automatically
CREATE OR REPLACE FUNCTION public.get_pending_review(p_student_id UUID)
RETURNS TABLE (
  appointment_id UUID,
  instructor_id UUID,
  instructor_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    -- Status: Completed or past due (60 min margin)
    AND (
      a.status = 'completed' 
      OR (
        a.status IN ('confirmed', 'scheduled') 
        AND (a.date + a.start_time) < (now() - interval '60 minutes')
      )
    )
    -- This specific appointment hasn't been reviewed
    AND NOT EXISTS (
      SELECT 1 FROM public.reviews r 
      WHERE r.appointment_id = a.id
    )
    -- UX Rule: If purchase_id is set, check if ANY appointment in that group was reviewed
    AND CASE 
      WHEN a.purchase_id IS NULL THEN TRUE
      ELSE NOT EXISTS (
        SELECT 1 FROM public.reviews r2
        JOIN public.appointments a2 ON r2.appointment_id = a2.id
        WHERE a2.purchase_id = a.purchase_id
          AND a2.student_id = p_student_id
      )
    END
  ORDER BY a.date DESC, a.start_time DESC
  LIMIT 1;
END;
$$;

-- 4. Composite Index for performance
CREATE INDEX IF NOT EXISTS idx_appointments_student_instructor_status_date 
ON public.appointments (student_id, instructor_id, status, date DESC);
