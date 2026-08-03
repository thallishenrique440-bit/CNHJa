-- Migration: Evolution of payment_settlements SSOT with Immutable Participant Snapshot
-- Description: Adds instructor_id, student_id, and appointment_id directly to public.payment_settlements
-- to make the SSOT self-contained for all settlement types (LESSON, TIP, REFUND, CHARGEBACK).

-- 1. Add Columns to public.payment_settlements
-- Note: appointment_id is strictly an optional historical snapshot (nullable) and can remain NULL when no operational lesson exists (e.g., TIPs, adjustments).
ALTER TABLE public.payment_settlements
ADD COLUMN IF NOT EXISTS instructor_id UUID REFERENCES public.instructors(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES public.appointments(id) ON DELETE SET NULL;

-- 2. Create Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_payment_settlements_instructor_id
ON public.payment_settlements (instructor_id);

CREATE INDEX IF NOT EXISTS idx_payment_settlements_student_id
ON public.payment_settlements (student_id);

CREATE INDEX IF NOT EXISTS idx_payment_settlements_appointment_id
ON public.payment_settlements (appointment_id);

-- 3. Update Row Level Security (RLS) Policy for direct owner access
-- TRANSITION NOTE: The EXISTS(...) fallback via payment_installments is preserved exclusively 
-- for backward compatibility during the transition phase. After Phase 2 completion, full backfill, 
-- and production validation, a future hardening migration may simplify this policy to directly check 
-- auth.uid() = instructor_id OR auth.uid() = student_id.
DROP POLICY IF EXISTS "Users can view their own payment settlements" ON public.payment_settlements;

CREATE POLICY "Users can view their own payment settlements"
ON public.payment_settlements FOR SELECT
USING (
  auth.uid() = instructor_id OR
  auth.uid() = student_id OR
  EXISTS (
    SELECT 1 FROM public.payment_installments pi 
    WHERE pi.id = payment_settlements.installment_id 
    AND (pi.student_id = auth.uid() OR pi.instructor_id = auth.uid())
  )
);

-- 4. Idempotent Backfill for Historical Settlements
-- Step 4.1: Backfill from payment_installments for settlements linked to an installment
UPDATE public.payment_settlements ps
SET 
  instructor_id = COALESCE(ps.instructor_id, pi.instructor_id),
  student_id = COALESCE(ps.student_id, pi.student_id),
  appointment_id = COALESCE(ps.appointment_id, pi.appointment_id)
FROM public.payment_installments pi
WHERE ps.installment_id = pi.id
  AND (ps.instructor_id IS NULL OR ps.student_id IS NULL OR ps.appointment_id IS NULL);

-- Step 4.2: Backfill from transactions for standalone settlements (e.g., TIPs where installment_id is NULL)
-- Uses a deterministic CTE with DISTINCT ON (provider_payment_id) ORDER BY provider_payment_id, created_at DESC
WITH deterministic_transactions AS (
  SELECT DISTINCT ON (provider_payment_id)
    provider_payment_id,
    instructor_id,
    student_id,
    appointment_id
  FROM public.transactions
  WHERE provider_payment_id IS NOT NULL
  ORDER BY
    provider_payment_id,
    created_at DESC
)
UPDATE public.payment_settlements ps
SET 
  instructor_id = COALESCE(ps.instructor_id, dt.instructor_id),
  student_id = COALESCE(ps.student_id, dt.student_id),
  appointment_id = COALESCE(ps.appointment_id, dt.appointment_id)
FROM deterministic_transactions dt
WHERE ps.installment_id IS NULL
  AND ps.provider_payment_id = dt.provider_payment_id
  AND (ps.instructor_id IS NULL OR ps.student_id IS NULL OR ps.appointment_id IS NULL);
