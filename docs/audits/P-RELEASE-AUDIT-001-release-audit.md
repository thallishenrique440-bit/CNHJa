# CNHJá — RELEASE AUDIT
## P-RELEASE-AUDIT-001 — Auditoria forense de pré-lançamento (Google Play)

**Data:** 2026-09-24
**Projeto Supabase:** `ohftsqsxymtrclnpadam` (sa-east-1, PostgreSQL 17.6, Compute NANO)
**Código:** `D:\projetos\CNHJa\CNHJa` — branch `main`, commit `abb3a17` (2026-09-23)
**Modo:** SOMENTE LEITURA. Nenhum arquivo alterado. Nenhum INSERT/UPDATE/DELETE/DDL/VACUUM executado. Nenhum commit, push ou deploy. Nenhum pagamento, refund ou webhook disparado.
**Método:** leitura estática do código + consultas `SELECT` ao banco de produção + catálogo do PostgreSQL (`pg_policy`, `pg_proc`, `pg_constraint`, `pg_trigger`) + Supabase advisors.

> **Limite estrutural desta auditoria:** tudo é estático. **Nenhum fluxo foi executado.** Nenhuma afirmação de "funciona" foi validada em runtime. Testes dinâmicos ficaram **PENDENTES** por exigirem escrita em produção.

---

# A. VEREDITO TÉCNICO

## 🔴 NÃO APTO

O veredito não é baseado em impressão. É baseado em **quatro bloqueadores de classe crítica confirmados por evidência direta**, cada um suficiente isoladamente para impedir a publicação:

1. **BL-01** — Usuário autenticado pode inserir aula com preço e status arbitrários (fraude financeira direta, confirmada em `pg_policy` + `pg_trigger`).
2. **BL-02** — Qualquer usuário logado lê CPF, e-mail, telefone e contato de confiança de **todos** os usuários (violação de LGPD, confirmada em `pg_policy`).
3. **BL-03** — Não existe exclusão de conta no app nem por URL web (requisito **obrigatório** do Google Play desde 2023; e a própria UI afirma falsamente que o recurso existe).
4. **BL-04** — Não existe nenhum artefato Android. Não há o que submeter à Play Console.

Além disso, há **dinheiro real parado em produção neste momento**: 3 aulas em `cancelling` com `payment_status='paid'` e 2 estornos presos em `REQUESTED` (R$100 cada) desde 22–23/09, sem nenhum processo que os resolva.

---

# B. BLOQUEADORES

| ID | SEV | PROBLEMA | EVIDÊNCIA | IMPACTO | CORREÇÃO NECESSÁRIA |
|---|---|---|---|---|---|
| **BL-01** | 🔴 CRÍTICO | **INSERT em `appointments` sem qualquer guarda de preço ou status.** As policies de INSERT são `CHECK (auth.uid() = student_id)` e `CHECK (auth.uid()=student_id AND is_profile_complete)`. O trigger `appointments_security_check_trigger` é **`BEFORE UPDATE` apenas** — não existe trigger de INSERT. `authenticated` tem `INSERT` privilege = true. | `pg_policy` em `appointments` (8 policies); `pg_trigger`: só `appointments_security_check_trigger` (UPDATE) e `tr_set_updated_by` | Aluno logado cria aula com `price=1`, `status='confirmed'`, `payment_status='paid'` direto via PostgREST, sem passar por `create-booking-intent`. Aula gratuita. Instrutor bloqueado sem receber. Toda a autoridade de preço do backend é contornável. | Trigger `BEFORE INSERT` que force `price` derivado do servidor e restrinja `status` inicial; ou revogar `INSERT` de `authenticated` e criar aulas só via RPC/Edge `SECURITY DEFINER`. |
| **BL-02** | 🔴 CRÍTICO | **`profiles` legível integralmente por qualquer autenticado.** Policy `Authenticated users can read profiles` → `USING (true)` para role `authenticated`. Colunas incluem `cpf`, `email`, `phone`, `trusted_contact`, `security_message`, `provider_customer_id`. | `pg_policy` + `information_schema.columns` de `profiles` | Vazamento de CPF e telefone de 100% da base para qualquer conta criada. Violação de LGPD art. 6º (necessidade) e art. 46. Dado de **terceiro** (`trusted_contact`) exposto. | Restringir SELECT a `auth.uid() = id` + view pública com colunas mínimas (`full_name`, `avatar_url`, `city`) para o que o produto realmente precisa expor. |
| **BL-03** | 🔴 CRÍTICO | **Exclusão de conta inexistente.** Busca exaustiva por `delete_account\|deleteAccount\|excluir conta\|admin.deleteUser\|anonymize` em `pages/ components/ api/ supabase/functions/ lib/ supabase/migrations/`: **zero resultados funcionais**. Nenhuma rota, botão ou endpoint. Agravante: `components/PrivacyModal.tsx:110` afirma que o usuário pode excluir "através das configurações do seu perfil". | grep exaustivo; `pages/student/Profile.tsx:486-490` e `pages/InstructorProfile.tsx:942-946` oferecem só logout | **Rejeição praticamente certa na Play Console.** Requisito obrigatório desde 2023 (Account/Data deletion policy): fluxo in-app **e** URL web acessível sem instalar o app. Declaração falsa na UI agrava (risco de suspensão). | Implementar fluxo in-app + página web pública de solicitação; definir o que é apagado, o que é anonimizado e o que é retido por obrigação legal/fiscal. |
| **BL-04** | 🔴 CRÍTICO | **Nenhum artefato Android existe.** Sem `android/`, `capacitor.config.*`, `twa-manifest.json`, `build.gradle`, `AndroidManifest.xml`, `.apk`, `.aab`. Sem `package name`, `versionCode`, `versionName`, `targetSdkVersion`. Sem `public/.well-known/assetlinks.json`. | busca por nome de arquivo (maxdepth 3, excluindo node_modules/dist/_to_delete) → vazio; `ls public/.well-known` → não existe | Não há o que submeter. Sem `assetlinks.json` um TWA abre com a barra de URL do Chrome e falha a verificação Digital Asset Links. | Empacotar (Bubblewrap/TWA ou Capacitor), definir identidade do app, publicar `assetlinks.json` no domínio do `start_url`. |
| **BL-05** | 🔴 CRÍTICO | **`send-push-notification` publicamente invocável.** `verify_jwt = false` em `supabase/config.toml` **e** nenhuma checagem de auth no handler (`index.ts:99-124` vai direto ao `req.json()`), usando `SERVICE_ROLE_KEY`, com `Access-Control-Allow-Origin: '*'` (`:4`). | `supabase/config.toml`; `supabase/functions/send-push-notification/index.ts:4,99-124` | Qualquer pessoa na internet POSTa `{"notification_id":"<uuid>"}` e força push a qualquer usuário. Spam/amplificação. | Exigir JWT ou segredo compartilhado validado fail-closed; restringir CORS. |
| **BL-06** | 🔴 CRÍTICO | **Telemetria vaza o `CRON_SECRET` caractere a caractere.** `notification-worker/index.ts:8-72` loga, em mismatch, o SHA-256 de `Bearer <CRON_SECRET>`, os comprimentos e o **caractere esperado na primeira posição divergente** (`:30 expectedMismatchCharacter`). A função tem `verify_jwt = false`. | `supabase/functions/notification-worker/index.ts:8-72`, esp. `:30`, `:47-48` | Oráculo remoto que permite recuperar o segredo de cron por tentativa e erro. Com ele, um atacante invoca todos os jobs de cron. | Remover a telemetria de debug; comparação constant-time; fail-closed. |
| **BL-07** | 🔴 CRÍTICO | **`CRON_SECRET` fail-open.** `if (cronSecret && authHeader !== ...)` — se a variável não estiver setada no ambiente da função, a verificação é **inteiramente ignorada**. | `supabase/functions/notification-worker/index.ts:79` | Com a var ausente, o worker fica publicamente invocável sem nenhum segredo. | Abortar com 500 se o segredo não estiver configurado. |
| **BL-08** | 🔴 CRÍTICO | **Reconciliação e verificação de integridade NÃO RODAM.** `ReconciliationService` e `IntegrityChecker` só aparecem em testes e em `scripts/run-tests.ts`. Nenhum endpoint em `api/` os importa; nenhum job em `cron.job`; `vercel.json` não tem bloco `crons`; `.github/` vazio. | grep em `api/ lib/ pages/ components/ supabase/ scripts/ server.ts vercel.json`; `SELECT * FROM cron.job` (4 jobs, nenhum de reconciliação) | O webhook **delega explicitamente** à reconciliação (`api/asaas-webhook.ts:637-649`, `reason_code:'RECONCILIATION_PENDING'`) para um processo que não existe. Resultado observável: 7 eventos de webhook presos em `PENDING` desde 11/08 e 2 estornos presos em `REQUESTED`. | Agendar `ReconciliationService` (já existe e está testado) e criar um reaper para operações de estorno com lease expirado. |
| **BL-09** | 🔴 CRÍTICO | **Ambiente Asaas = SANDBOX em 7 defaults independentes**, sem fail-closed e sem log de alerta. Nenhuma ocorrência de `api.asaas.com` em código executável. | `lib/payments/AsaasProvider.ts:183`; `api/sync-fees.ts:49`; `lib/payments/BookingCancellationCore.ts:116`; `supabase/functions/create-tip/index.ts:138`; `create-asaas-account/index.ts:143`; `sync-payment-status/index.ts:86`; `_shared/BookingCancellationCore.ts:126` | Se `ASAAS_API_URL` não estiver definida no deploy, a plataforma inteira opera contra o sandbox **silenciosamente** — cobranças que não existem. | Variável `ASAAS_ENV` explícita, validação de coerência ambiente↔chave e fail-closed na ausência. **Valor real em produção: NÃO VERIFICADO** (sem acesso aos env vars do Vercel/Edge). |
| **BL-10** | 🔴 CRÍTICO | **Transição `confirmed → cancelled` alcançável direto do frontend**, violando a regra central "aula aceita não pode ser cancelada, só remarcada". O trigger autoriza `cancelled` sem olhar `OLD.status`; a policy `Users can update their own appointments` tem `WITH CHECK` nulo e anula por OR o `WITH CHECK status='cancelled'` da policy do aluno. | `prosrc` de `check_appointments_update_security` (só olha `NEW.status`); `pg_policy` de `appointments` | A proteção existe apenas em `cancel-booking/index.ts:93-104` e `BookingCancellationCore.ts:58-61` — ambas contornáveis por `UPDATE` direto via PostgREST. | Trigger com validação de `OLD.status → NEW.status` e de quem é o ator. |
| **BL-11** | 🔴 CRÍTICO | **Aluno pode marcar aula como `completed` e `no_show`.** O trigger autoriza esses status para qualquer parte da aula. `pages/student/Lessons.tsx:671-679` faz exatamente isso, em lote (`.in('id', lessonIds)`). | `prosrc` do trigger; `pages/student/Lessons.tsx:671-679`; `pages/InstructorAgenda.tsx:1028,1062` | `completed` é o gatilho de liberação de repasse. Marcado pelo lado errado da relação, sem idempotência (sem CAS), duplo clique reescreve. | Restringir por ator no trigger; mover para RPC. |
| **BL-12** | 🔴 ALTO | **Política de Privacidade omite 11 categorias de dados efetivamente coletados** — CPF do aluno, data de nascimento, endereço completo + CEP, **renda declarada**, foto de perfil (em bucket **público**), contato de confiança (dado de terceiro), geolocalização do ponto de encontro, tokens FCM/`device_type`, senha, rascunhos em `localStorage`/`sessionStorage` com credencial DETRAN. E nomeia **apenas o Asaas** como terceiro — Supabase, Vercel, Firebase/Google, Google Maps/Places e Meta/WhatsApp não são nomeados. **Transferência internacional (art. 33) não é mencionada em nenhum documento.** | `pages/Privacy.tsx:69-87` vs data inventory da seção J | Inconsistência detectável entre o formulário Data Safety e a política publicada → risco alto de rejeição na Play Console, além da exposição à ANPD. | Reescrever a política a partir do data inventory real; nomear todos os operadores; declarar transferência internacional e bases legais por finalidade. |
| **BL-13** | 🔴 ALTO | **`instructors` legível por `anon`** (policy `Public profiles are viewable by everyone` → `USING (true)`, role PUBLIC; `anon` tem SELECT). Expõe `credential_number`, `whatsapp`, `provider_account_id`, `provider_wallet_id`. | `pg_policy`; `has_table_privilege('anon', ...)` = true; colunas de `instructors` | Identificadores de conta e carteira do gateway de pagamento publicamente legíveis sem login, junto com o WhatsApp pessoal de todos os instrutores. | View pública com colunas mínimas; revogar SELECT direto de `anon` na tabela. |
| **BL-14** | 🔴 ALTO | **2 vulnerabilidades `critical` e 11 `high`** em dependências: `protobufjs` (RCE, via `firebase`), `websocket-driver`, `@remix-run/router` (**XSS via open redirect**, em `react-router-dom`), `ws`, `vite`, `sharp`, `postcss`, `path-to-regexp`, `nanoid`, `@grpc/grpc-js`, `browserslist`. | `npm audit --json` → `{low:2, moderate:5, high:11, critical:2, total:20}` | XSS em runtime do cliente; RCE na cadeia do Firebase; DoS na superfície Express. Agravado por `vercel.json` **sem nenhum header de segurança** (sem CSP, HSTS, X-Frame-Options). | `npm audit fix`, atualização de `react-router-dom`, e headers de segurança no `vercel.json`. |

