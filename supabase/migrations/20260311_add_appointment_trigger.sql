-- Create a trigger function to call the edge function on appointment status changes
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
    
    -- Get the Edge Function URL and Service Role Key from Vault/Env
    -- In a real Supabase environment, you would use pg_net and vault to securely call the function.
    -- For this setup, we'll assume the URL is stored in a secure way or hardcoded for the specific project.
    -- Example: 'https://[PROJECT_REF].supabase.co/functions/v1/send-push-notification'
    
    -- Construct the payload
    v_payload := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'record', row_to_json(NEW),
      'old_record', row_to_json(OLD)
    );

    -- Call the Edge Function using pg_net extension
    -- Note: pg_net must be enabled in the Supabase project
    -- This is an asynchronous call, so it won't block the transaction
    PERFORM net.http_post(
      url := current_setting('app.settings.edge_function_url', true) || '/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
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

-- Create the trigger on the appointments table
DROP TRIGGER IF EXISTS on_appointment_status_change ON public.appointments;
CREATE TRIGGER on_appointment_status_change
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_appointment_status_change();
