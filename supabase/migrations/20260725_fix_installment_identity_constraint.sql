-- Migration: 20260725_fix_installment_identity_constraint.sql
-- Description: Fix installment logical identity by switching constraint to (group_id, installment_number)
--              and consolidating existing duplicate records.

-- 1. Consolidate and clean up duplicate payment_installments records for the same (group_id, installment_number)
DO $$
DECLARE
    rec RECORD;
    keeper_id UUID;
    dup_id UUID;
BEGIN
    FOR rec IN
        SELECT group_id, installment_number, COUNT(*) as cnt
        FROM public.payment_installments
        WHERE group_id IS NOT NULL
        GROUP BY group_id, installment_number
        HAVING COUNT(*) > 1
    LOOP
        -- Pick keeper ID: prefer 'PAID' status, then most recently updated/created
        SELECT id INTO keeper_id
        FROM public.payment_installments
        WHERE group_id = rec.group_id AND installment_number = rec.installment_number
        ORDER BY CASE WHEN status = 'PAID' THEN 1 WHEN status = 'REFUNDED' THEN 2 ELSE 3 END ASC,
                 updated_at DESC,
                 created_at DESC
        LIMIT 1;

        -- For all other duplicates for this group_id & installment_number:
        FOR dup_id IN
            SELECT id
            FROM public.payment_installments
            WHERE group_id = rec.group_id 
              AND installment_number = rec.installment_number 
              AND id <> keeper_id
        LOOP
            -- Re-link any payment_settlements pointing to the duplicate row
            UPDATE public.payment_settlements
            SET installment_id = keeper_id
            WHERE installment_id = dup_id;

            -- Delete the duplicate row
            DELETE FROM public.payment_installments
            WHERE id = dup_id;
        END LOOP;
    END LOOP;
END $$;

-- 2. Drop legacy constraint/index if present
ALTER TABLE public.payment_installments 
DROP CONSTRAINT IF EXISTS payment_installments_provider_payment_id_installment_num_key;

DROP INDEX IF EXISTS public.payment_installments_provider_payment_id_installment_num_idx;

-- 3. Add new UNIQUE constraint on (group_id, installment_number)
ALTER TABLE public.payment_installments
ADD CONSTRAINT payment_installments_group_installment_key 
UNIQUE (group_id, installment_number);

-- 4. Ensure performance index on provider_payment_id remains active
CREATE INDEX IF NOT EXISTS idx_payment_installments_provider_payment_id
ON public.payment_installments (provider_payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_installments_group_id
ON public.payment_installments (group_id);
