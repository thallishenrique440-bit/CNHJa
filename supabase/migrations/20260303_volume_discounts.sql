-- Create instructor_discounts table
CREATE TABLE IF NOT EXISTS instructor_discounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instructor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  min_lessons INTEGER NOT NULL,
  discount_percentage INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add columns to appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS group_id UUID;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- Add index for group_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_appointments_group_id ON appointments(group_id);

-- Add index for expires_at for cleanup job
CREATE INDEX IF NOT EXISTS idx_appointments_expires_at ON appointments(expires_at);

-- Ensure RLS is enabled on instructor_discounts
ALTER TABLE instructor_discounts ENABLE ROW LEVEL SECURITY;

-- Policies for instructor_discounts
CREATE POLICY "Instructors can view their own discounts" 
ON instructor_discounts FOR SELECT 
USING (auth.uid() = instructor_id);

CREATE POLICY "Instructors can insert their own discounts" 
ON instructor_discounts FOR INSERT 
WITH CHECK (auth.uid() = instructor_id);

CREATE POLICY "Instructors can update their own discounts" 
ON instructor_discounts FOR UPDATE 
USING (auth.uid() = instructor_id);

CREATE POLICY "Instructors can delete their own discounts" 
ON instructor_discounts FOR DELETE 
USING (auth.uid() = instructor_id);

-- Allow public read access to discounts (for students to see)
CREATE POLICY "Public can view discounts" 
ON instructor_discounts FOR SELECT 
USING (true);
