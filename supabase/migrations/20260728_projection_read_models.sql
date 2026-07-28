-- ==============================================================================
-- MIGRATION: PROJECTION READ MODELS FOR CQRS FINANCIAL ARCHITECTURE (ETAPA 7.1 HARDENING)
-- ==============================================================================
-- Creates read model projection tables:
-- 1. instructor_financial_projections
-- 2. platform_financial_projections
-- 3. cash_flow_projections
--
-- Strict CQRS Read Models: Owned exclusively by Projection Service.

-- 1. Table: instructor_financial_projections
CREATE TABLE IF NOT EXISTS public.instructor_financial_projections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  instructor_id UUID NOT NULL UNIQUE REFERENCES public.instructors(id) ON DELETE CASCADE,
  future_receivables INTEGER NOT NULL DEFAULT 0, -- In cents
  pending_release INTEGER NOT NULL DEFAULT 0,    -- In cents
  settled_available INTEGER NOT NULL DEFAULT 0,  -- In cents
  total_gross INTEGER NOT NULL DEFAULT 0,        -- In cents
  total_platform_fee INTEGER NOT NULL DEFAULT 0, -- In cents
  total_net INTEGER NOT NULL DEFAULT 0,         -- In cents
  total_refunds INTEGER NOT NULL DEFAULT 0,      -- In cents
  total_chargebacks INTEGER NOT NULL DEFAULT 0,  -- In cents
  total_overdue INTEGER NOT NULL DEFAULT 0,      -- In cents
  projection_version INTEGER NOT NULL DEFAULT 1,
  last_processed_event_id TEXT,
  last_processed_settlement_id TEXT,
  rebuild_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Table: platform_financial_projections
CREATE TABLE IF NOT EXISTS public.platform_financial_projections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  platform_key TEXT NOT NULL UNIQUE DEFAULT 'GLOBAL',
  gmv INTEGER NOT NULL DEFAULT 0,                 -- Gross Merchandise Value in cents
  total_revenue INTEGER NOT NULL DEFAULT 0,       -- Platform fees in cents
  total_fee_collected INTEGER NOT NULL DEFAULT 0,  -- Provider fees in cents
  total_instructor_payouts INTEGER NOT NULL DEFAULT 0,
  total_refunds INTEGER NOT NULL DEFAULT 0,
  total_chargebacks INTEGER NOT NULL DEFAULT 0,
  projection_version INTEGER NOT NULL DEFAULT 1,
  last_processed_event_id TEXT,
  last_processed_settlement_id TEXT,
  rebuild_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Table: cash_flow_projections
CREATE TABLE IF NOT EXISTS public.cash_flow_projections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('INSTRUCTOR', 'PLATFORM')),
  entity_id TEXT NOT NULL,
  projection_date DATE NOT NULL,
  expected_inflow INTEGER NOT NULL DEFAULT 0,  -- In cents
  expected_outflow INTEGER NOT NULL DEFAULT 0, -- In cents
  settled_inflow INTEGER NOT NULL DEFAULT 0,   -- In cents
  settled_outflow INTEGER NOT NULL DEFAULT 0,  -- In cents
  projection_version INTEGER NOT NULL DEFAULT 1,
  last_processed_event_id TEXT,
  last_processed_settlement_id TEXT,
  rebuild_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_cash_flow_entity_date UNIQUE (entity_type, entity_id, projection_date)
);

-- Indexes for Fast Read Model Access (O(1) & Range Queries)
CREATE INDEX IF NOT EXISTS idx_instructor_projections_instructor_id 
ON public.instructor_financial_projections (instructor_id);

CREATE INDEX IF NOT EXISTS idx_platform_projections_key 
ON public.platform_financial_projections (platform_key);

CREATE INDEX IF NOT EXISTS idx_cash_flow_entity_date 
ON public.cash_flow_projections (entity_type, entity_id, projection_date);

-- Row Level Security (RLS)
ALTER TABLE public.instructor_financial_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_financial_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_flow_projections ENABLE ROW LEVEL SECURITY;

-- Select Policies (Hardened RLS)
DROP POLICY IF EXISTS "Instructors can view their own financial projection" ON public.instructor_financial_projections;
CREATE POLICY "Instructors can view their own financial projection"
ON public.instructor_financial_projections FOR SELECT
USING (auth.uid() = instructor_id OR (auth.jwt() ->> 'role') = 'service_role');

DROP POLICY IF EXISTS "Service role and admins can view platform projections" ON public.platform_financial_projections;
CREATE POLICY "Service role and admins can view platform projections"
ON public.platform_financial_projections FOR SELECT
USING (
  (auth.jwt() ->> 'role') = 'service_role' OR 
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'superuser'))
);

DROP POLICY IF EXISTS "Users can view relevant cash flow projections" ON public.cash_flow_projections;
CREATE POLICY "Users can view relevant cash flow projections"
ON public.cash_flow_projections FOR SELECT
USING (
  (entity_type = 'INSTRUCTOR' AND auth.uid()::text = entity_id) OR
  ((auth.jwt() ->> 'role') = 'service_role' OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'superuser')))
);

-- Grants
GRANT ALL ON public.instructor_financial_projections TO authenticated, service_role;
GRANT ALL ON public.platform_financial_projections TO authenticated, service_role;
GRANT ALL ON public.cash_flow_projections TO authenticated, service_role;
