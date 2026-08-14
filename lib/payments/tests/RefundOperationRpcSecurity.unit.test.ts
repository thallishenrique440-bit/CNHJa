import { readFileSync } from 'node:fs';

const assert = (value: boolean, message: string) => {
  if (!value) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

const migration = readFileSync(new URL('../../../supabase/migrations/20260812_refund_operations_forensic.sql', import.meta.url), 'utf8');
assert(migration.includes('SECURITY INVOKER'), 'claim RPC uses caller privileges rather than owner privileges');
assert(!migration.includes('SECURITY DEFINER'), 'claim RPC has no definer-privilege escalation');
assert(migration.includes('SET search_path = pg_catalog, public'), 'claim RPC has a pinned search path');
assert(migration.includes('version = version + 1'), 'claim version increments inside the atomic update');
assert(migration.includes("AND status = 'REQUESTED'") && migration.includes('AND owner_id IS NULL') && migration.includes('AND version = 1'), 'claim RPC contains the expected CAS predicates');
assert(migration.includes('REVOKE ALL ON FUNCTION public.claim_refund_operation(uuid, text, timestamptz) FROM PUBLIC'), 'PUBLIC execute is revoked');
assert(migration.includes('FROM anon, authenticated'), 'client roles are explicitly revoked');
assert(migration.includes('GRANT EXECUTE ON FUNCTION public.claim_refund_operation(uuid, text, timestamptz) TO service_role'), 'only service_role receives execute');
assert(migration.includes('GRANT SELECT, UPDATE ON TABLE public.refund_operations TO service_role'), 'claim table privileges are explicit for service_role');
assert(migration.includes('ALTER TABLE public.refund_operations ENABLE ROW LEVEL SECURITY'), 'operation table enables RLS');
