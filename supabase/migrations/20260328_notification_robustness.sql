
-- 1. Add updated_by to appointments to track who performed the last action
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS updated_by uuid;

-- 2. Create function to set updated_by
CREATE OR REPLACE FUNCTION public.set_updated_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Use auth.uid() if available, otherwise keep what was passed (e.g. from webhooks)
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Create trigger to set updated_by
DROP TRIGGER IF EXISTS tr_set_updated_by ON public.appointments;
CREATE TRIGGER tr_set_updated_by
BEFORE INSERT OR UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

-- 4. Create notification_logs table for idempotency
CREATE TABLE IF NOT EXISTS public.notification_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  status text NOT NULL,
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  
  -- Unique constraint for idempotency: appointment_id + status + target_user_id
  UNIQUE(appointment_id, status, target_user_id)
);

-- Enable RLS for notification_logs
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

-- Only system/service_role should manage logs
CREATE POLICY "Service role can manage notification logs"
ON public.notification_logs FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 3. Update the trigger function to include updated_by in the payload
CREATE OR REPLACE FUNCTION public.notify_appointment_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_edge_function_url TEXT;
  v_service_role_key TEXT;
  v_payload JSONB;
BEGIN
  -- We only care about updates where the status actually changed
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    
    -- Construct the payload
    v_payload := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'record', row_to_json(NEW),
      'old_record', row_to_json(OLD)
    );

    -- Call the Edge Function using pg_net extension
    PERFORM net.http_post(
      url := COALESCE(current_setting('app.settings.edge_function_url', true), 'https://ais-dev-2zuzlgcqjewvzuj6h5drpa-12778738639.us-west1.run.app/functions/v1') || '/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(current_setting('app.settings.service_role_key', true), '')
      ),
      body := v_payload
    );
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but don't fail the transaction
    RAISE WARNING 'Failed to trigger push notification: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- 4. Recreate the trigger
DROP TRIGGER IF EXISTS on_appointment_status_change ON public.appointments;
CREATE TRIGGER on_appointment_status_change
AFTER UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.notify_appointment_status_change();
