-- Update lunch configuration columns to slot-based model
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS lunch_start_slot TEXT DEFAULT '12:00',
ADD COLUMN IF NOT EXISTS lunch_duration INTEGER DEFAULT 2;
