-- =============================================================================
-- AP-02 — Bateria de exposicao minima de profiles / instructors
-- =============================================================================
--
-- ALVO: migration 20260925_ap02_profiles_instructors_minimal_exposure.sql
--
-- COMO EXECUTAR (PostgreSQL efemero, NUNCA producao):
--   psql -f supabase/tests/ap02_harness.pgsql.sql
--   psql -f supabase/migrations/20260925_ap02_profiles_instructors_minimal_exposure.sql
--   psql -f supabase/tests/ap02_profiles_instructors_exposure.pgsql.sql
--
-- Cada verificacao roda com SET ROLE anon/authenticated para que RLS, grants e
-- EXECUTE sejam avaliados como no PostgREST.
-- =============================================================================

\set ON_ERROR_STOP on

-- Atores
--   S1 aluno, perfil completo            11111111-...
--   S2 aluno, perfil INCOMPLETO, sem aula 55555555-...
--   S3 aluno, perfil INCOMPLETO, com aula 66666666-...
--   I1 instrutor                          22222222-...
--   I2 outro instrutor                    44444444-...
INSERT INTO public.profiles (id, email, full_name, role, city, avatar_url, trusted_contact,
                             security_message, experience_level, cnh_process_type, phone,
                             is_profile_complete, provider_customer_id, cpf) VALUES
 ('11111111-1111-1111-1111-111111111111','s1@x.test','Aluno Um','student','Cidade A','a1.png',
  'contato S1','msg S1','few','first','5511900000001',true,'cus_s1','00000000001'),
 ('55555555-5555-5555-5555-555555555555','s2@x.test','Aluno Dois','student','Cidade A',NULL,
  'contato S2',NULL,NULL,NULL,'5511900000002',false,NULL,'00000000002'),
 ('66666666-6666-6666-6666-666666666666','s3@x.test','Aluno Tres','student','Cidade B',NULL,
  NULL,NULL,'never','rehab','5511900000003',false,NULL,'00000000003'),
 ('22222222-2222-2222-2222-222222222222','i1@x.test','Instrutor Um','instructor','Cidade A','i1.png',
  NULL,NULL,NULL,NULL,'5511900000010',true,NULL,'00000000010'),
 ('44444444-4444-4444-4444-444444444444','i2@x.test','Instrutor Dois','instructor','Cidade B',NULL,
  NULL,NULL,NULL,NULL,'5511900000020',true,NULL,'00000000020');

INSERT INTO public.instructors (id, public_id, credential_number, whatsapp, base_price, night_price,
                                categories, meeting_point, payouts_enabled, provider_account_id,
                                provider_wallet_id, provider_status) VALUES
 ('22222222-2222-2222-2222-222222222222','inst1','CRED-1','5511988887777',10000,12000,
  ARRAY['B'],'Praca 1',true,'acc_i1','wal_i1','APPROVED'),
 ('44444444-4444-4444-4444-444444444444','inst2','CRED-2','   ',9000,NULL,
  ARRAY['A'],'Praca 2',false,'acc_i2','wal_i2','PENDING');

