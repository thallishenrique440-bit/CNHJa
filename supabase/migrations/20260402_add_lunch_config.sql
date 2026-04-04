-- Add lunch configuration columns to instructors table
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS lunch_start TEXT DEFAULT '12:00',
ADD COLUMN IF NOT EXISTS lunch_end TEXT DEFAULT '13:50',
ADD COLUMN IF NOT EXISTS lunch_active BOOLEAN DEFAULT true;
