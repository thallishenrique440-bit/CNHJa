-- Migration: Update payment_installments status check constraint for Etapa 5
ALTER TABLE public.payment_installments 
  DROP CONSTRAINT IF EXISTS payment_installments_status_check;

ALTER TABLE public.payment_installments 
  ADD CONSTRAINT payment_installments_status_check 
  CHECK (status IN (
    'PENDING', 
    'AUTHORIZED', 
    'CONFIRMED', 
    'RECEIVED', 
    'OVERDUE', 
    'REFUNDED', 
    'CHARGEBACK', 
    'CANCELLED', 
    'FAILED'
  ));
