-- ROLLBACK AP-01 — estado de public.appointments capturado em producao
-- (ohftsqsxymtrclnpadam) ANTES da migration
-- 20260925_ap01_appointments_insert_authority, em 2026-09-25.
--
-- Estado pre-aplicacao (referencia):
--   grants anon / authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   8 policies; triggers: appointments_security_check_trigger, tr_set_updated_by
--   check_appointments_insert_authority: inexistente
--   check_appointments_update_security (AP-03/AP-11): md5(functiondef) f850d52afdff8fc6a1affd2e8c3aa003
--   appointments: 28 linhas (cancelled 3, cancelling 3, completed 19, expired 3); instructors: 6
--
-- ATENCAO: executar este rollback REABRE o BL-01. Usar apenas em regressao comprovada.

DROP TRIGGER IF EXISTS appointments_insert_authority_trigger ON public.appointments;
DROP FUNCTION IF EXISTS public.check_appointments_insert_authority();

-- Definicoes exatas lidas de pg_policy antes da aplicacao:
CREATE POLICY "Students can create appointments" ON public.appointments
  FOR INSERT TO public
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can book appointments" ON public.appointments
  FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = student_id) AND
    ((SELECT profiles.is_profile_complete FROM profiles WHERE profiles.id = auth.uid()) = true));

GRANT INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.appointments TO anon;
GRANT TRUNCATE, TRIGGER, REFERENCES ON public.appointments TO authenticated;
