-- ROLLBACK AP-03/AP-11 — definicao de public.check_appointments_update_security()
-- capturada em producao (ohftsqsxymtrclnpadam) via pg_get_functiondef ANTES da
-- aplicacao da migration 20260924_ap03_ap11_appointments_status_transition_guard,
-- em 2026-09-24. oid=86082, prosecdef=true, proconfig={search_path=public}.
-- Estado de referencia pre-aplicacao: 8 policies em appointments
-- (md5 bfe0d21509519620985764245566aef6), acl md5 46875263bd6598c4534e2df7d1847a5e,
-- status: cancelling=3, completed=19, cancelled=3, expired=3.
-- Para reverter: executar este arquivo. O trigger aponta pelo OID; nao recriar.

CREATE OR REPLACE FUNCTION public.check_appointments_update_security()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN

  IF auth.role() = 'authenticated' THEN

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

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status NOT IN ('cancelled', 'completed', 'no_show', 'pending_approval') THEN
        RAISE EXCEPTION
          'Alteracao de status nao autorizada ou invalida via client: %',
          NEW.status;
      END IF;
    END IF;

  END IF;

  RETURN NEW;

END;
$function$;
