-- Update trigger trigger_notify_appointment_status_change/on_appointment_status_change to listen to status, reschedule_requested_at, and rescheduled_at
DROP TRIGGER IF EXISTS on_appointment_status_change ON public.appointments;
DROP TRIGGER IF EXISTS trigger_notify_appointment_status_change ON public.appointments;

CREATE TRIGGER on_appointment_status_change
  AFTER UPDATE OF status, reschedule_requested_at, rescheduled_at
  ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_appointment_status_change();
