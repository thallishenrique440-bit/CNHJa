-- =============================================================================
-- Extensao de harness para AP-05 / Trilha A (ferias)
--
-- Aplicar DEPOIS de supabase/tests/p1205_harness.pgsql.sql e ANTES das
-- migrations. Completa o harness com o que existe em producao e que a
-- migration de ferias e sua bateria precisam (catalogo lido em 2026-09-25):
--   - roles anon / authenticated / service_role (existem no Supabase);
--   - colunas de vitrine de instructors e a tabela profiles (views AP-02);
--   - security_audit_logs com os CHECK constraints e o trigger de imutabilidade
--     de producao (a migration de ferias NAO pode depender de valores fora deles);
--   - instructor_vacation_events NAO e' criada aqui: e' criada pela propria
--     migration sob teste, para que a bateria exercite o DDL real.
--   - tabelas financeiras minimas, so para provar que nada muda nelas;
--   - RLS + policies + grants de instructors como em producao.
--
-- PostgreSQL efemero apenas. NUNCA producao.
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;

GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

-- Colunas de instructors usadas pela vitrine (instructors_public).
ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS public_id text,
  ADD COLUMN IF NOT EXISTS credential_number text,
  ADD COLUMN IF NOT EXISTS whatsapp text,
  ADD COLUMN IF NOT EXISTS base_price integer,
  ADD COLUMN IF NOT EXISTS night_price integer,
  ADD COLUMN IF NOT EXISTS categories text[],
  ADD COLUMN IF NOT EXISTS meeting_point text,
  ADD COLUMN IF NOT EXISTS meeting_point_lat double precision,
  ADD COLUMN IF NOT EXISTS meeting_point_lng double precision,
  ADD COLUMN IF NOT EXISTS meeting_point_place_id text,
  ADD COLUMN IF NOT EXISTS payouts_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_wallet_id text;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  role text,
  city text,
  avatar_url text,
  phone text,
  cpf text,
  experience_level text,
  cnh_process_type text,
  is_profile_complete boolean DEFAULT false
);

-- security_audit_logs — colunas, CHECK constraints e trigger de imutabilidade
-- identicos a producao.
CREATE TABLE IF NOT EXISTS public.security_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  environment varchar NOT NULL,
  actor_id uuid,
  event_type varchar NOT NULL,
  ip_address varchar,
  request_id varchar,
  details jsonb
);

-- CHECK constraints REAIS de producao (pg_get_constraintdef, 2026-09-25).
-- Nao simplificar: sao eles que recusam eventos fora do dominio de seguranca.
ALTER TABLE public.security_audit_logs DROP CONSTRAINT IF EXISTS chk_security_audit_environment;
ALTER TABLE public.security_audit_logs ADD CONSTRAINT chk_security_audit_environment
  CHECK (((environment)::text = ANY ((ARRAY['production'::character varying, 'preview'::character varying, 'development'::character varying])::text[])));
ALTER TABLE public.security_audit_logs DROP CONSTRAINT IF EXISTS chk_security_audit_event_type;
ALTER TABLE public.security_audit_logs ADD CONSTRAINT chk_security_audit_event_type
  CHECK (((event_type)::text = ANY ((ARRAY['LOGIN_FAILED'::character varying, 'UNAUTHORIZED_ACCESS'::character varying, 'BANK_INFO_CHANGE'::character varying, 'ROLE_CHANGE'::character varying])::text[])));
-- (A FK actor_id -> auth.users ON DELETE SET NULL de producao nao e' reproduzida:
--  o harness nao tem auth.users e nenhum caminho de ferias escreve nesta tabela.)

CREATE OR REPLACE FUNCTION public.prevent_security_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN
    RAISE EXCEPTION 'Operação rejeitada. Registros em public.security_audit_logs são estritamente imutáveis e protegidos contra alteração ou exclusão.';
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_security_audit_mutation_row ON public.security_audit_logs;
CREATE TRIGGER trg_prevent_security_audit_mutation_row
  BEFORE UPDATE OR DELETE ON public.security_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_security_audit_mutation();
DROP TRIGGER IF EXISTS trg_prevent_security_audit_mutation_stmt ON public.security_audit_logs;
CREATE TRIGGER trg_prevent_security_audit_mutation_stmt
  BEFORE TRUNCATE ON public.security_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_security_audit_mutation();

ALTER TABLE public.security_audit_logs ENABLE ROW LEVEL SECURITY;

-- Tabelas financeiras minimas (somente para verificar que ferias nao as altera).
CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid, instructor_id uuid, student_id uuid,
  type text, status text, gross_amount integer, net_amount integer, platform_fee integer
);
CREATE TABLE IF NOT EXISTS public.payment_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid, instructor_id uuid, student_id uuid, group_id uuid,
  installment_number int, status text, gross_amount integer, net_amount integer,
  platform_fee integer, fee_amount integer, provider_payment_id text
);
CREATE TABLE IF NOT EXISTS public.payment_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installment_id uuid, instructor_id uuid, student_id uuid, settlement_type text,
  gross_amount integer, net_amount integer, platform_fee integer, fee_amount integer
);
CREATE TABLE IF NOT EXISTS public.refund_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid, status text, requested_amount_cents integer
);

-- instructors: RLS + policies + grants como em producao (pre-AP-02; a
-- migration AP-02 substitui a policy de SELECT).
ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.instructors;
CREATE POLICY "Public profiles are viewable by everyone" ON public.instructors
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert their own instructor profile" ON public.instructors;
CREATE POLICY "Users can insert their own instructor profile" ON public.instructors
  FOR INSERT WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "Instructors can update own data" ON public.instructors;
CREATE POLICY "Instructors can update own data" ON public.instructors
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read profiles" ON public.profiles;
CREATE POLICY "Authenticated users can read profiles" ON public.profiles
  FOR SELECT TO authenticated USING (true);

GRANT ALL ON public.instructors, public.profiles, public.appointments TO anon, authenticated, service_role;
