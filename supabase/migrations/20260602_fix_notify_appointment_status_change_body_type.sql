-- Create migration to fix type mismatch in net.http_post call by casting v_payload to TEXT
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
  -- We care about updates where:
  -- 1. The status actually changed OR
  -- 2. reschedule_requested_at changed OR
  -- 3. rescheduled_at changed
  IF (OLD.status IS DISTINCT FROM NEW.status) OR
     (OLD.reschedule_requested_at IS DISTINCT FROM NEW.reschedule_requested_at) OR
     (OLD.rescheduled_at IS DISTINCT FROM NEW.rescheduled_at) THEN
    
    -- Construct the payload
    v_payload := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'record', row_to_json(NEW),
      'old_record', row_to_json(OLD)
    );

    -- Call the Edge Function using pg_net extension
    -- Cast v_payload (JSONB) to TEXT to match the signature of net.http_post
    PERFORM net.http_post(
      url := COALESCE(current_setting('app.settings.edge_function_url', true), 'https://ais-dev-2zuzlgcqjewvzuj6h5drpa-12778738639.us-west1.run.app/functions/v1') || '/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(current_setting('app.settings.service_role_key', true), '')
      ),
      body := v_payload::text
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
