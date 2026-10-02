-- =============================================================================
-- FASE 0 — notification_config: remover segredo sem uso e fechar privilegios
-- =============================================================================
--
-- STATUS: APLICADA EM PRODUCAO E VALIDADA.
-- DATA DA APLICACAO: 2026-10-02.
-- PROJETO SUPABASE: ohftsqsxymtrclnpadam.
-- REGISTRO NO HISTORICO: 20261002184534.
-- COMMIT DO SQL ORIGINAL: f73c4a1.
-- VALIDACAO POS-APLICACAO: CONCLUIDA COM SUCESSO.
--
-- IMPORTANTE:
--   Esta migration ja foi aplicada em producao. Nao executar novamente.
--   O SQL abaixo e mantido para fins de historico, auditoria e rastreabilidade.
--
-- PROBLEMA (confirmado em producao em 2026-10-02, sem leitura do valor)
--   1. `public.notification_config` guardava uma linha `service_role_key` com a
--      chave secreta do projeto em texto puro (41 caracteres, `sb_secret_...`).
--   2. `anon` e `authenticated` tinham TODOS os privilegios de tabela (SELECT,
--      INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER).
--   3. A unica barreira era o RLS ativo sem nenhuma policy. Uma policy
--      permissiva criada no futuro, ou o RLS desativado, tornaria a chave
--      legivel com a chave publica do aplicativo.
--
-- DEPENDENCIAS VERIFICADAS
--   - Banco: so `invoke_edge_function_cron` e `invoke_vercel_cron` leem a
--     tabela, e apenas as chaves `edge_function_url` / `app_base_url`. Ambas
--     sao SECURITY DEFINER (nao dependem de privilegio de anon/authenticated).
--     Nenhuma funcao, trigger, view ou job le a linha `service_role_key`
--     (a leitura foi movida para o Vault em 20260711).
--   - Codigo: `NotificationService` grava `edge_function_url` e
--     `sync-payment-status` le `app_base_url`, ambos com a service role, que
--     ignora RLS e mantem seus privilegios.
--   - O Vault ja contem `service_role_key` e `cron_secret`.
--
-- O QUE FOI FEITO
--   1. A verificacao de dependencias nao encontrou funcao do banco que ainda
--      referencie `notification_config` e `service_role_key` simultaneamente.
--   2. A linha `service_role_key` foi removida da tabela.
--   3. Todos os privilegios de PUBLIC, anon e authenticated foram revogados
--      na tabela.
--
-- O QUE NAO FOI FEITO
--   A chave nao foi rotacionada (acao manual, no painel do Supabase).
--   O Vault, o RLS, as demais linhas e os privilegios de postgres/service_role
--   nao foram alterados.
--
-- VALIDACAO POS-APLICACAO
--   - A linha `service_role_key` nao existe mais na tabela.
--   - Permanecem as linhas `app_base_url` e `edge_function_url`.
--   - Os privilegios de anon e authenticated foram revogados.
--   - O RLS continua habilitado, com zero policies.
--   - A migration consta no historico do Supabase.
--   - Os cinco cron jobs permanecem ativos.
--   - Os ciclos posteriores observados dos servicos retornaram sucesso
--     (HTTP 200), sem timeout ou erro nas respostas verificadas.
--   - Nenhum valor de credencial foi lido ou exibido durante a validacao.
--
-- OBSERVACAO SOBRE A ESTRUTURA
--   `service_role_key` nao era uma coluna da tabela. Era uma linha armazenada
--   nas colunas `key` e `value`. A migration removeu essa linha, sem alterar
--   a estrutura da tabela.
--
-- EXECUCAO REPETIDA
--   O DELETE e os REVOKE sao idempotentes em seus efeitos. Entretanto, como
--   esta migration ja foi aplicada e registrada em producao, nao deve ser
--   executada novamente.
--
-- ROLLBACK
--   Os privilegios poderiam ser devolvidos com GRANT (nao recomendado).
--   A linha removida NAO deve ser recriada: o segredo pertence ao Vault.
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