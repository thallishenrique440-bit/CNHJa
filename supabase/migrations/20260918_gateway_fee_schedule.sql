-- P-1.16A — Modelo de tarifa de gateway versionado por vigencia.
--
-- ADITIVA E NAO DESTRUTIVA:
--   * nenhum DROP, TRUNCATE ou DELETE;
--   * platform_financial_settings permanece intacta (legado, nao mais usada
--     pelo checkout — sera avaliada na P-1.16B);
--   * colunas novas em payment_installments sao NULLABLE: linhas historicas
--     ficam exatamente como estao e nao sao recalculadas.

BEGIN;

-- 1. Schedule de tarifas -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_fee_schedule (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text        NOT NULL DEFAULT 'asaas',
  method            text        NOT NULL,
  installment_from  integer     NOT NULL DEFAULT 1,
  installment_to    integer     NOT NULL DEFAULT 1,
  -- pontos percentuais sobre service_price. Ex.: 2.99
  percent           numeric(7,4) NOT NULL DEFAULT 0,
  -- componente fixo por cobranca, em centavos. Ex.: 49
  fixed_cents       integer     NOT NULL DEFAULT 0,
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz NULL,
  source            text        NOT NULL DEFAULT 'manual',
  notes             text        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gateway_fee_schedule_method_check
    CHECK (method = ANY (ARRAY['PIX'::text, 'CREDIT_CARD'::text, 'BOLETO'::text])),
  CONSTRAINT gateway_fee_schedule_source_check
    CHECK (source = ANY (ARRAY['manual'::text, 'asaas'::text, 'builtin'::text])),
  CONSTRAINT gateway_fee_schedule_range_check
    CHECK (installment_from >= 1 AND installment_to >= installment_from),
  CONSTRAINT gateway_fee_schedule_percent_check CHECK (percent >= 0),
  CONSTRAINT gateway_fee_schedule_fixed_check   CHECK (fixed_cents >= 0),
  CONSTRAINT gateway_fee_schedule_validity_check
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE public.gateway_fee_schedule IS
  'P-1.16A. Tarifa do gateway por (provider, method, faixa de parcelas, vigencia). gateway_fee_expected = round(service_price*percent/100 + fixed_cents). NUNCA altera appointments.price.';

-- Uma unica faixa vigente por (provider, method, intervalo de parcelas).
-- Versionar = fechar a anterior com effective_to e inserir a nova.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_fee_schedule_active_uniq
  ON public.gateway_fee_schedule (provider, method, installment_from, installment_to)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS gateway_fee_schedule_lookup_idx
  ON public.gateway_fee_schedule (provider, method, installment_from, installment_to, effective_from DESC);

-- RLS: espelha platform_financial_settings (leitura publica, escrita apenas
-- por service_role, que ignora RLS). O checkout do browser precisa ler.
ALTER TABLE public.gateway_fee_schedule ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'gateway_fee_schedule'
      AND p.polname = 'Allow read access to anyone'
  ) THEN
    CREATE POLICY "Allow read access to anyone"
      ON public.gateway_fee_schedule FOR SELECT USING (true);
  END IF;
END $$;

GRANT SELECT ON public.gateway_fee_schedule TO anon, authenticated;

-- 2. Congelamento da tarifa por compra --------------------------------------
-- Alem do valor em centavos (fee_amount, ja existente), guardar o que permite
-- reconstruir a tarifa depois: alicota, fixo, metodo, parcelas e vigencia.
ALTER TABLE public.payment_installments
  ADD COLUMN IF NOT EXISTS fee_rule_id         uuid NULL REFERENCES public.gateway_fee_schedule(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fee_percent_applied numeric(7,4) NULL,
  ADD COLUMN IF NOT EXISTS fee_fixed_cents     integer NULL,
  ADD COLUMN IF NOT EXISTS fee_source          text NULL,
  ADD COLUMN IF NOT EXISTS fee_effective_from  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS payment_method      text NULL;

COMMENT ON COLUMN public.payment_installments.fee_percent_applied IS
  'P-1.16A. Alicota vigente no momento da compra. NULL em linhas anteriores a P-1.16A — nao recalcular.';

-- 3. Seed das faixas observadas no painel Asaas Sandbox (2026-09-18) ---------
-- Idempotente: so insere o que ainda nao existe como faixa vigente.
INSERT INTO public.gateway_fee_schedule
  (provider, method, installment_from, installment_to, percent, fixed_cents, effective_from, source, notes)
SELECT v.provider, v.method, v.i_from, v.i_to, v.percent, v.fixed, now(), 'manual', v.notes
FROM (VALUES
  ('asaas', 'PIX',          1,  1,  0.00::numeric, 199, 'P-1.16A seed: painel Asaas Sandbox, R$1,99 por cobranca recebida'),
  ('asaas', 'CREDIT_CARD',  1,  1,  2.99::numeric,  49, 'P-1.16A seed: painel Asaas Sandbox, 1x'),
  ('asaas', 'CREDIT_CARD',  2,  6,  3.49::numeric,  49, 'P-1.16A seed: painel Asaas Sandbox, 2x-6x'),
  ('asaas', 'CREDIT_CARD',  7, 12,  3.99::numeric,  49, 'P-1.16A seed: painel Asaas Sandbox, 7x-12x'),
  ('asaas', 'CREDIT_CARD', 13, 21,  4.29::numeric,  49, 'P-1.16A seed: painel Asaas Sandbox, 13x-21x')
) AS v(provider, method, i_from, i_to, percent, fixed, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.gateway_fee_schedule g
  WHERE g.provider = v.provider
    AND g.method = v.method
    AND g.installment_from = v.i_from
    AND g.installment_to = v.i_to
    AND g.effective_to IS NULL
);

COMMIT;
