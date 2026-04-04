-- Migration: Add Privacy Policy Tracking and Security Hardening
-- 1. Add privacy_accepted_at and privacy_version to profiles
-- 2. Update handle_new_user to enforce privacy acceptance
-- 3. Update RLS policies to require both terms and privacy acceptance

-- 1. Add Columns
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamptz,
ADD COLUMN IF NOT EXISTS privacy_version text;

-- 2. Update Trigger Function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  user_role text;
  terms_accepted text;
  privacy_accepted text;
BEGIN
  -- Extrai a role dos metadados ou assume 'student'
  user_role := COALESCE(NEW.raw_user_meta_data->>'role', 'student');
  terms_accepted := NEW.raw_user_meta_data->>'terms_accepted_at';
  privacy_accepted := NEW.raw_user_meta_data->>'privacy_accepted_at';

  -- SECURITY: Enforce terms and privacy acceptance at the database level for new accounts
  IF (terms_accepted IS NULL) THEN
    RAISE EXCEPTION 'Terms of Use must be accepted to create an account.';
  END IF;

  IF (privacy_accepted IS NULL) THEN
    RAISE EXCEPTION 'Privacy Policy must be accepted to create an account.';
  END IF;

  -- Inserção na tabela de perfis
  INSERT INTO public.profiles (
    id, 
    full_name, 
    email, 
    role, 
    city, 
    phone,
    terms_accepted_at,
    terms_version,
    privacy_accepted_at,
    privacy_version
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    user_role,
    COALESCE(NEW.raw_user_meta_data->>'city', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', NEW.raw_user_meta_data->>'whatsapp', ''),
    terms_accepted::timestamptz,
    '1.0', -- HARDCODED TERMS VERSION
    privacy_accepted::timestamptz,
    '1.0'  -- HARDCODED PRIVACY VERSION
  )
  ON CONFLICT (id) DO UPDATE SET
    terms_accepted_at = EXCLUDED.terms_accepted_at,
    terms_version = EXCLUDED.terms_version,
    privacy_accepted_at = EXCLUDED.privacy_accepted_at,
    privacy_version = EXCLUDED.privacy_version;

  -- Se for instrutor, cria também o registro na tabela de instrutores
  IF (user_role = 'instructor') THEN
    INSERT INTO public.instructors (id, credential_number, whatsapp, base_price, night_price)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'credential', ''),
      NEW.raw_user_meta_data->>'whatsapp',
      11000, -- Default inicial (Carro B Diurna)
      13000  -- Default inicial (Carro B Noturna)
    )
    ON CONFLICT (id) DO NOTHING;

    -- Inserir categorias padrão com preços
    INSERT INTO public.instructor_categories (instructor_id, category, day_price, night_price)
    VALUES 
      (NEW.id, 'A', 10000, 11000), -- Moto
      (NEW.id, 'B', 11000, 13000)  -- Carro
    ON CONFLICT (instructor_id, category) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Update RLS Policies for Appointments (Require both)
DROP POLICY IF EXISTS "Students can book appointments" ON public.appointments;
CREATE POLICY "Students can book appointments"
ON public.appointments FOR INSERT
WITH CHECK (
  auth.uid() = student_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND terms_accepted_at IS NOT NULL AND privacy_accepted_at IS NOT NULL
  )
);

DROP POLICY IF EXISTS "Instructors can block slots" ON public.appointments;
CREATE POLICY "Instructors can block slots"
ON public.appointments FOR INSERT
WITH CHECK (
  auth.uid() = instructor_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND terms_accepted_at IS NOT NULL AND privacy_accepted_at IS NOT NULL
  )
);

-- 4. Update RLS Policies for Reviews (Require both)
DROP POLICY IF EXISTS "Students can create reviews for their own finished lessons" ON public.reviews;
CREATE POLICY "Students can create reviews for their own finished lessons"
ON public.reviews FOR INSERT
WITH CHECK (
  auth.uid() = student_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND terms_accepted_at IS NOT NULL AND privacy_accepted_at IS NOT NULL
  )
);
