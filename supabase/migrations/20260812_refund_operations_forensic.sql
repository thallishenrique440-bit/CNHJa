-- FASE 3.1.16.1 — COPY-ONLY SCHEMA SPECIFICATION
-- This file is not executed by this phase.
CREATE TABLE IF NOT EXISTS public.refund_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL,
  provider text NOT NULL DEFAULT 'asaas',
  provider_payment_id text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('REQUESTED','PENDING','UNKNOWN','COMPLETED','PARTIALLY_COMPLETED','DENIED','CONFLICT')),
  requested_amount_cents bigint NOT NULL CHECK (requested_amount_cents >= 0),
  completed_amount_cents bigint CHECK (completed_amount_cents IS NULL OR completed_amount_cents >= 0),
  currency text NOT NULL DEFAULT 'BRL',
  version integer NOT NULL DEFAULT 1,
  owner_id text,
  lease_until timestamptz,
  attempt integer NOT NULL DEFAULT 0,
  provider_refund_id text,
  sent_at timestamptz,
  unknown_since timestamptz,
  acknowledged_at timestamptz,
  completed_at timestamptz,
  denial_reason text,
  receipt_url text,
  raw_payload_hash text,
  source_event_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, operation_key),
  UNIQUE (provider, provider_refund_id)
);

CREATE TABLE IF NOT EXISTS public.refund_operation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_operation_id uuid NOT NULL REFERENCES public.refund_operations(id),
  appointment_id uuid,
  requested_amount_cents bigint NOT NULL CHECK (requested_amount_cents >= 0),
  completed_amount_cents bigint,
  split_amount_cents bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (refund_operation_id, appointment_id)
);

CREATE TABLE IF NOT EXISTS public.refund_operation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_operation_id uuid NOT NULL REFERENCES public.refund_operations(id),
  provider_event_id text,
  source text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  evidence_hash text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_operation_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_refund_operations_claim ON public.refund_operations(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_refund_operations_payment ON public.refund_operations(provider_payment_id, status);

-- Financial operation records are backend-only. service_role bypasses RLS;
-- no policy is deliberately granted to anon/authenticated roles.
ALTER TABLE public.refund_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_operation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_operation_events ENABLE ROW LEVEL SECURITY;

-- Atomic claim contract. The function runs with its caller's privileges: only
-- service_role receives the narrowly required table and execute permissions.
CREATE OR REPLACE FUNCTION public.claim_refund_operation(
  p_operation_id uuid,
  p_owner_id text,
  p_lease_until timestamptz
)
RETURNS SETOF public.refund_operations
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'claim operation id is required';
  END IF;
  IF p_owner_id IS NULL OR length(pg_catalog.btrim(p_owner_id)) = 0 OR length(p_owner_id) > 200 THEN
    RAISE EXCEPTION 'invalid claim owner';
  END IF;
  IF p_lease_until IS NULL OR p_lease_until <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'claim lease must be in the future';
  END IF;

  RETURN QUERY
  UPDATE public.refund_operations
     SET owner_id = p_owner_id,
         lease_until = p_lease_until,
         version = version + 1,
         updated_at = pg_catalog.now()
   WHERE id = p_operation_id
     AND status = 'REQUESTED'
     AND owner_id IS NULL
     AND version = 1
  RETURNING *;
END;
$$;

-- The claim boundary is backend-only. Do not expose ownership mutation to
-- anon/authenticated clients through PostgREST RPC.
GRANT SELECT, INSERT, UPDATE ON TABLE public.refund_operations TO service_role;
GRANT SELECT, INSERT ON TABLE public.refund_operation_items TO service_role;
GRANT SELECT, INSERT ON TABLE public.refund_operation_events TO service_role;
REVOKE ALL ON FUNCTION public.claim_refund_operation(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_refund_operation(uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_operation(uuid, text, timestamptz) TO service_role;
