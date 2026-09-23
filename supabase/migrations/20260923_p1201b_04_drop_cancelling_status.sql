-- =============================================================================
-- P-1.20.1B — M4: remover 'cancelling' do CHECK de appointments.status
--
-- MOTIVO
--   'cancelling' era um lock distribuido improvisado, gravado ANTES da chamada
--   ao gateway, sem dono, sem lease e sem release. Consequencias medidas:
--     - nao esta excluido de idx_unique_active_slot nem de
--       idx_unique_student_active_slot -> o horario ficava bloqueado para
--       sempre, para instrutor E aluno;
--     - nao existe em LessonDBStatus nem em getDerivedStatus -> a UI renderizava
--       um status sem badge e sem acoes;
--     - nao esta na whitelist do trigger de seguranca -> nem o cliente podia
--       reverter.
--   A P-1.20.1B removeu as DUAS escritas (lib/payments e o gerado _shared) e os
--   TRES consumidores (asaas-webhook, sync-payment-status x2). O lock financeiro
--   passou a ser exclusivamente refund_operations.
--
-- *** BLOQUEIO CONHECIDO ***
--   Existem hoje DUAS linhas de teste em status='cancelling'. Esta migration
--   FALHARA enquanto elas existirem. Aplicar APOS a limpeza final do banco.
--   Nenhum backfill foi escrito de proposito: esses dados sao descartaveis e a
--   fase P-1.20.1B foi explicitamente proibida de toca-los.
--
--   Consulta de verificacao antes de aplicar:
--     SELECT id, date, start_time, status FROM public.appointments
--      WHERE status = 'cancelling';
--
-- APOS APLICAR: remover o membro 'cancelling' de src/types.ts (ja marcado
-- @deprecated) e atualizar supabase_schema.sql:257.
--
-- NAO APLICADA. Aplicar somente apos a limpeza do banco.
-- =============================================================================

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN (
    'pending',
    'scheduled',
    'confirmed',
    'in_progress',
    'completed',
    'cancelled',
    'blocked',
    'reserved',
    'failed',
    'pending_approval',
    'expired',
    'rejected',
    'no_show',
    'awaiting_payment'
  ));
