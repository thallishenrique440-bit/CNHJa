-- =============================================================================
-- P-1.20.5 FASE F (1/2) — TIPOS DE NOTIFICACAO ESPECIFICOS DE REMARCACAO
--
-- EVIDENCIA COLETADA NA AUDITORIA:
--
--  1. `notifications_type_check` hoje admite exatamente 9 valores:
--     booking_request, booking_accepted, booking_rejected, booking_cancelled,
--     booking_expired, payment_released, reminder, system, tip.
--
--  2. NENHUM consumidor do projeto ramifica por `notification.type`.
--     Varredura em pages/ components/ src/ hooks/ retornou um unico ponto
--     (pages/student/Lessons.tsx:766) e ele apenas ESCREVE o valor.
--     O enum lib/NotificationService.ts declara
--       BOOKING_RESCHEDULED = 'booking_request'
--     justamente porque nao havia tipo proprio.
--
--  3. O trigger `tr_enqueue_notification` -> `enqueue_notification` e'
--     TYPE-AGNOSTICO: enfileira qualquer linha inserida em `notifications`.
--     Logo, criar tipos novos nao quebra a cadeia FCM.
--
--  4. Os dois indices de idempotencia sao
--       (type, user_id, group_id)      WHERE group_id IS NOT NULL
--       (type, user_id, appointment_id) WHERE group_id IS NULL
--                                         AND appointment_id IS NOT NULL
--     e `create_unified_notification` CAPTURA `unique_violation` INTERNAMENTE
--     devolvendo o id existente SEM INSERIR. Foi exatamente isso que engoliu a
--     notificacao da P-1.20.4 em producao.
--
-- CONSEQUENCIA: remarcacao e' um evento REPETIVEL sobre a MESMA aula. Se os
-- tipos novos ficassem sob os indices atuais, a segunda remarcacao da mesma
-- aula seria deduplicada silenciosamente — exatamente o que este bloco proibe.
-- Por isso os 4 tipos novos sao EXCLUIDOS dos dois indices.
--
-- A idempotencia dessas operacoes passa a ser garantida NA ORIGEM: as RPCs de
-- remarcacao so notificam quando realmente transicionam estado (FOR UPDATE +
-- checagem de status), e devolvem no_op sem notificar caso contrario.
--
-- Nenhum tipo existente muda de comportamento: os dois indices continuam
-- valendo integralmente para os 9 tipos atuais.
--
-- NAO APLICADA. Revisar antes de executar.
-- =============================================================================

BEGIN;

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    -- 9 tipos preexistentes, preservados na ordem original
    'booking_request'::text,
    'booking_accepted'::text,
    'booking_rejected'::text,
    'booking_cancelled'::text,
    'booking_expired'::text,
    'payment_released'::text,
    'reminder'::text,
    'system'::text,
    'tip'::text,
    -- P-1.20.5
    'reschedule_requested'::text,  -- proposta criada (aluno <=24h ou instrutor)
    'reschedule_accepted'::text,   -- proposta aceita pela contraparte
    'reschedule_rejected'::text,   -- proposta recusada pela contraparte
    'reschedule_applied'::text     -- remarcacao direta aplicada (aluno >24h, P-1.20.4)
  ]));

-- Recria os dois indices isentando os tipos de remarcacao.
DROP INDEX IF EXISTS public.idx_notifications_idempotency_group;

CREATE UNIQUE INDEX idx_notifications_idempotency_group
  ON public.notifications USING btree (type, user_id, group_id)
  WHERE group_id IS NOT NULL
    AND type <> ALL (ARRAY[
      'reschedule_requested'::text,
      'reschedule_accepted'::text,
      'reschedule_rejected'::text,
      'reschedule_applied'::text
    ]);

DROP INDEX IF EXISTS public.idx_notifications_idempotency_appointment;

CREATE UNIQUE INDEX idx_notifications_idempotency_appointment
  ON public.notifications USING btree (type, user_id, appointment_id)
  WHERE group_id IS NULL
    AND appointment_id IS NOT NULL
    AND type <> ALL (ARRAY[
      'reschedule_requested'::text,
      'reschedule_accepted'::text,
      'reschedule_rejected'::text,
      'reschedule_applied'::text
    ]);

COMMIT;
