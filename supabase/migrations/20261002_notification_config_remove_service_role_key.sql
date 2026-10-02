-- =============================================================================
-- FASE 0 — notification_config: remover segredo sem uso e fechar privilegios
-- =============================================================================
--
-- PROPOSTA. NAO APLICADA. Aplicacao somente com autorizacao do proprietario.
--
-- PROBLEMA (confirmado em producao em 2026-10-02, sem leitura do valor)
--   1. `public.notification_config` guarda uma linha `service_role_key` com a
--      chave secreta do projeto em texto puro (41 caracteres, `sb_secret_...`).
--   2. `anon` e `authenticated` tem TODOS os privilegios de tabela (SELECT,
--      INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER).
--   3. A unica barreira e' o RLS ativo sem nenhuma policy. Uma policy
--      permissiva criada no futuro, ou o RLS desativado, tornaria a chave
--      legivel com a chave publica do aplicativo.
--
-- DEPENDENCIAS VERIFICADAS
--   - Banco: so' `invoke_edge_function_cron` e `invoke_vercel_cron` leem a
--     tabela, e apenas as chaves `edge_function_url` / `app_base_url`. Ambas
--     sao SECURITY DEFINER (nao dependem de privilegio de anon/authenticated).
--     Nenhuma funcao, trigger, view ou job le a linha `service_role_key`
--     (a leitura foi movida para o Vault em 20260711).
--   - Codigo: `NotificationService` grava `edge_function_url` e
--     `sync-payment-status` le `app_base_url`, ambos com a service role, que
--     ignora RLS e mantem seus privilegios.
--   - O Vault ja' contem `service_role_key` e `cron_secret`.
--
-- O QUE FAZ
--   1. Aborta, sem alterar nada, se alguma funcao do banco ainda referenciar
--      `notification_config` e `service_role_key` ao mesmo tempo.
--   2. Remove a linha `service_role_key` da tabela.
--   3. Revoga todos os privilegios de PUBLIC, anon e authenticated na tabela.
--
-- O QUE NAO FAZ
--   Nao rotaciona a chave (acao manual, no painel do Supabase). Nao altera o
--   Vault, o RLS, as demais linhas, nem os privilegios de postgres/service_role.
--
-- EXECUCAO REPETIDA
--   Idempotente: DELETE sem linha e REVOKE sem privilegio nao tem efeito.
--
-- ROLLBACK
--   Os privilegios podem ser devolvidos com GRANT (nao recomendado). A linha
--   removida NAO deve ser recriada: o segredo pertence ao Vault.
-- =============================================================================

DO $$
DECLARE
  v_dependentes text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname, ', ')
    INTO v_dependentes
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'vault')
     AND p.prosrc ILIKE '%notification_config%'
     AND p.prosrc ILIKE '%service_role_key%';

  IF v_dependentes IS NOT NULL THEN
    RAISE EXCEPTION 'Abortado: funcoes ainda leem service_role_key de notification_config: %', v_dependentes;
  END IF;
END;
$$;

DELETE FROM public.notification_config WHERE key = 'service_role_key';

REVOKE ALL ON TABLE public.notification_config FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- VERIFICACAO — DEPOIS DE APLICAR (somente SELECT; nao le valores)
-- =============================================================================
--
-- -- a) A linha nao existe mais; as demais continuam
-- SELECT key FROM public.notification_config ORDER BY key;
--
-- -- b) Somente postgres e service_role tem privilegios
-- SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'notification_config'
--  GROUP BY grantee;
--
-- -- c) Os jobs do cron continuam respondendo
-- SELECT j.jobname, d.status, d.start_time
--   FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--  ORDER BY d.start_time DESC LIMIT 8;
-- =============================================================================
