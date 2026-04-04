-- ===============================================================
-- PARTE 1: Ajuste de Estrutura (Defaults e Fallbacks)
-- ===============================================================

-- Garante que campos obrigatórios tenham defaults para evitar falhas no trigger
ALTER TABLE public.instructors 
  ALTER COLUMN base_price SET DEFAULT 11000,
  ALTER COLUMN night_price SET DEFAULT 13000,
  ALTER COLUMN rating SET DEFAULT 5.0;

-- Garante que a coluna role em profiles tenha um default seguro
ALTER TABLE public.profiles 
  ALTER COLUMN role SET DEFAULT 'student';

-- ===============================================================
-- PARTE 2: Script de Migração (Backfill para usuários existentes)
-- ===============================================================

-- 1. Cria perfis para usuários que existem no Auth mas não no Profiles
INSERT INTO public.profiles (id, full_name, email, role, city, phone)
SELECT 
  id,
  raw_user_meta_data->>'full_name',
  email,
  COALESCE(raw_user_meta_data->>'role', 'student'),
  raw_user_meta_data->>'city',
  COALESCE(raw_user_meta_data->>'phone', raw_user_meta_data->>'whatsapp')
FROM auth.users
ON CONFLICT (id) DO UPDATE SET
  full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
  city = COALESCE(NULLIF(public.profiles.city, ''), EXCLUDED.city),
  phone = COALESCE(NULLIF(public.profiles.phone, ''), EXCLUDED.phone);

-- 2. Cria registros de instrutores para usuários com role 'instructor'
INSERT INTO public.instructors (id, credential_number, whatsapp)
SELECT 
  id,
  COALESCE(raw_user_meta_data->>'credential', ''),
  raw_user_meta_data->>'whatsapp'
FROM auth.users
WHERE raw_user_meta_data->>'role' = 'instructor'
ON CONFLICT (id) DO NOTHING;

-- ===============================================================
-- PARTE 3: Versão Final do Trigger (Automação de novos cadastros)
-- ===============================================================

-- Função que processa o novo usuário do Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  user_role text;
BEGIN
  -- Extrai a role dos metadados ou assume 'student'
  user_role := COALESCE(NEW.raw_user_meta_data->>'role', 'student');

  -- Inserção na tabela de perfis
  INSERT INTO public.profiles (id, full_name, email, role, city, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    user_role,
    COALESCE(NEW.raw_user_meta_data->>'city', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', NEW.raw_user_meta_data->>'whatsapp', '')
  )
  ON CONFLICT (id) DO NOTHING;

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

-- Trigger que dispara após o insert no Auth
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
