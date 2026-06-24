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

-- ===============================================================
-- PARTE 4: Configurações Financeiras da Plataforma (Repasse de Taxas)
-- ===============================================================

CREATE TABLE IF NOT EXISTS public.platform_financial_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  pix_flat_fee integer NOT NULL DEFAULT 149, -- em centavos (ex: R$1,49)
  credit_1x_fee numeric(5,2) NOT NULL DEFAULT 3.99, -- em percentual (ex: 3.99%)
  credit_2x_fee numeric(5,2) NOT NULL DEFAULT 5.49,
  credit_3x_fee numeric(5,2) NOT NULL DEFAULT 6.49,
  credit_4x_fee numeric(5,2) NOT NULL DEFAULT 7.49,
  credit_5x_fee numeric(5,2) NOT NULL DEFAULT 8.49,
  credit_6x_fee numeric(5,2) NOT NULL DEFAULT 9.49,
  credit_7x_fee numeric(5,2) NOT NULL DEFAULT 10.49,
  credit_8x_fee numeric(5,2) NOT NULL DEFAULT 11.49,
  credit_9x_fee numeric(5,2) NOT NULL DEFAULT 12.49,
  credit_10x_fee numeric(5,2) NOT NULL DEFAULT 13.49,
  credit_11x_fee numeric(5,2) NOT NULL DEFAULT 14.49,
  credit_12x_fee numeric(5,2) NOT NULL DEFAULT 15.49
);

-- Habilitar RLS
ALTER TABLE public.platform_financial_settings ENABLE ROW LEVEL SECURITY;

-- Permitir leitura pública para alunos/professores/anon
CREATE POLICY "Allow read access to anyone"
  ON public.platform_financial_settings FOR SELECT
  USING (true);

-- Inserir registro inicial padrão se não houver nenhum
INSERT INTO public.platform_financial_settings (
  id,
  pix_flat_fee,
  credit_1x_fee, credit_2x_fee, credit_3x_fee, credit_4x_fee, credit_5x_fee, credit_6x_fee,
  credit_7x_fee, credit_8x_fee, credit_9x_fee, credit_10x_fee, credit_11x_fee, credit_12x_fee
)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  149,
  3.99, 5.49, 6.49, 7.49, 8.49, 9.49,
  10.49, 11.49, 12.49, 13.49, 14.49, 15.49
)
ON CONFLICT (id) DO NOTHING;

