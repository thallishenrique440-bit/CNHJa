-- Migration: Fix handle_new_user to match current profiles schema
-- Created on: 2026-07-18
-- This migration updates handle_new_user to copy terms fields and avoid non-existent privacy fields.

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
