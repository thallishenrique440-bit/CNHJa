-- Add work_saturday_afternoon column to instructors table
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS work_saturday_afternoon boolean DEFAULT false;
