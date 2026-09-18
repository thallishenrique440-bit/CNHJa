-- P-1.16B — Agendamento diario da sincronizacao de tarifas Asaas.
--
-- REUSO DE INFRAESTRUTURA: nenhum agendador novo. Usa o pg_cron ja existente
-- (mesmo mecanismo de check-expired-bookings, notification-worker e
-- auto-complete-lessons), o pg_net ja instalado e o CRON_SECRET que ja vive no
-- Supabase Vault. A unica peca nova e' uma funcao irma de
-- invoke_edge_function_cron, porque o alvo aqui e' um handler Vercel
-- (api/sync-fees.ts) e nao uma Edge Function.
--
-- ADITIVA: nenhum DROP de tabela, TRUNCATE ou DELETE de dado financeiro.
-- Nao altera RLS existente.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Funcao de invocacao do app Vercel
-- ---------------------------------------------------------------------------
-- Espelha invoke_edge_function_cron: le a base URL de notification_config e o
-- CRON_SECRET do Vault. NENHUM segredo e' escrito nesta migration.
--
-- Sem app_base_url configurado a funcao FALHA EXPLICITAMENTE. E' proposital:
-- este POST carrega o CRON_SECRET no header, entao nao pode haver dominio
-- "chutado" como fallback.
CREATE OR REPLACE FUNCTION public.invoke_vercel_cron(p_path text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_base_url   text;
  v_secret     text;
  v_request_id bigint;
BEGIN
  SELECT value INTO v_base_url
  FROM public.notification_config
  WHERE key = 'app_base_url';

  IF v_base_url IS NULL OR v_base_url = '' OR v_base_url LIKE '%<%' THEN
    RAISE EXCEPTION
      'app_base_url nao configurado em public.notification_config. '
      'Configure a URL de producao do app antes de habilitar este cron: '
      'INSERT INTO public.notification_config (key, value) VALUES (''app_base_url'', ''https://SEU-DOMINIO'');';
  END IF;

  IF v_base_url NOT LIKE 'https://%' THEN
    RAISE EXCEPTION 'app_base_url deve usar https. Valor atual rejeitado.';
  END IF;

  v_base_url := rtrim(v_base_url, '/');

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'cron_secret';

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE EXCEPTION 'cron_secret nao encontrado no Supabase Vault';
  END IF;

  v_request_id := net.http_post(
    url     := v_base_url || '/' || ltrim(p_path, '/'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := '{}'::jsonb
  );

  RETURN v_request_id;
END;
$function$;

COMMENT ON FUNCTION public.invoke_vercel_cron(text) IS
  'P-1.16B. Invoca um handler do app Vercel a partir do pg_cron, com CRON_SECRET do Vault. Falha explicitamente se app_base_url nao estiver configurado.';

REVOKE ALL ON FUNCTION public.invoke_vercel_cron(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_vercel_cron(text) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Job diario, sem duplicar agendador
-- ---------------------------------------------------------------------------
-- 04:17 UTC = 01:17 BRT. Diario: tarifa comercial nao muda de hora em hora.
-- Minuto quebrado para nao concorrer com os jobs de minuto ja existentes.
DO $$
DECLARE
  v_existing int;
BEGIN
  -- Guarda anti-duplicacao: qualquer job que ja invoque sync-fees conta.
  SELECT count(*) INTO v_existing
  FROM cron.job
  WHERE jobname = 'sync-gateway-fees-job'
     OR command ILIKE '%sync-fees%';

  IF v_existing > 0 THEN
    RAISE NOTICE 'P-1.16B: ja existe agendador para sync-fees (% encontrado(s)). Nada foi criado.', v_existing;
  ELSE
    PERFORM cron.schedule(
      'sync-gateway-fees-job',
      '17 4 * * *',
      $cron$SELECT public.invoke_vercel_cron('api/sync-fees');$cron$
    );
    RAISE NOTICE 'P-1.16B: job sync-gateway-fees-job criado (diario, 04:17 UTC).';
  END IF;
END $$;

COMMIT;
