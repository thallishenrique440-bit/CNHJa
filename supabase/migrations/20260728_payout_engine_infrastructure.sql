-- ==============================================================================
-- MIGRATION: STAGE 8.1A - PAYOUT ENGINE DATABASE INFRASTRUCTURE (REVISED & HARDENED)
-- CNHJá Financial Architecture v1.0
-- ==============================================================================

-- 1. Create ENUMs for Payout Status, Payout Mode, and Provider Status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_status') THEN
        CREATE TYPE public.payout_status AS ENUM (
            'BLOCKED',
            'READY',
            'PENDING',
            'PROCESSING',
            'PAID',
            'FAILED',
            'CANCELLED'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_mode') THEN
        CREATE TYPE public.payout_mode AS ENUM (
            'SHADOW',
            'LIVE'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_provider_status') THEN
        CREATE TYPE public.payout_provider_status AS ENUM (
            'PENDING',
            'IN_TRANSIT',
            'DONE',
            'FAILED',
            'CANCELLED'
        );
    END IF;
END $$;

-- 2. Ensure transactions table constraint allows payout events with student_id IS NULL
DO $$
BEGIN
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS check_financial_transaction_not_null;
    ALTER TABLE public.transactions ADD CONSTRAINT check_financial_transaction_not_null
        CHECK (
            type IN ('payout', 'webhook_event') OR (
                student_id IS NOT NULL AND 
                instructor_id IS NOT NULL AND 
                amount IS NOT NULL AND 
                gross_amount IS NOT NULL AND 
                platform_fee IS NOT NULL AND 
                net_amount IS NOT NULL AND 
                event_date IS NOT NULL
            )
        );
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- 3. Ensure global unique index on idempotency_key for Event Ledger idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key_global 
ON public.transactions (idempotency_key) 
WHERE idempotency_key IS NOT NULL;

-- 4. Create payouts table with full financial breakdown
CREATE TABLE IF NOT EXISTS public.payouts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payout_key TEXT NOT NULL UNIQUE,
  instructor_id UUID NOT NULL REFERENCES public.instructors(id) ON DELETE RESTRICT,
  appointment_id UUID REFERENCES public.appointments(id) ON DELETE SET NULL,
  installment_id UUID REFERENCES public.payment_installments(id) ON DELETE SET NULL,
  settlement_id UUID REFERENCES public.payment_settlements(id) ON DELETE SET NULL,
  gross_amount INTEGER NOT NULL CHECK (gross_amount > 0),
  platform_fee INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
  net_amount INTEGER NOT NULL CHECK (net_amount > 0),
  amount INTEGER NOT NULL CHECK (amount > 0), -- Net payout amount alias
  status public.payout_status NOT NULL DEFAULT 'BLOCKED',
  payout_mode public.payout_mode NOT NULL DEFAULT 'SHADOW',
  provider_transfer_id TEXT,
  provider_status public.payout_provider_status,
  failure_reason TEXT,
  scheduled_for TIMESTAMPTZ DEFAULT now(),
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_payout_amount_equals_net CHECK (amount = net_amount)
);

-- 5. Indexes & Unique Constraints
CREATE INDEX IF NOT EXISTS idx_payouts_instructor_status 
ON public.payouts (instructor_id, status);

CREATE INDEX IF NOT EXISTS idx_payouts_status_scheduled 
ON public.payouts (status, scheduled_for);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_settlement_id 
ON public.payouts (settlement_id) 
WHERE settlement_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_provider_transfer_id 
ON public.payouts (provider_transfer_id) 
WHERE provider_transfer_id IS NOT NULL;

-- 6. Enable Row Level Security (RLS) & Strict Grants
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Instructors can view their own payouts" ON public.payouts;
CREATE POLICY "Instructors can view their own payouts"
ON public.payouts FOR SELECT
USING (
  auth.uid() = instructor_id OR 
  (auth.jwt() ->> 'role') = 'service_role' OR
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'superuser'))
);

DROP POLICY IF EXISTS "Service role can perform all operations on payouts" ON public.payouts;
CREATE POLICY "Service role can perform all operations on payouts"
ON public.payouts FOR ALL
USING ((auth.jwt() ->> 'role') = 'service_role')
WITH CHECK ((auth.jwt() ->> 'role') = 'service_role');

-- Strict Least-Privilege Grants
REVOKE ALL ON public.payouts FROM PUBLIC, authenticated, anon;
GRANT SELECT ON public.payouts TO authenticated;
GRANT ALL ON public.payouts TO service_role;