---

# C. PENDÊNCIAS ANTES DA PUBLICAÇÃO

Itens que precisam ser resolvidos mas não são, isoladamente, bloqueadores de submissão.

| ID | PROBLEMA | EVIDÊNCIA |
|---|---|---|
| P-01 | **Dinheiro parado agora:** 3 appointments em `cancelling` com `payment_status='paid'`; 2 `refund_operations` em `REQUESTED` (R$100 cada, `attempt=0`, `sent_at=null`) desde 22–23/09; 1 appointment `cancelled/refund_requested`. Nenhum código sai de `cancelling`. A migration `20260923_p1201b_04_drop_cancelling_status.sql` **não foi aplicada**. | `SELECT status, payment_status, count(*) FROM appointments`; `SELECT * FROM refund_operations` |
| P-02 | **`platform_fee + fee_amount + net ≠ gross` em 24 de 36 linhas** de `payment_installments` (23/36 em `payment_settlements`). Causa: dupla contagem da tarifa, corrigida no código em 19/09 18:07 mas **nunca aplicada retroativamente**. O delta é exatamente `−fee_amount`. O instrutor **nunca foi lesado** (`net = 90%` em 36/36); a receita da plataforma está **inflada em ≈ R$73**. | queries de identidade contábil; corte temporal visível por `created_at` |
| P-03 | **7 eventos de webhook presos em `PENDING`** desde 11/08/2026, com `provider_payment_id = NULL` e `processing_error = NULL`. Nunca serão reprocessados (BL-08). | `SELECT processing_status, count(*) FROM transactions WHERE type='webhook_event'` → PROCESSED 59, IGNORED 37, PENDING 7 |
| P-04 | **1 `notification_job` travado em `processing` há 43 dias** (`15682777-d40a-433b-a674-a30f70ed5b76`, `attempts=0`, `last_error=NULL`). **Retry, backoff e dead-letter não existem** — o esquema tem `attempts`, `max_attempts=5`, `retry`, `dead`, mas nenhuma função do banco grava esses estados e `notification-worker/index.ts:157-160` só faz `console.error`. | `SELECT status, count(*) FROM notification_jobs`; `prosrc` de `claim_notification_jobs` |
| P-05 | **Falha de push é reportada como sucesso.** `send-push-notification/index.ts:241-246` retorna `success:true` incondicionalmente, inclusive quando todos os envios ao FCM falham e quando o usuário não tem token. O worker aceita e marca `sent`. **A métrica "61 sent" não prova entrega de nada.** | `send-push-notification/index.ts:156-160,241-246`; `notification-worker/index.ts:142` |
| P-06 | **Deep links mortos ponta a ponta.** O SW lê `event.notification.data?.url` (`firebase-messaging-sw.js:37`) mas o payload nunca envia `url` (`send-push-notification/index.ts:196-204`, "NO URLs inside data"). `target_screen` é escrito e **nunca lido** (0 leituras em todo o front). Toda notificação abre a home. | grep por `target_screen` → só 2 escritas, 0 leituras |
| P-07 | **Token FCM não é removido no logout.** `signOut` (`AuthContext.tsx:383-388`) só faz `signOut()` + `localStorage.clear()`. Em dispositivo compartilhado, pushes de A continuam chegando ao dispositivo de B até que B ative notificações. | `AuthContext.tsx:383-388`; único DELETE em `fcm_tokens` é por erro do FCM (`send-push-notification/index.ts:231`) |
| P-08 | **`cron.job_run_details` sem retenção.** Taxa medida: **3.169 linhas/dia** (= 1440+1440+288+1, determinístico), ~1,26 KB/linha → **+3,9 MB/dia, ~119 MB/mês, ~1,39 GB/ano**. A janela atual (desde 25/08) reconstituiu 117 MB em ~30 dias. **Nenhum job de limpeza existe.** ~97% é ruído de dois jobs de minuto em minuto que quase nunca têm trabalho (61 jobs processados em 45 dias contra ~65.000 execuções). | `SELECT date_trunc('day',start_time), count(*)`; `cron.job` sem job de retenção; `pg_proc` sem função que toque `job_run_details` |
| P-09 | **`succeeded` no pg_cron não significa sucesso.** `invoke_edge_function_cron` retorna o `request_id` do pg_net imediatamente e **nunca lê `net._http_response`**. Um HTTP 401/500 na Edge Function é registrado como `succeeded`. Vale para os 4 jobs. Crítico em `sync-gateway-fees-job` (1×/dia, sem retry): uma falha = 24h de taxas não reconciliadas, indistinguível de sucesso. | `prosrc` de `invoke_edge_function_cron`; 24h com 0 falhas registradas |
| P-10 | **`npm run lint` permanentemente quebrado** — é `tsc --noEmit` e falha com 9 erros em `supabase/functions/` (especificadores Deno `npm:` e imports `.ts`), que deveria estar em `exclude`. Nenhum erro no código React. **Não existe ESLint** (`.eslintrc*` e `eslint.config.*` ausentes). | `npx tsc --noEmit`; `ls .eslintrc* eslint.config.*` |
| P-11 | **`reject-booking` cancela escopos diferentes conforme o entrypoint.** `cancel-booking/index.ts:106-113` passa `scope:'SINGLE_APPOINTMENT'` explícito; `supabase/functions/reject-booking/index.ts:62-68` e `api/reject-booking.ts:65-70` **não passam scope**, e o default para `instructor_rejected` com `group_id` é **`FULL_GROUP`**. O mesmo ato de negócio cancela 1 aula ou o combo inteiro. | `BookingCancellationCore.ts:128-130` |
| P-12 | **`api/reject-booking.ts` reintroduz o falso sucesso.** Devolve `200` incondicionalmente, inclusive para `pending_refund` — o bug que os dois Edge corrigiram com `409 REFUND_PENDING`. | `api/reject-booking.ts:66-78` vs `cancel-booking/index.ts:115-140` |
| P-13 | **`auto_complete_lessons` ignora `proposal_status`.** Filtra só `reschedule_requested_at IS NULL` (coluna legada). Aula com proposta de remarcação **pendente** cujo horário original passou é marcada `completed`; a proposta fica órfã e `accept_reschedule` passa a falhar com `INVALID_STATUS`. | `prosrc` de `auto_complete_lessons` vs `propose_reschedule` |
| P-14 | **`propose_reschedule` não valida a grade do instrutor** (noite/sábado/almoço/domingo) — só conflito de slot. `accept_reschedule` também só revalida conflito. `reschedule_appointment_direct` valida a grade inteira. Caminho para gravar aula fora da agenda configurada. | `prosrc` das três RPCs |
| P-15 | **Guarda de split incompleta.** `create-booking-intent.ts:212-217` exige `provider_account_id` **OU** `provider_wallet_id`. Instrutor com `provider_account_id` mas **sem** `provider_wallet_id` passa a guarda; `AsaasProvider.ts:389` filtra `!!rule.walletId` e **o split é silenciosamente removido — 100% fica com a plataforma**. | `create-booking-intent.ts:212-217`; `AsaasProvider.ts:386-405` |
| P-16 | **`returnUrl` do checkout usa roteamento hash** (`${origin}/#/student/lessons`, `create-booking-intent.ts:600`) enquanto o app usa `BrowserRouter` (`App.tsx:192`). O retorno cai em `/` → `Navigate → /welcome` → `PublicGuard` → `/student/home`. **Nunca chega a `/student/lessons`.** | `create-booking-intent.ts:600`; `App.tsx:141,192` |
| P-17 | **Divergência de domínio:** fallback `https://autoescolabrasil.com` no código vs `cnhja.com.br` nos e-mails. O `assetlinks.json` do TWA precisa ficar no domínio do `start_url`. | `api/create-booking-intent.ts:600`; `constants.ts:11` |
| P-18 | **Aceite não granular e sem versionamento.** Um único checkbox cobre Termos + Privacidade, e voltar de `/terms` marca aceite **de ambos** (`termsAgreed==='true' \|\| privacyAgreed==='true'`). `TERMS_VERSION`/`PRIVACY_VERSION` são importados e **nunca usados**; `terms_version` é gravado hard-coded `'1.0'` no trigger. A cláusula 12 dos Termos (re-aceite) é inaplicável. | `pages/RegisterStudent.tsx:56-64`; `constants.ts:5-6`; `20260404_security_hardening_terms.sql:41` |
| P-19 | **Controlador não identificado.** Nenhum documento traz razão social, CNPJ ou endereço da empresa. Nenhum encarregado/DPO nomeado (só um e-mail). Exigido por CDC art. 46 e LGPD art. 41 §1º. | `pages/Terms.tsx`, `pages/Privacy.tsx` integrais |
| P-20 | **Buckets `avatars` e `assets` são públicos** (`storage.buckets.public = true`, sem `file_size_limit` nem `allowed_mime_types`). Fotos de rosto acessíveis por URL sem autenticação; upload sem limite de tamanho ou tipo. | `SELECT * FROM storage.buckets` |
| P-21 | **`leaked password protection` desabilitado** no Supabase Auth. | Supabase security advisor |
| P-22 | **Migrations não rastreadas:** `supabase_migrations.schema_migrations` tem **2 linhas** contra 68 arquivos em `supabase/migrations/`. Não há como afirmar, pelo registro, o que está aplicado. Toda a auditoria de banco teve de ser feita por catálogo. | `SELECT * FROM supabase_migrations.schema_migrations` |
| P-23 | **Sem ícone `maskable` e sem screenshots.** `public/manifest.json:12-23` tem só 192 e 512 PNG RGBA, nenhum com `"purpose":"maskable"`. `public/icons/` está vazio (só `.gitkeep`). | `public/manifest.json`; `file public/android-chrome-*.png` |
| P-24 | **Política pública incompleta para o revisor.** `/privacy` e `/terms` são rotas públicas, mas o conteúdo é condicional ao papel (`Privacy.tsx:17`, fallback `'student'`) — **um visitante anônimo nunca vê a versão do Instrutor**. Além disso é SPA React: política renderizada por JS pode falhar em crawlers/validadores. | `App.tsx:132-133`; `Privacy.tsx:17`; `Terms.tsx:17` |
| P-25 | **Sem verificação documental do instrutor.** Os Termos prometem "processo rigoroso" com CNH+EAR e documento do veículo; o código coleta apenas o **número** da credencial DETRAN em texto livre, sem validação contra fonte alguma e **sem nenhum upload de documento**. | `RegisterInstructor.tsx:52,88,124`; único upload no app é avatar |
| P-26 | **Suspensão e banimento previstos nos Termos (cl. 9 e 11) não existem no código** — sem painel admin, sem flag `suspended`/`banned`. | grep `suspend\|ban` em `pages/ api/ supabase/` → 0 |
| P-27 | **`vercel.json` sem `regions`** — usa o default `iad1` (Washington DC) para app brasileiro com Supabase em sa-east-1 e Asaas no Brasil. Sem config `functions` (memória/maxDuration): `api/asaas-webhook.ts` (60 KB) roda com timeout default de 10s. | `vercel.json` |

