-- Migration: Security Hardening for Terms of Use
-- 1. Update handle_new_user to enforce terms acceptance and hardcode version
-- 2. Update RLS policies to require terms acceptance for critical actions

-- 1. Update Trigger Function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  user_role text;
  terms_accepted text;
BEGIN
  -- Extrai a role dos metadados ou assume 'student'
  user_role := COALESCE(NEW.raw_user_meta_data->>'role', 'student');
  terms_accepted := NEW.raw_user_meta_data->>'terms_accepted_at';

  -- SECURITY: Enforce terms acceptance at the database level for new accounts
  -- This prevents bypass via direct API calls to auth.signUp
  IF (terms_accepted IS NULL) THEN
    RAISE EXCEPTION 'Terms of Use must be accepted to create an account.';
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
    terms_version
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    user_role,
    COALESCE(NEW.raw_user_meta_data->>'city', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', NEW.raw_user_meta_data->>'whatsapp', ''),
    terms_accepted::timestamptz,
    '1.0' -- HARDCODED VERSION: Managed by backend
  )
  ON CONFLICT (id) DO UPDATE SET
    terms_accepted_at = EXCLUDED.terms_accepted_at,
    terms_version = EXCLUDED.terms_version;

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

-- 2. Update RLS Policies for Appointments
DROP POLICY IF EXISTS "Students can book appointments" ON public.appointments;
CREATE POLICY "Students can book appointments"
ON public.appointments FOR INSERT
WITH CHECK (
  auth.uid() = student_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND terms_accepted_at IS NOT NULL
  )
);

DROP POLICY IF EXISTS "Instructors can block slots" ON public.appointments;
CREATE POLICY "Instructors can block slots"
ON public.appointments FOR INSERT
WITH CHECK (
  auth.uid() = instructor_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND terms_accepted_at IS NOT NULL
  )
);

-- 3. Update RLS Policies for Reviews
DROP POLICY IF EXISTS "Students can create reviews for their own finished lessons" ON public.reviews;
CREATE POLICY "Students can create reviews for their own finished lessons"
ON public.reviews FOR INSERT
WITH CHECK (
  auth.uid() = student_id AND 
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND terms_accepted_at IS NOT NULL
  )
);
