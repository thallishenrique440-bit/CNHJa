-- Migration: Security Hardening (C1 - Hardening Transactions, C2 - Hardening Appointments)
-- Date: 2026-06-09

-- ==========================================
-- PATCH C1 — HARDENING DO LEDGER FINANCEIRO
-- ==========================================

-- Remove the permissive insert policy for authenticated students
DROP POLICY IF EXISTS "System/Students can create transactions" ON public.transactions;

-- Ensure that only service_role (and database triggers/functions running with admin auth) can insert new transactions.
-- No new INSERT policy for 'authenticated' role is created, blocking any client-side creation.


-- ==========================================
-- PATCH C2 — HARDENING DE APPOINTMENTS
-- ==========================================

-- 1. Create a security check function for appointments updates
CREATE OR REPLACE FUNCTION public.check_appointments_update_security()
RETURNS TRIGGER AS $$
BEGIN
  -- We ONLY enforce this check for non-service_role requests (authenticated/anon users via Client SDK)
  -- service_role automatically bypasses this if we check auth.role() = 'authenticated'
  IF auth.role() = 'authenticated' THEN
    
    -- Prevent alteration of sensitive financial and provider columns
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
      RAISE EXCEPTION 'Alteracao de payment_status nao permitida via client.';
    END IF;

    IF NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
      RAISE EXCEPTION 'Alteracao de payment_intent_id nao permitida via client.';
    END IF;

    IF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
      RAISE EXCEPTION 'Alteracao de provider_payment_id nao permitida via client.';
    END IF;

    IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id THEN
      RAISE EXCEPTION 'Alteracao de purchase_id nao permitida via client.';
    END IF;

    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
      RAISE EXCEPTION 'Alteracao de payment_id nao permitida via client.';
    END IF;

    IF NEW.price IS DISTINCT FROM OLD.price THEN
      RAISE EXCEPTION 'Alteracao de price nao permitida via client.';
    END IF;

    IF NEW.provider_name IS DISTINCT FROM OLD.provider_name THEN
      RAISE EXCEPTION 'Alteracao de provider_name nao permitida via client.';
    END IF;

    -- If status is changed, restrict to allowed client transitions (completed, cancelled, no_show, pending_approval)
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status NOT IN ('cancelled', 'completed', 'no_show', 'pending_approval') THEN
        RAISE EXCEPTION 'Alteracao de status nao autorizada ou invalida via client: %', NEW.status;
      END IF;
    END IF;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Bind the security check trigger to public.appointments
DROP TRIGGER IF EXISTS appointments_security_check_trigger ON public.appointments;

CREATE TRIGGER appointments_security_check_trigger
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_appointments_update_security();