---

# D. RISCOS NÃO BLOQUEADORES

| ID | RISCO | EVIDÊNCIA |
|---|---|---|
| R-01 | `AuthGuard` ignora a checagem de papel quando `userRole` é `null` (`App.tsx:62` exige `userRole &&`). Usuário sem `role` no metadata acessa área de qualquer perfil. Mitigado pelo RLS, não pelo front. | `App.tsx:48-77` |
| R-02 | `ProfileGuard` **não bloqueia nada** — só renderiza spinner e `<Outlet/>` (comentário explícito "FASE 5C"). Importa `supabase`, `useToast`, `Navigate` sem usar. | `components/ProfileGuard.tsx:7-22` |
| R-03 | `userRole` vem de `user_metadata.role`, campo fornecido pelo próprio usuário no `signUp`. O controle real depende do RLS. | `AuthContext.tsx:307,341`; `RegisterStudent.tsx:116` |
| R-04 | `signOut` faz `localStorage.clear()` — apaga tudo do domínio, inclusive `booking_selected_slots` e preferências. | `AuthContext.tsx:383-388` |
| R-05 | 6 `catch` vazios e ~40 `catch` que só fazem `console.*` em telas de usuário — home, perfil, aulas e agenda podem aparecer vazias sem nenhuma mensagem. Sem observabilidade (grep Sentry/Datadog/logtail → 0). | `lib/functions.ts:50`; `StudentHome.tsx:169,245,265`; `student/Profile.tsx:113`; `InstructorProfile.tsx:251`; etc. |
| R-06 | **35 ocorrências de `error.message` cru** exposto ao usuário, incluindo mensagens do PostgREST em inglês com nomes de coluna/constraint. `InstructorAgenda.tsx:169,1043,1077,1188,1209,1227,1257` e `Lessons.tsx:765` mostram a mensagem **sem prefixo algum**. | grep `error.message` em `pages/` |
| R-07 | 5 `setLoading(true)` sem `finally` (Login, RegisterStudent, RegisterInstructor, ForgotPassword, UpdatePassword) — exceção de rede trava o botão. Em `student/InstructorProfile.tsx:1015-1111`, `isProcessingPayment` permanece `true` após `CheckoutLauncher.launch` — se o popup for bloqueado, a UI congela em "processando". | arquivos citados |
| R-08 | **Inconsistência de timezone dentro da mesma tela:** `InstructorFinance.tsx:252` formata data em UTC e `:257` formata hora no fuso local — a mesma transação pode exibir data e hora de dias diferentes. `AuthContext` calcula `serverTimeOffset` (`:277-292`) e **nenhum formatador o usa**. | `InstructorFinance.tsx:252,257`; `HistoryCardFormatter.ts:35`; `InstructorAgenda.tsx:1394` |
| R-09 | Regra das 24h de **cancelamento** usa offset `-03:00` hardcoded em JS no Edge (`cancel-booking/index.ts:75-88`), e após P-1.20.1B é praticamente **código morto** (o único status cancelável é pré-aceite). A regra viva é a de **remarcação**, em SQL com `AT TIME ZONE 'America/Sao_Paulo'`. | `cancel-booking/index.ts:75-88`; `prosrc` de `reschedule_appointment_direct` |
| R-10 | `propose_reschedule` **não tem checagem de 24h** — aluno com >24h pode criar proposta pendente em vez de remarcar direto, prendendo o instrutor num fluxo não previsto. Sem impacto financeiro. | `prosrc` de `propose_reschedule` |
| R-11 | Cancelamento de combo pelo aluno é um **loop não atômico** na UI (`Lessons.tsx:995-1002`, uma chamada por aula). Se a 3ª falhar, as 2 primeiras já foram canceladas/estornadas, sem compensação. | `pages/student/Lessons.tsx:995-1002` |
| R-12 | Webhook sem **HMAC** (token estático comparado com `!==`, não constant-time), **sem rate limit** e **sem verificação de origem/IP**. O `accountId` é extraído (`:136`) mas nunca comparado com valor esperado. Idempotência, essa sim, é robusta. | `api/asaas-webhook.ts:96-102,136`; grep `rate\|throttle\|allowlist` → 0 |
| R-13 | `api/asaas-webhook.ts:738-740` captura erros de `PaymentStateService`/`SettlementService` com `console.warn` e **continua**, devolvendo 200. Um settlement que falhe aqui **não é re-entregue**. | linha citada |
| R-14 | Preço e desconto são **duplicados** entre front e back (`LessonPricing.ts:77-108` vs `InstructorProfile.tsx:878-912`); só o cálculo de tarifa é compartilhado (`GatewayFeeModel.ts`). Divergências: front sem fail-closed para `night_price` nulo, e comparação de categoria case-sensitive (`:885`). Afeta exibição, não cobrança. | arquivos citados |
| R-15 | `MAX_INSTALLMENTS = 4` duplicado em 3 lugares sem fonte única; schedule de tarifas cobre até 21x (faixas 7-21x inalcançáveis). | `create-booking-intent.ts:12`; `AsaasProvider.ts:3`; `InstructorProfile.tsx:25`; `GatewayFeeModel.ts:70-76` |
| R-16 | `net_amount` da gorjeta é gravado com o **valor bruto** na criação (`create-tip/index.ts:184-188`) e só corrigido pelo webhook. Entre criação e liquidação, `transactions` mostra o instrutor recebendo 100% do bruto. | linhas citadas |
| R-17 | `_shared/InstallmentService.ts` (94 linhas) é subconjunto estrito de `lib/payments/InstallmentService.ts` (319) e **removeu o fallback por `appointment_id`** — um estorno que só conheça o `appointment_id` não encontra a parcela na Edge Function. Divergência assumida (`scripts/sync-shared.ts` marca `BLOCKED`). | diff; `scripts/sync-shared.ts` |
| R-18 | `lib/NotificationService.ts` (365) vs `_shared/NotificationService.ts` (385) divergem e **não são cobertos** pelo `sync-shared --check`. | diff |
| R-19 | Status `blocked` e `scheduled` no CHECK **sem nenhum produtor** no código. `scheduled` é estado-fantasma duplicado de `confirmed` em toda guarda (`IN ('confirmed','scheduled')`). `reschedule_appointment_direct` filtra por `failed` e `rejected`, que **não existem** no CHECK — cláusula morta. | `pg_constraint`; grep |
| R-20 | Dois workers para a mesma fila: `notification-worker` (pg_cron) e `ShadowWorker`/`notificationQueueProcessor` iniciado por `server.ts:67` + `api/worker.ts`. `SKIP LOCKED` evita corrupção, mas é dívida ativa. | `server.ts:67`; `lib/ShadowWorker.ts` |
| R-21 | `create_unified_notification` tem `EXECUTE` para `authenticated` e ainda é chamada do cliente (`InstructorAgenda.tsx:1164-1177`), permitindo forjar conteúdo de notificação. | `pg_proc`; grants |
| R-22 | Helpers `reschedule_grid_violation` e `reschedule_slot_violation` expostos a `authenticated` sem necessidade — vazam ocupação de agenda. | grants |
| R-23 | `get_instructor_availability` e `get_instructor_lessons_count` são `SECURITY DEFINER` executáveis por `anon`. | Supabase security advisor |
| R-24 | `pg_net` instalado no schema `public`. | Supabase security advisor |
| R-25 | 39 policies re-avaliam `auth.<function>()` por linha (`auth_rls_initplan`); 32 casos de policies permissivas múltiplas; 7 FKs sem índice; 8 índices nunca usados. | Supabase performance advisor |
| R-26 | `payouts` está **vazia (0 linhas)** apesar de `PayoutEngine`/`PayoutWorker`/`PayoutRepository`/`PayoutStateMachine` existirem. Nenhum repasse jamais registrado. `PayoutWorker` só é importado por testes. | `SELECT count(*) FROM payouts`; grep |
| R-27 | Máquina de estados de refund tem 8 estados; **apenas `REQUESTED` aparece em produção**. Os outros 7 nunca foram exercitados. | `SELECT status, count(*) FROM refund_operations` |
| R-28 | **`TermsModal.tsx:148-158` promete compartilhamento de localização em tempo real durante a aula — recurso que não existe** (grep `navigator.geolocation` → 0). | linha citada |
| R-29 | **`no_show` não tem lógica financeira alguma.** Os Termos prometem retenção integral em favor do instrutor; o código só grava o status. Nenhuma referência a `no_show` em `lib/payments/`. | `InstructorAgenda.tsx:1052-1065`; grep |
| R-30 | **Foro de eleição em São Paulo/SP contra consumidor** tende a ser afastado (CDC art. 51, IX; CPC art. 63 §3º). | `Terms.tsx:188` |
| R-31 | **Menores de idade não tratados** em nenhum documento nem no código (sem verificação de idade do aluno). | ausência |
| R-32 | `LGPD_EMAIL='lgpd@cnhja.com.br'` declarado em `constants.ts:13` e **nunca usado** — risco de canal divulgado divergir do real. | `constants.ts:12-13` |
| R-33 | `supabase/functions/create-booking/index.ts` é **código morto** (nenhum `invoke('create-booking')` no front) com `verify_jwt=false`, sem aplicar desconto e sem validar data passada/domingo. Riscos latentes, não explorados hoje. | grep; `config.toml` |
| R-34 | `supabase/functions/cleanup-scheduler/` não está em `config.toml` nem em `cron.job` — órfão. | `config.toml`; `cron.job` |
| R-35 | **15 scripts `.ts` soltos na raiz**, nenhum referenciado pelo `package.json`, vários usando `SUPABASE_SERVICE_ROLE_KEY` (ex.: `check-fcm.ts:19` lê `fcm_tokens` inteira). Inclui `apply-migration.ts`, aplicador de migration fora do fluxo oficial. | `ls *.ts`; `package.json` |
| R-36 | Resíduos na raiz: 4 arquivos `baseline-p*.txt`, `grep_output.txt`, `supabase_schema.sql` (33 KB, snapshot divergente das migrations), `bun.lock` vazio coexistindo com `package-lock.json`, 9 diretórios `tests-p1*`, e **dois arquivos com nome corrompido por escape de shell**: `Base31177.unit.test.ts' -or` e `tests -File |`. Pasta `_to_delete` ainda presente. | `ls` |
| R-37 | `sharp` e `micro` em `dependencies` sem uso no bundle do cliente; `@types/uuid ^10` desalinhado com `uuid ^13`. | `package.json` |

---

# E. FUNCIONALIDADES AUDITADAS

Legenda STATUS: **OK** = implementado ponta a ponta com evidência · **PARCIAL** = existe com lacuna material · **SÓ FRONT** / **SÓ BACK** · **QUEBRADO** · **INEXISTENTE** · **MORTO** = código presente, não acionado.
Coluna TESTE: **U**=unitário, **I**=integração, **SQL**=pgsql, **—**=nenhum. **Nenhuma função foi testada dinamicamente nesta auditoria.**

