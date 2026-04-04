-- Migration: Add terms acceptance tracking to profiles
-- This allows us to track when a user accepted the terms and which version they accepted.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
ADD COLUMN IF NOT EXISTS terms_version text DEFAULT '1.0';

-- Update existing users to have a default acceptance date if needed (optional)
-- UPDATE public.profiles SET terms_accepted_at = created_at, terms_version = '1.0' WHERE terms_accepted_at IS NULL;
