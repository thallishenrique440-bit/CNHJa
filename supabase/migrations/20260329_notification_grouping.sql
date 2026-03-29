
-- Add group_id to notification_logs
ALTER TABLE public.notification_logs ADD COLUMN IF NOT EXISTS group_id uuid;

-- Add index for group_id for faster lookups in the Edge Function
CREATE INDEX IF NOT EXISTS idx_notification_logs_group_id ON public.notification_logs(group_id);

-- Ensure the unique constraint on appointment_id remains for individual idempotency
-- (It was already created in the previous migration, but we keep it)