| FUNÇÃO | PERFIL | FRONTEND | BACKEND | BANCO | TESTE | STATUS | EVIDÊNCIA |
|---|---|---|---|---|---|---|---|
| Cadastro aluno | aluno | `RegisterStudent.tsx` | Supabase Auth | `profiles` + `handle_new_user` | — | **PARCIAL** | loading sem `finally` (`:107`); rascunho em `sessionStorage` (`:49-52`) |
| Cadastro instrutor | instrutor | `RegisterInstructor.tsx` | Supabase Auth | `profiles`, `instructors` | — | **PARCIAL** | sem upload de documento; credencial não validada (`:88`); grava PII em `localStorage` (`:150-155`) |
| Login | ambos | `Login.tsx:29` | Supabase Auth | — | — | **PARCIAL** | loading sem `finally`; `error.message` cru (`:41`) |
| Logout | ambos | `AuthContext.tsx:383-388` | — | — | — | **PARCIAL** | token FCM não removido (P-07); `localStorage.clear()` |
| Recuperação de senha | ambos | `ForgotPassword.tsx` + `UpdatePassword.tsx` | Supabase Auth | — | — | **OK** | mensagem genérica correta (`:37`), sem enumeração de conta |
| Guard de perfil | ambos | `ProfileGuard.tsx` | — | — | — | **MORTO** | não bloqueia nada (`:7-22`) |
| Perfil do aluno | aluno | `student/Profile.tsx` | — | `profiles` (7 colunas) | — | **PARCIAL** | CPF coletado em outra tela; catch só-log (`:113`) |
| Perfil do instrutor | instrutor | `InstructorProfile.tsx` | — | `profiles`, `instructors`, `instructor_categories`, `instructor_vehicles` | — | **OK** | `:329-479` |
| Cidade | ambos | `CitySelect.tsx` + `data/cities*.ts` | — | `profiles.city` | — | **OK** | validação contra lista (`RegisterStudent.tsx:81`) |
| Busca de instrutor | aluno | `StudentHome.tsx` | — | `instructors` (RLS `true`) | — | **PARCIAL** | 3 catch só-log (`:169,245,265`) — home pode aparecer vazia sem aviso |
| Favoritos | aluno | `StudentHome.tsx:292` | — | `student_favorites` | — | **OK** | RLS por `auth.uid()` |
| Perfil público do instrutor | ambos | `student/InstructorProfile.tsx` | — | `instructors`, `reviews` | — | **PARCIAL** | expõe dados de `instructors` a `anon` (BL-13) |
| Link curto do instrutor | público | `InstructorShortLink.tsx` (`/i/:publicId`) | — | `instructors.public_id` | — | **OK** | rota pública sem guard (`App.tsx:129`) |
| Disponibilidade / grade | ambos | `DateSelector.tsx`, `lib/slots.ts` | RPC `get_instructor_availability` | `appointments`, `instructors` | — | **PARCIAL** | RPC `SECURITY DEFINER` executável por `anon` (R-23) |
| Seleção de aula | aluno | `student/InstructorProfile.tsx` | — | `localStorage['booking_selected_slots']` | — | **OK** | `:298` |
| Descontos progressivos | ambos | `InstructorProfile.tsx:898-912` | `lib/discount-utils.ts:24-56` | `instructor_discounts` | U | **PARCIAL** | lógica duplicada front/back (R-14) |
| Gestão de descontos | instrutor | `InstructorDiscounts.tsx` | — | `instructor_discounts` | — | **OK** | `:117` |
| Combo | aluno | `student/Lessons.tsx:1088-1160` | `group_id` em `create-booking-intent.ts:565` | `appointments.group_id` | U,SQL | **PARCIAL** | agrupamento no front é por **contiguidade de horário**, não por `group_id` |
| Checkout | aluno | `CheckoutLauncher.ts` | `api/create-booking-intent.ts` | `appointments`, `payment_installments` | U | **PARCIAL** | `returnUrl` com hash quebrado (P-16) |
| Preço server-authoritative | — | — | `create-booking-intent.ts:405-443` | `instructor_categories` | U | **OK no endpoint / QUEBRADO no sistema** | fail-closed `PRICE_AUTHORITY_UNRESOLVED` (`:429-435`), mas contornável por BL-01 |
| Pagamento PIX | aluno | — | `AsaasProvider.ts:380-383` | — | U | **PARCIAL** | ambiente sandbox (BL-09) |
| Pagamento cartão | aluno | — | `AsaasProvider.ts:362-364` | — | U | **PARCIAL** | idem |
| Parcelamento (até 4x) | aluno | `InstructorProfile.tsx:25` | `create-booking-intent.ts:175-180`; `AsaasProvider.ts:356-358` | `payment_installments` | U | **OK** | dupla validação |
| Gross-up da tarifa | — | `GatewayFeeModel.ts` (compartilhado) | idem | `gateway_fee_schedule` | U | **OK** | `:249-297`, busca exata (binária proibida, `:243-247`) |
| Split (aula) | — | — | `create-booking-intent.ts:617-622` | — | U | **PARCIAL** | guarda incompleta de wallet (P-15) |
| Comissão CNHJá 10% | — | — | `create-booking-intent.ts:596` | `payment_installments.platform_fee` | U (22 asserts) | **OK no código / VIOLADO nos dados** | 24/36 linhas históricas (P-02) |
| Repasse instrutor 90% | — | — | `create-booking-intent.ts:620` | `net_amount` | U | **OK** | 36/36 linhas corretas |
| Pagamento abandonado | aluno | `PaymentFeedback.tsx` (rota órfã) | `check-expired-bookings` | `appointments.expires_at` | — | **PARCIAL** | rotas `/student/payment/*` sem nenhum `navigate` que as alcance |
| Webhook Asaas | — | — | `api/asaas-webhook.ts` (1389 l.) | `transactions` (ledger) | U | **PARCIAL** | idempotência robusta; sem HMAC/rate limit/origem (R-12) |
| Idempotência de webhook | — | — | `asaas-webhook.ts:140-252` | `transactions.type='webhook_event'` | U | **OK** | 0 duplicatas no banco |
| Settlement | — | — | `SettlementService.ts:77-113` | `payment_settlements` | U,I | **OK** | 0 chaves duplicadas |
| Aceite (instrutor) | instrutor | `InstructorAgenda.tsx` | `approve-booking/index.ts:194-210` | `appointments` | U | **OK** | service_role |
| Recusa (instrutor) | instrutor | `InstructorAgenda.tsx` | `reject-booking` (Edge + Vercel) | `appointments`, `refund_operations` | U | **QUEBRADO** | escopo divergente (P-11) + falso sucesso no Vercel (P-12) |
| Cancelamento aluno | aluno | `student/Lessons.tsx:995-1002` | `cancel-booking` | `appointments` | U,I | **PARCIAL** | loop não atômico (R-11); regra 24h praticamente morta (R-09) |
| Bloqueio: aula aceita não cancelável | ambos | `Lessons.tsx:1640` | `cancel-booking/index.ts:93-104` | — | U | **QUEBRADO** | contornável por UPDATE direto (BL-10) |
| Remarcação direta (>24h) | aluno | `Lessons.tsx:133-135,920` | RPC `reschedule_appointment_direct` | `appointments` | SQL (57 asserts) | **OK** | valida grade + conflito + 24h server-side |
| Remarcação por proposta (≤24h) | ambos | `Lessons.tsx`, `InstructorAgenda.tsx` | RPCs `propose/accept/reject/cancel_reschedule_proposal` | `appointments.proposal_*` | SQL | **PARCIAL** | não valida grade (P-14); ignorada por `auto_complete_lessons` (P-13) |
| Preservação financeira na remarcação | — | — | 5 RPCs | — | SQL | **OK** | nenhuma escreve `status`/`price`/`payment_*` (verificado linha a linha) |
| Conclusão automática | — | `ShadowWorker.ts:109` | RPC `auto_complete_lessons` | `appointments` | — | **PARCIAL** | EXECUTE fechado corretamente; ignora `proposal_status` (P-13) |
| Conclusão manual | ambos | `InstructorAgenda.tsx:1028`; `Lessons.tsx:671` | — | `appointments` | — | **QUEBRADO** | aluno pode marcar `completed`/`no_show` (BL-11), sem idempotência |
| No-show | instrutor | `InstructorAgenda.tsx:1062` | — | `appointments` | — | **SÓ FRONT** | nenhuma lógica financeira (R-29) |
| Gorjeta | aluno | `student/Lessons.tsx` | `create-tip/index.ts` | `transactions` | U | **OK** | `platform_fee:0`, split 100%; confirmado no banco |
| Histórico financeiro do aluno | aluno | `student/Finance.tsx` + `StudentHistoryAdapter.ts` | `api/student-finance.ts` | `payment_installments` | U (30) | **OK** | |
| Histórico financeiro do instrutor | instrutor | `InstructorFinance.tsx` + `InstructorHistoryAdapter.ts` | `api/instructor-finance.ts` + `InstructorFinanceReadService.ts` | idem | U (26+22) | **PARCIAL** | inconsistência de timezone (R-08) |
| Onboarding Asaas (subconta) | instrutor | `InstructorFinance.tsx:692-704` | `create-asaas-account` (`verify_jwt=false`) | `instructors.provider_*`, `profiles.cpf` | — | **PARCIAL** | **NÃO VERIFICADO** se valida identidade internamente |
| Saque / repasse | instrutor | — | `PayoutEngine`/`PayoutWorker` | `payouts` (**0 linhas**) | U,I,conc | **MORTO** | não acionado por nenhum endpoint/cron (R-26) |
| Reconciliação | — | — | `ReconciliationService`, `IntegrityChecker` | — | U,I | **MORTO** | BL-08 |
| `sync-fees` | — | — | `api/sync-fees.ts` | `gateway_fee_schedule` | — | **OK** | pg_cron job 12, `17 4 * * *` |
| `sync-asaas-status` | instrutor | botão em `InstructorFinance.tsx:753` | `api/sync-asaas-status.ts` | — | — | **PARCIAL** | só manual; autorização por papel **NÃO VERIFICADA** |
| `reconcile-payment` | — | — | `api/reconcile-payment.ts` | — | — | **MORTO** | só chamado por `sync-payment-status`, que **não está agendada** |
| Refund | — | — | `RefundOperationRepository`, `AsaasRefundAdapter`, `RefundStateMachine` | `refund_operations` | U (12 suítes) | **QUEBRADO** | 2 operações presas em `REQUESTED` (P-01); sem reaper |
| Notificações in-app | ambos | — | `create_unified_notification` | `notifications` (62 linhas) | — | **PARCIAL** | 5 dos 13 tipos nunca emitidos |
| Push (FCM) | ambos | `usePushNotifications.ts`, `PushNotificationManager.tsx` | `send-push-notification` | `fcm_tokens` (6 tokens/5 usuários) | — | **QUEBRADO** | BL-05, P-05, P-06, P-07 |
| Service worker | ambos | `public/firebase-messaging-sw.js` | — | — | — | **PARCIAL** | sem handler `fetch`, sem cache/offline; deep link quebrado |
| Fila de notificações | — | `ShadowWorker.ts` + `notification-worker` | `claim_notification_jobs` | `notification_jobs` | — | **PARCIAL** | sem retry/dead-letter; 1 job travado há 43 dias (P-04) |
| Notificação de pagamento liberado | — | helper `_shared/NotificationService.ts:342` | — | — | — | **MORTO** | nunca chamado |
| Notificação de conclusão | — | — | — | — | — | **INEXISTENTE** | sem tipo nem emissor |
| Notificação de refund | — | — | — | — | — | **INEXISTENTE** | sem tipo nem emissor |
| Avaliações | aluno | `RatingBadge.tsx`, `lib/instructorRating.ts` | RPC `get_pending_review` | `reviews` (leitura pública) | — | **OK** | |
| Suporte | ambos | e-mail em `constants.ts:11` | — | — | — | **PARCIAL** | sem página de suporte nem URL pública |
| Exclusão de conta | ambos | — | — | — | — | **INEXISTENTE** | BL-03 |
| Exportação / portabilidade | ambos | — | — | — | — | **INEXISTENTE** | nenhuma rota/endpoint |
| Suspensão / banimento | admin | — | — | — | — | **INEXISTENTE** | R-26 |
| Termos de Uso | ambos | `Terms.tsx`, `TermsModal.tsx` | — | `profiles.terms_accepted_at/version` | — | **PARCIAL** | seção I |
| Política de Privacidade | ambos | `Privacy.tsx`, `PrivacyModal.tsx` | — | `profiles.privacy_accepted_at` | — | **PARCIAL** | seção J |

