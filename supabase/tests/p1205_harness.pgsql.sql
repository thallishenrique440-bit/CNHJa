-- Harness fiel ao schema de producao para testar as migrations P-1.20.5
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('test.role', true), ''), 'service_role')
$$;

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY,
  has_night_lessons boolean DEFAULT false,
  work_saturday_afternoon boolean DEFAULT false,
  lunch_active boolean DEFAULT true,
  lunch_start_slot text DEFAULT '12:00',
  lunch_duration int DEFAULT 2
);

CREATE TABLE public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  student_id uuid,
  instructor_id uuid NOT NULL,
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  category text,
  price integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cancelled_reason text,
  purchase_id uuid,
  expires_at timestamptz,
  payment_id text,
  payment_intent_id text,
  payment_status text DEFAULT 'pending',
  updated_at timestamptz DEFAULT now(),
  group_id uuid,
  start_time_utc timestamptz,
  is_last_minute boolean DEFAULT false,
  updated_by uuid,
  reschedule_requested_at timestamptz,
  rescheduled_at timestamptz,
  provider_name text DEFAULT 'asaas',
  provider_payment_id text,
  -- Colunas do modelo de proposta (migration 20260923_p1205_01). Presentes em
  -- producao e lidas pelo trigger de INSERT do AP-01. A p1205_01 usa
  -- ADD COLUMN IF NOT EXISTS, entao declara-las aqui e' compativel com ela.
  proposed_date date,
  proposed_start_time time,
  proposed_end_time time,
  proposed_by uuid,
  proposal_status text,
  proposal_created_at timestamptz,
  proposal_resolved_at timestamptz
);

CREATE UNIQUE INDEX idx_unique_active_slot ON public.appointments (instructor_id, date, start_time)
  WHERE status <> ALL (ARRAY['cancelled','failed','rejected','expired']);
CREATE UNIQUE INDEX idx_unique_student_active_slot ON public.appointments (student_id, date, start_time)
  WHERE status <> ALL (ARRAY['cancelled','failed','rejected','expired']) AND student_id IS NOT NULL;

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  title text,
  message text,
  type text,
  entity_type text,
  target_screen text,
  combo_count integer,
  group_id uuid,
  appointment_id uuid,
  payload_version integer
);

ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY['booking_request','booking_accepted','booking_rejected',
    'booking_cancelled','booking_expired','payment_released','reminder','system','tip']));

CREATE UNIQUE INDEX idx_notifications_idempotency_group
  ON public.notifications (type, user_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX idx_notifications_idempotency_appointment
  ON public.notifications (type, user_id, appointment_id)
  WHERE group_id IS NULL AND appointment_id IS NOT NULL;

CREATE TABLE public.notification_jobs (
  notification_id uuid PRIMARY KEY,
  status text, priority int, attempts int, max_attempts int,
  locked_at timestamptz, locked_by text, next_run_at timestamptz,
  completed_at timestamptz, last_error text, metadata jsonb
);

CREATE OR REPLACE FUNCTION public.enqueue_notification(p_notification_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.notification_jobs (notification_id, status, priority, attempts,
    max_attempts, locked_at, locked_by, next_run_at, completed_at, last_error, metadata)
  VALUES (p_notification_id,'pending',0,0,5,NULL,NULL,clock_timestamp(),NULL,NULL,'{}'::jsonb)
  ON CONFLICT (notification_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_enqueue_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.enqueue_notification(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_enqueue_notification AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tr_enqueue_notification();

-- copia literal da funcao de producao
CREATE OR REPLACE FUNCTION public.create_unified_notification(
  p_user_id uuid, p_title text, p_message text, p_type text, p_entity_type text,
  p_target_screen text, p_combo_count integer, p_group_id uuid, p_appointment_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_notification_id uuid;
BEGIN
  BEGIN
    INSERT INTO public.notifications (user_id,title,message,type,entity_type,
      target_screen,combo_count,group_id,appointment_id,payload_version)
    VALUES (p_user_id,p_title,p_message,p_type,p_entity_type,p_target_screen,
      p_combo_count,p_group_id,p_appointment_id,1)
    RETURNING id INTO v_notification_id;
  EXCEPTION
    WHEN unique_violation THEN
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

CREATE OR REPLACE FUNCTION public.check_appointment_conflict(
  p_instructor_id uuid, p_date date, p_start_time time, p_exclude_appointment_ids uuid[])
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_has_conflict BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.appointments
    WHERE instructor_id = p_instructor_id AND date = p_date AND start_time = p_start_time
      AND status IN ('pending','pending_approval','confirmed','scheduled','reserved','awaiting_payment')
      AND (p_exclude_appointment_ids IS NULL OR NOT (id = ANY(p_exclude_appointment_ids)))
  ) INTO v_has_conflict;
  RETURN v_has_conflict;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_appointments_update_security() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF auth.role() = 'authenticated' THEN
    IF NEW.payment_status    IS DISTINCT FROM OLD.payment_status    THEN RAISE EXCEPTION 'payment_status'; END IF;
    IF NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN RAISE EXCEPTION 'payment_intent_id'; END IF;
    IF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN RAISE EXCEPTION 'provider_payment_id'; END IF;
    IF NEW.purchase_id       IS DISTINCT FROM OLD.purchase_id       THEN RAISE EXCEPTION 'purchase_id'; END IF;
    IF NEW.payment_id        IS DISTINCT FROM OLD.payment_id        THEN RAISE EXCEPTION 'payment_id'; END IF;
    IF NEW.price             IS DISTINCT FROM OLD.price             THEN RAISE EXCEPTION 'price'; END IF;
    IF NEW.provider_name     IS DISTINCT FROM OLD.provider_name     THEN RAISE EXCEPTION 'provider_name'; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status NOT IN ('cancelled','completed','no_show','pending_approval') THEN
        RAISE EXCEPTION 'status: %', NEW.status;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_appointments_update_security BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.check_appointments_update_security();
