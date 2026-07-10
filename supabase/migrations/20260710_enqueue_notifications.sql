-- Migration: Microfase 1.2 - Enfileiramento de Notificações (Versão Refinada)
-- Author: Principal Software Engineer + Database Architect
-- Date: 2026-07-10
-- Purpose: Implement enqueue_notification function and trigger to feed notification_jobs table asynchronously without altering legacy push notification behavior.

-- 1. Create the dedicated enqueue_notification function
CREATE OR REPLACE FUNCTION public.enqueue_notification(p_notification_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notification_jobs (
    notification_id,
    status,
    priority,
    attempts,
    max_attempts,
    locked_at,
    locked_by,
    next_run_at,
    completed_at,
    last_error,
    metadata
  ) VALUES (
    p_notification_id,
    'pending',
    0,
    0,
    5,
    NULL,
    NULL,
    clock_timestamp(),
    NULL,
    NULL,
    '{}'::jsonb
  )
  ON CONFLICT (notification_id) DO NOTHING;
END;
$$;

-- 2. Create the trigger function to automatically enqueue newly created notifications
CREATE OR REPLACE FUNCTION public.tr_fn_enqueue_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.enqueue_notification(NEW.id);
  RETURN NEW;
END;
$$;

-- 3. Register the AFTER INSERT trigger on public.notifications
DROP TRIGGER IF EXISTS tr_enqueue_notification ON public.notifications;
CREATE TRIGGER tr_enqueue_notification
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.tr_fn_enqueue_notification();

-- 4. Documentação técnica via Comentários no Banco (Auto-documentação de Produção)
COMMENT ON FUNCTION public.enqueue_notification(uuid) IS 'Função interna de infraestrutura para enfileirar uma notificação de forma idempotente e atômica sob o padrão Transactional Outbox.';
COMMENT ON FUNCTION public.tr_fn_enqueue_notification() IS 'Trigger de integração que intercepta inserções de domínio em public.notifications e alimenta public.notification_jobs.';

-- 5. Revogar privilégios públicos padrão e limitar acesso exclusivamente ao service_role/postgres
REVOKE EXECUTE ON FUNCTION public.enqueue_notification(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.tr_fn_enqueue_notification() FROM public;

GRANT EXECUTE ON FUNCTION public.enqueue_notification(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tr_fn_enqueue_notification() TO service_role;