### Código morto / rotas órfãs confirmados

- **Componente nunca importado:** `components/InstructorShareCard.tsx` (0 referências).
- **Hooks nunca importados:** `hooks/useInstructorFinance.ts`, `hooks/usePaymentState.ts`, `hooks/useStudentFinance.ts`.
- **Módulos importados só por testes:** `PayoutWorker.ts`, `ReconciliationService.ts`, `AsaasRefundAdapter.ts`, `PaymentStateErrors.ts`.
- **Rotas inalcançáveis:** `/student/payment` (desativada por comentário em `student/InstructorProfile.tsx:1108`, com `console.warn`/`console.trace` de debug remanescentes em `PaymentPage.tsx:7,14,22,28`), `/student/payment/success|cancelled|expired` (0 referências em todo o repo — se são callbacks configurados no painel Asaas: **NÃO VERIFICADO**).
- **Edge Functions órfãs:** `create-booking` (nenhum invoke no front), `cleanup-scheduler` (fora de `config.toml` e de `cron.job`).
- **15 scripts `.ts` na raiz** não referenciados (R-35).

---

# F. FINANCEIRO

## F.1 Invariantes

**AULA — `service_price` = 100%, CNHJá = 10%, Instrutor = 90%, tarifa por gross-up**

| Grandeza | Fórmula | Evidência |
|---|---|---|
| `service_price` | `finalPrice` (não sofre tarifa) | `create-booking-intent.ts:447-457` |
| Comissão CNHJá | `Math.round(finalPrice * 0.10)` | `:596` |
| Instrutor (split) | `fixedValue: finalPrice − applicationFeeAmount` | `:617-622` |
| Cobrança do aluno | `min{SC : SC − taxa_real(SC) ≥ SP}` | `GatewayFeeModel.ts:249-297` |
| `gateway_fee_expected` | `studentCharge − servicePrice` | `:359` |
| Identidade declarada | `gross = net + platform_fee + fee_amount` | `create-booking-intent.ts:716` |

✅ **RESPEITADO NO CÓDIGO ATUAL.** O gross-up é **matematicamente exato**, não aproximado: busca linear porque `g(SC) = SC − taxa(SC)` não é monotônica para `n ≥ 3` (contraexemplo documentado: `g(20747)=19978`, `g(20748)=19976`). Sobra de arredondamento ≤ 1 centavo fica com a plataforma, **nunca sai do instrutor**, porque o split é valor fixo calculado antes da tarifa. O webhook preserva o invariante usando estritamente os valores contratuais de `payment_installments` (`asaas-webhook.ts:652-655`), não o payload do Asaas.

❌ **VIOLADO NOS DADOS HISTÓRICOS** — ver P-02.

**GORJETA — CNHJá = 0%, tarifa descontada da gorjeta, instrutor recebe o resto**

✅ **RESPEITADO** em código e dados. `create-tip/index.ts:186` (`platform_fee: 0`), `:210-215` (`percentualValue: 100`). Confirmado no banco: `gross 1000, platform_fee 0, fee 199, net = instructor_amount = 801`.

## F.2 Tabelas reais

⚠️ **`payments` e `settlements` NÃO EXISTEM.** Os nomes reais são **`payment_installments`** e **`payment_settlements`**.

| Tabela | Linhas |
|---|---:|
| `payment_installments` | 36 |
| `payment_settlements` | 36 |
| `transactions` | 171 |
| `refund_operations` | 2 |
| `payouts` | **0** |
| `appointments` | 28 |
| `gateway_fee_schedule` | 5 |

## F.3 Verificações relacionais

| Verificação | Resultado | Veredito |
|---|---:|---|
| Settlement com `installment_id` órfão | 0 | ✅ |
| Settlement com `installment_id` NULL | 1 | ✅ é a gorjeta, por design |
| Installment sem settlement | 4 | ✅ 1 `CANCELLED` + 3 `CONFIRMED` (parcelas futuras) |
| Refund sem payment | 0 | ✅ |
| Installment sem appointment | 0 | ✅ |
| Installment com appointment órfão | 0 | ✅ |
| **Chave de settlement duplicada** | **0** | ✅ idempotência funciona na prática |
| **Chave de installment duplicada** | **0** | ✅ |
| **`platform_fee + fee + net ≠ gross`** | **24/36** e **23/36** | ❌ P-02 |
| `instructor_amount ≠ net_amount` | **0/36** | ✅ |

## F.4 R$0,01 e manipulação de preço

- **Pelo endpoint `create-booking-intent`: IMPOSSÍVEL.** Nenhum campo do `req.body` entra na cadeia monetária; o `lesson.price` do cliente é descartado e gravado só como `submittedCents` para auditoria (`LessonPricing.ts:147-160`). `category` restrita a `A|B|AB`, `lessons.length ≤ 20`, `installmentCount ∈ 1..4`.
- **Pelo PostgREST: POSSÍVEL — ver BL-01.** A autoridade do endpoint é irrelevante se o cliente pode inserir a linha diretamente.

---

# G. SEGURANÇA

| Área | Situação | Evidência |
|---|---|---|
| RLS habilitado | ✅ em **todas** as 26 tabelas de `public` | `pg_class.relrowsecurity` |
| `rls_forced` | ❌ `false` em todas (o owner ignora RLS) | idem |
| `profiles` SELECT | ❌ **`USING(true)` para `authenticated`** — BL-02 | `pg_policy` |
| `instructors` SELECT | ❌ **`USING(true)` para PUBLIC**, `anon` tem SELECT — BL-13 | `pg_policy` + `has_table_privilege` |
| `appointments` SELECT | ✅ `uid=student_id OR uid=instructor_id`. **A afirmação de `USING(true)` presente na migration `20260308_fix_appointments_rls.sql` NÃO corresponde ao banco vivo — REFUTADA.** | `pg_policy` |
| `appointments` INSERT | ❌ sem guarda de preço/status — BL-01 | `pg_policy` + `pg_trigger` |
| `appointments` UPDATE | ❌ trigger só olha `NEW.status`, `WITH CHECK` nulo anula por OR — BL-10, BL-11 | `prosrc` + `pg_policy` |
| `transactions` | ✅ só SELECT `uid=student OR uid=instructor`; sem policy de escrita | `pg_policy` |
| `payment_installments` / `payment_settlements` | ✅ só SELECT pelas partes | `pg_policy` |
| `refund_operations`, `refund_operation_events`, `refund_operation_items` | ✅ **fail-closed**: RLS on, 0 policies, e `anon`/`authenticated` sem privilégio | advisor + `has_table_privilege` |
| `notification_config` | ✅ fail-closed por 0 policies (mas tem GRANT — depende só do RLS) | advisor |
| `instructor_bank_details` | ✅ 4 policies por `auth.uid()` | `pg_policy` |
| `fcm_tokens` | ✅ 4 policies por `auth.uid()`; UNIQUE em `token`, não em `user_id` (multi-device correto) | `pg_policy` + `pg_constraint` |
| `gateway_fee_schedule`, `platform_financial_settings` | ⚠️ leitura por qualquer um (`USING(true)`) — expõe a tabela de tarifas e as configurações financeiras da plataforma | `pg_policy` |
| SECURITY DEFINER | ✅ **28 funções, 100% com `search_path` definido.** 7 RPCs de remarcação usam `pg_catalog, public` (hardening correto); as demais usam `public` apenas | `pg_proc.proconfig` |
| EXECUTE por `anon` | ⚠️ 2 funções: `get_instructor_availability`, `get_instructor_lessons_count` | advisor + `has_function_privilege` |
| EXECUTE por `authenticated` | ⚠️ 13 funções, incluindo `create_unified_notification` (R-21) e os 2 helpers internos de remarcação (R-22) |
| RPCs de remarcação — derivação de papel | ✅ **todas** derivam de `auth.uid()`; nenhuma aceita papel/`student_id`/`instructor_id` como parâmetro; `FOR UPDATE` antes de validar (fecha TOCTOU) | `prosrc` |
| IDOR | ❌ confirmado em `profiles` (BL-02) e `instructors` (BL-13) |
| Webhook | ⚠️ token estático, sem HMAC, sem rate limit, sem verificação de origem (R-12); idempotência robusta ✅ |
| `verify_jwt = false` | ⚠️ 6 Edge Functions: `check-expired-bookings` 🟡, `notification-worker` 🔴 (BL-06/BL-07), `auto-complete-lessons` 🟡 **NÃO VERIFICADO**, `send-push-notification` 🔴 (BL-05), `create-booking` 🔴 **NÃO VERIFICADO**, `create-asaas-account` 🔴 **NÃO VERIFICADO** | `supabase/config.toml` |
| Storage | ⚠️ `avatars` e `assets` públicos, sem limite de tamanho nem de MIME (P-20) | `storage.buckets` |
| Secrets no código | ✅ nenhum segredo impresso nesta auditoria. `lib/supabase.ts:3-4` tem URL + anon key hardcoded (pública por design, mas versionada). `.env.local` presente; **conteúdo e cobertura pelo `.gitignore` NÃO VERIFICADOS** |
| Git history | **NÃO VERIFICADO** — não foi feita varredura de segredos no histórico |
| CORS | ⚠️ `Access-Control-Allow-Origin: '*'` em `send-push-notification/index.ts:4` |
| Headers HTTP | ❌ `vercel.json` sem **nenhum** header de segurança (P-27/BL-14) |
| Rate limit | ❌ inexistente em toda a superfície |
| `leaked password protection` | ❌ desabilitado (P-21) |
| `pg_net` em `public` | ⚠️ advisor WARN (R-24) |

---

# H. LGPD

| Requisito | Situação |
|---|---|
| Direitos do titular (art. 18) | ✅ rol completo declarado (`Privacy.tsx:146-157`) — mas **nenhum é operacionalizável no produto** |
| Canal de contato | ⚠️ `privacidade@cnhja.com.br`; `LGPD_EMAIL` declarado e nunca usado (R-32) |
| Exclusão | ❌ **inexistente** (BL-03); `PrivacyModal.tsx:110` afirma falsamente que está "nas configurações do seu perfil" |
| Acesso / portabilidade | ❌ inexistente |
| Correção | ⚠️ parcial — perfil editável, mas **CPF não é corrigível** (`create-asaas-account/index.ts:213` só grava se NULL); nascimento/endereço/renda não editáveis |
| Eliminação | ❌ inexistente |
| **Bases legais** | ❌ **PENDENTE DE DEFINIÇÃO.** A política fala em "bases legais legítimas" sem atribuir base por finalidade. Indeterminadas: contato de confiança, tokens FCM, geolocalização, renda declarada |
| Terceiros nomeados | ❌ **só o Asaas.** Supabase, Vercel, Firebase/Google (FCM), Google Maps/Places e Meta/WhatsApp **não são nomeados** |
| Transferência internacional (art. 33) | ❌ **não mencionada em nenhum documento.** De fato ocorre: Firebase/FCM e Google Maps fora do Brasil; Vercel CDN global sem `regions`. Região do Supabase: `sa-east-1` (Brasil) ✅ |
| Medidas de segurança | ⚠️ declaradas (TLS + repouso), **contraditas** por buckets públicos e pelos BL-02/BL-13 |
| Encarregado / DPO | ❌ só um e-mail; sem nome (art. 41 §1º) |
| **Controlador** | ❌ **não identificado** — sem razão social, CNPJ ou endereço em nenhum documento (P-19) |
| Retenção | ❌ **PENDENTE DE DEFINIÇÃO** — cláusula genérica sem prazo algum; nenhuma rotina de expurgo no código |
| Menores | ❌ não tratado (R-31) |
| Consentimento granular | ❌ checkbox único para Termos + Privacidade (P-18) |
| Cookies | ⚠️ a seção 8 descreve cookies que o app **não usa** (`document.cookie` não aparece em lugar nenhum) e **omite** o `localStorage`/`sessionStorage` que ele de fato usa |
| Analytics | ✅ **NÃO EXISTE** — grep por `gtag`, `googletagmanager`, `posthog`, `mixpanel`, `hotjar`, `clarity.ms`, `fbq(`, `amplitude`, `@sentry` → 0 resultados |

