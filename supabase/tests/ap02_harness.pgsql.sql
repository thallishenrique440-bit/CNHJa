-- =============================================================================
-- Harness AP-02 — profiles / instructors / appointments no estado de producao
-- (catalogo lido em 2026-09-25): mesmas colunas relevantes, RLS habilitado,
-- as 6 policies vigentes e os grants ALL de anon/authenticated.
--
-- auth.uid()/auth.role() leem current_setting('test.uid'/'test.role'), como no
-- harness p1205. Os roles anon/authenticated existem para que a bateria rode
-- com SET ROLE e o RLS seja de fato avaliado (o owner ignora RLS).
--
-- PostgreSQL efemero apenas. NUNCA producao.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('test.role', true), ''), 'service_role')
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  role text,
  city text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  avatar_url text,
  trusted_contact text,
  security_message text,
  experience_level text,
  cnh_process_type text,
  phone text,
  terms_accepted_at timestamptz,
  terms_version text,
  is_profile_complete boolean DEFAULT false,
  provider_name text,
  provider_customer_id text,
  cpf text
);

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  public_id text,
  credential_number text,
  whatsapp text,
  base_price integer,
  night_price integer,
  has_night_lessons boolean DEFAULT false,
  meeting_point text,
  categories text[],
  created_at timestamptz DEFAULT now(),
  payouts_enabled boolean DEFAULT false,
  work_saturday_afternoon boolean DEFAULT false,
  meeting_point_lat double precision,
  meeting_point_lng double precision,
  meeting_point_place_id text,
  lunch_active boolean DEFAULT true,
  lunch_start_slot text DEFAULT '12:00',
  lunch_duration integer DEFAULT 2,
  provider_name text,
  provider_account_id text,
  provider_wallet_id text,
  provider_onboarding_completed boolean DEFAULT false,
  provider_status text
);

CREATE TABLE public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  instructor_id uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  date date NOT NULL DEFAULT current_date,
  start_time time NOT NULL DEFAULT '10:00',
  end_time time NOT NULL DEFAULT '11:00',
  price integer NOT NULL DEFAULT 10000,
  status text NOT NULL DEFAULT 'pending',
  payment_status text DEFAULT 'pending'
);

ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- Policies vigentes em producao (antes do AP-02)
CREATE POLICY "Authenticated users can read profiles" ON public.profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert their own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "Public profiles are viewable by everyone" ON public.instructors
  FOR SELECT USING (true);
CREATE POLICY "Users can insert their own instructor profile" ON public.instructors
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Instructors can update own data" ON public.instructors
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can view own appointments" ON public.appointments
  FOR SELECT USING ((auth.uid() = student_id) OR (auth.uid() = instructor_id));

-- Grants vigentes em producao
GRANT ALL ON public.profiles, public.instructors, public.appointments TO anon, authenticated;
