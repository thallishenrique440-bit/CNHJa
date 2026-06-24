-- Migration: Create Platform Financial Settings and expansion fields
-- Created: 2026-06-24
-- Phase: CNHJÁ Definitive Fee Architecture

CREATE TABLE IF NOT EXISTS public.platform_financial_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  pix_flat_fee integer NOT NULL DEFAULT 149, -- em centavos (ex: R$1,49)
  credit_1x_fee numeric(5,2) NOT NULL DEFAULT 3.99, -- em percentual (ex: 3.99%)
  credit_2x_fee numeric(5,2) NOT NULL DEFAULT 5.49,
  credit_3x_fee numeric(5,2) NOT NULL DEFAULT 6.49,
  credit_4x_fee numeric(5,2) NOT NULL DEFAULT 7.49,
  credit_5x_fee numeric(5,2) NOT NULL DEFAULT 8.49,
  credit_6x_fee numeric(5,2) NOT NULL DEFAULT 9.49,
  credit_7x_fee numeric(5,2) NOT NULL DEFAULT 10.49,
  credit_8x_fee numeric(5,2) NOT NULL DEFAULT 11.49,
  credit_9x_fee numeric(5,2) NOT NULL DEFAULT 12.49,
  credit_10x_fee numeric(5,2) NOT NULL DEFAULT 13.49,
  credit_11x_fee numeric(5,2) NOT NULL DEFAULT 14.49,
  credit_12x_fee numeric(5,2) NOT NULL DEFAULT 15.49,
  pix_last_sync timestamptz,
  credit_1x_last_sync timestamptz,
  fee_source text NOT NULL DEFAULT 'manual' CONSTRAINT check_fee_source CHECK (fee_source IN ('manual', 'asaas'))
);

-- Enable RLS
ALTER TABLE public.platform_financial_settings ENABLE ROW LEVEL SECURITY;

-- Drop policy if exists
DROP POLICY IF EXISTS "Allow read access to anyone" ON public.platform_financial_settings;

-- Allow read access to anyone
CREATE POLICY "Allow read access to anyone"
  ON public.platform_financial_settings FOR SELECT
  USING (true);

-- Insert default settings row if it doesn't exist
INSERT INTO public.platform_financial_settings (
  id,
  pix_flat_fee,
  credit_1x_fee, credit_2x_fee, credit_3x_fee, credit_4x_fee, credit_5x_fee, credit_6x_fee,
  credit_7x_fee, credit_8x_fee, credit_9x_fee, credit_10x_fee, credit_11x_fee, credit_12x_fee,
  fee_source
)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  149,
  3.99, 5.49, 6.49, 7.49, 8.49, 9.49,
  10.49, 11.49, 12.49, 13.49, 14.49, 15.49,
  'manual'
)
ON CONFLICT (id) DO NOTHING;