---

# I. TERMOS DE USO

**Local:** `pages/Terms.tsx` (217 linhas) + `components/TermsModal.tsx` (187). **Não existe `.md`/`.html`/`.txt`** — o documento só existe como JSX. Condicional por perfil (`Terms.tsx:17`, fallback `'student'`). Data: "04 de julho de 2026" (string literal). Versão não exibida.

## Divergências contrato × código

| TEMA | TERMOS | CÓDIGO | DIVERGÊNCIA |
|---|---|---|---|
| Comissão | "comissão retida sobre o valor bruto", **sem percentual** | **10% fixo** sobre `finalPrice` | **SIM — omissão material** |
| Instrutor recebe 90% | não menciona | `finalPrice − 10%` | **SIM** |
| Taxa de processamento (gateway) | **não mencionada** | somada ao valor do aluno (`totalPriceWithFee`) | **SIM** |
| Reembolso | ">24h = estorno **integral do valor pago**" | reembolsa `appointment.price` = **preço do serviço, sem a taxa de gateway** | **SIM** |
| Cancelamento (24h) | aluno pode cancelar; >24h reembolso, <24h retenção | **após o aceite, cancelamento é bloqueado em qualquer prazo** ("Use a remarcação") | **SIM — grave** |
| Remarcação | **a palavra não aparece nos Termos** | regra completa: >24h direta, ≤24h proposta | **SIM — grave, regra operativa não contratualizada** |
| Gorjeta | **não mencionada** | fluxo completo, 100% ao instrutor | **SIM** |
| Combos | **não mencionados** | `group_id`, escopo `FULL_GROUP` | **SIM** |
| Descontos progressivos | **não mencionados** | aplicados automaticamente | **SIM** |
| Parcelamento | **não mencionado** | até 4x com taxa repassada | **SIM** |
| Rejeição pelo instrutor | não tratada | `instructor_rejected` + refund | **SIM — omissão** |
| Expiração automática | não tratada | `auto_expired` + `expires_at` | **SIM — omissão** |
| No-show | "retenção integral em favor do instrutor" | só grava o status, **sem lógica financeira** | **SIM — não implementado** |
| Credenciamento do instrutor | "processo rigoroso", CNH+EAR, doc. do veículo | só o **número** da credencial, sem validação nem upload | **SIM** |
| Localização em tempo real | `TermsModal.tsx:148-158` promete o recurso | `navigator.geolocation` → **0 ocorrências** | **SIM — promessa sem implementação** |
| Suspensão / banimento | cl. 9 e 11 preveem | **não existe no código** | **SIM** |
| Encerramento de conta | **não previsto** | **não implementado** | **SIM — omissão + requisito Play** |
| Propriedade intelectual | **cláusula AUSENTE** | — | **SIM — lacuna contratual** |
| Alteração dos Termos | cl. 12: uso continuado = aceite | **sem mecanismo de re-aceite**; `terms_version` hard-coded `'1.0'` | **SIM** |
| Asaas como processador | ✅ nomeado | ✅ | Não |
| Intermediação de pagamento | ✅ declarada | ✅ | Não |
| WhatsApp entre as partes | ✅ cl. 10 autoriza | ✅ `wa.me` | Não |
| Foro São Paulo/SP | cl. 13 | — | **Alerta jurídico** (R-30) |
| Contato | `suporte@cnhja.com.br` | `constants.ts:11` | Não |

---

# J. POLÍTICA DE PRIVACIDADE

**Local:** `pages/Privacy.tsx` (206 linhas) + `components/PrivacyModal.tsx` (150). Data: "04 de julho de 2026". 11 seções.

## Data inventory real — dados NÃO documentados na Política

| DADO | ORIGEM | ARMAZENAMENTO | COMPARTILHADO COM | RETENÇÃO | NA POLÍTICA? |
|---|---|---|---|---|---|
| **CPF do aluno** | `student/InstructorProfile.tsx:193-224` (modal obrigatório antes de pagar) | `profiles.cpf` | Asaas | PENDENTE | ❌ **NÃO** |
| **Data de nascimento (instrutor)** | `InstructorFinance.tsx:237,706-710` | não persistido | Asaas | n/a | ❌ **NÃO** |
| **Endereço completo + nº + complemento + bairro + CEP** | `InstructorFinance.tsx:229-233,695-699` | não persistido | Asaas | n/a | ❌ **NÃO** |
| **Renda/faturamento declarado (`incomeValue`)** | `InstructorFinance.tsx:238,703` | não persistido | Asaas | n/a | ❌ **NÃO** — dado financeiro sensível |
| **Foto de perfil** | `student/Profile.tsx:196-214` | bucket **público** `avatars` + `profiles.avatar_url` | **URL pública** | PENDENTE | ❌ **NÃO** |
| **Contato de confiança** | `student/Profile.tsx:52,140,156` | `profiles.trusted_contact` | — | PENDENTE | ❌ **NÃO** — dado de **terceiro** sem base legal |
| **Geolocalização (lat/lng/place_id)** | `InstructorProfile.tsx:363-366`; `GooglePlacesInput.tsx:42,60` | `instructors.meeting_point_*` | **Google Maps/Places** | PENDENTE | ❌ **NÃO** |
| **Token FCM + `device_type`** | `AuthContext.tsx:119,134` | `fcm_tokens` | **Google/Firebase** | PENDENTE | ❌ **NÃO** — push não é mencionado em nenhum documento |
| **Conteúdo das notificações** (nome, data, valor) | `send-push-notification/index.ts:187-216` | `notifications` | **Google/Firebase** (sai do Brasil) | PENDENTE | ❌ **NÃO** |
| **Senha** | `RegisterStudent.tsx:30,125` | `auth.users` | Supabase | PENDENTE | ❌ **NÃO** |
| **Rascunhos em `sessionStorage`** (nome, e-mail, WhatsApp, cidade, **credencial DETRAN**) | `RegisterStudent.tsx:49-52`; `RegisterInstructor.tsx:52-53` | navegador | — | sessão | ❌ **NÃO** |
| **`localStorage['ab_instructor_data']`** (nome, credencial, WhatsApp, cidade) — **persiste após logout**? não: `localStorage.clear()` no signOut | `RegisterInstructor.tsx:150-155` | navegador | — | até logout | ❌ **NÃO** |

**Documentados e coerentes:** nome, e-mail, telefone/WhatsApp, cidade, nível de experiência, tipo de processo CNH, credencial DETRAN, dados bancários/subconta, histórico de aulas, avaliações, IP/cookies/dispositivo (genericamente).

**A Política promete coleta que o código NÃO faz:** CNH digitalizada com EAR, comprovante de regularidade, modelo/placa/licenciamento/seguro do veículo (`Privacy.tsx:83-84`) — nenhum desses campos existe.

---

# K. GOOGLE PLAY

| Item | FATO |
|---|---|
| Empacotamento Android | ❌ **NÃO EXISTE** (sem `android/`, Capacitor, TWA, Bubblewrap, `.apk`, `.aab`) |
| package name / applicationId | ❌ **NÃO EXISTE**. `package.json:2` = `autoescola-do-brasil`, divergente da marca CNHJá |
| versionCode / versionName | ❌ **NÃO EXISTEM** (só `package.json:4` `"version":"1.0.0"`) |
| targetSdkVersion | ❌ **NÃO EXISTE** |
| Permissões Android | ❌ **NÃO EXISTEM**. No PWA, a única permissão em runtime é Notificações |
| `public/.well-known/assetlinks.json` | ❌ **NÃO EXISTE** — bloqueador absoluto para TWA |
| manifest.json | ✅ existe: `name`/`short_name` "CNHJá", `start_url` `/`, `display` `standalone`, `theme_color`/`background_color` `#009C3B`, `scope` `/`, `orientation` `portrait`, `lang` `pt-BR` |
| Ícones | ⚠️ só 192 e 512 PNG RGBA; **nenhum `"purpose":"maskable"`**; `public/icons/` vazio |
| Screenshots | ❌ **NÃO EXISTEM** (nem arquivos, nem campo no manifest) |
| Service worker | ⚠️ existe (`firebase-messaging-sw.js`) mas **sem handler `fetch`, sem cache/offline, sem Workbox/vite-plugin-pwa** |
| Política de privacidade por URL pública | ⚠️ `/privacy` é rota pública (`App.tsx:133`, fora dos guards), mas o conteúdo é condicional ao papel — **o revisor anônimo nunca vê a versão do Instrutor**; e é SPA React |
| **Exclusão de conta no app** | ❌ **NÃO EXISTE** |
| **Exclusão de conta por URL web** | ❌ **NÃO EXISTE** — requisito obrigatório do Google Play desde 2023 |
| Data Safety | **NÃO VERIFICÁVEL — depende da Play Console.** Ver J.1 abaixo |
| Classificação etária | **NÃO VERIFICÁVEL — depende da Play Console.** No código não há gate de idade |
| Suporte / contato | ⚠️ e-mails nos documentos in-app; **sem página de suporte nem URL pública** |
| Domínio de produção | ⚠️ divergência `autoescolabrasil.com` (código) vs `cnhja.com.br` (e-mails) |

## K.1 Data Safety — declarações que o inventário exigiria

**NÃO VERIFICÁVEL** (o formulário depende da Play Console). Com base no data inventory:

- **Personal info:** Name, Email, User IDs, Phone number, Address (instrutor), **Other info** (CPF/CNPJ e data de nascimento = identificador governamental).
- **Financial info:** *Purchase history* + *Other financial info* (renda declarada, dados de subconta). Dados de cartão **não** são coletados pelo app.
- **Location:** *Approximate location* (endereço escolhido, não GPS).
- **Photos:** foto de perfil.
- **Device or other IDs:** token FCM.
- **App activity:** interações, avaliações.
- Para os itens de cadastro/pagamento: `Collected = Yes`, `Shared = Yes` (Asaas; Google/Firebase para push), `Processed ephemerally = No`, `Required = Yes`.
- `Users can request data deletion` → hoje seria **No**. **Declarar "Yes" sem implementar é motivo de suspensão.**

⚠️ O formulário é comparado com a política publicada. Como a política **omite** CPF, nascimento, endereço, renda, foto, localização e token FCM, haverá **inconsistência detectável** → risco alto de rejeição.

## K.2 Funcionalidades financeiras

Os pagamentos são de **serviço presencial real**, não de produto digital. A regra de Payments do Google Play exige Google Play Billing para produtos/serviços **digitais**; bens e serviços físicos/presenciais normalmente usam processador externo (aqui, Asaas).

⚠️ **Esta leitura precisa ser confirmada na documentação oficial vigente do Google Play (Payments policy e Financial Services policy) — não afirmo a regra atual com certeza.** Pontos a confirmar:
- Parcelamento em cartão com taxa repassada ao usuário pode atrair a **Financial Services policy** e exigir declaração na Play Console.
- Categoria do app e eventuais documentos regulatórios: **NÃO VERIFICÁVEL — depende da Play Console.**

---

# L. CRON / PG_NET

## L.1 Jobs

| jobid | jobname | schedule | active | command |
|---|---|---|---|---|
| 9 | `check-expired-bookings-job` | `* * * * *` | true | `invoke_edge_function_cron('check-expired-bookings')` |
| 10 | `notification-worker-job` | `* * * * *` | true | `invoke_edge_function_cron('notification-worker')` |
| 11 | `auto-complete-lessons-job` | `*/5 * * * *` | true | `invoke_edge_function_cron('auto-complete-lessons')` |
| 12 | `sync-gateway-fees-job` | `17 4 * * *` | true | `invoke_vercel_cron('api/sync-fees')` |

Últimas 24h: 288 + 1440 + 1440 + 1 execuções, **0 falhas** — mas ver P-09: `succeeded` só significa "enfileirado no pg_net".

