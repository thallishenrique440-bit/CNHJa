# AP-10 — Plano de reset dos dados de teste

| | |
|---|---|
| **Status** | **PREPARADO — NÃO EXECUTADO** |
| **Quando executa** | **Somente no final**, depois de F6-01 e F6-02 |
| **Quem executa** | O proprietário, **manualmente**, após autorização explícita |
| **Data** | 2026-09-24 |

> **Nenhum comando deste documento foi executado.** Nenhum dado foi apagado. Nenhum `DELETE`, `TRUNCATE` ou `DROP` foi emitido contra `ohftsqsxymtrclnpadam`.

---

## 1. Pré-condições bloqueantes

O reset **não pode** começar antes de todas estas condições, sem exceção:

- [ ] **F6-01** — auditoria de código pré-reset aprovada (Fases 1, 3, 4 e 5 concluídas e validadas)
- [ ] **F6-02** — migrations reconciliadas contra o catálogo (CONFLITO-05: hoje 2 registradas × 69 arquivos)
- [ ] **AP-04** resolvido — tarifas reais de produção do Asaas confirmadas (o seed depende disso)
- [ ] **AP-13** executado e a correção de F4-01 aplicada e testada
- [ ] **AP-05** resolvido — política de retenção definida (define o que o reset apaga e o que a exclusão de conta apaga depois)
- [ ] **Backup completo** do banco realizado e **verificado restaurável**
- [ ] Autorização explícita e nominal do proprietário para esta operação

---

## 2. O que se apaga e o que se preserva

### 2.1 APAGAR — dados de teste

Em ordem de dependência de FK (folhas primeiro). Esta ordem foi derivada do grafo real de constraints lido em 2026-09-24.

| # | Tabela | Linhas hoje | Observação |
|---|---|---:|---|
| 1 | `notification_logs` | 1 | folha |
| 2 | `notification_jobs` | 62 | PK = `notification_id` |
| 3 | `notifications` | 62 | **FK `NO ACTION` para `profiles`** — precisa sair antes |
| 4 | `fcm_tokens` | 6 | `CASCADE`, mas explicitar |
| 5 | `student_favorites` | 1 | `CASCADE` |
| 6 | `reviews` | 1 | **FK `NO ACTION` nos dois lados** |
| 7 | `refund_operation_events` | 0 | |
| 8 | `refund_operation_items` | 0 | |
| 9 | `refund_operations` | 2 | inclui os 2 estornos presos em `REQUESTED` |
| 10 | `payouts` | 0 | **FK `RESTRICT`** para `instructors` |
| 11 | `payment_settlements` | 36 | |
| 12 | `payment_installments` | 36 | |
| 13 | `transactions` | 171 | **FK `NO ACTION`** nos dois lados; inclui os 7 webhooks `PENDING` |
| 14 | `cash_flow_projections` | 20 | **sem FK** — não sai por cascata, tem de ser explícito |
| 15 | `instructor_financial_projections` | 1 | |
| 16 | `platform_financial_projections` | 1 | zerar, não remover a linha de configuração se houver |
| 17 | `appointments` | 28 | inclui as 3 em `cancelling` |
| 18 | `instructor_vehicles` | 8 | |
| 19 | `instructor_categories` | 11 | |
| 20 | `instructor_discounts` | 6 | |
| 21 | `instructor_bank_details` | 0 | |
| 22 | `instructors` | 6 | |
| 23 | `profiles` | 12 | |
| 24 | `auth.users` | 12 | **por último** |
| 25 | `security_audit_logs` | 14 | ⚠️ tabela **imutável** por trigger `prevent_security_audit_mutation` — ver §5 |
| 26 | Bucket `avatars` | 51 objetos / 32,2 MB | ⚠️ **sem FK** — não sai com o usuário; delete separado |

### 2.2 PRESERVAR — configuração, não dados

| Tabela / objeto | Por quê |
|---|---|
| `gateway_fee_schedule` | **Repovoar** com as tarifas reais de produção (AP-04). As 5 linhas atuais vieram do painel **sandbox** e não servem. |
| `platform_financial_settings` | Configuração da plataforma |
| `notification_config` | `app_base_url` e `edge_function_url` — sem isso os crons param |
| Bucket `assets` (2 objetos) | Logo e PIX.png, usados em 6 telas pré-login |
| `cron.job` (4 jobs) | Agendamento |
| Todas as funções, triggers, policies, índices, constraints | O reset é de **dados**, não de esquema |
| `supabase_migrations.schema_migrations` | Reconciliado em F6-02, não apagado |
| Vault (`cron_secret`) | Segredos não são tocados |

---

## 3. Forma de entrega e execução

O script será entregue como **arquivo versionado** — `scripts/reset-test-data.sql` — e executado **manualmente** pelo proprietário. Estrutura obrigatória:

```
-- BLOCO 1 — VERIFICAÇÃO ANTES (somente SELECT, saída guardada)
-- BLOCO 2 — os DELETEs, em ordem de FK, um por tabela, com contagem
-- BLOCO 3 — VERIFICAÇÃO DEPOIS (somente SELECT)
-- BLOCO 4 — SEED pós-reset (gateway_fee_schedule com tarifas de produção)
```

### Princípios do script

1. **`DELETE`, não `TRUNCATE`.** `TRUNCATE` ignora triggers de FK e não devolve contagem por tabela. Além disso, `anon` e `authenticated` têm grant de `TRUNCATE` em várias tabelas — não é hora de exercitar esse caminho.
2. **Uma tabela por comando**, com `RETURNING`/contagem, para que a saída seja auditável linha a linha.
3. **Transação única** envolvendo o Bloco 2, com `BEGIN` / `COMMIT` explícitos, para que um erro no meio não deixe o banco parcialmente limpo.
4. **Sem `CASCADE` implícito**: cada tabela é apagada explicitamente, mesmo quando a FK cascatearia. Isso torna a contagem verificável e evita surpresa.
5. O script **não apaga** nada fora da lista de §2.1.

