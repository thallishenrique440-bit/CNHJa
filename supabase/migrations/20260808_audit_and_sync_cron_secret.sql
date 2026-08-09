-- Migration: 20260808_audit_and_sync_cron_secret.sql
-- Purpose: Audit and synchronize Vault cron_secret safely without exposing plain text secrets
-- Author: AI Coding Agent
-- Date: 2026-08-08

-- 1. Helper function to audit the cron_secret stored in Vault (fingerprint only)
CREATE OR REPLACE FUNCTION public.audit_cron_secret()
RETURNS TABLE (
  secret_exists boolean,
  secret_length int,
  sha256_hash text,
  whitespace_count int,
  cr_count int,
  lf_count int,
  has_quotes boolean,
  has_bearer boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;
  
  IF v_secret IS NULL THEN
    RETURN QUERY SELECT false, 0, ''::text, 0, 0, 0, false, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT 
    true,
    length(v_secret),
    encode(digest(v_secret, 'sha256'), 'hex'),
    (length(v_secret) - length(replace(v_secret, ' ', '')))::int,
    (length(v_secret) - length(replace(v_secret, chr(13), '')))::int,
    (length(v_secret) - length(replace(v_secret, chr(10), '')))::int,
    (v_secret LIKE '"%' OR v_secret LIKE '%"' OR v_secret LIKE '''%' OR v_secret LIKE '%'''),
    (v_secret ILIKE 'Bearer %');
END;
$$;

-- 2. Helper function to safely update the Vault cron_secret token
CREATE OR REPLACE FUNCTION public.sync_cron_secret(p_new_secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_clean_secret text;
  v_count int;
BEGIN
  v_clean_secret := p_new_secret;
  
  SELECT COUNT(*) INTO v_count FROM vault.secrets WHERE name = 'cron_secret';
  
  IF v_count > 0 THEN
    UPDATE vault.secrets 
    SET secret = v_clean_secret 
    WHERE name = 'cron_secret';
  ELSE
    PERFORM vault.create_secret(v_clean_secret, 'cron_secret');
  END IF;

  RETURN true;
END;
$$;

-- 3. Helper function to inspect pg_net responses for cron calls
CREATE OR REPLACE FUNCTION public.get_last_cron_http_response()
RETURNS TABLE (
  id bigint,
  status_code int,
  content text,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, extensions
AS $$
BEGIN
  RETURN QUERY 
  SELECT r.id, r.status_code, r.content, r.created_at
  FROM net._http_response r
  ORDER BY r.id DESC
  LIMIT 5;
END;
$$;

-- Revoke all permissions from untrusted roles
REVOKE EXECUTE ON FUNCTION public.audit_cron_secret() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_cron_secret(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_last_cron_http_response() FROM PUBLIC, anon, authenticated;

-- Grant execution permissions exclusively to administrative roles
GRANT EXECUTE ON FUNCTION public.audit_cron_secret() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.sync_cron_secret(text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_last_cron_http_response() TO postgres, service_role;
