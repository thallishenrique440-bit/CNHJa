-- Migration: Unified Notification System for CNHJÁ
-- Author: AI Coding Agent
-- Date: 2026-07-06

-- 0. Ensure the pg_net extension is created for async HTTP requests
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1. Alter notifications table to add new semantic and routing columns
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS appointment_id uuid;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS target_screen text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS combo_count integer DEFAULT 1;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS payload_version integer DEFAULT 1;

-- 2. Drop old type check and add updated check constraint to allow standard types
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check 
    CHECK (type IN ('booking_request', 'booking_accepted', 'booking_rejected', 'booking_cancelled', 'booking_expired', 'payment_released', 'reminder', 'system', 'tip'));

-- 3. Create composite unique indexes for robust idempotency per recipient and group/appointment
-- This guarantees that a group or appointment cannot generate duplicate notifications for the same event type and recipient
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency_group 
ON public.notifications (type, user_id, group_id) 
WHERE group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency_appointment 
ON public.notifications (type, user_id, appointment_id) 
WHERE group_id IS NULL AND appointment_id IS NOT NULL;

-- 4. Drop legacy automatic appointment-based triggers to switch completely to source-based consolidation
DROP TRIGGER IF EXISTS on_appointment_status_change ON public.appointments;
DROP TRIGGER IF EXISTS trigger_notify_appointment_status_change ON public.appointments;

-- 5. Create robust stored procedure RPC function to handle notifications insertion
CREATE OR REPLACE FUNCTION public.create_unified_notification(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_type text,
  p_entity_type text,
  p_target_screen text,
  p_combo_count integer,
  p_group_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notification_id uuid;
BEGIN
  BEGIN
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      entity_type,
      target_screen,
      combo_count,
      group_id,
      appointment_id,
      payload_version
    ) VALUES (
      p_user_id,
      p_title,
      p_message,
      p_type,
      p_entity_type,
      p_target_screen,
      p_combo_count,
      p_group_id,
      p_appointment_id,
      1
    )
    RETURNING id INTO v_notification_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- If a duplicate exists due to the composite unique index constraint, log it and return the existing id
      IF p_group_id IS NOT NULL THEN
        SELECT id INTO v_notification_id FROM public.notifications 
        WHERE type = p_type AND user_id = p_user_id AND group_id = p_group_id LIMIT 1;
      ELSE
        SELECT id INTO v_notification_id FROM public.notifications 
        WHERE type = p_type AND user_id = p_user_id AND appointment_id = p_appointment_id LIMIT 1;
      END IF;
  END;

  RETURN v_notification_id;
END;
$$;

-- 6. Create trigger function to dispatch notifications to the Edge Function send-push-notification
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
  -- Retrieve configurations exclusively, without fallback
  v_edge_function_url := current_setting('app.settings.edge_function_url', true);
  v_service_role_key := current_setting('app.settings.service_role_key', true);

  -- O armazenamento da notificacao possui prioridade sobre o envio do Push.
  -- O Push eh apenas um mecanismo de entrega secundario e assincrono.
  -- A notificacao persistida eh a fonte oficial da verdade, portanto, falhas ou ausencias
  -- de configuracao de rede/Push jamais devem abortar ou impedir o INSERT/transacao principal.
  IF v_edge_function_url IS NULL OR v_edge_function_url = '' THEN
    RAISE WARNING 'Configuracao obrigatoria ausente: app.settings.edge_function_url. Envio de push ignorado.';
    RETURN NEW;
  END IF;

  IF v_service_role_key IS NULL OR v_service_role_key = '' THEN
    RAISE WARNING 'Configuracao obrigatoria ausente: app.settings.service_role_key. Envio de push ignorado.';
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

-- 7. Register the trigger on the notifications table
DROP TRIGGER IF EXISTS tr_notify_new_notification ON public.notifications;
CREATE TRIGGER tr_notify_new_notification
AFTER INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.notify_new_notification();