-- 7. Transactional RPC with Official State Machine Validation & Event Ledger Idempotency
CREATE OR REPLACE FUNCTION public.record_payout_and_ledger_event(
    p_payout_key TEXT,
    p_instructor_id UUID,
    p_appointment_id UUID DEFAULT NULL,
    p_installment_id UUID DEFAULT NULL,
    p_settlement_id UUID DEFAULT NULL,
    p_gross_amount INTEGER DEFAULT NULL,
    p_platform_fee INTEGER DEFAULT 0,
    p_net_amount INTEGER DEFAULT NULL,
    p_amount INTEGER DEFAULT NULL,
    p_status public.payout_status DEFAULT 'BLOCKED',
    p_payout_mode TEXT DEFAULT 'SHADOW',
    p_provider_transfer_id TEXT DEFAULT NULL,
    p_provider_status TEXT DEFAULT NULL,
    p_failure_reason TEXT DEFAULT NULL,
    p_executed_at TIMESTAMPTZ DEFAULT NULL,
    p_ledger_event_type TEXT DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL,
    p_provider_event_id TEXT DEFAULT NULL,
    p_raw_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing RECORD;
    v_payout RECORD;
    v_transaction_id UUID := NULL;
    v_gross INTEGER;
    v_fee INTEGER;
    v_net INTEGER;
    v_mode public.payout_mode;
    v_prov_status public.payout_provider_status;
BEGIN
    -- Financial values fallback calculation
    v_net := COALESCE(p_net_amount, p_amount);
    v_gross := COALESCE(p_gross_amount, v_net);
    v_fee := COALESCE(p_platform_fee, 0);

    IF v_net IS NULL OR v_net <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT: Net payout amount must be greater than zero.';
    END IF;

    -- Cast mode & provider status safely
    v_mode := COALESCE(p_payout_mode::public.payout_mode, 'SHADOW'::public.payout_mode);
    IF p_provider_status IS NOT NULL THEN
        v_prov_status := p_provider_status::public.payout_provider_status;
    ELSE
        v_prov_status := NULL;
    END IF;

    -- 1. Lock existing payout row for state machine validation
    SELECT * INTO v_existing FROM public.payouts WHERE payout_key = p_payout_key FOR UPDATE;

    IF FOUND THEN
        -- STATE MACHINE VALIDATION MATRIX:
        -- Final terminal states: PAID, CANCELLED cannot transition to any other status
        IF v_existing.status IN ('PAID', 'CANCELLED') AND v_existing.status <> p_status THEN
            RAISE EXCEPTION 'INVALID_STATE_TRANSITION: Payout % is in terminal state % and cannot transition to %',
                p_payout_key, v_existing.status, p_status;
        ELSIF v_existing.status = p_status THEN
            -- Same status update (Allowed metadata refresh)
            NULL;
        ELSIF v_existing.status = 'BLOCKED' AND p_status IN ('READY') THEN
            NULL;
        ELSIF v_existing.status = 'READY' AND p_status IN ('PROCESSING', 'BLOCKED', 'CANCELLED') THEN
            NULL;
        ELSIF v_existing.status = 'PENDING' AND p_status IN ('PROCESSING', 'CANCELLED') THEN
            NULL;
        ELSIF v_existing.status = 'PROCESSING' AND p_status IN ('PAID', 'FAILED') THEN
            NULL;
        ELSIF v_existing.status = 'FAILED' AND p_status IN ('READY', 'CANCELLED') THEN
            NULL;
        ELSE
            RAISE EXCEPTION 'INVALID_STATE_TRANSITION: Cannot transition payout % from % to %',
                p_payout_key, v_existing.status, p_status;
        END IF;

        -- Apply valid state transition & update metadata
        UPDATE public.payouts SET
            status = p_status,
            payout_mode = v_mode,
            provider_transfer_id = COALESCE(p_provider_transfer_id, payouts.provider_transfer_id),
            provider_status = COALESCE(v_prov_status, payouts.provider_status),
            failure_reason = p_failure_reason,
            executed_at = COALESCE(p_executed_at, payouts.executed_at),
            updated_at = now()
        WHERE payout_key = p_payout_key
        RETURNING * INTO v_payout;

    ELSE
        -- Initial Creation: status MUST be BLOCKED, PENDING, or READY
        IF p_status NOT IN ('BLOCKED', 'PENDING', 'READY') THEN
            RAISE EXCEPTION 'INVALID_INITIAL_STATE: Cannot create payout % with initial status %',
                p_payout_key, p_status;
        END IF;

        INSERT INTO public.payouts (
            payout_key,
            instructor_id,
            appointment_id,
            installment_id,
            settlement_id,
            gross_amount,
            platform_fee,
            net_amount,
            amount,
            status,
            payout_mode,
            provider_transfer_id,
            provider_status,
            failure_reason,
            executed_at,
            created_at,
            updated_at
        ) VALUES (
            p_payout_key,
            p_instructor_id,
            p_appointment_id,
            p_installment_id,
            p_settlement_id,
            v_gross,
            v_fee,
            v_net,
            v_net,
            p_status,
            v_mode,
            p_provider_transfer_id,
            v_prov_status,
            p_failure_reason,
            p_executed_at,
            now(),
            now()
        )
        RETURNING * INTO v_payout;
    END IF;

    -- 2. Insert Event Ledger entry into transactions atomically if requested
    IF p_ledger_event_type IS NOT NULL THEN
        INSERT INTO public.transactions (
            type,
            instructor_id,
            amount,
            gross_amount,
            platform_fee,
            net_amount,
            event_date,
            provider,
            provider_event_id,
            idempotency_key,
            receipt_status,
            processing_status,
            raw_payload,
            processed_at,
            processor_version
        ) VALUES (
            'payout',
            p_instructor_id,
            v_net,
            v_gross,
            v_fee,
            v_net,
            now(),
            'asaas',
            p_provider_event_id,
            p_idempotency_key,
            'RECEIVED',
            'PROCESSED',
            p_raw_payload,
            now(),
            '1.0.0'
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id INTO v_transaction_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'payout_id', v_payout.id,
        'payout_key', v_payout.payout_key,
        'status', v_payout.status,
        'transaction_id', v_transaction_id
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_payout_and_ledger_event FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.record_payout_and_ledger_event TO service_role;
