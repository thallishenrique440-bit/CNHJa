-- Migration: Add Settlement transaction types to public.transactions type check constraint
ALTER TABLE public.transactions 
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE public.transactions 
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'lesson_payment', 
    'tip', 
    'refund', 
    'platform_fee', 
    'transfer_in', 
    'payout', 
    'adjustment', 
    'webhook_event',
    'settlement_credit',
    'settlement_refund',
    'settlement_chargeback'
  ));

