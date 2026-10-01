-- =============================================================================
-- Estado financeiro `refund_denied` em public.appointments.payment_status
-- =============================================================================
--
-- ORIGEM
--   Incidente de 2026-10-01 (docs/auditorias/*EXPIRACAO*REEMBOLSO*): aula paga
--   que expirou com o estorno RECUSADO pelo Asaas ficava presa em
--   `pending_approval`/`paid` para sempre, porque o encerramento operacional
--   dependia do estorno concluido.
--
-- O QUE MUDA
--   O CHECK de `payment_status` passa a aceitar tambem `refund_denied`. Nenhum
--   valor existente e' removido.
--
--   Significado: a aula foi ENCERRADA (`status` = expired | cancelled) e o
--   gateway RECUSOU o estorno. O pagamento original continua valido e o
--   dinheiro segue com a plataforma — exige revisao manual. Difere de:
--     `paid`             aula ativa, pagamento recebido
--     `refund_requested` estorno solicitado, ainda sem desfecho (em analise)
--     `refunded`         estorno CONFIRMADO pelo gateway
--     `failed`           o PAGAMENTO falhou (nunca usado para recusa de estorno)
--
-- POR QUE NAO E' UM SIMPLES `DROP CONSTRAINT IF EXISTS <nome>`
--   A versao anterior desta migration removia a constraint pelo nome
--   `appointments_payment_status_check`. Se, no banco real, a constraint
--   tivesse outro nome, o DROP nao faria nada, a migration terminaria "com
--   sucesso" e o banco continuaria rejeitando `refund_denied` — recolocando as
--   aulas no ciclo de erro que esta mudanca veio resolver.
--
--   Esta versao localiza a constraint pela DEFINICAO (qualquer CHECK da tabela
--   que restrinja somente a coluna `payment_status`), qualquer que seja o nome,
--   e so' prossegue se for seguro. Ela ABORTA, sem alterar nada, quando:
--     (1) existe em uso algum valor de `payment_status` fora da lista nova;
--     (2) a constraint atual aceita algum valor que a lista nova nao tem
--         (para nao remover um status existente);
--     (3) `payment_status` participa de um CHECK com outras colunas (regra
--         composta: precisa de revisao manual, nao e' substituida aqui);
--     (4) a coluna nao e' de tipo texto (ex.: enum — o caminho seria outro).
--
-- ESTRUTURA REAL CONFERIDA EM PRODUCAO (2026-10-01, somente leitura, pelo
-- proprietario — consultas (a) e (b) do final deste arquivo)
--   - tabela public.appointments, coluna payment_status: text, aceita NULL,
--     default 'pending';
--   - UM unico CHECK sobre a coluna, de nome appointments_payment_status_check,
--     com os 7 valores: pending, paid, failed, refunded, authorized, released,
--     refund_requested;
--   - valores em uso: failed (3), paid (26), refund_requested (1),
--     refunded (3), released (1) — nenhum fora da lista.
--   Com essa estrutura nenhuma das condicoes de aborto abaixo e' acionada: a
--   migration remove o CHECK encontrado e o recria, com o mesmo nome, com os 7
--   valores atuais + `refund_denied`. As verificacoes permanecem para o caso de
--   o banco ter mudado entre a conferencia e a aplicacao.
--
-- O QUE NAO MUDA
--   - Nenhuma linha e' alterada. Nenhum dado e' migrado.
--   - Nenhum outro CHECK, indice, trigger, policy ou grant e' tocado
--     (`appointments_status_check` inclusive).
--   - O trigger de transicao (20260924_ap03_ap11) segue proibindo o cliente de
--     alterar `payment_status`; somente service_role grava `refund_denied`.
--
-- EXECUCAO REPETIDA
--   Idempotente: reaplicar encontra a constraint ja' com os 8 valores e a
--   recria identica.
--
-- ORDEM DE APLICACAO (OBRIGATORIA)
--   1. esta migration;
--   2. deploy da Vercel (webhook + frontend);
--   3. deploy das Edge Functions.
--   Com o codigo novo e o CHECK antigo, o UPDATE que encerra uma aula com
--   estorno recusado falha por violacao de CHECK e a aula volta a ficar presa.
--   Aplicar a migration com o codigo antigo no ar e' seguro: o codigo antigo
--   simplesmente nunca grava o valor novo.
--
-- APLICACAO
--   APLICADA EM PRODUCAO em 2026-10-01 (17:20 UTC), projeto
--   ohftsqsxymtrclnpadam, com autorizacao do proprietario, pela API de
--   migrations do Supabase. Registrada em supabase_migrations.schema_migrations
--   como versao 20261001172037, nome 20261001_refund_denied_payment_status.
--   O SQL executado foi este arquivo SEM as instrucoes externas `BEGIN;` e
--   `COMMIT;` (o bloco DO e' uma unica instrucao, atomica por si). O bloco DO
--   executado e' identico ao deste arquivo.
--   Este cabecalho foi atualizado depois da aplicacao; o texto registrado no
--   historico ainda traz o cabecalho anterior ("nao aplicada"). Somente
--   comentarios diferem.
--   Evidencias: docs/auditorias/APLICACAO_MIGRATION_REFUND_DENIED_FASE2_2026-10-01.md
--   NAO reexecutar sem necessidade (e' idempotente, mas ja' esta' aplicada).
-- =============================================================================

BEGIN;

DO $migration$
DECLARE
  v_rel       CONSTANT regclass := 'public.appointments'::regclass;
  v_canonical CONSTANT text     := 'appointments_payment_status_check';
  v_allowed   CONSTANT text[]   := ARRAY[
    'pending',
    'paid',
    'failed',
    'refunded',
    'authorized',
    'released',
    'refund_requested',
    'refund_denied'
  ];
  v_attnum    smallint;
  v_coltype   text;
  v_con       record;
  v_literals  text[];
  v_missing   text[];
  v_in_use    text[];
  v_names     text[] := ARRAY[]::text[];
  v_name      text;
  v_list      text;
BEGIN
  -- A coluna existe e e' texto?
  SELECT a.attnum, format_type(a.atttypid, a.atttypmod)
    INTO v_attnum, v_coltype
    FROM pg_attribute a
   WHERE a.attrelid = v_rel
     AND a.attname = 'payment_status'
     AND NOT a.attisdropped;

  IF v_attnum IS NULL THEN
    RAISE EXCEPTION 'refund_denied: coluna public.appointments.payment_status nao encontrada.';
  END IF;

  IF v_coltype NOT IN ('text', 'character varying') AND v_coltype NOT LIKE 'character varying(%' THEN
    RAISE EXCEPTION 'refund_denied: payment_status e'' do tipo % (esperado: text). Revisao manual necessaria; nada foi alterado.', v_coltype;
  END IF;

  -- (1) Nenhum valor em uso pode ficar fora da lista nova.
  SELECT array_agg(DISTINCT a.payment_status ORDER BY a.payment_status)
    INTO v_in_use
    FROM public.appointments a
   WHERE a.payment_status IS NOT NULL
     AND NOT (a.payment_status = ANY (v_allowed));

  IF v_in_use IS NOT NULL THEN
    RAISE EXCEPTION 'refund_denied: existem linhas com payment_status fora da lista nova: %. Inclua esses valores na migration antes de aplicar; nada foi alterado.', v_in_use;
  END IF;

  -- (2) e (3) Inspeciona TODO CHECK que envolve payment_status, pelo conteudo e nao pelo nome.
  FOR v_con IN
    SELECT c.conname, c.conkey, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.conrelid = v_rel
       AND c.contype = 'c'
       AND v_attnum = ANY (c.conkey)
     ORDER BY c.conname
  LOOP
    IF array_length(v_con.conkey, 1) <> 1 THEN
      RAISE EXCEPTION 'refund_denied: a constraint "%" combina payment_status com outras colunas (%). Ela nao e'' substituida automaticamente; revisao manual necessaria; nada foi alterado.', v_con.conname, v_con.def;
    END IF;

    -- Valores literais aceitos pela definicao atual.
    SELECT array_agg(DISTINCT m[1])
      INTO v_literals
      FROM regexp_matches(v_con.def, '''([^'']+)''', 'g') AS m;

    SELECT array_agg(lit ORDER BY lit)
      INTO v_missing
      FROM unnest(COALESCE(v_literals, ARRAY[]::text[])) AS lit
     WHERE NOT (lit = ANY (v_allowed));

    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'refund_denied: a constraint "%" aceita valores ausentes da lista nova: %. Inclua-os na migration antes de aplicar; nada foi alterado. Definicao atual: %', v_con.conname, v_missing, v_con.def;
    END IF;

    v_names := v_names || v_con.conname::text;
    RAISE NOTICE 'refund_denied: substituindo a constraint "%": %', v_con.conname, v_con.def;
  END LOOP;

  IF array_length(v_names, 1) IS NULL THEN
    RAISE NOTICE 'refund_denied: nenhum CHECK sobre payment_status encontrado; criando "%".', v_canonical;
  END IF;

  -- Substituicao: remove pelo nome REAL encontrado e recria com o nome canonico.
  FOREACH v_name IN ARRAY v_names LOOP
    EXECUTE format('ALTER TABLE public.appointments DROP CONSTRAINT %I', v_name);
  END LOOP;

  SELECT string_agg(quote_literal(val), ', ' ORDER BY ord)
    INTO v_list
    FROM unnest(v_allowed) WITH ORDINALITY AS t(val, ord);

  EXECUTE format(
    'ALTER TABLE public.appointments ADD CONSTRAINT %I CHECK (payment_status IN (%s))',
    v_canonical, v_list
  );

  -- Pos-condicao: exatamente um CHECK sobre a coluna, aceitando refund_denied.
  IF (SELECT count(*)
        FROM pg_constraint c
       WHERE c.conrelid = v_rel
         AND c.contype = 'c'
         AND v_attnum = ANY (c.conkey)
         AND pg_get_constraintdef(c.oid) LIKE '%refund_denied%') <> 1
     OR (SELECT count(*)
           FROM pg_constraint c
          WHERE c.conrelid = v_rel
            AND c.contype = 'c'
            AND v_attnum = ANY (c.conkey)) <> 1 THEN
    RAISE EXCEPTION 'refund_denied: pos-condicao violada (esperado exatamente um CHECK sobre payment_status, aceitando refund_denied). Transacao desfeita.';
  END IF;
END
$migration$;

COMMIT;

-- =============================================================================
-- VERIFICACAO — EXECUTAR ANTES DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- a) TODOS os CHECKs que envolvem payment_status, por conteudo (nao por nome).
-- --    Guardar a saida: e' o material de rollback.
-- SELECT c.conname                                   AS nome,
--        pg_get_constraintdef(c.oid)                 AS definicao,
--        c.convalidated                              AS validada,
--        array_length(c.conkey, 1)                   AS qtd_colunas,
--        (SELECT array_agg(att.attname::text ORDER BY att.attnum)
--           FROM pg_attribute att
--          WHERE att.attrelid = c.conrelid AND att.attnum = ANY (c.conkey)) AS colunas
--   FROM pg_constraint c
--  WHERE c.conrelid = 'public.appointments'::regclass
--    AND c.contype = 'c'
--    AND EXISTS (SELECT 1 FROM pg_attribute a
--                 WHERE a.attrelid = c.conrelid
--                   AND a.attname = 'payment_status'
--                   AND a.attnum = ANY (c.conkey))
--  ORDER BY c.conname;
--
-- -- b) Tipo da coluna e valores hoje em uso.
-- SELECT format_type(a.atttypid, a.atttypmod) AS tipo
--   FROM pg_attribute a
--  WHERE a.attrelid = 'public.appointments'::regclass AND a.attname = 'payment_status';
-- SELECT payment_status, count(*) FROM public.appointments GROUP BY 1 ORDER BY 1;
--
-- RESULTADO ESPERADO PARA AUTORIZAR A APLICACAO
--   (a) exatamente UMA linha, com qtd_colunas = 1, colunas = {payment_status} e
--       uma definicao cujos valores sejam um SUBCONJUNTO de:
--       pending, paid, failed, refunded, authorized, released, refund_requested
--       (o nome pode ser qualquer um; a migration usa o nome real).
--   (b) tipo = text; e todos os valores em uso dentro da mesma lista (NULL e'
--       aceito pelo CHECK).
--   Qualquer outro resultado (zero linhas, mais de uma, valor extra, mais de
--   uma coluna, tipo diferente): NAO aplicar; a migration abortaria ou
--   precisaria ser ajustada primeiro.
--
-- =============================================================================
-- VERIFICACAO — EXECUTAR DEPOIS DE APLICAR (somente SELECT)
-- =============================================================================
--
-- -- c) Repetir (a). Esperado: UMA linha, nome appointments_payment_status_check,
-- --    definicao com os 8 valores, incluindo refund_denied.
-- -- d) Repetir a contagem de (b): nenhuma linha mudou.
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
--
--   So' e' possivel enquanto NENHUMA linha usar `refund_denied`:
--     SELECT count(*) FROM public.appointments WHERE payment_status = 'refund_denied';
--   Com zero linhas: DROP da constraint `appointments_payment_status_check` e
--   ADD com o nome e a definicao capturados em (a).
--   Com linhas, o rollback do CHECK falha (por desenho): primeiro e' preciso
--   reverter o deploy do codigo e decidir, caso a caso, o estado financeiro
--   dessas aulas.
-- =============================================================================
