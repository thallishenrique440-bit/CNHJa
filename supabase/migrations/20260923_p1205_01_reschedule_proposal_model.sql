-- =============================================================================
-- P-1.20.5 FASE B — MODELO DE PROPOSTA DE REMARCACAO
--
-- A auditoria P-1.20.5 confirmou que `appointments` (25 colunas) possui apenas
-- `reschedule_requested_at` e `rescheduled_at`. Nao existe nenhuma estrutura
-- capaz de armazenar UM HORARIO PROPOSTO, nem quem propos, nem o estado da
-- proposta. Por isso o fluxo <=24h do aluno hoje so grava um timestamp e deixa
-- o instrutor escolher o horario sozinho.
--
-- DECISAO DE DESENHO: a proposta vive na PROPRIA LINHA do appointment.
--   - uma aula = no maximo UMA proposta (garantido estruturalmente, sem indice
--     auxiliar: nao existe linha onde caber uma segunda proposta pendente);
--   - a operacao e' naturalmente APPOINTMENT-LEVEL;
--   - nenhuma tabela nova, nenhuma FK nova, nenhum JOIN novo nos consumidores.
--
-- `reschedule_requested_at` NAO e' removido nem alterado aqui. Ele possui
-- consumidores vivos (InstructorAgenda.tsx e a propria RPC P-1.20.4) e sera
-- tratado em fase propria.
--
-- NEUTRALIDADE FINANCEIRA: nenhuma coluna financeira e' criada, alterada ou
-- referenciada.
--
-- NAO APLICADA. Revisar antes de executar.
-- =============================================================================

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS proposed_date        date,
  ADD COLUMN IF NOT EXISTS proposed_start_time  time without time zone,
  ADD COLUMN IF NOT EXISTS proposed_end_time    time without time zone,
  ADD COLUMN IF NOT EXISTS proposed_by          uuid,
  ADD COLUMN IF NOT EXISTS proposal_status      text,
  ADD COLUMN IF NOT EXISTS proposal_created_at  timestamptz,
  ADD COLUMN IF NOT EXISTS proposal_resolved_at timestamptz;

-- 1. Dominio fechado de estados.
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_proposal_status_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_proposal_status_check
  CHECK (proposal_status IS NULL
         OR proposal_status IN ('pending','accepted','rejected','cancelled'));

-- 2. Coerencia do bloco de proposta:
--    ou TUDO nulo (sem proposta), ou o bloco completo preenchido;
--    'pending' exige resolved_at nulo; qualquer estado terminal exige resolved_at.
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_proposal_coherent_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_proposal_coherent_check
  CHECK (
    (
      proposal_status      IS NULL
      AND proposed_date        IS NULL
      AND proposed_start_time  IS NULL
      AND proposed_end_time    IS NULL
      AND proposed_by          IS NULL
      AND proposal_created_at  IS NULL
      AND proposal_resolved_at IS NULL
    )
    OR
    (
      proposal_status      IS NOT NULL
      AND proposed_date        IS NOT NULL
      AND proposed_start_time  IS NOT NULL
      AND proposed_end_time    IS NOT NULL
      AND proposed_by          IS NOT NULL
      AND proposal_created_at  IS NOT NULL
      AND (
        (proposal_status =  'pending' AND proposal_resolved_at IS NULL)
        OR
        (proposal_status <> 'pending' AND proposal_resolved_at IS NOT NULL)
      )
    )
  );

-- 3. Quem propoe so pode ser uma das duas partes da propria aula.
--    Fecha a porta para um terceiro autenticado gravar uma proposta.
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_proposed_by_is_party_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_proposed_by_is_party_check
  CHECK (proposed_by IS NULL
         OR proposed_by = student_id
         OR proposed_by = instructor_id);

-- 4. Proposta precisa apontar para um intervalo valido.
ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_proposed_interval_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_proposed_interval_check
  CHECK (proposed_start_time IS NULL
         OR proposed_end_time IS NULL
         OR proposed_end_time > proposed_start_time);

-- 5. Indice de leitura: as duas telas listam propostas pendentes por parte.
--    NAO e' unico: a unicidade de "uma proposta por aula" ja vem do desenho
--    (uma linha de appointment carrega no maximo um bloco de proposta).
CREATE INDEX IF NOT EXISTS idx_appointments_proposal_pending
  ON public.appointments (instructor_id, student_id, proposal_created_at)
  WHERE proposal_status = 'pending';

COMMENT ON COLUMN public.appointments.proposed_date IS
  'P-1.20.5: data proposta para esta aula. O horario vigente continua em date/start_time ate o aceite.';
COMMENT ON COLUMN public.appointments.proposed_by IS
  'P-1.20.5: quem criou a proposta (student_id ou instructor_id desta mesma linha).';
COMMENT ON COLUMN public.appointments.proposal_status IS
  'P-1.20.5: pending | accepted | rejected | cancelled. NULL = sem proposta.';
