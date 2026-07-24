-- ==============================================================================
-- MIGRATION: ADDITIVE FINANCIAL ARCHITECTURE FOR ASAAS INSTALLMENTS
-- ==============================================================================
-- Creates payment_installments (Financial Schedule) and payment_settlements (Cash Flow)
-- Preserves existing transactions table as Commercial Contract / Competência.

-- 1. Table: payment_installments (Cronograma Financeiro das Parcelas)
CREATE TABLE IF NOT EXISTS public.payment_installments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_payment_id TEXT NOT NULL,
  installment_number INTEGER NOT NULL DEFAULT 1,
  total_installments INTEGER NOT NULL DEFAULT 1,
  gross_amount INTEGER NOT NULL,      -- Value in Cents
  net_amount INTEGER NOT NULL,        -- Value in Cents (after platform fee)
  fee_amount INTEGER NOT NULL DEFAULT 0, -- Provider transaction fee in Cents
  platform_fee INTEGER NOT NULL DEFAULT 0, -- Platform fee in Cents
  instructor_amount INTEGER NOT NULL DEFAULT 0, -- Net to instructor in Cents
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'REFUNDED', 'CANCELLED', 'FAILED')),
  due_date TIMESTAMPTZ,
  payment_date TIMESTAMPTZ,
  group_id TEXT,
  appointment_id UUID REFERENCES public.appointments(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  student_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  instructor_id UUID REFERENCES public.instructors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_provider_payment_installment UNIQUE (provider_payment_id, installment_number)
);

-- 2. Table: payment_settlements (Fluxo de Caixa Real / Liquidações)
CREATE TABLE IF NOT EXISTS public.payment_settlements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  installment_id UUID REFERENCES public.payment_installments(id) ON DELETE CASCADE,
  provider_payment_id TEXT NOT NULL,
  provider_settlement_id TEXT,
  settlement_type TEXT NOT NULL DEFAULT 'PAYMENT' CHECK (settlement_type IN ('PAYMENT', 'REFUND', 'CHARGEBACK')),
  gross_amount INTEGER NOT NULL,      -- Value in Cents
  net_amount INTEGER NOT NULL,        -- Value in Cents
  fee_amount INTEGER NOT NULL DEFAULT 0, -- Value in Cents
  platform_fee INTEGER NOT NULL DEFAULT 0, -- Value in Cents
  instructor_amount INTEGER NOT NULL DEFAULT 0, -- Value in Cents
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_settlement_idempotency UNIQUE (provider_payment_id, settlement_type, provider_settlement_id)
);

-- 3. Indexes for Performance & Idempotency
CREATE INDEX IF NOT EXISTS idx_payment_installments_provider_payment_id 
ON public.payment_installments (provider_payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_installments_group_id 
ON public.payment_installments (group_id);

CREATE INDEX IF NOT EXISTS idx_payment_installments_instructor_status 
ON public.payment_installments (instructor_id, status);

CREATE INDEX IF NOT EXISTS idx_payment_installments_due_date 
ON public.payment_installments (due_date);

CREATE INDEX IF NOT EXISTS idx_payment_installments_appointment_id 
ON public.payment_installments (appointment_id);

CREATE INDEX IF NOT EXISTS idx_payment_installments_transaction_id 
ON public.payment_installments (transaction_id);

CREATE INDEX IF NOT EXISTS idx_payment_settlements_installment_id 
ON public.payment_settlements (installment_id);

CREATE INDEX IF NOT EXISTS idx_payment_settlements_provider_payment_id 
ON public.payment_settlements (provider_payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_settlements_settled_at 
ON public.payment_settlements (settled_at);

-- 4. Row Level Security (RLS)
ALTER TABLE public.payment_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_settlements ENABLE ROW LEVEL SECURITY;

-- Select Policies
CREATE POLICY "Users can view their own payment installments"
ON public.payment_installments FOR SELECT
USING (auth.uid() = student_id OR auth.uid() = instructor_id);

CREATE POLICY "Users can view their own payment settlements"
ON public.payment_settlements FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.payment_installments pi 
    WHERE pi.id = payment_settlements.installment_id 
    AND (pi.student_id = auth.uid() OR pi.instructor_id = auth.uid())
  )
);

-- Grants
GRANT ALL ON public.payment_installments TO authenticated, service_role;
GRANT ALL ON public.payment_settlements TO authenticated, service_role;
