-- Migration: Fix Push Notification API Key Header in notify_new_notification()
-- Date: 2026-08-08
-- Purpose: Add explicit 'apikey' header to pg_net.http_post alongside 'Authorization: Bearer' 
--          to prevent Supabase API Gateway 401 Unregistered API Key errors.

CREATE OR REPLACE FUNCTION public.notify_new_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_edge_function_url TEXT;
  v_service_role_key TEXT;
  v_payload JSONB;
  v_url_found BOOLEAN;
  v_key_found BOOLEAN;
  v_state TEXT;
  v_msg TEXT;
  v_context TEXT;
  v_request_id BIGINT;
  -- Forensic diagnostics local variables
  v_key_status TEXT;
  v_key_len INT;
  v_final_url TEXT;
  v_url_count INT;
  v_key_count INT;
  v_dispatch_started TIMESTAMP WITH TIME ZONE;
  v_dispatch_finished TIMESTAMP WITH TIME ZONE;
  v_elapsed_ms DOUBLE PRECISION;
BEGIN
  -- ==========================================
  -- [CP-01] ENTRY: Started trigger
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-01] ENTRY: Started trigger for notification_id: %', NEW.id;
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-01', 'ENTRY: Started trigger', 'SUCCESS', jsonb_build_object('notification_id', NEW.id));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-01: %', SQLERRM;
  END;

  -- Retrieve configurations from the secure notification_config table
  SELECT value INTO v_edge_function_url FROM public.notification_config WHERE key = 'edge_function_url';
  v_url_found := FOUND;

  -- ==========================================
  -- [CP-02] SELECT_URL: Completed
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-02] SELECT_URL: Found = %, value = %', v_url_found, v_edge_function_url;
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-02', 'SELECT_URL executed', 'SUCCESS', jsonb_build_object('found', v_url_found, 'edge_function_url', v_edge_function_url));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-02: %', SQLERRM;
  END;

  SELECT COUNT(*) INTO v_url_count FROM public.notification_config WHERE key = 'edge_function_url';

  -- ==========================================
  -- [CP-02A] CHECK_URL_DUPLICITY: Detailed count audit
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-02A] CHECK_URL_DUPLICITY: count = %, found = %, value = %', v_url_count, v_url_found, v_edge_function_url;
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-02A', 'CHECK_URL_DUPLICITY: Count of edge_function_url keys', 'SUCCESS', jsonb_build_object('count', v_url_count, 'found', v_url_found, 'value', v_edge_function_url));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-02A: %', SQLERRM;
  END;

  -- Sourced exclusively from Supabase Vault (vault.decrypted_secrets)
  SELECT decrypted_secret INTO v_service_role_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  v_key_found := FOUND;

  v_key_len := COALESCE(length(v_service_role_key), 0);
  IF v_service_role_key IS NULL THEN
    v_key_status := 'NULL';
  ELSIF v_service_role_key = '' THEN
    v_key_status := 'VAZIA';
  ELSE
    v_key_status := 'PRESENTE';
  END IF;

  -- ==========================================
  -- [CP-03] SELECT_KEY: Completed
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-03] SELECT_KEY: Found = %, status = %, length = %', v_key_found, v_key_status, v_key_len;
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-03', 'SELECT_KEY executed', 'SUCCESS', jsonb_build_object('found', v_key_found, 'key_status', v_key_status, 'key_length', v_key_len));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-03: %', SQLERRM;
  END;

  SELECT COUNT(*) INTO v_key_count FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  -- ==========================================
  -- [CP-03A] CHECK_KEY_DUPLICITY: Detailed count audit
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-03A] CHECK_KEY_DUPLICITY: count = %, found = %, status = %, length = %', v_key_count, v_key_found, v_key_status, v_key_len;
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-03A', 'CHECK_KEY_DUPLICITY: Count of service_role_key keys', 'SUCCESS', jsonb_build_object('count', v_key_count, 'found', v_key_found, 'status', v_key_status, 'length', v_key_len));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-03A: %', SQLERRM;
  END;

  -- ==========================================
  -- [CP-04] BEFORE_IF_URL: Validation check starts
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-04] BEFORE_IF_URL: Checking URL validation';
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-04', 'BEFORE_IF_URL: Checking URL validation', 'SUCCESS', jsonb_build_object('edge_function_url', v_edge_function_url));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-04: %', SQLERRM;
  END;

  IF v_edge_function_url IS NULL OR v_edge_function_url = '' THEN
    RAISE WARNING '[DEBUG-FORENSE] [CP-05] AFTER_IF_URL_TRUE: URL is null or empty';
    BEGIN
      INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
      VALUES (NEW.id, 'CP-05', 'AFTER_IF_URL_TRUE: URL is null or empty', 'ABORTED', NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-05: %', SQLERRM;
    END;

    RAISE WARNING '[DEBUG-FORENSE] [CP-05-ABORT] RETURN_EARLY_URL: Aborting with RETURN NEW';
    RAISE WARNING 'Configuracao obrigatoria ausente na tabela public.notification_config: edge_function_url. Envio de push ignorado.';
    RETURN NEW;
  ELSE
    RAISE WARNING '[DEBUG-FORENSE] [CP-06] AFTER_IF_URL_FALSE: URL is valid';
    BEGIN
      INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
      VALUES (NEW.id, 'CP-06', 'AFTER_IF_URL_FALSE: URL is valid', 'SUCCESS', NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-06: %', SQLERRM;
    END;
  END IF;

  -- ==========================================
  -- [CP-07] BEFORE_IF_KEY: Validation check starts
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-07] BEFORE_IF_KEY: Checking KEY validation';
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-07', 'BEFORE_IF_KEY: Checking KEY validation', 'SUCCESS', jsonb_build_object('key_status', v_key_status));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-07: %', SQLERRM;
  END;

  IF v_service_role_key IS NULL OR v_service_role_key = '' THEN
    RAISE WARNING '[DEBUG-FORENSE] [CP-08] AFTER_IF_KEY_TRUE: Key is null or empty';
    BEGIN
      INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
      VALUES (NEW.id, 'CP-08', 'AFTER_IF_KEY_TRUE: Key is null or empty', 'ABORTED', NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-08: %', SQLERRM;
    END;

    RAISE WARNING '[DEBUG-FORENSE] [CP-08-ABORT] RETURN_EARLY_KEY: Aborting with RETURN NEW';
    RAISE WARNING 'Configuracao obrigatoria ausente no Supabase Vault: service_role_key. Envio de push ignorado.';
    RETURN NEW;
  ELSE
    RAISE WARNING '[DEBUG-FORENSE] [CP-09] AFTER_IF_KEY_FALSE: Key is valid';
    BEGIN
      INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
      VALUES (NEW.id, 'CP-09', 'AFTER_IF_KEY_FALSE: Key is valid', 'SUCCESS', NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-09: %', SQLERRM;
    END;
  END IF;

  -- ==========================================
  -- [CP-10] BUILD_URL: Construct final routing fields
  -- ==========================================
  v_final_url := rtrim(v_edge_function_url, '/') || '/send-push-notification';
  v_payload := jsonb_build_object(
    'notification_id', NEW.id
  );

  RAISE WARNING '[DEBUG-FORENSE] [CP-10] BUILD_URL: URL = %, Payload = %', v_final_url, v_payload;
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-10', 'BUILD_URL: Mounted final URL and payload', 'SUCCESS', jsonb_build_object('final_url', v_final_url, 'payload', v_payload));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-10: %', SQLERRM;
  END;

  -- ==========================================
  -- [CP-11] BEFORE_HTTP_POST: Imminent call to net.http_post
  -- ==========================================
  v_dispatch_started := clock_timestamp();
  RAISE WARNING '[DEBUG-FORENSE] [CP-11] BEFORE_HTTP_POST: Calling net.http_post...';
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (
      NEW.id, 
      'CP-11', 
      'BEFORE_HTTP_POST: Calling net.http_post', 
      'PENDING', 
      jsonb_build_object(
        'url', v_final_url, 
        'headers_safe', jsonb_build_object(
          'Content-Type', 'application/json', 
          'apikey', v_key_status,
          'Authorization', 'Bearer ' || v_key_status
        ), 
        'body_summary', v_payload, 
        'dispatch_timestamp', v_dispatch_started,
        'dispatch_started_at', v_dispatch_started
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-11: %', SQLERRM;
  END;

  -- Network/dispatch block using pg_net (Includes both 'apikey' and 'Authorization' headers)
  BEGIN
    v_request_id := net.http_post(
      url := v_final_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', v_service_role_key,
        'Authorization', 'Bearer ' || v_service_role_key
      ),
      body := v_payload
    );

    v_dispatch_finished := clock_timestamp();
    v_elapsed_ms := EXTRACT(EPOCH FROM (v_dispatch_finished - v_dispatch_started)) * 1000.0;

    -- ==========================================
    -- [CP-12] AFTER_HTTP_POST_SUCCESS: Completed successfully
    -- ==========================================
    RAISE WARNING '[DEBUG-FORENSE] [CP-12] AFTER_HTTP_POST_SUCCESS: net.http_post returned request_id = %, started_at = %, finished_at = %, elapsed = % ms', v_request_id, v_dispatch_started, v_dispatch_finished, v_elapsed_ms;
    RAISE WARNING 'REQUEST_ID=%', v_request_id;
    BEGIN
      INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
      VALUES (
        NEW.id, 
        'CP-12', 
        'AFTER_HTTP_POST_SUCCESS: net.http_post completed successfully', 
        'SUCCESS', 
        jsonb_build_object(
          'request_id', v_request_id, 
          'dispatch_started_at', v_dispatch_started, 
          'dispatch_finished_at', v_dispatch_finished, 
          'elapsed_ms', v_elapsed_ms
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-12: %', SQLERRM;
    END;

  EXCEPTION
    WHEN OTHERS THEN
      v_dispatch_finished := clock_timestamp();
      v_elapsed_ms := EXTRACT(EPOCH FROM (v_dispatch_finished - v_dispatch_started)) * 1000.0;

      -- Capture absolute diagnostics details
      GET STACKED DIAGNOSTICS 
        v_state = RETURNED_SQLSTATE,
        v_msg = MESSAGE_TEXT,
        v_context = PG_EXCEPTION_CONTEXT;

      -- ==========================================
      -- [CP-13] EXCEPTION_HANDLER: Caught execution exception
      -- ==========================================
      RAISE WARNING '[DEBUG-FORENSE] [CP-13] EXCEPTION_HANDLER: SQLSTATE = %, SQLERRM = %, CONTEXT = %, elapsed = % ms', v_state, v_msg, v_context, v_elapsed_ms;
      RAISE WARNING 'Falha ao despachar notificacao via pg_net: %', SQLERRM;
      BEGIN
        INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
        VALUES (
          NEW.id, 
          'CP-13', 
          'EXCEPTION_HANDLER: Exception caught', 
          'ERROR', 
          jsonb_build_object(
            'sqlstate', v_state, 
            'sqlerrm', v_msg, 
            'context', v_context, 
            'dispatch_started_at', v_dispatch_started,
            'dispatch_finished_at', v_dispatch_finished,
            'elapsed_ms', v_elapsed_ms
          )
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-13: %', SQLERRM;
      END;
  END;

  -- ==========================================
  -- [CP-14] FUNCTION_END: Before the final RETURN NEW
  -- ==========================================
  RAISE WARNING '[DEBUG-FORENSE] [CP-14] FUNCTION_END: Reached end of notify_new_notification()';
  BEGIN
    INSERT INTO public.audit_notify_new_notification (notification_id, checkpoint, description, status, payload_summary)
    VALUES (NEW.id, 'CP-14', 'FUNCTION_END: Normal termination of function', 'SUCCESS', NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[DEBUG-FORENSE] Falha ao gravar auditoria para CP-14: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;
