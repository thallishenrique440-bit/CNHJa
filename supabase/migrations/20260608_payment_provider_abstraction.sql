-- Migration: Payment Provider Abstraction
-- Created: 2026-06-08
-- Phase: D.1 (CNHJÁ - Stripe to Asaas Prep)

-- 1. Profiles: Genéricamente associado a um cliente de provedor de pagamentos
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_customer_id text;

-- 2. Instructors: Vinculação de subconta/carteira de provedor genérico
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_account_id text, -- ID da conta/subconta genérica
ADD COLUMN IF NOT EXISTS provider_wallet_id text,  -- ID adicional para carteiras (ex: Asaas Wallet ID)
ADD COLUMN IF NOT EXISTS provider_onboarding_completed boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS provider_status text DEFAULT 'pending'; -- Status cadastral/onboarding

-- 3. Appointments: Vinculação de transação com provedor genérico
ALTER TABLE public.appointments
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_payment_id text; -- ID do pagamento/cobrança no provedor

-- 4. Transactions: Rastreabilidade financeira multiprovedor
ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_payment_id text,
ADD COLUMN IF NOT EXISTS provider_transfer_id text,
ADD COLUMN IF NOT EXISTS provider_payout_id text;

-- 5. Índices de Idempotência e Performance para a camada de abstração genérica
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_provider_type_appointment 
ON public.transactions (provider_payment_id, type, appointment_id) 
WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_provider_payout_id 
ON public.transactions (provider_payout_id);
