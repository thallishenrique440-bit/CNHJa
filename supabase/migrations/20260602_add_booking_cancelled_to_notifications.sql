-- Migration: Update notifications_type_check to allow 'booking_cancelled'
-- This fixes database insert failures when inserting notifications with type = 'booking_cancelled'

-- 1. Drop existing check constraint if it exists
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

-- 2. Create the updated check constraint including 'booking_cancelled'
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check 
  CHECK (type IN ('booking_request', 'booking_accepted', 'booking_rejected', 'booking_cancelled', 'booking_expired', 'payment_released', 'reminder', 'system'));
