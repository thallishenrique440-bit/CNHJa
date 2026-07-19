-- Migration: Update handle_new_user to automatically create instructor_categories with default prices
-- Created on: 2026-07-19
-- Price configuration (in cents):
-- - Category B (Carro): Day: 11000, Night: 13000
-- - Category A (Moto): Day: 10000, Night: 12000

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  user_role text;
  terms_accepted text;
BEGIN
  -- Extrai a role dos metadados ou assume 'student'
  user_role := COALESCE(NEW.raw_user_meta_data->>'role', 'student');
  terms_accepted := NEW.raw_user_meta_data->>'terms_accepted_at';

  -- VALIDAÇÃO DE SEGURANÇA
  -- Caso esteja ausente, nulo ou vazio, interrompe a criação
  IF (terms_accepted IS NULL OR terms_accepted = '') THEN
    RAISE EXCEPTION 'Terms of Use must be accepted to create an account.';
  END IF;

  -- Inserção na tabela de perfis
  INSERT INTO public.profiles (
    id, 
    email,
    full_name, 
    role, 
    city, 
    phone,
    terms_accepted_at,
    terms_version
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    user_role,
    COALESCE(NEW.raw_user_meta_data->>'city', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', NEW.raw_user_meta_data->>'whatsapp', ''),
    terms_accepted::timestamptz,
    '1.0'
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    city = EXCLUDED.city,
    phone = EXCLUDED.phone,
    terms_accepted_at = EXCLUDED.terms_accepted_at,
    terms_version = EXCLUDED.terms_version;

  -- Se for instrutor, cria também o registro na tabela de instrutores e suas categorias padrão
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

    -- Inserir categorias padrão com preços (A e B)
    INSERT INTO public.instructor_categories (instructor_id, category, day_price, night_price)
    VALUES 
      (NEW.id, 'A', 10000, 12000), -- Moto A (Diurno: 100,00, Noturno: 120,00)
      (NEW.id, 'B', 11000, 13000)  -- Carro B (Diurno: 110,00, Noturno: 130,00)
    ON CONFLICT (instructor_id, category) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
