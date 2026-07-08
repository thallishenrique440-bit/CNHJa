-- Migration: Remove current_setting() dependency and use secure notification_config table
-- Author: AI Coding Agent
-- Date: 2026-07-07

-- 1. Create a secure configuration table for the notification system
CREATE TABLE IF NOT EXISTS public.notification_config (
    key text PRIMARY KEY,
    value text NOT NULL
);

-- 2. Enable Row Level Security (RLS) to prevent unauthorized public/authenticated access
ALTER TABLE public.notification_config ENABLE ROW LEVEL SECURITY;

-- 3. Recreate notify_new_notification trigger function to read from public.notification_config
CREATE OR REPLACE FUNCTION public.notify_new_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_edge_function_url TEXT;
  v_service_role_key TEXT;
  v_payload JSONB;
BEGIN
  -- Retrieve configurations from the secure notification_config table
  SELECT value INTO v_edge_function_url FROM public.notification_config WHERE key = 'edge_function_url';
  SELECT value INTO v_service_role_key FROM public.notification_config WHERE key = 'service_role_key';

  -- O armazenamento da notificacao possui prioridade sobre o envio do Push.
  -- O Push eh apenas um mecanismo de entrega secundario e assincrono.
  -- A notificacao persistida eh a fonte oficial da verdade, portanto, falhas ou ausencias
  -- de configuracao de rede/Push jamais devem abortar ou impedir o INSERT/transacao principal.
  IF v_edge_function_url IS NULL OR v_edge_function_url = '' THEN
    RAISE WARNING 'Configuracao obrigatoria ausente na tabela public.notification_config: edge_function_url. Envio de push ignorado.';
    RETURN NEW;
  END IF;

  IF v_service_role_key IS NULL OR v_service_role_key = '' THEN
    RAISE WARNING 'Configuracao obrigatoria ausente na tabela public.notification_config: service_role_key. Envio de push ignorado.';
    RETURN NEW;
  END IF;

  -- Construct the payload containing just the notification_id
  v_payload := jsonb_build_object(
    'notification_id', NEW.id
  );

  -- Network/dispatch block using pg_net
  BEGIN
    PERFORM net.http_post(
      url := rtrim(v_edge_function_url, '/') || '/send-push-notification',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_role_key
      ),
      body := v_payload
    );
  EXCEPTION
    WHEN OTHERS THEN
      -- Log other errors (like transient network failures) but do not fail the transaction
      RAISE WARNING 'Falha ao despachar notificacao via pg_net: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- 4. Re-register the trigger on the notifications table to guarantee it's active
DROP TRIGGER IF EXISTS tr_notify_new_notification ON public.notifications;
CREATE TRIGGER tr_notify_new_notification
AFTER INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.notify_new_notification();
