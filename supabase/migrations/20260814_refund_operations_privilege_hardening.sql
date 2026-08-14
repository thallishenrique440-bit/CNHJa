-- ============================================================================
-- FASE 3.1.20.8B — HARDENING CONTROLADO DE PRIVILÉGIOS DE OBJETO (DML)
-- Tabelas Alvo: refund_operations, refund_operation_items, refund_operation_events
--
-- Objetivo:
-- 1. Revogar explicitamente privilégios excessivos concedidos pelas regras de
--    DEFAULT PRIVILEGES do schema public para as roles anon, authenticated,
--    service_role e PUBLIC.
-- 2. Conceder estritamente os privilégios DML necessários ao service_role
--    conforme o Princípio do Menor Privilégio (Principle of Least Privilege).
-- 3. Preservar o owner (postgres) e o isolamento RLS sem alterar estruturas DDL.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABELA: public.refund_operations
-- Contrato do Repositório: SELECT, INSERT, UPDATE
-- Não utiliza: DELETE, TRUNCATE, REFERENCES, TRIGGER
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.refund_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.refund_operations TO service_role;

-- ----------------------------------------------------------------------------
-- 2. TABELA: public.refund_operation_items
-- Contrato do Repositório: SELECT, INSERT (itens imutáveis pós-criação)
-- Não utiliza: UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.refund_operation_items FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.refund_operation_items TO service_role;

-- ----------------------------------------------------------------------------
-- 3. TABELA: public.refund_operation_events
-- Contrato do Repositório: SELECT, INSERT (log de auditoria append-only)
-- Não utiliza: UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.refund_operation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.refund_operation_events TO service_role;