| Job | Retry | Se falhar | Impacto |
|---|---|---|---|
| `check-expired-bookings` | nenhum | próximo minuto tenta | 🟡 baixo, auto-recuperável |
| `notification-worker` | nenhum (nem no cron, nem no worker) | jobs ficam `pending` ou travam em `processing` para sempre | 🔴 silêncio de notificações (P-04) |
| `auto-complete-lessons` | nenhum | aulas não concluem | 🔴 **financeiro** — conclusão dispara liberação de repasse, e não há notificação `payment_released` para ninguém perceber |
| `sync-gateway-fees` | nenhum | 24h sem sincronizar taxas | 🔴 **financeiro mais grave** — 1×/dia, falha indistinguível de sucesso |

## L.2 Estado das três tabelas

| Tabela | Linhas | Tamanho | Janela | Autolimpeza |
|---|---:|---|---|---|
| `cron.job_run_details` | ~97.170 | 117 MB | 25/08 → 24/09 | ❌ **nenhuma** |
| `net._http_response` | 792 | 1.392 kB | ~6h | ✅ TTL do pg_net |
| `net.http_request_queue` | 0 | 40 kB | — | ✅ |

## L.3 Resultado da limpeza recente (P-1.23D.3A/3B)

- **3A** — `VACUUM FULL net._http_response`: 172 MB → 1.016 kB. ✅ estável (1.392 kB hoje, 792 linhas, autolimpeza funcionando).
- **B1** — DELETE de 193.719 linhas de `cron.job_run_details` (`runid ≤ 193719`), em 20 lotes, duração máxima 0,516 s, **zero falhas de cron**, período crítico 07–16/09 (31.680 linhas) **intacto**.
- **B2** — `VACUUM (ANALYZE)`: estatísticas corrigidas (`reltuples` 290.700 → 97.021), **tamanho em disco inalterado em 110 MB de heap** (comportamento esperado do VACUUM comum). Densidade caiu de ~20,6 para ~6,9 tuplas/página → **~⅔ do heap (≈73 MB) é espaço livre reutilizável**.
- **B3** (`VACUUM FULL`) — **ainda não executado**, aguardando decisão.

## L.4 Funcionamento correto?

✅ Sim: os 4 jobs seguiram executando durante toda a limpeza, 0 falhas registradas, período crítico preservado.

## L.5 Retenção coerente?

❌ **Não.** Não existe nenhuma retenção. A retenção efetiva hoje é "manual, quando alguém lembrar".

## L.6 Risco de crescimento e de recorrência do incidente de setembro

- Taxa medida: **3.169 linhas/dia** (= 1440+1440+288+1, perfeitamente determinístico), ~1,26 KB/linha.
- **+3,9 MB/dia · ~119 MB/mês · ~1,39 GB/ano.**
- **A partir de qualquer limpeza, a tabela volta aos 117 MB / ~97k linhas em exatamente ~30 dias.** É exatamente o que aconteceu desde 25/08.
- **~97% é ruído:** 2.880 das 3.169 linhas/dia vêm de dois jobs de minuto em minuto que quase nunca têm trabalho (61 jobs de notificação processados em 45 dias contra ~65.000 execuções).
- **Risco de recorrência do incidente de 07–16/09: NÃO ELIMINADO.** A causa raiz identificada em P-1.23D.1 foi o padrão de varredura sobre uma tabela grande sem índice em `start_time` (só PK em `runid`). Esse cenário **se reconstitui em ~30 dias** na ausência de retenção. A limpeza tratou o sintoma, não a causa.

---

# M. TESTES

| Métrica | Valor |
|---|---|
| Suítes em `lib/payments/tests/` | **51 arquivos** |
| Suítes SQL em `supabase/tests/` | 2 (`p1205_harness.pgsql.sql`, `p1205_reschedule.pgsql.sql` — 57 asserts) |
| Diretórios de teste paralelos na raiz | 9 (`tests-p110`, `tests-p116a`, `tests-p117`, `tests-p118e`, `tests-p118f3`, `tests-p118p22`, `tests-p118p26`, `tests-p119`, `tests-p1203`) |
| Runner | `scripts/run-tests.ts` |
| Bateria oficial (último resultado conhecido) | **39 testes, 35 PASS, 4 FAIL** — as 4 falhas foram classificadas como **baseline pré-existente** na auditoria P-1.20.5 |
| ESLint | ❌ **não existe** |
| `npm run lint` (= `tsc --noEmit`) | ❌ **9 erros**, todos em `supabase/functions/` (config Deno vs tsconfig Node) — permanentemente vermelho |

## Cobertura por domínio

| Domínio | Cobertura | Observação |
|---|---|---|
| Refund | ✅ **12 suítes** | domínio mais testado |
| Payout | ✅ 8 suítes (unit, integration, concurrency) | **testa código que nunca rodou em produção** (`payouts` = 0 linhas) |
| Settlement | ✅ unit + integration | |
| Reconciliação | ✅ 3 suítes | **testa código que não está agendado** |
| Comissão CNHJá | ✅ `CommissionCnhJaP121B` (22 asserts, fixtures = cópia literal das 33 settlements de produção) | |
| Remarcação | ✅ `RescheduleDirectP1204`, `RescheduleProposalP1205` + 57 asserts SQL | |
| Cancelamento | ✅ `CancelBookingFase3110`, `ConstraintAndCancellationCore` | |
| Webhook | ✅ `AsaasWebhookHardening` | |
| UI financeira | ✅ `FinanceUiCoherenceP122` (30), `InstructorStatementLessonsP121A` (26) | |
| **RLS** | ❌ **NENHUM TESTE** | nenhuma suíte valida policies — e é exatamente onde estão BL-01, BL-02, BL-10, BL-11, BL-13 |
| **Autenticação / autorização de rota** | ❌ **NENHUM** | |
| **Notificações / FCM** | ❌ **NENHUM** | |
| **Cron / pg_net** | ❌ **NENHUM** | |
| **E2E / fluxo completo** | ❌ **NENHUM** | |
| **Frontend (React)** | ❌ **NENHUM** teste de componente | |

## Testes frágeis / que não rodam sem secrets / que poderiam tocar produção

- **Não rodam sem secrets:** todas as `*.integration.test.ts` e `*.concurrency.test.ts` (`PayoutDatabase`, `PayoutEngine`, `PayoutWorker`, `ProjectionService`, `Reconciliation`, `SettlementService`, `PaymentStateService`, `RealIdempotencyIntegration`, `Wave2Hardening`) — exigem credenciais de banco. **NÃO VERIFICADO** contra qual banco apontam.
- ⚠️ **Risco de tocar produção:** se essas suítes leem `SUPABASE_SERVICE_ROLE_KEY` do `.env.local` (que aponta para `ohftsqsxymtrclnpadam`), **rodá-las escreveria no banco de produção**. Isso é consistente com a existência dos **5 registros de teste que nunca podem ser tocados** (3 appointments + 2 refund_operations), que são resíduo de execução contra produção. **Não executei nenhuma delas.**
- **Frágeis (confirmado historicamente):** testes que dependiam de formatação ICU pt-BR quebraram por "18 **de** set" e por `U+00A0` em `R$ 90,00`; corrigidos com normalização.

---

# N. PRODUÇÃO / VERCEL / SUPABASE / ASAAS

| Item | Situação |
|---|---|
| **Vercel — crons** | ❌ **nenhum**. O cron financeiro diário é disparado **de fora**, pelo pg_cron job 12 → HTTP POST ao Vercel. Acopla o agendamento financeiro à saúde do pg_net e cria dependência invisível a quem lê o `vercel.json` |
| **Vercel — headers** | ❌ **nenhum** (sem CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy) |
| **Vercel — regions** | ❌ não definido → default `iad1` (Washington DC) para app BR com Supabase em sa-east-1 |
| **Vercel — functions config** | ❌ ausente. `api/asaas-webhook.ts` (60 KB) e `api/create-booking-intent.ts` (31 KB) com timeout default de 10s |
| **Vercel — rewrites** | ✅ 1 rewrite SPA com exclusões corretas (inclusive do service worker) |
| **Supabase — região** | ✅ `sa-east-1` |
| **Supabase — compute** | ⚠️ **NANO** para um app com 4 jobs de cron (2 deles de minuto em minuto) |
| **Supabase — migrations** | ❌ 2 registradas × 68 arquivos (P-22) |
| **Supabase — `config.toml`** | ⚠️ 6 funções com `verify_jwt=false` (seção G) |
| **Supabase — Auth** | ⚠️ leaked password protection desabilitado |
| **Asaas — ambiente** | ❌ **SANDBOX em 7 defaults** (BL-09). Valor real no deploy: **NÃO VERIFICADO** |
| **Asaas — webhook secret** | ✅ fail-closed (`asaas-webhook.ts:96-102`): sem `ASAAS_WEBHOOK_SECRET`, tudo é rejeitado |
| **Asaas — `provider_payment_id`** | ⚠️ formato consistente com dados de teste (`pay_wk0uwd3eylx5ehsx`) |
| **`GatewayFeeModel`** | ⚠️ schedule embutido veio do "painel da conta Asaas **Sandbox** observado em 2026-09-18" (`:63-65`) |
| **Observabilidade** | ❌ **inexistente** — grep por Sentry/Datadog/logtail → 0. Nenhum alerta para: settlement falho, job travado, cron com HTTP 500, estorno preso |
| **`.env.local`** | presente (1.340 bytes). **Conteúdo e cobertura pelo `.gitignore`: NÃO VERIFICADOS.** Recomendo `git check-ignore -v .env.local` e, se já foi commitado, rotacionar tudo |

---

# O. CÓDIGO MORTO / FUNÇÕES ÓRFÃS

| Categoria | Itens |
|---|---|
| **Componentes** | `components/InstructorShareCard.tsx` (0 referências) |
| **Hooks** | `useInstructorFinance.ts`, `usePaymentState.ts`, `useStudentFinance.ts` |
| **Módulos só usados por testes** | `PayoutWorker.ts`, `ReconciliationService.ts`, `AsaasRefundAdapter.ts`, `PaymentStateErrors.ts` |
| **Subsistemas inteiros não acionados** | `PayoutEngine` + `PayoutRepository` + `PayoutStateMachine` + `PayoutKeyFactory` + `PayoutWorkerTypes` (tabela `payouts` = 0 linhas); `IntegrityChecker` |
| **Edge Functions órfãs** | `create-booking` (nenhum invoke no front, `verify_jwt=false`), `cleanup-scheduler` (fora de `config.toml` e de `cron.job`) |
| **Endpoints nunca acionados automaticamente** | `api/reconcile-payment.ts` (só `sync-payment-status`, que não está agendada), `api/sync-asaas-status.ts` (só botão manual), `api/debug-env.ts`, `api/worker.ts` |
| **Rotas órfãs** | `/student/payment` (desativada em código), `/student/payment/success\|cancelled\|expired` |
| **Estados sem produtor** | `appointments.status` = `blocked`, `scheduled`; filtro por `failed`/`rejected` em `reschedule_appointment_direct` (não existem no CHECK) |
| **Tipos de notificação sem emissor** | `booking_rejected` (helper existe, 0 linhas no banco), `payment_released`, `reminder`, `system`, `reschedule_rejected` |
| **Constantes importadas e não usadas** | `TERMS_VERSION`, `PRIVACY_VERSION`, `LGPD_EMAIL` |
| **Campo escrito e nunca lido** | `notifications.target_screen` (2 escritas, 0 leituras) |
| **Scripts soltos na raiz** | 15 `.ts` não referenciados pelo `package.json` (vários com `SERVICE_ROLE_KEY`) |
| **Resíduos** | `baseline-p*.txt` (4), `grep_output.txt`, `supabase_schema.sql` (33 KB divergente), `bun.lock` vazio, 9 dirs `tests-p1*`, `_to_delete/`, e 2 arquivos com nome corrompido: `Base31177.unit.test.ts' -or` e `tests -File \|` |
| **Migration criada e não aplicada** | `20260923_p1201b_04_drop_cancelling_status.sql` |
| **Dependências sem uso no bundle** | `sharp`, `micro` |

