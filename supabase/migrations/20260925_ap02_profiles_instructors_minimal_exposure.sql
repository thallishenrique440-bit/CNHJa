-- =============================================================================
-- AP-02 / F1-02 / F1-03 — Exposicao minima de public.profiles e public.instructors
-- =============================================================================
--
-- PROBLEMA (catalogo de producao, leitura em 2026-09-25)
--   profiles:    policy "Authenticated users can read profiles" USING (true)
--                -> qualquer autenticado le cpf, email, phone, trusted_contact,
--                   security_message, provider_customer_id de TODOS os usuarios.
--   instructors: policy "Public profiles are viewable by everyone" USING (true),
--                role PUBLIC, e anon com SELECT
--                -> qualquer pessoa, sem login, le whatsapp, provider_account_id,
--                   provider_wallet_id, provider_status, payouts_enabled.
--   anon possui todos os privilegios nas duas tabelas.
--
-- DESENHO (MASTER-CORRECTION-PLAN v1.1, analise AP-02: 2 views + 2 RPCs)
--   profiles_public    view: id, full_name, avatar_url, city. Somente authenticated.
--   instructors_public view: dados de vitrine + identidade publica do instrutor
--                      (nome, foto, cidade) + has_whatsapp. Sem whatsapp, sem
--                      provider_*, sem payouts_enabled. anon + authenticated.
--   get_instructor_whatsapp(uuid)
--        numero do instrutor para: o proprio instrutor; aluno com vinculo de
--        aula; ou ALUNO autenticado com perfil completo (decisao de produto de
--        2026-09-25: o contato pre-contrato continua existindo, mas sai da
--        vitrine publica e passa a ser 1 instrutor por chamada).
--   get_student_contact_for_appointment(uuid)
--        phone, experience_level, cnh_process_type do aluno SOMENTE para o
--        instrutor daquela aula e SOMENTE em aula paga/aceita.
--
--   Tabelas: SELECT passa a ser da propria linha (auth.uid() = id).
--
-- AS VIEWS SAO "security definer" (padrao do Postgres, owner = postgres):
--   leem a tabela base sem RLS, e a PROJECAO de colunas e' o controle. Nenhuma
--   coluna sensivel entra nelas. O Supabase advisor sinaliza esse padrao
--   (security_definer_view); e' intencional aqui e esta documentado.
--
-- CAMINHOS NAO AFETADOS
--   - Todo backend (api/*, supabase/functions/*) usa service_role.
--   - Policies de outras tabelas que consultam profiles o fazem so na propria
--     linha (profiles.id = auth.uid()) -> continuam funcionando.
--   - Funcoes SECURITY DEFINER existentes nao dependem do RLS dessas tabelas.
--   - INSERT/UPDATE das proprias linhas: policies intocadas.
--
-- FORA DO ESCOPO: N-01, N-02, N-03; C-09 das demais tabelas; buckets (AP-08).
-- APLICACAO: NAO APLICADA. Aplicacao manual apos validacao.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles: leitura so da propria linha + view publica minima
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can read profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE OR REPLACE VIEW public.profiles_public AS
  SELECT p.id, p.full_name, p.avatar_url, p.city
    FROM public.profiles p;

COMMENT ON VIEW public.profiles_public IS
  'AP-02: projecao publica de profiles (id, full_name, avatar_url, city). Sem cpf, email, phone, trusted_contact, security_message, provider_*.';

-- -----------------------------------------------------------------------------
-- 2. instructors: leitura so da propria linha + view de vitrine
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.instructors;
DROP POLICY IF EXISTS "Instructors can read own data" ON public.instructors;
CREATE POLICY "Instructors can read own data" ON public.instructors
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE OR REPLACE VIEW public.instructors_public AS
  SELECT i.id,
         i.public_id,
         i.credential_number,
         i.base_price,
         i.night_price,
         i.has_night_lessons,
         i.categories,
         i.meeting_point,
         i.meeting_point_lat,
         i.meeting_point_lng,
         i.meeting_point_place_id,
         i.work_saturday_afternoon,
         i.lunch_active,
         i.lunch_start_slot,
         i.lunch_duration,
         (i.whatsapp IS NOT NULL AND btrim(i.whatsapp) <> '') AS has_whatsapp,
         p.full_name,
         p.avatar_url,
         p.city
    FROM public.instructors i
    JOIN public.profiles p ON p.id = i.id;

COMMENT ON VIEW public.instructors_public IS
  'AP-02: vitrine de instrutores. Sem whatsapp (so has_whatsapp), sem provider_*, sem payouts_enabled.';

-- -----------------------------------------------------------------------------
-- 3. Privilegios
-- -----------------------------------------------------------------------------
-- O Supabase concede ALL em objetos novos do schema public a anon/authenticated
-- por default privileges: revogar tudo e conceder somente o necessario.
REVOKE ALL ON public.profiles_public    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instructors_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profiles_public    TO authenticated;
GRANT SELECT ON public.instructors_public TO anon, authenticated;

-- anon nao tem nenhum uso legitimo das tabelas base (F1-03).
REVOKE ALL ON public.profiles    FROM anon;
REVOKE ALL ON public.instructors FROM anon;

-- -----------------------------------------------------------------------------
-- 4. RPC: WhatsApp do instrutor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_instructor_whatsapp(p_instructor_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_allowed boolean;
  v_whatsapp text;
BEGIN
  IF v_uid IS NULL OR p_instructor_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_allowed :=
       v_uid = p_instructor_id
    OR EXISTS (SELECT 1 FROM public.profiles pr
                WHERE pr.id = v_uid
                  AND pr.role = 'student'
                  AND pr.is_profile_complete = true)
    OR EXISTS (SELECT 1 FROM public.appointments a
                WHERE a.instructor_id = p_instructor_id
                  AND a.student_id = v_uid);

  IF NOT v_allowed THEN
    RETURN NULL;
  END IF;

  SELECT i.whatsapp INTO v_whatsapp
    FROM public.instructors i
   WHERE i.id = p_instructor_id;

  RETURN NULLIF(btrim(v_whatsapp), '');
END;
$function$;

COMMENT ON FUNCTION public.get_instructor_whatsapp(uuid) IS
  'AP-02: WhatsApp do instrutor para o proprio instrutor, aluno com aula com ele, ou aluno autenticado com perfil completo. NULL para qualquer outro chamador.';

-- -----------------------------------------------------------------------------
-- 5. RPC: contato do aluno para o instrutor da aula
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_student_contact_for_appointment(p_appointment_id uuid)
RETURNS TABLE (phone text, experience_level text, cnh_process_type text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_appointment_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT pr.phone, pr.experience_level::text, pr.cnh_process_type::text
      FROM public.appointments a
      JOIN public.profiles pr ON pr.id = a.student_id
     WHERE a.id = p_appointment_id
       AND a.instructor_id = v_uid
       AND a.status IN ('pending_approval', 'confirmed', 'scheduled', 'completed', 'no_show');
END;
$function$;

COMMENT ON FUNCTION public.get_student_contact_for_appointment(uuid) IS
  'AP-02: phone/experience_level/cnh_process_type do aluno, somente para o instrutor da aula e somente em aula paga ou aceita. Zero linhas para qualquer outro chamador.';

REVOKE ALL ON FUNCTION public.get_instructor_whatsapp(uuid)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_student_contact_for_appointment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_instructor_whatsapp(uuid)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_contact_for_appointment(uuid) TO authenticated;


-- =============================================================================
-- VERIFICACAO — ANTES (somente SELECT)
-- =============================================================================
-- SELECT c.relname, polname, polcmd, pg_get_expr(polqual, polrelid)
--   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--  WHERE c.relname IN ('profiles','instructors') ORDER BY 1, 2;
--   -- esperado hoje: 3 policies em cada; SELECT com USING (true)
-- SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY 1)
--   FROM information_schema.role_table_grants
--  WHERE table_name IN ('profiles','instructors') AND grantee IN ('anon','authenticated')
--  GROUP BY 1, 2;
-- SELECT count(*) FROM information_schema.views
--  WHERE table_schema='public' AND table_name IN ('profiles_public','instructors_public'); -- 0
--
-- =============================================================================
-- VERIFICACAO — DEPOIS (somente SELECT)
-- =============================================================================
--   policies SELECT: "Users can read own profile" / "Instructors can read own data"
--   anon: nenhum privilegio em profiles/instructors; SELECT em instructors_public
--   authenticated: SELECT em profiles_public e instructors_public
--   funcoes: 2 novas, prosecdef = true, EXECUTE apenas authenticated/service_role
--   bateria: supabase/tests/ap02_profiles_instructors_exposure.pgsql.sql
--
-- =============================================================================
-- ROLLBACK (reabre F1-02/F1-03 — usar so em regressao comprovada)
-- =============================================================================
-- DROP FUNCTION IF EXISTS public.get_student_contact_for_appointment(uuid);
-- DROP FUNCTION IF EXISTS public.get_instructor_whatsapp(uuid);
-- DROP VIEW IF EXISTS public.instructors_public;
-- DROP VIEW IF EXISTS public.profiles_public;
-- DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
-- DROP POLICY IF EXISTS "Instructors can read own data" ON public.instructors;
-- CREATE POLICY "Authenticated users can read profiles" ON public.profiles
--   FOR SELECT TO authenticated USING (true);
-- CREATE POLICY "Public profiles are viewable by everyone" ON public.instructors
--   FOR SELECT TO public USING (true);
-- GRANT ALL ON public.profiles    TO anon;
-- GRANT ALL ON public.instructors TO anon;
-- =============================================================================