INSERT INTO public.appointments (id, student_id, instructor_id, status) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','confirmed'),
 ('aaaaaaaa-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222','reserved'),
 ('aaaaaaaa-0000-4000-8000-000000000003','66666666-6666-6666-6666-666666666666',
  '22222222-2222-2222-2222-222222222222','completed');

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.as_actor(p_role text, p_uid text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('test.role', p_role, false);
  PERFORM set_config('test.uid', coalesce(p_uid, ''), false);
  EXECUTE format('SET ROLE %I', p_role);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.t_assert(p_cond boolean, p_name text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_cond, false) THEN RAISE NOTICE '  [PASS] %', p_name;
  ELSE RAISE EXCEPTION '  [FAIL] %', p_name; END IF;
END $$;

-- Executa um SQL e devolve NULL em sucesso ou o SQLERRM.
CREATE OR REPLACE FUNCTION pg_temp.t_err(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;

-- Colunas que NUNCA podem aparecer em view publica.
CREATE OR REPLACE FUNCTION pg_temp.sensitive_cols(p_view text)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = p_view
     AND column_name IN ('cpf','email','phone','trusted_contact','security_message',
                         'provider_customer_id','provider_name','whatsapp',
                         'provider_account_id','provider_wallet_id','provider_status',
                         'provider_onboarding_completed','payouts_enabled',
                         'experience_level','cnh_process_type','role')
$$;

GRANT EXECUTE ON FUNCTION pg_temp.as_actor(text, text), pg_temp.t_assert(boolean, text),
                          pg_temp.t_err(text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- GRUPO 1 — estrutura das views
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE 'GRUPO 1 — estrutura';
  PERFORM pg_temp.t_assert(pg_temp.sensitive_cols('profiles_public') = 0,
    '1.1 profiles_public nao contem nenhuma coluna sensivel');
  PERFORM pg_temp.t_assert(pg_temp.sensitive_cols('instructors_public') = 0,
    '1.2 instructors_public nao contem whatsapp nem provider_* nem payouts_enabled');
  PERFORM pg_temp.t_assert(
    (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='profiles_public')
    = ARRAY['avatar_url','city','full_name','id'],
    '1.3 profiles_public = exatamente id, full_name, avatar_url, city');
  PERFORM pg_temp.t_assert(
    (SELECT prosecdef FROM pg_proc WHERE proname='get_instructor_whatsapp')
    AND (SELECT prosecdef FROM pg_proc WHERE proname='get_student_contact_for_appointment'),
    '1.4 as 2 RPCs sao SECURITY DEFINER');
  PERFORM pg_temp.t_assert(
    (SELECT bool_and(array_to_string(proconfig, ',') LIKE '%search_path%')
       FROM pg_proc WHERE proname IN ('get_instructor_whatsapp','get_student_contact_for_appointment')),
    '1.5 as 2 RPCs fixam search_path');
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 2 — profiles: usuario comum nao le dados de terceiros
-- -----------------------------------------------------------------------------
DO $$
DECLARE n int; v text;
BEGIN
  RAISE NOTICE 'GRUPO 2 — profiles';
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');

  SELECT count(*) INTO n FROM public.profiles;
  PERFORM pg_temp.t_assert(n = 1, '2.1 aluno so enxerga a propria linha em profiles (obtido '||n||')');

  SELECT count(*) INTO n FROM public.profiles WHERE id <> '11111111-1111-1111-1111-111111111111';
  PERFORM pg_temp.t_assert(n = 0, '2.2 cpf/phone/trusted_contact de outro usuario: 0 linhas');

  SELECT cpf INTO v FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111';
  PERFORM pg_temp.t_assert(v = '00000000001', '2.3 aluno continua lendo o PROPRIO cpf');

  SELECT count(*) INTO n FROM public.profiles_public;
  PERFORM pg_temp.t_assert(n = 5, '2.4 profiles_public lista nome/foto/cidade de todos (reviews, agenda)');

  SELECT full_name INTO v FROM public.profiles_public WHERE id = '55555555-5555-5555-5555-555555555555';
  PERFORM pg_temp.t_assert(v = 'Aluno Dois', '2.5 nome de terceiro continua disponivel pela view');

  PERFORM pg_temp.as_actor('anon', NULL);
  PERFORM pg_temp.t_assert(pg_temp.t_err('SELECT 1 FROM public.profiles') LIKE '%permission denied%',
    '2.6 anon: SELECT em profiles NEGADO');
  PERFORM pg_temp.t_assert(pg_temp.t_err('SELECT 1 FROM public.profiles_public') LIKE '%permission denied%',
    '2.7 anon: SELECT em profiles_public NEGADO');
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 3 — instructors: vitrine publica sem dado sensivel
-- -----------------------------------------------------------------------------
DO $$
DECLARE n int; v text; b boolean;
BEGIN
  RAISE NOTICE 'GRUPO 3 — instructors';
  PERFORM pg_temp.as_actor('anon', NULL);
  PERFORM pg_temp.t_assert(pg_temp.t_err('SELECT 1 FROM public.instructors') LIKE '%permission denied%',
    '3.1 anon: SELECT direto em instructors NEGADO (wallet/whatsapp fora do alcance)');
  SELECT count(*) INTO n FROM public.instructors_public;
  PERFORM pg_temp.t_assert(n = 2, '3.2 anon: vitrine instructors_public continua listando (link publico /i/:id)');
  SELECT id::text INTO v FROM public.instructors_public WHERE public_id = 'inst1';
  PERFORM pg_temp.t_assert(v = '22222222-2222-2222-2222-222222222222',
    '3.3 anon: resolucao do link curto por public_id funciona');

  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  SELECT count(*) INTO n FROM public.instructors;
  PERFORM pg_temp.t_assert(n = 0, '3.4 aluno: tabela instructors nao devolve linha de instrutor');
  SELECT has_whatsapp INTO b FROM public.instructors_public WHERE id = '22222222-2222-2222-2222-222222222222';
  PERFORM pg_temp.t_assert(b, '3.5 has_whatsapp = true quando ha numero');
  SELECT has_whatsapp INTO b FROM public.instructors_public WHERE id = '44444444-4444-4444-4444-444444444444';
  PERFORM pg_temp.t_assert(NOT b, '3.6 has_whatsapp = false para numero em branco');
  SELECT full_name||'|'||city INTO v FROM public.instructors_public WHERE id = '22222222-2222-2222-2222-222222222222';
  PERFORM pg_temp.t_assert(v = 'Instrutor Um|Cidade A', '3.7 nome e cidade do instrutor vem na view');

  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  SELECT provider_wallet_id INTO v FROM public.instructors WHERE id = '22222222-2222-2222-2222-222222222222';
  PERFORM pg_temp.t_assert(v = 'wal_i1', '3.8 instrutor continua lendo a PROPRIA linha (wallet, onboarding)');
  SELECT count(*) INTO n FROM public.instructors;
  PERFORM pg_temp.t_assert(n = 1, '3.9 instrutor nao le a linha de outro instrutor');
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 4 — get_instructor_whatsapp
-- -----------------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  RAISE NOTICE 'GRUPO 4 — get_instructor_whatsapp';
  PERFORM pg_temp.as_actor('anon', NULL);
  PERFORM pg_temp.t_assert(
    pg_temp.t_err($q$SELECT public.get_instructor_whatsapp('22222222-2222-2222-2222-222222222222')$q$)
      LIKE '%permission denied%',
    '4.1 anon: EXECUTE NEGADO');

  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  v := public.get_instructor_whatsapp('22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v = '5511988887777', '4.2 aluno logado com perfil completo recebe o numero (pre-contrato)');
  v := public.get_instructor_whatsapp('44444444-4444-4444-4444-444444444444');
  PERFORM pg_temp.t_assert(v IS NULL, '4.3 numero em branco volta NULL');

  PERFORM pg_temp.as_actor('authenticated', '55555555-5555-5555-5555-555555555555');
  v := public.get_instructor_whatsapp('22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v IS NULL, '4.4 aluno com perfil incompleto e sem aula: NULL');

  PERFORM pg_temp.as_actor('authenticated', '66666666-6666-6666-6666-666666666666');
  v := public.get_instructor_whatsapp('22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v = '5511988887777', '4.5 aluno com aula com o instrutor recebe o numero');

  PERFORM pg_temp.as_actor('authenticated', '44444444-4444-4444-4444-444444444444');
  v := public.get_instructor_whatsapp('22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v IS NULL, '4.6 outro instrutor: NULL');

  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  v := public.get_instructor_whatsapp('22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(v = '5511988887777', '4.7 instrutor le o proprio numero');
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 5 — get_student_contact_for_appointment
-- -----------------------------------------------------------------------------
DO $$
DECLARE n int; v text;
BEGIN
  RAISE NOTICE 'GRUPO 5 — get_student_contact_for_appointment';
  PERFORM pg_temp.as_actor('anon', NULL);
  PERFORM pg_temp.t_assert(
    pg_temp.t_err($q$SELECT * FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000001')$q$)
      LIKE '%permission denied%',
    '5.1 anon: EXECUTE NEGADO');

  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  SELECT phone||'|'||experience_level||'|'||cnh_process_type INTO v
    FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000001');
  PERFORM pg_temp.t_assert(v = '5511900000001|few|first',
    '5.2 instrutor da aula confirmada recebe telefone, experiencia e processo');
  SELECT count(*) INTO n FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000003');
  PERFORM pg_temp.t_assert(n = 1, '5.3 aula concluida: contato disponivel');
  SELECT count(*) INTO n FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000002');
  PERFORM pg_temp.t_assert(n = 0, '5.4 aula reserved (nao paga): 0 linhas');

  PERFORM pg_temp.as_actor('authenticated', '44444444-4444-4444-4444-444444444444');
  SELECT count(*) INTO n FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000001');
  PERFORM pg_temp.t_assert(n = 0, '5.5 outro instrutor: 0 linhas');

  PERFORM pg_temp.as_actor('authenticated', '55555555-5555-5555-5555-555555555555');
  SELECT count(*) INTO n FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000001');
  PERFORM pg_temp.t_assert(n = 0, '5.6 terceiro (outro aluno): 0 linhas');

  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  SELECT count(*) INTO n FROM public.get_student_contact_for_appointment('aaaaaaaa-0000-4000-8000-000000000001');
  PERFORM pg_temp.t_assert(n = 0, '5.7 o proprio aluno nao usa a RPC do instrutor: 0 linhas');
  RESET ROLE;
END $$;

-- -----------------------------------------------------------------------------
-- GRUPO 6 — nao-regressao
-- -----------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  RAISE NOTICE 'GRUPO 6 — nao-regressao';
  PERFORM pg_temp.as_actor('authenticated', '11111111-1111-1111-1111-111111111111');
  PERFORM pg_temp.t_assert(
    pg_temp.t_err($q$UPDATE public.profiles SET city = 'Cidade Z' WHERE id = '11111111-1111-1111-1111-111111111111'$q$) IS NULL,
    '6.1 aluno continua atualizando o proprio perfil');
  PERFORM pg_temp.as_actor('authenticated', '22222222-2222-2222-2222-222222222222');
  PERFORM pg_temp.t_assert(
    pg_temp.t_err($q$UPDATE public.instructors SET lunch_active = false WHERE id = '22222222-2222-2222-2222-222222222222'$q$) IS NULL,
    '6.2 instrutor continua atualizando a propria agenda (instructors)');
  RESET ROLE;
  PERFORM set_config('test.role', 'service_role', false);
  SELECT count(*) INTO n FROM public.profiles;
  PERFORM pg_temp.t_assert(n = 5, '6.3 backend (owner/service_role) continua lendo tudo');
END $$;

DO $$ BEGIN RAISE NOTICE 'AP-02 — TODAS AS ASSERCOES PASSARAM'; END $$;