### Verificação ANTES (Bloco 1)

```sql
SELECT 'appointments' t, count(*) n FROM appointments
UNION ALL SELECT 'payment_installments', count(*) FROM payment_installments
UNION ALL SELECT 'payment_settlements', count(*) FROM payment_settlements
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'refund_operations', count(*) FROM refund_operations
UNION ALL SELECT 'payouts', count(*) FROM payouts
UNION ALL SELECT 'notifications', count(*) FROM notifications
UNION ALL SELECT 'notification_jobs', count(*) FROM notification_jobs
UNION ALL SELECT 'fcm_tokens', count(*) FROM fcm_tokens
UNION ALL SELECT 'reviews', count(*) FROM reviews
UNION ALL SELECT 'student_favorites', count(*) FROM student_favorites
UNION ALL SELECT 'cash_flow_projections', count(*) FROM cash_flow_projections
UNION ALL SELECT 'instructors', count(*) FROM instructors
UNION ALL SELECT 'profiles', count(*) FROM profiles
UNION ALL SELECT 'auth.users', count(*) FROM auth.users
UNION ALL SELECT 'gateway_fee_schedule (PRESERVAR)', count(*) FROM gateway_fee_schedule
UNION ALL SELECT 'notification_config (PRESERVAR)', count(*) FROM notification_config
ORDER BY 1;

-- Objetos de storage
SELECT bucket_id, count(*) FROM storage.objects GROUP BY 1;

-- Estado do esquema que NÃO pode mudar
SELECT count(*) AS policies FROM pg_policy
 WHERE polrelid IN (SELECT oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind='r');
SELECT count(*) AS funcoes_secdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef;
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;
```

### Verificação DEPOIS (Bloco 3)

O mesmo bloco, mais:

```sql
-- Todas as tabelas de dados devem estar em 0
-- gateway_fee_schedule, notification_config e platform_financial_settings NÃO
-- O contador de policies e de funções SECURITY DEFINER deve ser IDÊNTICO ao de antes
-- Os 4 cron jobs devem continuar active = true

-- Órfãos que o reset não alcança por não terem FK:
SELECT count(*) AS avatares_orfaos FROM storage.objects WHERE bucket_id = 'avatars';
SELECT count(*) AS projecoes_orfas FROM cash_flow_projections;
```

---

## 4. Critérios de sucesso

| # | Critério |
|---|---|
| 1 | Todas as tabelas de §2.1 com `count(*) = 0` |
| 2 | `gateway_fee_schedule` repovoada com as tarifas **de produção**, não sandbox |
| 3 | `notification_config` e `platform_financial_settings` intactas |
| 4 | Bucket `assets` intacto (2 objetos); bucket `avatars` em 0 objetos |
| 5 | Nº de policies, triggers, funções `SECURITY DEFINER` e índices **idêntico** ao de antes |
| 6 | 4 cron jobs `active = true` e executando |
| 7 | Nenhum erro de FK durante a execução |
| 8 | Um cadastro novo de aluno e de instrutor funciona ponta a ponta logo depois |

---

## 5. Pontos que exigem decisão antes de escrever o script

| # | Ponto | Por quê |
|---|---|---|
| 1 | **`security_audit_logs`** — a tabela é imutável por trigger. Apagar exige desabilitar o trigger temporariamente. **Desabilitar uma trilha de auditoria, mesmo por um instante, é decisão do proprietário.** Alternativa: preservar as 14 linhas e aceitar que contêm IP e e-mail de teste. |
| 2 | **Bucket `avatars`** — o delete não é SQL; é API de storage. Os 51 objetos incluem 43 órfãos já hoje. Decidir se o reset também limpa o bucket (recomendado) e por qual meio. |
| 3 | **`auth.users`** — apagar via SQL direto ou via Admin API do Supabase. A Admin API é o caminho suportado; SQL direto pode deixar resíduo em tabelas internas de `auth`. |
| 4 | **Tarifas de produção** — sem elas o Bloco 4 não pode ser escrito. Depende de AP-04. |
| 5 | **Momento** — o reset invalida qualquer link público de avatar já compartilhado e derruba todas as sessões ativas. Escolher janela. |

---

## 6. Rollback

**Não há rollback incremental.** A única reversão é **restaurar o backup completo** feito na pré-condição.

Por isso:

1. O backup é **obrigatório** e tem de ser **verificado restaurável** antes de começar — não basta existir.
2. O Bloco 2 roda em transação única: um erro aborta tudo e o banco fica como estava.
3. Se o Bloco 3 revelar qualquer divergência nos critérios 3, 5 ou 6 (configuração ou esquema alterados), **restaurar o backup imediatamente** — significa que o script saiu do escopo.

---

## 7. Depois do reset

O reset é pré-requisito de **F6-04** (testes finais com banco limpo), não o fim do processo. A bateria de F6-04 inclui, entre outros:

- cadastro de aluno e instrutor
- onboarding Asaas do instrutor
- compra PIX, cartão à vista e combo 4x
- verificação de `gross = net + platform_fee + fee_amount` em **100%** das linhas novas
- verificação de que o instrutor recebe exatamente 90%
- **tentativa de cancelamento após o aceite → deve falhar** (AP-11)
- **tentativa do aluno de marcar `completed` → deve falhar** (AP-03)
- estorno integral de cobrança 4x (valida a correção de F4-01 / AP-13)
- exclusão de conta in-app e por URL web

---

**NADA DESTE PLANO FOI EXECUTADO.** Aguardando a conclusão das fases anteriores e autorização explícita (AP-10).