---

# P. CHECKLIST FINAL DE GO-LIVE

### Segurança
- [BLOQUEADOR] INSERT em `appointments` sem guarda de preço/status (BL-01)
- [BLOQUEADOR] `profiles` legível integralmente por qualquer autenticado (BL-02)
- [BLOQUEADOR] `instructors` legível por `anon` com wallet/credencial (BL-13)
- [BLOQUEADOR] `send-push-notification` publicamente invocável (BL-05)
- [BLOQUEADOR] `CRON_SECRET` vazado por telemetria (BL-06) e fail-open (BL-07)
- [BLOQUEADOR] `confirmed → cancelled` e `completed`/`no_show` alcançáveis direto do front (BL-10, BL-11)
- [BLOQUEADOR] 2 vulns `critical` + 11 `high` em dependências (BL-14)
- [PENDENTE] Buckets `avatars`/`assets` públicos sem limite de MIME/tamanho
- [PENDENTE] Headers de segurança no `vercel.json`
- [PENDENTE] Leaked password protection
- [PENDENTE] Webhook sem HMAC, sem rate limit, sem verificação de origem
- [PENDENTE] `create_unified_notification` executável por `authenticated`
- [OK] RLS habilitado em 26/26 tabelas
- [OK] 28 funções `SECURITY DEFINER` com `search_path` definido
- [OK] RPCs de remarcação derivam o papel de `auth.uid()`, com `FOR UPDATE`
- [OK] `refund_operations` e tabelas correlatas fail-closed
- [OK] Webhook fail-closed sem `ASAAS_WEBHOOK_SECRET`
- [NÃO VERIFICÁVEL] Auth interna de `create-booking`, `create-asaas-account`, `auto-complete-lessons`
- [NÃO VERIFICÁVEL] Segredos no histórico do Git

### Financeiro
- [BLOQUEADOR] Ambiente Asaas = sandbox nos defaults, sem fail-closed (BL-09)
- [BLOQUEADOR] Reconciliação e IntegrityChecker não rodam (BL-08)
- [PENDENTE] 3 aulas em `cancelling` com `payment_status='paid'`
- [PENDENTE] 2 estornos presos em `REQUESTED` (R$100 cada), sem reaper
- [PENDENTE] 7 webhooks presos em `PENDING` desde 11/08
- [PENDENTE] Backfill de `platform_fee` em 24 linhas históricas
- [PENDENTE] Guarda de `provider_wallet_id` incompleta (split silenciosamente removido)
- [PENDENTE] `sync-gateway-fees` 1×/dia sem retry e sem detecção de falha
- [PENDENTE] `reject-booking` com escopo divergente e falso sucesso no Vercel
- [OK] Invariante 10/90 no código
- [OK] Gross-up matematicamente exato; sobra fica com a plataforma
- [OK] Gorjeta 0% comissão (código + dados)
- [OK] Idempotência de webhook e de settlement (0 duplicatas)
- [OK] Preço server-authoritative **no endpoint** (anulado por BL-01 no sistema)
- [OK] `net_amount = 90%` em 36/36 linhas — instrutor nunca lesado
- [NÃO VERIFICADO] Rateio do Asaas de `totalFixedValue` entre parcelas
- [NÃO VERIFICADO] Valor real de `ASAAS_API_URL` no deploy

### Produto
- [BLOQUEADOR] Exclusão de conta inexistente (BL-03)
- [PENDENTE] Exportação/portabilidade inexistente
- [PENDENTE] Suspensão/banimento previsto nos Termos e inexistente
- [PENDENTE] `no_show` sem lógica financeira
- [PENDENTE] `returnUrl` do checkout quebrado (hash vs BrowserRouter)
- [PENDENTE] Deep links de push mortos
- [PENDENTE] Token FCM não removido no logout
- [PENDENTE] Sem retry/dead-letter de notificações; 1 job travado há 43 dias
- [PENDENTE] Falha de push reportada como sucesso
- [PENDENTE] Sem notificação de pagamento liberado, conclusão ou refund
- [PENDENTE] 35 `error.message` crus expostos ao usuário
- [PENDENTE] 5 loadings sem `finally` + `isProcessingPayment` que pode congelar
- [PENDENTE] Inconsistência de timezone na mesma tela
- [PENDENTE] Sem tratamento de offline/reconexão (`navigator.onLine` → 0 ocorrências)
- [PENDENTE] Sem tratamento de HTTP 401 em chamadas `fetch('/api/...')`
- [OK] Recuperação de senha sem enumeração de conta
- [OK] Remarcação preserva integralmente pagamento e settlement
- [OK] Idempotência das RPCs de remarcação e do `BookingCancellationCore`
- [OK] `SESSION_EXPIRED` tratado em todas as chamadas `invokeSecureFunction`

### Google Play
- [BLOQUEADOR] Nenhum artefato Android (BL-04)
- [BLOQUEADOR] `assetlinks.json` ausente
- [BLOQUEADOR] Exclusão de conta no app e por URL web
- [PENDENTE] Ícone `maskable` e screenshots
- [PENDENTE] Política pública mostra só a versão Aluno ao visitante anônimo
- [PENDENTE] Divergência de domínio (`autoescolabrasil.com` × `cnhja.com.br`)
- [PENDENTE] Página de suporte / URL pública de contato
- [OK] `/privacy` e `/terms` são rotas públicas sem guard
- [OK] `manifest.json` com `display: standalone`, `theme_color`, `scope`, `lang`
- [NÃO VERIFICÁVEL] Data Safety, classificação etária, descrição, screenshots na Console
- [NÃO VERIFICÁVEL] Enquadramento sob Payments/Financial Services policy — **confirmar na documentação oficial vigente**

### LGPD / Legal
- [BLOQUEADOR] Política omite 11 categorias de dados coletados (BL-12)
- [BLOQUEADOR] Exclusão de dados inexistente, com afirmação falsa na UI
- [PENDENTE] Bases legais por finalidade — **PENDENTE DE DEFINIÇÃO**
- [PENDENTE] Retenção — **PENDENTE DE DEFINIÇÃO** (nenhum prazo, nenhuma rotina de expurgo)
- [PENDENTE] Terceiros: só o Asaas é nomeado
- [PENDENTE] Transferência internacional não mencionada
- [PENDENTE] Controlador não identificado (razão social/CNPJ/endereço)
- [PENDENTE] Encarregado/DPO sem nome
- [PENDENTE] Consentimento não granular e sem versionamento efetivo
- [PENDENTE] Menores de idade não tratados
- [PENDENTE] Contato de confiança = dado de terceiro sem base legal nem aviso
- [PENDENTE] 21 divergências Termos × código (seção I)
- [PENDENTE] Cláusula de propriedade intelectual ausente
- [PENDENTE] `TermsModal` promete localização em tempo real inexistente
- [PENDENTE] Foro de eleição contra consumidor (risco de nulidade)
- [OK] Asaas nomeado como processador
- [OK] Intermediação de pagamento declarada
- [OK] Nenhum analytics/tracker de terceiro no código

### Infraestrutura
- [PENDENTE] `cron.job_run_details` sem retenção: volta a 117 MB em ~30 dias
- [PENDENTE] `succeeded` do pg_cron não detecta falha HTTP real
- [PENDENTE] B3 (`VACUUM FULL`) não executado — ~73 MB a recuperar
- [PENDENTE] Sem observabilidade (Sentry/Datadog/alertas)
- [PENDENTE] `vercel.json` sem regions e sem config de functions
- [PENDENTE] Compute NANO com 2 jobs de minuto em minuto
- [PENDENTE] Migrations não rastreadas (2 × 68)
- [OK] `net._http_response` e `net.http_request_queue` saudáveis e autolimpantes
- [OK] Os 4 jobs de cron sobreviveram à limpeza sem nenhuma falha
- [OK] Período crítico 07–16/09 (31.680 linhas) preservado

### Build / Qualidade
- [PENDENTE] `npm run lint` permanentemente quebrado (9 erros de config)
- [PENDENTE] ESLint inexistente
- [PENDENTE] 4 testes falhando na bateria oficial (baseline)
- [PENDENTE] Zero testes de RLS, auth, notificações, cron, E2E e frontend
- [PENDENTE] Testes de integração podem apontar para produção — **NÃO VERIFICADO**
- [PENDENTE] Limpeza de código morto (seção O)
- [OK] 51 suítes unitárias no domínio financeiro
- [OK] 57 asserts SQL de remarcação
- [OK] `scripts/sync-shared.ts --check` garante paridade do `BookingCancellationCore`

---

# CAMINHO MÍNIMO PARA "APTO COM PENDÊNCIAS"

Ordem sugerida, do que muda o veredito para o que pode esperar:

**1. Fechar a superfície de escrita (muda o veredito de segurança)**
BL-01 (trigger de INSERT), BL-10/BL-11 (trigger com `OLD.status` + ator), BL-02 (RLS de `profiles`), BL-13 (view pública de `instructors`), BL-05/BL-06/BL-07 (auth das Edge Functions).

**2. Fechar o financeiro (muda o veredito financeiro)**
BL-09 (`ASAAS_ENV` explícito e fail-closed), BL-08 (agendar reconciliação + reaper de estorno), P-01 (destravar as 3 aulas e os 2 estornos), P-02 (backfill).

**3. Fechar o requisito Play (muda o veredito de publicação)**
BL-03 (exclusão de conta in-app + URL web), BL-04 (empacotamento + `assetlinks.json`), BL-12 (política reescrita a partir do data inventory real), P-23/P-24.

**4. Depois disso**, as pendências P-04 a P-27 e os riscos R-01 a R-37 tornam o veredito defensável como **APTO COM PENDÊNCIAS**.

---

# REGRA FINAL — O QUE NÃO FOI VERIFICADO

| # | Item | O que falta para verificar |
|---|---|---|
| 1 | **Todo o comportamento em runtime** | A auditoria é 100% estática. Nenhum fluxo foi executado. Exigiria ambiente de staging isolado (não existe: `main` → Vercel → produção, sem preview branch) |
| 2 | Valor real de `ASAAS_API_URL`, `ASAAS_WEBHOOK_SECRET`, `CRON_SECRET`, `VITE_FIREBASE_VAPID_KEY` no deploy | Acesso ao painel de env vars do Vercel e aos secrets das Edge Functions |
| 3 | Auth interna de `create-booking`, `create-asaas-account`, `auto-complete-lessons` | Leitura dedicada desses 3 handlers (não foram lidos integralmente) |
| 4 | URLs de callback configuradas no painel Asaas | Acesso ao painel Asaas |
| 5 | Rateio do Asaas de `totalFixedValue` entre parcelas | Resposta real da API Asaas com o split por parcela |
| 6 | Conteúdo do `.env.local` e cobertura pelo `.gitignore` | `git check-ignore -v .env.local` + varredura do histórico |
| 7 | Contra qual banco apontam os testes de integração | Leitura da configuração de conexão de cada suíte |
| 8 | Screenshots, descrição, Data Safety, classificação etária | Play Console |
| 9 | Enquadramento sob Payments/Financial Services policy | Documentação oficial vigente do Google Play |
| 10 | Processo operacional de atendimento a pedidos LGPD por e-mail | Fora do repositório |
| 11 | Se houve limpeza manual de `cron.job_run_details` em 25/08 | Inferido da data mais antiga, não confirmado por log |
| 12 | `supabase/functions/cleanup-scheduler/index.ts` | Não lido integralmente; pode conter retenção/expurgo |
| 13 | Segredos no histórico do Git | `git log -p` + scanner de segredos |
| 14 | Causa exata dos 3.719 `n_dead_tup` residuais em `cron.job_run_details` após B2 | `pgstattuple` (não instalado) ou output `VERBOSE` do VACUUM (não retornado pelo MCP) |

---

**FIM DO RELATÓRIO.**

Nenhuma alteração foi feita. Nenhum commit, push ou deploy. Nenhuma alteração no banco. Nenhuma alteração de documentação. Aguardando sua análise para decidir a próxima etapa.
