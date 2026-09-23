-- =============================================================================
-- P-1.20.1B — M2: no maximo UMA operacao de refund nao-terminal por pagamento
--
-- MOTIVO
--   As barreiras de idempotencia existentes sao:
--     (a) UNIQUE (provider, operation_key)      -- mesma requisicao nao duplica
--     (b) claim atomico                          -- um unico worker envia
--     (c) getRetainedAmountCents                 -- teto cumulativo em centavos
--     (d) UNIQUE (provider, provider_refund_id)  -- mesmo refund nao registra 2x
--   Nenhuma delas impede DUAS operacoes DIFERENTES (escopos diferentes geram
--   chaves diferentes) em voo ao mesmo tempo sobre o mesmo pagamento. O teto (c)
--   limita o valor, mas nao a concorrencia.
--
-- ESTADOS NAO-TERMINAIS: REQUESTED, PENDING, UNKNOWN.
--   COMPLETED, PARTIALLY_COMPLETED, DENIED e CONFLICT sao terminais e podem
--   coexistir livremente (historico).
--
-- ATENCAO ANTES DE APLICAR
--   Verificar que nao existem hoje dois nao-terminais para o mesmo pagamento:
--     SELECT provider, provider_payment_id, count(*)
--       FROM public.refund_operations
--      WHERE status IN ('REQUESTED','PENDING','UNKNOWN')
--      GROUP BY 1,2 HAVING count(*) > 1;
--   Em 2026-09-23 esta consulta retornava zero linhas (as duas operacoes
--   existentes sao de pagamentos distintos).
--
-- NAO APLICADA. Revisar antes de executar.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_refund_per_payment
  ON public.refund_operations (provider, provider_payment_id)
  WHERE status IN ('REQUESTED', 'PENDING', 'UNKNOWN');

COMMENT ON INDEX public.idx_unique_active_refund_per_payment IS
  'P-1.20.1B: impede duas operacoes de refund em voo para o mesmo pagamento.';
