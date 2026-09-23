-- =============================================================================
-- P-1.20.1B — M3: invariante dono x status em refund_operations
--
-- REGRA
--   REQUESTED  <=>  owner_id IS NULL
--   Uma operacao so tem dono quando ja esta PENDING (ou num estado posterior,
--   onde o dono e' registro historico). O estado "REQUESTED com owner_id" foi
--   exatamente o que prendeu as duas operacoes do incidente P-1.20: com dono,
--   com lease vencido, sem `sent_at`, impossiveis de re-claimar.
--
--   Depois da P-1.20.1B o claim grava status e dono no MESMO UPDATE, entao esse
--   estado nao e' mais produzivel pelo codigo. Este CHECK garante o invariante
--   independentemente de revisao de codigo: e' a unica protecao que nao depende
--   de alguem ler o diff.
--
-- +-------------------------+-----------+------------+
-- | status                  | owner_id  | permitido  |
-- +-------------------------+-----------+------------+
-- | REQUESTED               | NULL      | sim        |
-- | REQUESTED               | <worker>  | NAO        |
-- | PENDING                 | <worker>  | sim        |
-- | COMPLETED/DENIED/...    | qualquer  | sim        |
-- +-------------------------+-----------+------------+
--
-- *** BLOQUEIO CONHECIDO ***
--   As DUAS operacoes de teste existentes hoje VIOLAM este CHECK
--   (status='REQUESTED' com owner_id preenchido). Esta migration FALHARA
--   enquanto elas existirem. Ela deve ser aplicada APOS a limpeza final do
--   banco, que ja esta prevista antes do lancamento. NENHUM backfill foi
--   escrito de proposito: esses dados sao descartaveis.
--
-- NAO APLICADA. Aplicar somente apos a limpeza do banco.
-- =============================================================================

ALTER TABLE public.refund_operations
  ADD CONSTRAINT refund_operations_owner_status_check
  CHECK ((status = 'REQUESTED') = (owner_id IS NULL))
  NOT VALID;

-- Depois de confirmar que nao ha linhas violando:
--   ALTER TABLE public.refund_operations
--     VALIDATE CONSTRAINT refund_operations_owner_status_check;
