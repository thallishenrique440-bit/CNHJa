-- =============================================================================
-- FASE 1 — payment_exceptions: registro de pagamento sem reserva valida
-- =============================================================================
--
-- PROPOSTA. NAO APLICADA. Aplicacao somente com autorizacao do proprietario.
--
-- PROBLEMA
--   Um pagamento que chega para uma reserva expirada, cancelada, rejeitada ou
--   inexistente so' gerava uma linha de log no webhook ("Necessaria analise
--   manual"). Nada ficava registrado para acompanhamento.
--
-- O QUE FAZ
--   Cria UMA tabela nova, `public.payment_exceptions`, com:
--     - uma linha por pagamento do provedor: UNIQUE (exception_type,
--       provider_payment_id). E' o que garante "exatamente uma ocorrencia";
--     - os fatos do pagamento, o estado da reserva na deteccao, a origem da
--       deteccao e os campos de resolucao (para o futuro painel ADMCNHJa);
--     - RLS ativo, sem policies, e nenhum privilegio para anon/authenticated:
--       so' a service role (backend) le e escreve.
--
-- O QUE NAO FAZ
--   Nao altera nenhuma tabela, funcao, trigger, policy ou job existente. Nao
--   cria chave estrangeira: a ocorrencia precisa poder ser registrada mesmo
--   sem reserva, sem grupo e sem aula, e nao pode ser apagada em cascata.
--   Nao le nem escreve dados existentes.
--
-- EXECUCAO REPETIDA
--   Idempotente (IF NOT EXISTS; REVOKE/GRANT sem efeito na segunda vez).
--
-- ROLLBACK (so' enquanto a tabela estiver vazia ou os dados forem descartaveis)
--   DROP TABLE IF EXISTS public.payment_exceptions;
--   Antes do rollback, publicar a versao anterior do webhook e da conciliacao:
--   o codigo da Fase 1 falha (HTTP 500 no webhook) se a tabela nao existir.
--
-- ORDEM DE ATIVACAO
--   1. Aplicar esta migration.  2. Publicar webhook (Vercel) e
--   sync-payment-status. O codigo novo NAO pode ir antes da tabela.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payment_exceptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificacao
  exception_type          text NOT NULL
    CONSTRAINT payment_exceptions_type_check
    CHECK (exception_type IN ('payment_without_valid_booking')),
  provider                text NOT NULL DEFAULT 'asaas',
  provider_payment_id     text NOT NULL,
  installment_number      integer,

  -- Vinculos (todos opcionais e SEM chave estrangeira)
  group_id                text,
  appointment_ids         uuid[] NOT NULL DEFAULT '{}',
  student_id              uuid,
  instructor_id           uuid,

  -- Valores (centavos)
  amount_cents            integer,
  net_amount_cents        integer,
  currency                text NOT NULL DEFAULT 'BRL',
  billing_type            text,

  -- Estado do pagamento no provedor. `provider_payment_status` guarda o estado
  -- ORIGINAL (ex.: CONFIRMED, RECEIVED). `provider_payment_phase` e' a leitura
  -- do CNHJa: authorized (cartao autorizado, NAO liquidado) ou received.
  provider_payment_status text NOT NULL,
  provider_payment_phase  text NOT NULL
    CONSTRAINT payment_exceptions_phase_check
    CHECK (provider_payment_phase IN ('other', 'authorized', 'received')),
  received_at             timestamptz,

  -- Reserva no momento da deteccao
  booking_state           text NOT NULL
    CONSTRAINT payment_exceptions_booking_state_check
    CHECK (booking_state IN ('no_group', 'not_found', 'expired', 'cancelled', 'rejected', 'mixed_invalid', 'partially_invalid')),
  booking_snapshot        jsonb NOT NULL DEFAULT '[]'::jsonb,
  split_snapshot          jsonb,

  -- Origem
  detected_by             text NOT NULL
    CONSTRAINT payment_exceptions_detected_by_check
    CHECK (detected_by IN ('webhook', 'reconciliation')),
  detected_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  source_event_id         text,

  -- Acompanhamento e resolucao (preenchidos pelo ADMCNHJa, no futuro)
  status                  text NOT NULL DEFAULT 'open'
    CONSTRAINT payment_exceptions_status_check
    CHECK (status IN ('open', 'resolved')),
  resolution              text,
  resolution_notes        text,
  resolved_by             uuid,
  resolved_at             timestamptz,

  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Uma ocorrencia por pagamento do provedor.
  CONSTRAINT payment_exceptions_unique_payment UNIQUE (exception_type, provider_payment_id),

  -- Recebido exige data de recebimento; resolvido exige data e resultado.
  CONSTRAINT payment_exceptions_received_check
    CHECK (provider_payment_phase <> 'received' OR received_at IS NOT NULL),
  CONSTRAINT payment_exceptions_resolved_check
    CHECK (status <> 'resolved' OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);

COMMENT ON TABLE public.payment_exceptions IS
  'Fase 1: pagamento recebido sem reserva valida. Uma linha por pagamento do provedor. Gestao futura pelo ADMCNHJa. Nenhuma automacao estorna, confirma aula ou apaga registros a partir desta tabela.';

-- Fila de trabalho: ocorrencias abertas, das mais recentes para as mais antigas.
CREATE INDEX IF NOT EXISTS idx_payment_exceptions_status_detected
  ON public.payment_exceptions (status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_exceptions_group
  ON public.payment_exceptions (group_id)
  WHERE group_id IS NOT NULL;

-- Seguranca: dado financeiro interno. RLS ativo SEM policies e nenhum
-- privilegio para os papeis de cliente. A service role ignora RLS.
ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;

-- Privilegios EXPLICITOS. No Supabase, tabela nova em `public` recebe por
-- padrao TODOS os privilegios para anon, authenticated e service_role
-- (default privileges). Por isso o REVOKE inclui a service_role: sem ele ela
-- manteria DELETE e TRUNCATE. A ordem importa: primeiro retira tudo, depois
-- devolve so' o necessario. Nenhum codigo apaga ocorrencias.
REVOKE ALL ON TABLE public.payment_exceptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_exceptions TO service_role;

-- =============================================================================
-- VERIFICACAO — DEPOIS DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- a) Tabela, RLS e ausencia de policies
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.payment_exceptions'::regclass;
-- SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payment_exceptions';
--
-- -- b) Privilegios: anon/authenticated nao podem aparecer; service_role
-- --    somente INSERT, SELECT, UPDATE (sem DELETE, TRUNCATE, REFERENCES, TRIGGER)
-- SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'payment_exceptions'
--  GROUP BY grantee;
--
-- -- c) Restricao de unicidade
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.payment_exceptions'::regclass ORDER BY conname;
--
-- -- d) Ocorrencias abertas (uso manual ate' existir o ADMCNHJa)
-- SELECT id, provider_payment_id, provider_payment_status, booking_state,
--        amount_cents, detected_by, detected_at
--   FROM public.payment_exceptions
--  WHERE status = 'open' ORDER BY detected_at DESC;
-- =============================================================================
