-- ==============================================================================
-- MIGRATION: ETAPA 1 - EVENT LEDGER BASELINE FOR TRANSACTIONS TABLE (REVISED)
-- ==============================================================================
-- Preserves existing transactions table while extending it to serve as the 
-- immutable Event Ledger for webhook auditability, idempotency, and state tracking.

-- 1. Add updated_at column to public.transactions
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. Relax NOT NULL constraints on public.transactions for type = 'webhook_event'
ALTER TABLE public.transactions
  ALTER COLUMN student_id DROP NOT NULL,
  ALTER COLUMN instructor_id DROP NOT NULL,
  ALTER COLUMN amount DROP NOT NULL,
  ALTER COLUMN gross_amount DROP NOT NULL,
  ALTER COLUMN platform_fee DROP NOT NULL,
  ALTER COLUMN net_amount DROP NOT NULL,
  ALTER COLUMN event_date DROP NOT NULL;

-- 3. Preserve Financial Transaction Integrity via CHECK constraint
-- Enforces that non-webhook_event records MUST still maintain NOT NULL values for financial fields.
DO $$
BEGIN
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS check_financial_transaction_not_null;
    ALTER TABLE public.transactions ADD CONSTRAINT check_financial_transaction_not_null
        CHECK (
            type = 'webhook_event' OR (
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
    WHEN others THEN NULL;
END $$;

-- 4. Expand transaction type check constraint to include 'webhook_event'
DO $$
BEGIN
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
        CHECK (type IN ('lesson_payment', 'tip', 'refund', 'platform_fee', 'transfer_in', 'payout', 'adjustment', 'webhook_event'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 5. Add Event Ledger Audit & Idempotency Columns
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS provider text DEFAULT 'asaas',
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS receipt_status text DEFAULT 'RECEIVED',
  ADD COLUMN IF NOT EXISTS processing_status text DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb,
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_error text,
  ADD COLUMN IF NOT EXISTS processor_version text DEFAULT '1.0.0';

-- 6. Check constraints for receipt_status and processing_status
DO $$
BEGIN
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_receipt_status_check;
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_receipt_status_check
        CHECK (receipt_status IN ('RECEIVED', 'REJECTED'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_processing_status_check;
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_processing_status_check
        CHECK (processing_status IN ('PENDING', 'PROCESSED', 'FAILED', 'IGNORED'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 7. Indexes and Unique Constraints for Idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_provider_event_id 
ON public.transactions (provider, provider_event_id) 
WHERE type = 'webhook_event' AND provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key 
ON public.transactions (idempotency_key) 
WHERE type = 'webhook_event' AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_payload_hash 
ON public.transactions (payload_hash) 
WHERE payload_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_processing_status 
ON public.transactions (processing_status);

CREATE INDEX IF NOT EXISTS idx_transactions_receipt_status 
ON public.transactions (receipt_status);
