-- =============================================================================
-- P-1.20.1B — M1: realinhar claim_refund_operation com a maquina de estados
--
-- PROBLEMA CORRIGIDO
--   1. A funcao NAO gravava `status = 'PENDING'`: deixava a linha em REQUESTED
--      com dono e lease. O Core entao emitia uma transicao separada para PENDING
--      usando a versao capturada ANTES do claim -- versao ja obsoleta. O CAS nao
--      casava e todo cancelamento pago morria com
--      "Refund operation claim is owned by another worker".
--   2. O predicado `AND version = 1` tornava a funcao utilizavel UMA UNICA VEZ
--      na vida da linha (version tem DEFAULT 1 e o claim incrementa). Qualquer
--      operacao liberada por um reaper ficava impossivel de re-claimar, ou seja,
--      o dinheiro que ela representa ficava congelado por construcao.
--
-- NOTA IMPORTANTE
--   O codigo da P-1.20.1B NAO depende mais desta funcao: RefundOperationRepository
--   .claim() usa um unico UPDATE CAS atomico. Esta migration existe para que a
--   funcao deixe de ser uma armadilha para qualquer chamador futuro, e para que
--   as duas implementacoes tenham semantica identica.
--
-- NAO APLICADA. Revisar antes de executar.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_refund_operation(
  p_operation_id uuid,
  p_owner_id text,
  p_lease_until timestamp with time zone
)
RETURNS SETOF public.refund_operations
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
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
     SET status      = 'PENDING',
         owner_id    = p_owner_id,
         lease_until = p_lease_until,
         sent_at     = COALESCE(sent_at, pg_catalog.now()),
         attempt     = attempt + 1,
         version     = version + 1,
         updated_at  = pg_catalog.now()
   WHERE id = p_operation_id
     AND status = 'REQUESTED'
     AND owner_id IS NULL
  RETURNING *;
END;
$function$;

COMMENT ON FUNCTION public.claim_refund_operation(uuid, text, timestamptz) IS
  'P-1.20.1B: o claim E a transicao REQUESTED -> PENDING. Sem o literal version = 1, '
  'para que uma operacao liberada possa ser re-claimada.';
