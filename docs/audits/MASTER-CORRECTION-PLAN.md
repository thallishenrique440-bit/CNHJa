# CNHJá — PLANO MESTRE DE CORREÇÃO
## Contrato de escopo para as fases de correção pré-lançamento

| | |
|---|---|
| **Documento** | `docs/audits/MASTER-CORRECTION-PLAN.md` |
| **Versão** | **1.1** |
| **Data** | 2026-09-24 (v1.0) · 2026-09-24 (v1.1) · **2026-09-25 (atualização §0.7)** |
| **Origem** | `P-RELEASE-AUDIT-001` (auditoria forense de pré-lançamento) |
| **Projeto Supabase** | `ohftsqsxymtrclnpadam` (sa-east-1, PostgreSQL 17.6, Compute NANO) |
| **Repositório** | `D:\projetos\CNHJa\CNHJa` — branch `main`, commit `abb3a17` |
| **Status do documento** | v1.1 — **5 aprovações implementadas/validadas** (AP-01, AP-03, AP-09, AP-11 + C-08), 8 analisadas, 2 preparadas |

> **Este documento não corrige nada.** É o contrato de escopo que delimita o que será feito nas próximas fases, em que ordem, com que critério de conclusão e com quais pontos de aprovação obrigatória.
---

# 0. ATUALIZAÇÃO v1.1 — 2026-09-24

> Esta seção foi **acrescentada** ao plano. **Nada do v1.0 foi removido.** Os 7 conflitos originais (C-01 a C-07), os 21 bloqueadores e os 73 itens permanecem íntegros nas seções seguintes. O que muda aqui é a **classificação das 15 aprovações** e o registro do que foi executado.

## 0.1 O que mudou nesta versão

| # | Mudança |
|---|---|
| 1 | As 15 aprovações (AP-01 a AP-15) passam a ter **classificação por grupo** e **status explícito**. |
| 2 | **4 aprovações fechadas e implementadas**: AP-03, AP-09, AP-11, AP-15. |
| 3 | **9 aprovações analisadas** sem implementação: AP-01, AP-02, AP-04, AP-05, AP-06, AP-07, AP-08, AP-12, AP-14. |
| 4 | **AP-13** reclassificada como **teste controlado** — protocolo preparado, execução bloqueada. |
| 5 | **AP-10** reclassificada como **execução futura** — plano preparado, não executado. |
| 6 | **4 novos conflitos** registrados: C-08, C-09, C-10, C-11. Os 7 anteriores permanecem. |
| 7 | Três documentos novos em `docs/audits/`: o relatório de auditoria (AP-15), o protocolo AP-13 e o plano de reset AP-10. |
| 8 | Correção de contagem: o v1.0 dizia "15 approvals" no corpo mas "12" no resumo executivo. **São 15**: AP-01 a AP-15. |

## 0.2 Classificação das 15 aprovações

### GRUPO 1 — Implementação autorizada e **CONCLUÍDA**

| AP | Assunto | Status | Entregue |
|---|---|---|---|
| **AP-03** | Aluno não altera status operacional da aula | ✅ **IMPLEMENTADO** | migration + 2 telas + 35 asserções |
| **AP-09** | Fixtures sintéticas/congeladas | ✅ **IMPLEMENTADO** | módulo de fixtures + 2 testes migrados |
| **AP-11** | Depois do aceite não há cancelamento, há remarcação | ✅ **IMPLEMENTADO** | mesma migration + verificação de coerência |
| **AP-15** | Versionar o relatório de auditoria | ⚠️ **PARCIAL** | arquivo colocado no repositório; `git add` **bloqueado** (ver §0.5) |

### GRUPO 2 — Análise obrigatória, **SEM implementação**

| AP | Assunto | Status | Resultado |
|---|---|---|---|
| **AP-01** | `appointments` INSERT — estratégia A | ✅ **ANALISADO** | Estratégia A é **barata**: 1 único fluxo a migrar |
| **AP-02** | Perfis / instructors — exposição mínima | ✅ **ANALISADO** | Mapa completo de leitores + desenho de 2 views + 2 RPCs |
| **AP-04** | Ambiente Asaas | ✅ **ANALISADO** | 7 fallbacks silenciosos; tarifas do banco = sandbox |
| **AP-05** | Retenção de dados | ✅ **ANALISADO** | Matriz completa; 6 bloqueadores duros de FK |
| **AP-06** | Android: TWA vs Capacitor | ✅ **ANALISADO** | Recomendação fundamentada: **TWA** |
| **AP-07** | Arquitetura de reconciliação | ✅ **ANALISADO** | Recomendação: `vercel.json crons` + reaper |
| **AP-08** | Buckets avatars / assets | ✅ **ANALISADO** | Recomendação: **manter públicos**, corrigir o ciclo de vida |
| **AP-12** | Bases legais LGPD | ✅ **ANALISADO** | Matriz de candidatas; nenhuma escolhida |
| **AP-14** | Alteração não commitada em teste de refund | ✅ **ANALISADO** | Contrato correto, **mock quebrado** → C-10 |

### GRUPO 3 — Teste controlado antes de alterar código

| AP | Assunto | Status |
|---|---|---|
| **AP-13** | Comportamento real do Asaas em cobrança parcelada | 📋 **PROTOCOLO PREPARADO — EXECUÇÃO BLOQUEADA** |

Protocolo em `docs/audits/AP-13-protocolo-teste-asaas-parcelado.md`. Bloqueado até: (a) confirmação de que o ambiente é Sandbox; (b) confirmação de que o webhook de sandbox **não** aponta para o banco de produção; (c) autorização explícita.

### GRUPO 4 — Reset de dados

| AP | Assunto | Status |
|---|---|---|
| **AP-10** | Reset dos dados de teste | 📋 **PLANO PREPARADO — NÃO EXECUTADO** |

Plano em `docs/audits/AP-10-plano-de-reset.md`. Executa somente após F6-01, F6-02, AP-04, AP-05 e AP-13 concluídos, com backup verificado restaurável.

## 0.3 O que foi efetivamente alterado no repositório

### Arquivos novos

| Arquivo | AP | O que é |
|---|---|---|
| `supabase/migrations/20260924_ap03_ap11_appointments_status_transition_guard.sql` | AP-03, AP-11 | Guarda de transição de status. **Versionada, NÃO aplicada.** |
| `supabase/tests/ap03_ap11_status_transition.pgsql.sql` | AP-03, AP-11 | Bateria funcional da matriz, para PostgreSQL efêmero |
| `lib/payments/tests/fixtures/syntheticFinanceFixtures.ts` | AP-09 | Fixtures sintéticas derivadas dos invariantes do produto |
| `lib/payments/tests/StatusAuthorityAP03AP11.unit.test.ts` | AP-03, AP-11 | 35 asserções estáticas sobre autoridade de status |
| `docs/audits/P-RELEASE-AUDIT-001-release-audit.md` | AP-15 | Relatório de auditoria de pré-lançamento |
| `docs/audits/AP-13-protocolo-teste-asaas-parcelado.md` | AP-13 | Protocolo de teste controlado |
| `docs/audits/AP-10-plano-de-reset.md` | AP-10 | Plano de reset |

### Arquivos alterados

| Arquivo | AP | Alteração |
|---|---|---|
| `pages/student/Lessons.tsx` | AP-03 | Removida a escrita de `status: 'completed'` pelo aluno (era em lote, sem CAS) e o estado otimista correspondente |
| `pages/InstructorAgenda.tsx` | AP-03 | CAS por status em `handleFinalizeLesson` e `handleNoShow` |
| `lib/payments/tests/CommissionCnhJaP121B.unit.test.ts` | AP-09 | FIXTURES deixou de ser cópia literal de 33 settlements de produção |
| `lib/payments/tests/ConstraintAndCancellationCore.unit.test.ts` | AP-09 | Substituídos o appointment UUID e o `provider_payment_id` de produção por sintéticos |
| `scripts/run-tests.ts` | AP-03 | Nova suíte adicionada à lista ALLOW |

### O que NÃO foi feito

- ❌ Nenhuma migration aplicada. A migration está versionada e aguarda aplicação **manual**.
- ❌ Nenhum SQL de escrita executado em produção. Somente `SELECT`.
- ❌ Nenhum deploy, commit ou push.
- ❌ Nenhum dado apagado. Nenhum reset.
- ❌ Nenhum refund executado. Nenhuma alteração no Asaas. Nenhum secret tocado.
- ❌ **Nada de AP-01** — as policies e grants de INSERT em `appointments` permanecem intocados.

## 0.4 Decisões de escopo tomadas durante a execução

| # | Situação | Decisão |
|---|---|---|
| 1 | AP-03 e AP-11 compartilham a mesma função de trigger | Uma única migration atende as duas, evitando duas reescritas da mesma função |
| 2 | A guarda de INSERT (F1-01) fica na mesma função | **Não tocada.** Depende de AP-01, ainda aberta. A migration é explicitamente `BEFORE UPDATE`, e o teste D10/D11/D12 **prova** que ela não mexe em policies, grants nem esquema |
| 3 | O aluno perde a escrita de `completed` | O fluxo legítimo (avaliação + gorjeta) é preservado: a policy de INSERT em `reviews` exige `auth.uid() = student_id` e perfil completo, **nunca** `status='completed'` — verificado em `pg_policy` |
| 4 | `cancelled` a partir de estados pré-aceite | **Mantido permitido** para ambas as partes, de forma conservadora. Nenhum caminho vivo de cliente o usa, mas restringi-lo seria ampliar escopo sem necessidade |
| 5 | `pending_approval` some da lista permitida ao cliente | Seus dois únicos produtores são `service_role`. Fecha o buraco de reabrir aula encerrada |
| 6 | Fixtures de `CommissionCnhJaP121B` | **Congeladas como sintéticas**, não regeneradas. Sobrevivem ao reset (AP-10) |
| 7 | AP-14 encontrou teste que não roda | **Não corrigido.** AP-14 é análise-apenas. Registrado como C-10 |

## 0.5 Bloqueio ativo: `.git/index.lock`

**CONFIRMADO** — existe `.git/index.lock` (0 bytes, criado em 2026-09-24 14:33), órfão de uma sessão anterior. Enquanto ele existir, **nenhuma operação de escrita do git funciona**: `git add`, `git commit`, `git stash`.

Consequência: **AP-15 ficou PARCIAL.** O relatório foi colocado em `docs/audits/P-RELEASE-AUDIT-001-release-audit.md`, mas não pôde ser registrado no índice do git.

O ambiente desta sessão não consegue remover arquivos dentro da pasta conectada. **Ação do proprietário:**

```
del D:\projetos\CNHJa\CNHJa\.git\index.lock
```

Depois disso, `git add` dos arquivos desta etapa — **explicitamente, nunca `git add .`**, porque há 8 itens não rastreados de fases anteriores (`_to_delete/`, 4 `baseline-*.txt`, `tests -File |`, `tests-p116a/`, `tests-p118e/`) que não devem entrar.

## 0.6 Testes executados nesta etapa

| Suíte | Asserções | Resultado |
|---|---:|---|
| `CommissionCnhJaP121B.unit.test.ts` (migrado para fixtures sintéticas) | 24 | ✅ **24 PASS, 0 FAIL** |
| `ConstraintAndCancellationCore.unit.test.ts` (IDs sintéticos) | 13 | ✅ **13 PASS, 0 FAIL** |
| `StatusAuthorityAP03AP11.unit.test.ts` (novo) | 35 | ✅ **35 PASS, 0 FAIL** |
| `supabase/tests/ap03_ap11_status_transition.pgsql.sql` | 25 | ⏸ **NÃO EXECUTADO** — requer PostgreSQL efêmero |
| `RefundReconciliationFase31.unit.test.ts` (AP-14) | — | ❌ **NÃO EXECUTA** — ver C-10 |

**Total executado: 72 asserções, 72 PASS, 0 FAIL.**

Nota de ambiente: `npx tsx` **não roda** no shell Linux desta sessão — `node_modules/@esbuild` contém apenas o binário `win32-x64`. Os testes foram compilados com `./node_modules/.bin/tsc` e executados com `node`. A bateria oficial (`npx tsx scripts/run-tests.ts`) precisa ser rodada **no Windows** pelo proprietário para confirmar o baseline completo.

---


---

## 0.7 ATUALIZAÇÃO 2026-09-25 — AP-01 e C-08 concluídos

> Acrescentado em 2026-09-25. Nada das seções anteriores foi removido.

### 0.7.1 AP-01 / BL-01 — CONCLUÍDO

A migration `20260925_ap01_appointments_insert_authority.sql` foi **aplicada em produção** e está registrada como `20260925091715`.

Auditoria pós-aplicação (somente `SELECT`, 2026-09-25):

| Verificação | Estado |
|---|---|
| Migration registrada | ✅ `20260925091715` presente em `supabase_migrations.schema_migrations` |
| Função `check_appointments_insert_authority` | ✅ existe, `SECURITY DEFINER`, `search_path=public` |
| Trigger `appointments_insert_authority_trigger` | ✅ habilitado (`O`), **INSERT=true / UPDATE=false** |
| Triggers em `appointments` | ✅ 3: `appointments_insert_authority_trigger`, `appointments_security_check_trigger`, `tr_set_updated_by` |
| Policies de INSERT | ✅ **1** — apenas `Instructors can block slots`. As duas policies de aluno foram removidas |
| Policies totais em `appointments` | 8 → **6** |
| Grants `anon` | 7 privilégios → **`SELECT` apenas** |
| Grants `authenticated` | 7 privilégios → **`DELETE, INSERT, SELECT, UPDATE`** (perdeu `TRUNCATE`, `TRIGGER`, `REFERENCES`) |

**Bateria funcional:** `supabase/tests/ap01_appointments_insert_authority.pgsql.sql` → **13/13 PASS**, `rc=0`, executada em PostgreSQL 16 efêmero pelo procedimento documentado, **sem nenhum patch**.

O bloqueador registrado na auditoria anterior — harness `p1205_harness.pgsql.sql` sem as colunas `proposal_*`, causando `record "new" has no field "proposal_status"` — **foi corrigido**: as 7 colunas do modelo de proposta (migration `20260923_p1205_01`) foram declaradas no harness. Isso alinha o harness à produção e destrava também as baterias futuras.

**Estratégia adotada:** Estratégia B (remover as policies de INSERT do aluno + trigger fail-closed), não a Estratégia A (revogar `INSERT` de `authenticated`). O efeito de segurança é equivalente — sem policy de INSERT que case, o aluno não insere de forma alguma — e evita criar a RPC `block_instructor_slot`. O grant de `INSERT` de `authenticated` permanece porque `DELETE` é necessário para `Instructors can delete blocks` e o par é concedido em conjunto.

### 0.7.2 C-08 — ENCERRADO

`create-booking` publicada como **versão 62**, `verify_jwt = true`, corpo reduzido a um handler que responde **410 `ENDPOINT_GONE`**, sem `createClient`, sem `SERVICE_ROLE_KEY` e sem escrita no banco. Confirmado via `list_edge_functions` em 2026-09-25.

O bypass de autoridade de criação que a Estratégia A não alcançava (por usar `service_role`) está fechado. A remoção definitiva do diretório segue em **F4-07**.

### 0.7.3 AP-03 / AP-11 — íntegros após AP-01

| Verificação | Estado |
|---|---|
| `check_appointments_update_security` | ✅ md5 do corpo sem comentários = `6173ed6d7396066728204c335a0e6b0a` — **idêntico** ao registrado no deploy de AP-03/AP-11 e ao do repositório |
| `appointments_security_check_trigger` | ✅ habilitado, `SECURITY DEFINER` preservado |
| Coexistência dos dois triggers | ✅ INSERT-only e UPDATE-only, sem interferência (probe no efêmero) |
| Bateria AP-03/AP-11 reexecutada | ✅ **29 asserções, 0 FAIL**, com AP-01 aplicado e harness novo |

### 0.7.4 Dados financeiros — sem alteração indevida

Contagens idênticas às da auditoria anterior; nenhuma linha criada, alterada ou removida pelas migrations.

| Tabela | Linhas |
|---|---:|
| `appointments` | 28 (`cancelled:3 \| cancelling:3 \| completed:19 \| expired:3`; `blocked:0`) |
| `payment_installments` | 36 |
| `payment_settlements` | 36 |
| `transactions` | 171 |
| `refund_operations` | 2 |
| `payouts` | 0 |
| `profiles` / `instructors` | 12 / 6 |

Baseline financeiro registrado: `sum(gross_amount)` = **258.637**, `sum(net_amount)` = **226.701**, `sum(platform_fee)` = **29.952**. Última transação: 2026-09-23 20:48:51 — nada novo escrito. 4 jobs de cron ativos, **0 falhas** em 2h.

### 0.7.5 AP-04 — decisão do proprietário registrada

> **Sandbox mantido por decisão do proprietário; produção de pagamentos será tratada somente na fase final de validação.**

- **NÃO** trocar a chave do Asaas Sandbox pela real agora.
- Manter o Sandbox durante **toda** a fase de implementação e correção.
- A migração para credenciais reais ocorre **somente no final**, depois dos testes funcionais completos.
- Não alterar credenciais, ambiente ou endpoint para produção neste momento.

Consequência para o plano: **F1-09 permanece aberto por decisão, não por pendência técnica.** O trabalho de código de AP-04 (variável `ASAAS_ENV` explícita e fail-closed) pode ser preparado a qualquer momento; a **virada** de ambiente é evento da fase final, junto com o repovoamento de `gateway_fee_schedule` com as tarifas reais (hoje as 5 linhas do banco são, pelos próprios `notes`, seed do painel Sandbox).

### 0.7.6 AP-05 — requisito de produto futuro: modo FÉRIAS

Registrado como **requisito**, não implementado. Quando AP-05 chegar à implementação, deverá incluir:

- **Ativação de FÉRIAS pelo instrutor.** Com o modo ativo, o instrutor **deixa de aparecer** para alunos e **não disponibiliza horários** para novas comparações ou agendamentos.
- **Nada é apagado:** histórico, financeiro e aulas existentes permanecem íntegros.
- **Analisar separadamente**, na implementação, o comportamento de:
  - aulas **já confirmadas** dentro do período de férias;
  - propostas de remarcação pendentes;
  - demais compromissos existentes.

Pontos de contato já mapeados nas análises deste plano, úteis quando a implementação começar: a vitrine (`pages/StudentHome.tsx`), o perfil público (`pages/student/InstructorProfile.tsx`), o link curto (`pages/InstructorShortLink.tsx`) e a RPC `get_instructor_availability`. A decisão sobre aulas já confirmadas é de produto e não deve ser inferida.

**NÃO implementar agora.**

### 0.7.7 Novo achado registrado (não investigado)

- **N-03 — `config.toml` não é fonte de verdade do `verify_jwt` publicado.** `create-tip` está ACTIVE em produção com `verify_jwt = false`, mas **não consta** em `supabase/config.toml` — onde a ausência significaria o default `true`. Cada função mantém o valor com que foi publicada, e só um redeploy o altera (foi exatamente assim que C-08 se fechou). `create-tip` cria cobranças no Asaas. Registrado como pendência separada, **fora do escopo atual**, sem investigação.

N-01 e N-02 permanecem registrados e **fora do escopo**, sem alteração.

### 0.7.8 Estado de Git e Vercel

- **AP-01 e C-08 não foram commitados.** `HEAD` = `474e6a2` = `origin/main`. Os arquivos estão no working tree.
- **Nenhum redeploy de frontend é necessário para AP-01/C-08:** nenhuma alteração toca o bundle do Vite. As mudanças são banco, Edge Function, testes e configuração.
- O conector MCP da Vercel apareceu nesta sessão mas **exige autorização**, então a correspondência do deployment de produção com `474e6a2` permanece **NÃO VERIFICÁVEL** por esta via.

### 0.7.9 Arquivos de AP-01 / C-08 no working tree

| Arquivo | Estado | Pertence a |
|---|---|---|
| `supabase/migrations/20260925_ap01_appointments_insert_authority.sql` | novo | AP-01 |
| `supabase/tests/ap01_appointments_insert_authority.pgsql.sql` | novo | AP-01 |
| `lib/payments/tests/InsertAuthorityAP01.unit.test.ts` | novo | AP-01 |
| `supabase/tests/p1205_harness.pgsql.sql` | modificado | AP-01 (correção do harness) |
| `scripts/run-tests.ts` | modificado | AP-01 (ALLOW) |
| `supabase/functions/create-booking/index.ts` | modificado | C-08 |
| `supabase/config.toml` | modificado | C-08 |

**Não pertencem** e não devem entrar no commit: `lib/payments/tests/RefundReconciliationFase31.unit.test.ts` (C-10), `supabase/.temp/cli-latest`, e os não rastreados `.claude/`, `_to_delete/`, `baseline-*.txt`, `tests -File |`, `tests-p116a/`, `tests-p118e/`.

`docs/` continua **não rastreado** — **AP-15 segue pendente** (`git add docs/`).

### 0.7.10 Status consolidado das 15 aprovações

| AP | Estado em 2026-09-25 |
|---|---|
| **AP-01** | **IMPLEMENTADO/VALIDADO** — aplicado em produção (`20260925091715`), 13/13 PASS |
| AP-02 | AUDITADO, NÃO IMPLEMENTADO |
| **AP-03** | **IMPLEMENTADO/VALIDADO** |
| AP-04 | AUDITADO — **Sandbox mantido por decisão do proprietário**; virada só na fase final |
| AP-05 | AUDITADO, NÃO IMPLEMENTADO — **+ requisito FÉRIAS registrado** |
| AP-06 | AUDITADO, NÃO IMPLEMENTADO |
| AP-07 | AUDITADO, NÃO IMPLEMENTADO |
| AP-08 | AUDITADO, NÃO IMPLEMENTADO |
| **AP-09** | **IMPLEMENTADO/VALIDADO** |
| AP-10 | PLANO PREPARADO |
| **AP-11** | **IMPLEMENTADO/VALIDADO** |
| AP-12 | AUDITADO, NÃO IMPLEMENTADO |
| AP-13 | PROTOCOLO PREPARADO — execução bloqueada |
| AP-14 | AUDITADO, NÃO IMPLEMENTADO |
| AP-15 | PENDENTE — `docs/` não rastreado |

**Bloqueadores fechados até aqui:** F1-01 (BL-01), F1-04, F1-05, C-08. **C-09 parcialmente fechado** (`anon` desarmado; `authenticated` mantém INSERT/UPDATE/DELETE por desenho).


---

# 1. RESUMO EXECUTIVO

## 1.1 Veredito herdado

A auditoria `P-RELEASE-AUDIT-001` concluiu **NÃO APTO** para publicação na Google Play Store, com base em 14 bloqueadores confirmados por evidência direta (catálogo do PostgreSQL, código com arquivo:linha, consultas ao banco).

Este plano reorganiza esses bloqueadores mais as descobertas desta sessão de planejamento em **6 fases**, com **73 itens** rastreáveis.

## 1.2 O que mudou desde o relatório

Esta etapa de planejamento **re-verificou o estado atual do código e do banco** e encontrou **7 conflitos** entre o relatório, o código e as premissas declaradas pelo proprietário. Todos estão registrados na seção 8 e **nenhum foi resolvido silenciosamente**.

O conflito mais material é o **CONFLITO-02**: em produção, cada parcela de um pagamento 4x tem um `provider_payment_id` **distinto** (4 parcelas = 4 `provider_payment_id`). Isso **inverte a leitura** do risco de refund parcial e torna o teste `InstallmentFullRefundFase3114` incoerente com o formato real dos dados. Detalhado em §5.4.

## 1.3 Decisão estrutural do proprietário incorporada ao plano

O banco atual contém **dados de ambiente de teste** e será **integralmente limpo antes do lançamento**. Portanto:

- **Nenhuma fase tentará reconstruir historicamente operações financeiras.**
- Os R$100 × 2 presos em `refund_operations` e as 3 aulas em `cancelling` são **DADOS DE TESTE — DESCARTÁVEIS NO RESET FINAL**.
- O que se preserva é **apenas a validação de que o CÓDIGO atual está correto**, não o estado dos dados.

Isso elimina do escopo o que teria sido a fase mais cara da auditoria (reconciliação histórica) e reduz P-02 (backfill de `platform_fee` em 24 linhas) de "correção de dados" para "validação de código".

## 1.4 Estratégia de execução acordada

```
Claude prepara código / migrations / testes
        ↓
Proprietário revisa as alterações
        ↓
SQL de produção aplicado MANUALMENTE, após autorização explícita
```

**Nenhuma solução neste plano exige execução automática de SQL.** Toda migration será entregue como arquivo versionado em `supabase/migrations/`, acompanhada do SQL de verificação (`SELECT`) a ser rodado antes e depois, e de um procedimento de rollback.

## 1.5 Números

| Fase | Itens | Bloqueadores |
|---|---:|---:|
| FASE 1 — Blockers de segurança e publicação | 17 | 17 |
| FASE 2 — Dados financeiros de teste | 8 | 0 |
| FASE 3 — LGPD / Termos / Privacidade / Publicação | 16 | 3 |
| FASE 4 — Refund legado | 9 | 1 |
| FASE 5 — Demais funcionalidades | 19 | 0 |
| FASE 6 — Auditoria final | 4 | 0 |
| **TOTAL** | **73** | **21** |

**Conflitos encontrados:** 7
**Pontos que exigem aprovação antes de qualquer mudança:** 15 (AP-01 a AP-15) — *corrigido na v1.1: o v1.0 dizia 12 aqui e 15 na seção 15*

---

# 2. LISTA COMPLETA DE BLOCKERS

Consolidação dos 14 bloqueadores do relatório + 7 promovidos nesta etapa de planejamento. A coluna FASE indica onde cada um é tratado.

| ID | Origem | Bloqueador | FASE | Migration? | Código? |
|---|---|---|---|---|---|
| F1-01 | BL-01 | INSERT em `appointments` sem guarda de preço/status | 1 | ✅ SIM | ✅ SIM |
| F1-02 | BL-02 | `profiles` legível integralmente por qualquer autenticado | 1 | ✅ SIM | ✅ SIM |
| F1-03 | BL-13 | `instructors` legível por `anon` com wallet/credencial | 1 | ✅ SIM | ✅ SIM |
| F1-04 | BL-10 | `confirmed → cancelled` alcançável direto do frontend | 1 | ✅ SIM | ❌ NÃO |
| F1-05 | BL-11 | Aluno pode marcar `completed` / `no_show` | 1 | ✅ SIM | ✅ SIM |
| F1-06 | BL-05 | `send-push-notification` publicamente invocável | 1 | ❌ NÃO | ✅ SIM |
| F1-07 | BL-06 | Telemetria vaza `CRON_SECRET` caractere a caractere | 1 | ❌ NÃO | ✅ SIM |
| F1-08 | BL-07 | `CRON_SECRET` fail-open | 1 | ❌ NÃO | ✅ SIM |
| F1-09 | BL-09 | Ambiente Asaas = sandbox em 7 defaults, sem fail-closed | 1 | ❌ NÃO | ✅ SIM |
| F1-10 | BL-14 | 2 vulns `critical` + 11 `high` em dependências | 1 | ❌ NÃO | ✅ SIM |
| F1-11 | NOVO | 3 Edge Functions com `verify_jwt=false` e auth interna NÃO VERIFICADA | 1 | ❌ NÃO | ⚠️ A DEFINIR |
| F1-12 | BL-03 | Exclusão de conta inexistente (app + URL web) | 1 | ✅ SIM | ✅ SIM |
| F1-13 | BL-04 | Nenhum artefato Android existe | 1 | ❌ NÃO | ✅ SIM |
| F1-14 | BL-08 | Reconciliação e IntegrityChecker não rodam | 1 | ⚠️ TALVEZ | ✅ SIM |
| F1-15 | P-20 | Buckets `avatars` e `assets` públicos sem limite | 1 | ✅ SIM | ❌ NÃO |
| F1-16 | P-27 | `vercel.json` sem nenhum header de segurança | 1 | ❌ NÃO | ✅ SIM |
| F1-17 | P-21 | Leaked password protection desabilitado | 1 | ❌ NÃO | ❌ NÃO (painel) |
| F3-01 | BL-12 | Política omite 11 categorias de dados coletados | 3 | ❌ NÃO | ✅ SIM |
| F3-02 | NOVO | Afirmação falsa na UI sobre exclusão de conta | 3 | ❌ NÃO | ✅ SIM |
| F3-03 | NOVO | Data Safety inconsistente com a política publicada | 3 | ❌ NÃO | ❌ NÃO (Console) |
| F4-01 | CONFLITO-02 | Refund integral pode atingir só 1 parcela de 4 | 4 | ❌ NÃO | ✅ SIM |

---

# 3. FASE 1 — BLOCKERS DE SEGURANÇA E PUBLICAÇÃO

> **Princípio da Fase 1:** fechar a superfície de escrita e de leitura antes de qualquer outra coisa. Nenhum item desta fase depende do estado dos dados — todos são defeitos de **código, policy ou configuração**, e portanto sobrevivem ao reset do banco.

---

## F1-01 — INSERT em `appointments` sem guarda de preço e status

| Campo | Conteúdo |
|---|---|
| **Problema** | Um usuário autenticado pode inserir uma linha em `appointments` com `price` e `status` arbitrários, sem passar por `create-booking-intent`. |
| **Evidência** | `pg_policy` em `appointments`: as duas policies de INSERT são `CHECK (auth.uid() = student_id)` e `CHECK (auth.uid() = student_id AND is_profile_complete = true)`. Nenhuma restringe `price` ou `status`.<br>`pg_trigger` em `appointments`: apenas `appointments_security_check_trigger` (**BEFORE UPDATE**) e `tr_set_updated_by` (BEFORE INSERT/UPDATE, só preenche `updated_by`).<br>`has_table_privilege('authenticated','public.appointments','INSERT')` = `true`. |
| **Arquivos envolvidos** | Banco: policies `Students can create appointments`, `Students can book appointments`; função `check_appointments_update_security`; trigger `appointments_security_check_trigger`.<br>Código: `api/create-booking-intent.ts` (autoridade de preço a preservar), `lib/payments/LessonPricing.ts`. |
| **Causa** | O hardening de `appointments` foi feito **apenas para UPDATE**. O caminho de INSERT sempre foi assumido como exclusivo do backend, mas o PostgREST expõe INSERT direto a `authenticated`. |
| **Impacto** | Aula gratuita. Instrutor com horário bloqueado sem receber. Toda a autoridade de preço server-side de `create-booking-intent` (que é exemplar, com fail-closed `PRICE_AUTHORITY_UNRESOLVED` em `:429-435`) torna-se irrelevante. **Fraude financeira direta.** |
| **Correção proposta** | **Opção A (recomendada):** `REVOKE INSERT ON public.appointments FROM authenticated` e mover a criação de aulas para uma RPC `SECURITY DEFINER` ou manter exclusivamente via service_role no backend. Exige mapear todos os INSERTs feitos hoje pelo frontend (inclusive `Instructors can block slots`).<br>**Opção B:** trigger `BEFORE INSERT` que, quando `auth.role() = 'authenticated'`, force `status` a um conjunto mínimo e derive `price` do servidor.<br>**A escolha entre A e B é um ponto de aprovação (AP-01).** |
| **Exige migration?** | ✅ **SIM** — nova policy e/ou trigger + revogação de privilégio. |
| **Exige alteração de código?** | ✅ **SIM** se Opção A (o bloqueio de horário do instrutor em `InstructorAgenda.tsx` insere direto). ❌ se Opção B. |
| **Testes necessários** | 1. Teste SQL (`supabase/tests/`) provando que `authenticated` não consegue inserir `price` arbitrário.<br>2. Teste provando que o bloqueio de horário do instrutor continua funcionando.<br>3. Teste provando que `create-booking-intent` continua criando aulas normalmente.<br>4. **Primeiro teste de RLS do projeto** — hoje a cobertura é zero nessa área. |
| **Dependências** | Nenhuma. É o item de maior prioridade absoluta. |
| **Critério objetivo de conclusão** | `INSERT INTO appointments (student_id, instructor_id, date, start_time, end_time, price, status) VALUES (auth.uid(), ..., 1, 'confirmed')` executado com JWT de aluno **falha**; e o fluxo de compra via `create-booking-intent` continua passando na bateria oficial. |

---

## F1-02 — `profiles` legível integralmente por qualquer autenticado

| Campo | Conteúdo |
|---|---|
| **Problema** | Policy `Authenticated users can read profiles` com `USING (true)` para a role `authenticated`. |
| **Evidência** | `pg_policy`: `polname='Authenticated users can read profiles'`, `polcmd='r'`, `roles='authenticated'`, `using_expr='true'`.<br>Colunas de `profiles`: `id, email, full_name, role, city, created_at, updated_at, avatar_url, trusted_contact, security_message, experience_level, cnh_process_type, phone, terms_accepted_at, terms_version, is_profile_complete, provider_name, provider_customer_id, cpf`. |
| **Arquivos envolvidos** | Banco: policy acima.<br>Código consumidor a mapear: `pages/StudentHome.tsx`, `pages/student/InstructorProfile.tsx`, `pages/InstructorAgenda.tsx` (lê `phone` do aluno para o WhatsApp), `contexts/AuthContext.tsx`. |
| **Causa** | Policy criada para permitir que aluno e instrutor vejam o nome um do outro, mas escrita como leitura total da tabela em vez de leitura das colunas necessárias sobre as contrapartes de uma aula. |
| **Impacto** | Vazamento de **CPF, e-mail, telefone e contato de confiança de 100% da base** para qualquer conta criada. Violação de LGPD art. 6º (necessidade) e art. 46. O `trusted_contact` é dado de **terceiro** que sequer consentiu. |
| **Correção proposta** | 1. Substituir por policy restrita: `USING (auth.uid() = id)`.<br>2. Criar view `public.public_profiles` com apenas `id, full_name, avatar_url, city`, legível por `authenticated`.<br>3. Para o caso legítimo "instrutor precisa do telefone do aluno de uma aula confirmada": policy adicional condicionada à existência de um `appointment` entre as partes em status apropriado, **ou** expor o telefone via RPC `SECURITY DEFINER` que valide o vínculo.<br>**A escolha entre policy condicional e RPC é ponto de aprovação (AP-02).** |
| **Exige migration?** | ✅ **SIM** |
| **Exige alteração de código?** | ✅ **SIM** — telas que hoje fazem `select('*')` em `profiles` precisam apontar para a view/RPC. |
| **Testes necessários** | 1. Teste SQL: aluno A não lê `cpf`/`phone` do aluno B.<br>2. Teste SQL: instrutor lê `phone` do aluno **apenas** de aula confirmada sua.<br>3. Teste de regressão das telas afetadas. |
| **Dependências** | Nenhuma. |
| **Critério objetivo de conclusão** | `SELECT cpf, phone, trusted_contact FROM profiles WHERE id <> auth.uid()` com JWT de usuário comum retorna **0 linhas**; e as telas de home, perfil do instrutor e agenda continuam funcionando. |

---

## F1-03 — `instructors` legível por `anon` com credencial e wallet

| Campo | Conteúdo |
|---|---|
| **Problema** | Policy `Public profiles are viewable by everyone` com `USING (true)` sem restrição de role (PUBLIC), e `anon` tem privilégio de SELECT. |
| **Evidência** | `pg_policy` em `instructors`; `has_table_privilege('anon','public.instructors','SELECT')` = `true`.<br>Colunas expostas: `credential_number`, `whatsapp`, `provider_account_id`, `provider_wallet_id`, `provider_status`, `meeting_point_lat/lng`. |
| **Arquivos envolvidos** | Banco: policy acima. Código: `pages/StudentHome.tsx`, `pages/student/InstructorProfile.tsx`, `pages/InstructorShortLink.tsx` (rota pública `/i/:publicId`). |
| **Causa** | A rota pública de link curto (`/i/:publicId`) exige leitura sem login, e a policy foi aberta na tabela inteira em vez de em uma projeção. |
| **Impacto** | Identificadores de conta e carteira do gateway de pagamento **publicamente legíveis sem login**, junto com o WhatsApp pessoal de todos os instrutores. Facilita enumeração e engenharia social. |
| **Correção proposta** | View `public.public_instructors` com apenas as colunas que a vitrine precisa (`id, public_id, base_price, night_price, has_night_lessons, categories, meeting_point, work_saturday_afternoon, lunch_*`), legível por `anon`; revogar SELECT direto de `anon` na tabela; manter `USING (auth.uid() = id)` para o próprio instrutor. O `whatsapp` só deve ser exposto após vínculo de aula (mesma regra de F1-02). |
| **Exige migration?** | ✅ **SIM** |
| **Exige alteração de código?** | ✅ **SIM** |
| **Testes necessários** | 1. Teste SQL: `anon` não lê `provider_wallet_id` nem `credential_number`.<br>2. Teste de regressão de `/i/:publicId` e da vitrine de instrutores. |
| **Dependências** | Compartilha a decisão de "exposição de telefone" com F1-02 (AP-02). |
| **Critério objetivo de conclusão** | `curl` anônimo em `/rest/v1/instructors?select=provider_wallet_id` retorna erro ou 0 colunas sensíveis; e a rota `/i/:publicId` continua renderizando. |

---

## F1-04 — `confirmed → cancelled` alcançável direto do frontend

| Campo | Conteúdo |
|---|---|
| **Problema** | O trigger de segurança autoriza `NEW.status = 'cancelled'` sem olhar `OLD.status`, e a policy `Users can update their own appointments` tem `WITH CHECK` nulo, anulando por OR o `WITH CHECK (status='cancelled')` da policy do aluno. |
| **Evidência** | `prosrc` de `check_appointments_update_security`: a única checagem é `IF NEW.status NOT IN ('cancelled','completed','no_show','pending_approval') THEN RAISE EXCEPTION`. Nunca referencia `OLD.status` nem o ator.<br>`pg_policy`: `Users can update their own appointments` → `USING (uid=instructor_id OR (uid=student_id AND is_profile_complete))`, `WITH CHECK = NULL`. |
| **Arquivos envolvidos** | Banco: função `check_appointments_update_security`, policies de UPDATE em `appointments`.<br>Código (proteções que serão contornadas): `supabase/functions/cancel-booking/index.ts:93-104`, `lib/payments/BookingCancellationCore.ts:58-65,203-217`. |
| **Causa** | O hardening foi desenhado como lista de status *permitidos*, não como máquina de transições. A regra de negócio "aula aceita só se remarca" vive apenas na camada de aplicação. |
| **Impacto** | Viola a regra central do produto. Um aluno pode cancelar uma aula já aceita via PostgREST, liberando o horário do instrutor sem passar pelo fluxo financeiro — deixando o pagamento órfão. |
| **Correção proposta** | Reescrever `check_appointments_update_security` como **máquina de transições explícita**, validando o par `(OLD.status, NEW.status)` **e** o ator (`auth.uid() = OLD.student_id` vs `= OLD.instructor_id`). Transições a partir de `confirmed`/`scheduled` por `authenticated` devem ser **negadas integralmente** — só `service_role` (via Core) pode fazê-las. |
| **Exige migration?** | ✅ **SIM** — `CREATE OR REPLACE FUNCTION` da função de trigger. Nova migration; **não editar as históricas**. |
| **Exige alteração de código?** | ❌ **NÃO** — desde que se confirme que todo caminho legítimo hoje usa Edge Function/RPC. **A verificar durante a implementação.** |
| **Testes necessários** | 1. Suíte SQL de transições: matriz completa `(OLD, NEW, ator)` → permitido/negado.<br>2. Teste de regressão dos 6 callers do `BookingCancellationCore`. |
| **Dependências** | Deve ser feito **junto** com F1-05 (mesma função de trigger, mesma migration). |
| **Critério objetivo de conclusão** | `UPDATE appointments SET status='cancelled' WHERE id=<aula confirmed>` com JWT de aluno **falha**; e o cancelamento legítimo via `cancel-booking` de aula `reserved` continua funcionando. |

---

## F1-05 — Aluno pode marcar `completed` e `no_show`

| Campo | Conteúdo |
|---|---|
| **Problema** | O trigger autoriza `completed` e `no_show` para qualquer parte da aula, sem distinguir aluno de instrutor. O frontend do aluno usa isso ativamente, em lote e sem idempotência. |
| **Evidência** | `prosrc` do trigger (mesma lista de 4 status).<br>`pages/student/Lessons.tsx:671-679` — `.update({status:'completed'}).in('id', lessonIds)`.<br>`pages/InstructorAgenda.tsx:1028-1035` (`completed`) e `:1062-1069` (`no_show`), ambos sem CAS `.in('status',[...])`. |
| **Causa** | Mesma raiz de F1-04. Adicionalmente, a UI do aluno implementa "marcar como concluída" como escrita direta. |
| **Impacto** | `completed` é o gatilho de liberação de repasse ao instrutor. Marcado pelo lado errado da relação, e sem idempotência (duplo clique reescreve e move `updated_at`). `no_show` "consome o crédito do aluno" e também é alcançável pelo aluno. |
| **Correção proposta** | 1. Na mesma migration de F1-04, restringir `completed`/`no_show` ao `instructor_id` (ou remover de `authenticated` e mover para RPC).<br>2. Adicionar CAS (`.in('status', ['confirmed','scheduled'])`) em todos os writes de status do frontend.<br>3. Decidir o que fazer com o "marcar concluída" do aluno: remover da UI ou converter em confirmação que não muda status. **Ponto de aprovação (AP-03).** |
| **Exige migration?** | ✅ **SIM** (mesma de F1-04) |
| **Exige alteração de código?** | ✅ **SIM** — `pages/student/Lessons.tsx`, `pages/InstructorAgenda.tsx` |
| **Testes necessários** | 1. Matriz de transições por ator (compartilhada com F1-04).<br>2. Teste de idempotência: dois UPDATEs consecutivos → segundo é no-op. |
| **Dependências** | F1-04 (mesma função de trigger). |
| **Critério objetivo de conclusão** | `UPDATE ... SET status='completed'` com JWT de **aluno** falha; com JWT de **instrutor** em aula `confirmed` sucede; repetido, é no-op. |

---

## F1-06 — `send-push-notification` publicamente invocável

| Campo | Conteúdo |
|---|---|
| **Problema** | `verify_jwt = false` **e** nenhuma checagem de autenticação no handler, que usa `SERVICE_ROLE_KEY` e responde com `Access-Control-Allow-Origin: '*'`. |
| **Evidência** | `supabase/config.toml`: `[functions.send-push-notification] verify_jwt = false`.<br>`supabase/functions/send-push-notification/index.ts:4` (CORS `*`), `:99-124` (vai direto ao `req.json()` sem validar origem/segredo). |
| **Arquivos envolvidos** | `supabase/config.toml`, `supabase/functions/send-push-notification/index.ts`, `supabase/functions/notification-worker/index.ts` (único chamador legítimo). |
| **Causa** | `verify_jwt=false` foi necessário porque o chamador é o worker (não um usuário), mas nenhum segredo compartilhado foi adicionado em substituição. |
| **Impacto** | Qualquer pessoa na internet POSTa `{"notification_id":"<uuid>"}` e força push a qualquer usuário. Spam e amplificação. |
| **Correção proposta** | Exigir header de segredo compartilhado validado **fail-closed** (abortar se a variável não estiver configurada), comparação constant-time, e restringir CORS à origem da aplicação. |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | Teste que invoca a função sem o segredo e espera 401; com o segredo e espera 200. |
| **Dependências** | Deve ser feito junto com F1-07 e F1-08 (mesmo mecanismo de segredo). |
| **Critério objetivo de conclusão** | `curl -X POST` sem header de segredo retorna 401. O worker continua despachando. |

---

## F1-07 — Telemetria vaza o `CRON_SECRET` caractere a caractere

| Campo | Conteúdo |
|---|---|
| **Problema** | Em caso de mismatch, a função loga o SHA-256 de `Bearer <CRON_SECRET>`, os comprimentos exatos, o índice do primeiro caractere divergente e **o caractere esperado nessa posição**. |
| **Evidência** | `supabase/functions/notification-worker/index.ts:8-72`, especialmente `:30` (`expectedMismatchCharacter`) e `:47-48`. A função tem `verify_jwt = false`. |
| **Arquivos envolvidos** | `supabase/functions/notification-worker/index.ts` |
| **Causa** | Código de diagnóstico adicionado durante a depuração do cron (ver `check-cron-secret-audit.ts` na raiz) e nunca removido. |
| **Impacto** | Oráculo remoto que permite recuperar o segredo de cron por tentativa e erro contra um endpoint sem JWT. Com o segredo, um atacante invoca todos os jobs de cron. |
| **Correção proposta** | Remover integralmente `logSecretTelemetry`. Substituir por log booleano ("auth ok/falhou") sem nenhum detalhe do segredo. |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | Grep de verificação: nenhuma ocorrência de `expectedHash`, `mismatchCharacter`, `expectedLength` no repositório. |
| **Dependências** | F1-06, F1-08 (mesmo arquivo/mecanismo). |
| **Critério objetivo de conclusão** | `grep -rn "expectedMismatchCharacter\|expectedHashSha256" supabase/` → 0 resultados. |

---

## F1-08 — `CRON_SECRET` fail-open

| Campo | Conteúdo |
|---|---|
| **Problema** | `if (cronSecret && authHeader !== ...)` — se a variável não estiver setada no ambiente da função, a verificação é **inteiramente ignorada**. |
| **Evidência** | `supabase/functions/notification-worker/index.ts:79` |
| **Arquivos envolvidos** | `notification-worker/index.ts`, e **a verificar**: `check-expired-bookings/index.ts`, `auto-complete-lessons/index.ts` (mesmo padrão provável). |
| **Causa** | Guarda escrita defensivamente para não quebrar em ambiente local sem a variável. |
| **Impacto** | Com a variável ausente no deploy, o worker fica publicamente invocável sem nenhum segredo. |
| **Correção proposta** | Inverter para fail-closed: se `CRON_SECRET` não estiver definida, responder 500 e abortar. Aplicar o mesmo padrão nas 3 funções de cron. |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | Teste que remove a variável do ambiente e espera 500. |
| **Dependências** | F1-06, F1-07. |
| **Critério objetivo de conclusão** | Nenhuma Edge Function de cron aceita requisição quando `CRON_SECRET` está ausente. |

---

## F1-09 — Ambiente Asaas = sandbox em 7 defaults, sem fail-closed

| Campo | Conteúdo |
|---|---|
| **Problema** | Sete pontos independentes fazem fallback para `https://sandbox.asaas.com/api/v3` quando `ASAAS_API_URL` não está definida. Não há variável de ambiente explícita nem validação de coerência. |
| **Evidência** | `lib/payments/AsaasProvider.ts:183`; `api/sync-fees.ts:49`; `lib/payments/BookingCancellationCore.ts:116`; `supabase/functions/create-tip/index.ts:138`; `supabase/functions/create-asaas-account/index.ts:143`; `supabase/functions/sync-payment-status/index.ts:86`; `supabase/functions/_shared/BookingCancellationCore.ts:126`.<br>Nenhuma ocorrência de `api.asaas.com` em código executável.<br>`lib/payments/GatewayFeeModel.ts:63-65` documenta que o schedule de tarifas veio do painel **Sandbox**. |
| **Arquivos envolvidos** | Os 7 acima + `lib/payments/GatewayFeeModel.ts` |
| **Causa** | Ausência de um conceito de "ambiente" no código. Cada módulo resolve a URL isoladamente. |
| **Impacto** | Se `ASAAS_API_URL` não estiver definida no deploy, **a plataforma inteira opera contra o sandbox silenciosamente** — cobranças que não existem, dinheiro que nunca entra. Sem log de alerta. |
| **Correção proposta** | 1. Introduzir `ASAAS_ENV` (`sandbox` \| `production`) como **única fonte de verdade**, sem default.<br>2. Módulo `lib/payments/AsaasEnvironment.ts` que resolve a URL a partir de `ASAAS_ENV` e **lança** se a variável estiver ausente ou inválida.<br>3. Validação de coerência ambiente↔chave no boot (prefixo da API key).<br>4. Substituir os 7 defaults por chamadas a esse módulo.<br>5. Revisar `GatewayFeeModel` — o schedule embutido é do sandbox; **as tarifas de produção precisam ser confirmadas no painel Asaas de produção. Ponto de aprovação (AP-04).** |
| **Exige migration?** | ❌ NÃO (mas `gateway_fee_schedule` tem 5 linhas que podem precisar de revisão — tratado em F2-06) |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | 1. Teste unitário: `ASAAS_ENV` ausente → lança.<br>2. Teste: `ASAAS_ENV=production` → URL de produção.<br>3. Teste de coerência chave↔ambiente. |
| **Dependências** | A virada para produção depende da decisão comercial do proprietário (Etapa I do roteiro original). O **código** pode ser preparado antes. |
| **Critério objetivo de conclusão** | `grep -rn "sandbox.asaas.com" --include=*.ts` retorna resultados **apenas** dentro de `AsaasEnvironment.ts`; e o boot falha explicitamente sem `ASAAS_ENV`. |

---

## F1-10 — 2 vulnerabilidades `critical` + 11 `high` em dependências

| Campo | Conteúdo |
|---|---|
| **Problema** | `npm audit` reporta `{low:2, moderate:5, high:11, critical:2, total:20}`. |
| **Evidência** | `npm audit --json`. Críticas: `protobufjs` (RCE, transitivo via `firebase`), `websocket-driver`. Altas de maior exposição: `@remix-run/router` / `react-router-dom` (**XSS via open redirect** — runtime do cliente), `path-to-regexp`, `qs`, `body-parser` (superfície Express), `ws`, `vite`, `sharp`, `postcss`, `nanoid`, `@grpc/grpc-js`, `browserslist`. |
| **Arquivos envolvidos** | `package.json`, `package-lock.json` |
| **Causa** | Dependências não atualizadas desde o início do projeto. |
| **Impacto** | XSS em runtime do cliente; RCE na cadeia do Firebase; DoS na superfície Express. **Agravado por F1-16** (ausência total de headers de segurança). |
| **Correção proposta** | 1. `npm audit fix` para o que resolve sem breaking change.<br>2. Atualização manual e testada de `react-router-dom` (a de maior risco em runtime).<br>3. Remover `sharp` e `micro` das `dependencies` se confirmado que não são usados no bundle.<br>4. Alinhar `@types/uuid` com `uuid ^13`.<br>**Não usar `--force` sem revisão** — pode quebrar o build. |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM (`package.json`, possíveis ajustes de API do react-router) |
| **Testes necessários** | 1. `npm run build` verde.<br>2. Bateria oficial sem novas falhas.<br>3. Smoke test manual de navegação (o upgrade de router é o risco real). |
| **Dependências** | Deve vir **depois** de F1-16 ou junto, para que o CSP já esteja no lugar. |
| **Critério objetivo de conclusão** | `npm audit` sem `critical` e sem `high` na superfície de runtime (dev-only aceitável com justificativa registrada); build e bateria verdes. |

---

## F1-11 — 3 Edge Functions com `verify_jwt=false` e auth interna NÃO VERIFICADA

| Campo | Conteúdo |
|---|---|
| **Problema** | `create-booking`, `create-asaas-account` e `auto-complete-lessons` estão com `verify_jwt = false`. A auditoria **não leu integralmente** esses 3 handlers — não se sabe se validam identidade internamente. |
| **Evidência** | `supabase/config.toml`. Marcado como **NÃO VERIFICADO** no relatório (§G e item 3 da lista final). |
| **Arquivos envolvidos** | `supabase/config.toml`, `supabase/functions/create-booking/index.ts`, `create-asaas-account/index.ts`, `auto-complete-lessons/index.ts` |
| **Causa** | A ser determinada. |
| **Impacto** | **Potencialmente crítico:** `create-asaas-account` cria subconta no gateway financeiro; `create-booking` cria reserva. Sem JWT e sem validação interna, seriam operações não autenticadas. |
| **Correção proposta** | **Primeiro passo é AUDITAR, não corrigir.** Ler os 3 handlers integralmente e classificar:<br>• se valida internamente → documentar e manter;<br>• se não valida → promover a bloqueador com correção própria.<br>Para `create-booking`, considerar que o relatório já o classificou como **código morto** (nenhum `invoke('create-booking')` no front) — a correção pode ser simplesmente removê-lo (ver F4-07). |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ⚠️ **A DEFINIR** após a auditoria. |
| **Testes necessários** | A definir. |
| **Dependências** | Nenhuma para auditar. |
| **Critério objetivo de conclusão** | Documento anexo classificando cada uma das 3 funções como SEGURA (com evidência) ou VULNERÁVEL (com item de correção criado). |

---

## F1-12 — Exclusão de conta inexistente (app + URL web)

| Campo | Conteúdo |
|---|---|
| **Problema** | Não existe nenhum fluxo de exclusão de conta ou de dados, nem no app nem por URL web. A UI afirma falsamente que o recurso existe. |
| **Evidência** | Busca exaustiva por `delete_account\|deleteAccount\|excluir conta\|deletar conta\|admin.deleteUser\|anonymize\|desativar conta` em `pages/`, `components/`, `api/`, `supabase/functions/`, `lib/`, `supabase/migrations/`: **zero resultados funcionais**.<br>Única ação destrutiva nas telas de perfil é logout (`pages/student/Profile.tsx:486-490`, `pages/InstructorProfile.tsx:942-946`).<br>**Afirmação falsa:** `components/PrivacyModal.tsx:110` diz que a exclusão está "através das configurações do seu perfil". |
| **Arquivos envolvidos** | A criar: rota web pública + tela in-app + Edge Function de exclusão. A corrigir: `components/PrivacyModal.tsx:110`, `pages/Privacy.tsx:148-154,184`. |
| **Causa** | Funcionalidade nunca implementada; o texto jurídico foi escrito descrevendo o estado desejado. |
| **Impacto** | **Rejeição praticamente certa na Play Console.** Requisito obrigatório desde 2023 (Account/Data deletion policy): fluxo in-app **e** URL web acessível sem instalar o app. Declarar "Yes" no Data Safety sem implementar é motivo de **suspensão**. Adicionalmente, LGPD art. 18. |
| **Correção proposta** | 1. Definir a **política de retenção** (o que apaga, o que anonimiza, o que retém por obrigação fiscal/contábil e por quanto tempo). **Isto é decisão do proprietário — ponto de aprovação (AP-05).**<br>2. Edge Function `delete-account` (`verify_jwt=true`) que executa a política sob `service_role`.<br>3. Tela in-app com dupla confirmação nos dois perfis.<br>4. Página web pública descrevendo o processo e permitindo solicitação sem login.<br>5. Corrigir os textos que afirmam algo inexistente. |
| **Exige migration?** | ✅ **SIM** — provavelmente colunas de soft-delete/anonimização e ajuste de FKs (`ON DELETE`). |
| **Exige alteração de código?** | ✅ **SIM** — nova Edge Function, nova rota, novas telas. |
| **Testes necessários** | 1. Teste: conta excluída não consegue logar.<br>2. Teste: dados pessoais apagados/anonimizados conforme a política.<br>3. Teste: registros financeiros retidos por obrigação legal permanecem, sem PII.<br>4. Teste: FKs não quebram (`appointments`, `transactions`, `reviews` referenciam o usuário). |
| **Dependências** | **Depende da decisão de retenção (F3-09).** Não começar a implementação antes dela. |
| **Critério objetivo de conclusão** | Fluxo in-app funcional nos 2 perfis + URL web pública acessível sem login + política de retenção documentada e implementada + textos corrigidos. |

---

## F1-13 — Nenhum artefato Android existe

| Campo | Conteúdo |
|---|---|
| **Problema** | Não há empacotamento Android de nenhum tipo. Não há o que submeter à Play Console. |
| **Evidência** | Busca (maxdepth 3, excluindo `node_modules`/`dist`/`_to_delete`): sem `android/`, `capacitor.config.*`, `twa-manifest.json`, `build.gradle`, `AndroidManifest.xml`, `.apk`, `.aab`.<br>`ls public/.well-known` → não existe.<br>Sem `package name`, `versionCode`, `versionName`, `targetSdkVersion`. |
| **Arquivos envolvidos** | A criar: configuração de empacotamento, `public/.well-known/assetlinks.json`. A revisar: `public/manifest.json`, `public/icons/` (vazio). |
| **Causa** | O projeto é um PWA e o empacotamento nunca foi iniciado. |
| **Impacto** | Bloqueador absoluto de publicação. Sem `assetlinks.json`, um TWA abre com a barra de URL do Chrome e falha a verificação Digital Asset Links. |
| **Correção proposta** | 1. **Decidir a estratégia de empacotamento: Bubblewrap/TWA ou Capacitor. Ponto de aprovação (AP-06).**<br>2. **Resolver a divergência de domínio (CONFLITO-03)** antes de gerar o `assetlinks.json` — ele precisa ficar no domínio do `start_url`.<br>3. Definir `package name`, `versionCode`, `versionName`, `targetSdkVersion`.<br>4. Gerar e publicar `public/.well-known/assetlinks.json`.<br>5. Adicionar ícone `maskable` e screenshots (F3-14). |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | 1. Verificador oficial de Digital Asset Links aponta para o domínio correto.<br>2. Build do `.aab` conclui.<br>3. Instalação local abre em modo standalone sem barra de URL. |
| **Dependências** | **CONFLITO-03** (domínio) e F3 (política pública acessível). Não faz sentido empacotar antes de F1-12 e F3-01, porque a submissão seria rejeitada. |
| **Critério objetivo de conclusão** | `.aab` assinado gerado + `assetlinks.json` validado no domínio de produção + app abre sem barra de URL. |

---

## F1-14 — Reconciliação e IntegrityChecker não rodam

| Campo | Conteúdo |
|---|---|
| **Problema** | `ReconciliationService` e `IntegrityChecker` existem, estão testados, e **não são invocados por nenhum endpoint ou cron**. O webhook delega explicitamente a eles. |
| **Evidência** | `ReconciliationService` referenciado apenas em: sua própria definição, 3 arquivos de teste, e `scripts/run-tests.ts:51`. Idem `IntegrityChecker`.<br>`SELECT * FROM cron.job` → 4 jobs, nenhum de reconciliação.<br>`vercel.json` sem bloco `crons`. `.github/` vazio.<br>`api/asaas-webhook.ts:637-649` retorna `reason_code:'RECONCILIATION_PENDING'` delegando a um processo inexistente.<br>`sync-payment-status` (única chamadora de `reconcile-payment`) também não está agendada. |
| **Arquivos envolvidos** | `lib/payments/ReconciliationService.ts`, `lib/payments/IntegrityChecker.ts`, `api/reconcile-payment.ts`, `supabase/functions/sync-payment-status/index.ts`, `vercel.json`, migrations de cron. |
| **Causa** | O agendamento nunca foi criado. |
| **Impacto** | Todo evento que cai no caminho `RECONCILIATION_PENDING` fica órfão para sempre. É o que produziu os 7 webhooks presos em `PENDING` e os 2 estornos em `REQUESTED`. **Como o banco será resetado, o impacto é sobre o futuro, não sobre os dados atuais.** |
| **Correção proposta** | 1. Criar endpoint/handler que invoque `ReconciliationService`.<br>2. Agendar — **decidir entre `vercel.json crons` e `pg_cron`. Ponto de aprovação (AP-07).** Observação: hoje o padrão do projeto é pg_cron chamando o Vercel (job 12), o que acopla o agendamento financeiro à saúde do pg_net. Vale reconsiderar.<br>3. Criar **reaper** de `refund_operations` com lease expirado em `REQUESTED` — hoje nada as retoma.<br>4. Agendar `sync-payment-status` ou remover `reconcile-payment` se for confirmado como morto. |
| **Exige migration?** | ⚠️ **TALVEZ** — se a escolha for pg_cron. |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | 1. Teste do reaper: operação `REQUESTED` com lease expirado é retomada.<br>2. Teste de idempotência da reconciliação.<br>3. **Validação pós-reset:** com banco limpo, simular um webhook órfão e confirmar que a reconciliação o resolve. |
| **Dependências** | Para a **validação** depende do reset (Fase 2 / Fase 6). Para a **implementação**, não. |
| **Critério objetivo de conclusão** | Job agendado e visível em `cron.job` ou `vercel.json`; reaper implementado e testado; validação pós-reset registrada. |

---

## F1-15 — Buckets `avatars` e `assets` públicos sem limite

| Campo | Conteúdo |
|---|---|
| **Problema** | Ambos com `public = true`, `file_size_limit = null`, `allowed_mime_types = null`. |
| **Evidência** | `SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets` |
| **Arquivos envolvidos** | Banco (configuração de storage); `pages/student/Profile.tsx:196-214`, `pages/InstructorProfile.tsx:279-292` (uploads). |
| **Causa** | Configuração padrão nunca endurecida. |
| **Impacto** | Fotos de rosto acessíveis por URL sem autenticação (dado pessoal, LGPD). Upload sem limite de tamanho nem de tipo MIME — vetor de abuso de armazenamento e de upload de conteúdo arbitrário. |
| **Correção proposta** | 1. Definir `file_size_limit` (ex.: 2 MB) e `allowed_mime_types` (`image/jpeg`, `image/png`, `image/webp`).<br>2. **Decidir se `avatars` deve permanecer público.** Tornar privado exige URLs assinadas e altera o código das telas. **Ponto de aprovação (AP-08).** |
| **Exige migration?** | ✅ SIM (ou configuração via painel — preferir migration versionada) |
| **Exige alteração de código?** | ❌ NÃO se mantiver público com limites; ✅ SIM se tornar privado. |
| **Testes necessários** | 1. Upload de arquivo > limite falha.<br>2. Upload de MIME não permitido falha.<br>3. Se privado: avatar continua renderizando via URL assinada. |
| **Dependências** | A decisão público/privado impacta F3 (data inventory e política). |
| **Critério objetivo de conclusão** | Limites aplicados e verificáveis via `SELECT` em `storage.buckets`; testes de upload passando. |

---

## F1-16 — `vercel.json` sem nenhum header de segurança

| Campo | Conteúdo |
|---|---|
| **Problema** | O arquivo contém **apenas** um bloco `rewrites`. Sem CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. |
| **Evidência** | Conteúdo atual de `vercel.json` verificado nesta sessão: um único `rewrites` com o regex de SPA. **Sem `headers`, sem `crons`, sem `regions`, sem `functions`.** |
| **Arquivos envolvidos** | `vercel.json` |
| **Causa** | Nunca configurado. |
| **Impacto** | Agrava diretamente a vulnerabilidade de XSS do `@remix-run/router` (F1-10). Sem CSP, um XSS tem alcance total. Sem HSTS, downgrade é possível. |
| **Correção proposta** | Adicionar bloco `headers` com CSP (ajustado para os CDNs efetivamente usados — `gstatic.com` para o Firebase SW, Google Maps), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.<br>**⚠️ Ver CONFLITO-01:** o bloco `regions` **não está no `vercel.json`**. Não planejar alteração de região sem antes verificar o estado no painel. |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | 1. `curl -I` na URL de produção mostra os headers.<br>2. Smoke test: o app carrega sem violações de CSP no console (o Firebase SW e o Google Maps são os pontos de atrito prováveis). |
| **Dependências** | Deve preceder ou acompanhar F1-10. |
| **Critério objetivo de conclusão** | Todos os headers presentes na resposta de produção e zero erros de CSP no console em navegação completa. |

---

## F1-17 — Leaked password protection desabilitado

| Campo | Conteúdo |
|---|---|
| **Problema** | O Supabase Auth não verifica senhas comprometidas contra HaveIBeenPwned. |
| **Evidência** | Supabase security advisor: `auth_leaked_password_protection`, level WARN. |
| **Arquivos envolvidos** | Nenhum — configuração do painel Supabase. |
| **Causa** | Configuração padrão. |
| **Impacto** | Usuários podem cadastrar senhas já vazadas publicamente. |
| **Correção proposta** | Habilitar no painel Supabase (Auth → Password security). |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ❌ NÃO — **ação manual do proprietário no painel.** |
| **Testes necessários** | Tentar cadastrar uma senha notoriamente vazada e confirmar rejeição. |
| **Dependências** | Nenhuma. |
| **Critério objetivo de conclusão** | Advisor `auth_leaked_password_protection` não aparece mais. |

---

# 4. FASE 2 — DADOS FINANCEIROS DE TESTE

> **Classificação geral desta fase: DADOS DE TESTE — DESCARTÁVEIS NO RESET FINAL.**
>
> **Regra absoluta:** nenhum registro listado aqui será alterado, estornado ou reconciliado. Nenhum refund real será executado. O objetivo desta fase é **identificar** o que é descartável e **preservar apenas a validação de que o código está correto**.
>
> **Nenhum arquivo será apagado automaticamente.** Esta fase produz uma lista para revisão.

---

## F2-01 — Registros financeiros presos (inventário, sem ação)

| Campo | Conteúdo |
|---|---|
| **Classificação** | **DADOS DE TESTE — DESCARTÁVEIS NO RESET FINAL** |
| **Inventário** | • 3 `appointments` em `status='cancelling'` com `payment_status='paid'`<br>• 1 `appointment` em `cancelled` / `refund_requested`<br>• 2 `refund_operations` em `REQUESTED` (R$100 cada, `attempt=0`, `sent_at=null`), criadas em 22 e 23/09<br>• 7 `transactions` de `type='webhook_event'` em `processing_status='PENDING'` desde 11/08<br>• 1 `notification_job` em `processing` desde 12/08 (43 dias) |
| **Ação** | **NENHUMA.** Não estornar, não reconciliar, não alterar status. |
| **O que se preserva** | Apenas a **evidência de que o código atual trata esses casos corretamente**, na forma de testes. Nenhum dado é preservado. |
| **Observação crítica** | Os IDs `3de5673a-027b-42c2-9a4a-3422c32438c3` e `e6f090c0-5add-4958-9088-46ec972b77a2` (refund_operations) e `9a8d3879-…`, `9034f919-…`, `526e8e5b-…` (appointments) constam na instrução permanente do projeto como **"os 5 registros de teste que nunca podem ser tocados"**. Essa instrução permanece válida até o reset. |
| **Critério de conclusão** | Inventário revisado e aceito pelo proprietário; nenhuma alteração executada. |

---

## F2-02 — `platform_fee + fee_amount + net ≠ gross` em 24/36 linhas

| Campo | Conteúdo |
|---|---|
| **Classificação** | **DADOS DE TESTE — DESCARTÁVEIS NO RESET FINAL** |
| **Problema** | Dupla contagem da tarifa em `platform_fee`, corrigida no código em 19/09 ~18:07 e nunca aplicada retroativamente. O delta é exatamente `−fee_amount`. |
| **Decisão** | **NÃO fazer backfill.** O relatório listava isso como P-02 (pendência). Com a decisão de reset, o backfill deixa de fazer sentido. |
| **O que se preserva** | A **prova de que o código atual está correto**: as 12 linhas posteriores ao corte fecham a identidade em 100%. Essa prova já existe em `lib/payments/tests/CommissionCnhJaP121B.unit.test.ts` (22 asserts, fixtures = cópia literal das settlements de produção). |
| **Ação obrigatória** | ⚠️ **As fixtures desse teste contêm dados de produção de teste.** Após o reset, elas deixam de corresponder ao banco. **Decidir:** manter as fixtures como dados sintéticos congelados (recomendado — o teste continua válido) ou regenerá-las. **Ponto de aprovação (AP-09).** |
| **Critério de conclusão** | Decisão sobre as fixtures registrada; nenhum UPDATE executado nas 24 linhas. |

---

## F2-03 — `payouts` vazia com subsistema completo

| Campo | Conteúdo |
|---|---|
| **Classificação** | **DADOS DE TESTE — DESCARTÁVEIS** (a tabela está vazia) / **LEGADO A INVESTIGAR** (o código) |
| **Problema** | `payouts` tem **0 linhas**, apesar de `PayoutEngine`, `PayoutWorker`, `PayoutRepository`, `PayoutStateMachine`, `PayoutKeyFactory` e `PayoutWorkerTypes` existirem com 8 suítes de teste (unit, integration, concurrency). `PayoutWorker` é importado **apenas por testes**. |
| **Pergunta a responder** | O repasse ao instrutor é feito **inteiramente pelo split do Asaas** (o que tornaria todo o subsistema `Payout` legado), ou havia um modelo de repasse próprio previsto? |
| **Ação** | **INVESTIGAR na Fase 4** (é o mesmo tipo de pergunta do refund legado). Não remover nada agora. |
| **Critério de conclusão** | Classificação registrada: subsistema `Payout` é A/B/C/D/E. |

---

## F2-04 — Arquivos que são exclusivamente evidência de testes antigos

> **NÃO APAGAR.** Lista para revisão do proprietário. A remoção, se aprovada, é ação da Fase 5 (F5-18).

| Arquivo / Diretório | Tamanho | Natureza | Classificação proposta |
|---|---|---|---|
| `baseline-p1-after.txt` | 14.746 B | Saída de bateria de teste da fase P-1 | Evidência de teste — **DESCARTÁVEL** |
| `baseline-p110-after.txt` | 14.746 B | Idem P-1.10 | Evidência de teste — **DESCARTÁVEL** |
| `baseline-p16.txt` | 14.746 B | Idem P-1.6 | Evidência de teste — **DESCARTÁVEL** |
| `baseline-p19-after.txt` | 14.746 B | Idem P-1.9 | Evidência de teste — **DESCARTÁVEL** |
| `grep_output.txt` | 1.130 B | Saída de grep de depuração (28/07) | Resíduo — **DESCARTÁVEL** |
| `supabase_schema.sql` | 33.052 B | Snapshot de schema de 28/08, **divergente das migrations** | ⚠️ **AMBÍGUO** — pode ser a única referência de schema legível. Ver CONFLITO-05 |
| `supabase_migration_plan.sql` | 5.530 B | Plano de migration de 28/08 | ⚠️ **AMBÍGUO** — verificar se descreve algo ainda não aplicado |
| `Base31177.unit.test.ts' -or` | — | **Nome corrompido por escape de shell no Windows** | Resíduo — **DESCARTÁVEL** |
| `tests -File \|` | — | **Nome corrompido por escape de shell no Windows** | Resíduo — **DESCARTÁVEL** |
| `_to_delete/` | 111 arquivos | Arquivos `.js` movidos em fase anterior por falta de permissão de delete | Resíduo — **DESCARTÁVEL** (remoção manual pelo proprietário) |
| `tests-p110/` … `tests-p1203/` (9 dirs) | — | Baterias de teste por fase, fora de `lib/payments/tests/` | ⚠️ **AMBÍGUO** — alguns são referenciados por `scripts/run-tests.ts`? **A VERIFICAR** |
| `bun.lock` | 0 B | Vazio, coexiste com `package-lock.json` | Resíduo — **DESCARTÁVEL** |
| 15 scripts `.ts` na raiz | — | Utilitários manuais de operação (vários com `SERVICE_ROLE_KEY`) | Ver F2-05 |

**Ação desta fase:** apenas produzir e revisar esta lista. **Nenhuma remoção.**

---

## F2-05 — 15 scripts soltos na raiz com `SERVICE_ROLE_KEY`

| Campo | Conteúdo |
|---|---|
| **Problema** | 15 arquivos `.ts` na raiz, **nenhum referenciado pelo `package.json`**, vários lendo `SUPABASE_SERVICE_ROLE_KEY` e escrevendo/lendo produção diretamente. |
| **Inventário** | `apply-migration.ts`, `audit_pwa_icons.ts`, `call-debug-env.ts`, `check-columns.ts`, `check-cron-secret-audit.ts`, `check-env.ts`, `check-fcm.ts`, `check-profiles.ts`, `check_env_keys.ts`, `debug-appointment.ts`, `list-recent-appointments.ts`, `list-recent-transactions.ts`, `test-db-connection.ts`, `test-env-vars.ts`, `test-handler.ts` |
| **Riscos específicos** | • `apply-migration.ts` é um aplicador de migration **fora do fluxo oficial** — é uma hipótese forte para explicar CONFLITO-05 (migrations não rastreadas).<br>• `check-fcm.ts:19` lê a tabela `fcm_tokens` inteira.<br>• `check-cron-secret-audit.ts` é provavelmente a origem da telemetria de F1-07. |
| **Ação desta fase** | Classificar cada um como: **manter em `scripts/`** (utilitário legítimo), **descartável**, ou **perigoso (remover)**. **Nenhuma remoção agora.** |
| **Critério de conclusão** | Tabela de classificação revisada pelo proprietário. |

---

## F2-06 — `gateway_fee_schedule` com tarifas do sandbox

| Campo | Conteúdo |
|---|---|
| **Classificação** | **DADOS DE TESTE — MAS COM IMPACTO PÓS-RESET** |
| **Problema** | A tabela tem 5 linhas, e `lib/payments/GatewayFeeModel.ts:63-65` documenta que o schedule embutido veio do **"painel da conta Asaas Sandbox observado em 2026-09-18"**. |
| **Por que não é simplesmente descartável** | Diferente dos demais dados de teste, esta tabela **precisa ser repovoada com valores corretos** após o reset — e os valores corretos são os de **produção**, que ainda não foram confirmados. |
| **Ação** | Não alterar agora. Registrar como dependência de F1-09 e do reset: **as tarifas reais de produção do Asaas precisam ser obtidas e confirmadas. Ponto de aprovação (AP-04).** |
| **Critério de conclusão** | Tarifas de produção confirmadas e registradas como seed do reset. |

---

## F2-07 — `refund_operation_items` e `refund_operation_events` vazias

| Campo | Conteúdo |
|---|---|
| **Problema** | Ambas com **0 linhas**. `refund_operation_items` não tem **nenhum** consumidor em código (zero referências em `.ts`/`.tsx`). `refund_operation_events` está vazia apesar de existirem 2 operações. |
| **Evidência** | `SELECT count(*)` nas três tabelas: `refund_operations=2`, `refund_operation_items=0`, `refund_operation_events=0`. Referências a `refund_operation_items` existem apenas em 2 migrations. |
| **Ação** | Tratado na **Fase 4** (classificação de legado). `refund_operation_items` é candidata a legado morto; `refund_operation_events` precisa de investigação (ver F4-06). |
| **Critério de conclusão** | Classificação registrada na Fase 4. |

---

## F2-08 — Definição do procedimento de reset (preparação, sem execução)

| Campo | Conteúdo |
|---|---|
| **Objetivo** | Preparar — **sem executar** — o procedimento de limpeza do banco, para que ele esteja revisado e aprovado antes da Fase 6. |
| **Escopo do reset (a confirmar)** | Usuários (`auth.users` + `profiles`), `instructors`, `instructor_*`, `appointments`, `payment_installments`, `payment_settlements`, `transactions`, `refund_operations` + `_items` + `_events`, `payouts`, `notifications`, `notification_jobs`, `notification_logs`, `fcm_tokens`, `reviews`, `student_favorites`, projeções. |
| **O que NÃO deve ser apagado** | `gateway_fee_schedule` (repovoar com tarifas de produção), `platform_financial_settings`, `notification_config`, `cron.job`, funções, policies, triggers. |
| **Forma de entrega** | Script SQL versionado em `supabase/migrations/` ou em `scripts/`, com:<br>• `SELECT` de verificação ANTES (contagens),<br>• os `DELETE`/`TRUNCATE` em ordem de dependência de FK,<br>• `SELECT` de verificação DEPOIS,<br>• procedimento de rollback (backup prévio).<br>**Execução manual pelo proprietário, após autorização explícita.** |
| **Ação desta fase** | **Apenas escrever e revisar o script. NÃO executar.** |
| **Ponto de aprovação** | **AP-10** — escopo exato do reset e ordem de execução. |
| **Critério de conclusão** | Script revisado e aprovado, guardado, **não executado**. |

---

# 5. FASE 3 — LGPD / TERMOS / PRIVACIDADE / PUBLICAÇÃO

> **Nenhum documento será alterado nesta etapa de planejamento.** Esta fase mapeia o que precisa mudar.
>
> **Dependência estrutural:** a Política de Privacidade não pode ser reescrita antes de as decisões de produto estarem tomadas (retenção, exclusão, buckets públicos), porque ela precisa descrever o comportamento **real**.

---

## F3-01 — Política omite 11 categorias de dados efetivamente coletados

| Campo | Conteúdo |
|---|---|
| **Problema** | O data inventory real diverge da política publicada em 11 categorias. |
| **Evidência** | Comparação entre `pages/Privacy.tsx:69-87` (lista declarada) e o data inventory levantado no código.<br>**Não documentados:** CPF do aluno (`student/InstructorProfile.tsx:193-224`); data de nascimento (`InstructorFinance.tsx:237`); endereço completo + CEP (`:229-233`); **renda declarada `incomeValue`** (`:238,703`); foto de perfil em bucket público (`student/Profile.tsx:196-214`); **contato de confiança — dado de terceiro** (`student/Profile.tsx:52,156`); geolocalização do ponto de encontro (`InstructorProfile.tsx:363-366`); token FCM + `device_type` (`AuthContext.tsx:119,134`); conteúdo das notificações; senha; rascunhos em `sessionStorage`/`localStorage` com credencial DETRAN (`RegisterInstructor.tsx:52,150-155`). |
| **Inverso** | A política **promete coleta que o código não faz**: CNH digitalizada com EAR, comprovante de regularidade, modelo/placa/licenciamento/seguro do veículo (`Privacy.tsx:83-84`). |
| **Impacto** | Inconsistência detectável entre o formulário Data Safety e a política publicada → risco alto de rejeição na Play Console. Exposição à ANPD. |
| **Correção proposta** | Reescrever a seção de coleta a partir do data inventory real, item a item. Remover as promessas de coleta inexistente. |
| **Dependência** | F1-15 (decisão sobre bucket público), F3-09 (retenção), F3-06 (bases legais). |
| **Critério de conclusão** | Cada item do data inventory tem linha correspondente na política; nenhum item da política descreve coleta inexistente. |

---

## F3-02 — Afirmação falsa sobre exclusão de conta na UI

| Campo | Conteúdo |
|---|---|
| **Problema** | `components/PrivacyModal.tsx:110` afirma que o titular pode "solicitar a exclusão ... através das configurações do seu perfil". O recurso não existe. |
| **Evidência** | Linha citada vs. busca exaustiva sem resultados (F1-12). |
| **Impacto** | Declaração falsa ao titular. Agrava o bloqueador F1-12 perante a Play Console e a ANPD. |
| **Correção proposta** | Alinhar o texto ao comportamento **depois** de F1-12 estar implementado (o texto passa a ser verdadeiro). Se F1-12 atrasar, corrigir o texto imediatamente para descrever o canal real (e-mail). |
| **Dependência** | F1-12. |
| **Critério de conclusão** | Texto descreve exatamente o que o produto faz. |

---

## F3-03 — Data Safety inconsistente com a política

| Campo | Conteúdo |
|---|---|
| **Problema** | O formulário Data Safety da Play Console é comparado com a política publicada. Com a política atual, a inconsistência é detectável. |
| **Declarações que o inventário exige** | **Personal info:** Name, Email, User IDs, Phone, Address, Other (CPF/CNPJ, data de nascimento).<br>**Financial info:** Purchase history + Other (renda declarada, dados de subconta).<br>**Location:** Approximate.<br>**Photos:** foto de perfil.<br>**Device or other IDs:** token FCM.<br>**App activity:** interações, avaliações.<br>`Shared = Yes` (Asaas; Google/Firebase).<br>`Users can request data deletion` → hoje seria **No**. |
| **Alerta** | **Declarar "Yes" para data deletion sem implementar é motivo de suspensão.** |
| **Ação** | Preencher o formulário **somente depois** de F1-12 e F3-01 concluídos. |
| **Dependência** | F1-12, F3-01. |
| **Critério de conclusão** | Formulário preenchido e coerente com a política publicada. **NÃO VERIFICÁVEL fora da Play Console.** |

---

## F3-04 — 21 divergências entre Termos de Uso e comportamento real

| Campo | Conteúdo |
|---|---|
| **Problema** | O texto dos Termos descreve um produto diferente do implementado em 21 pontos. |
| **Divergências que exigem alteração do TEXTO** | • Comissão sem percentual declarado (código: 10% fixo)<br>• Repasse de 90% ao instrutor não mencionado<br>• Taxa de processamento (gateway) não mencionada em lugar nenhum<br>• Reembolso prometido "integral do valor pago"; código reembolsa o **preço do serviço, sem a taxa de gateway**<br>• **Remarcação: a palavra não aparece nos Termos**, embora seja a regra operativa central (>24h direta, ≤24h proposta)<br>• Gorjeta não mencionada<br>• Combos não mencionados<br>• Descontos progressivos não mencionados<br>• Parcelamento não mencionado<br>• Rejeição pelo instrutor não tratada<br>• Expiração automática não tratada<br>• **Cláusula de propriedade intelectual AUSENTE** |
| **Divergências que exigem decisão de PRODUTO** | • Cancelamento: os Termos prometem regra de 24h; o código **bloqueia cancelamento após o aceite em qualquer prazo**. **O texto deve seguir o código, ou o código deve mudar? Ponto de aprovação (AP-11).**<br>• `no_show`: Termos prometem retenção integral; código **só grava o status, sem nenhuma lógica financeira**<br>• Credenciamento: Termos prometem "processo rigoroso" com CNH+EAR e documento do veículo; código coleta **só o número da credencial, sem validação nem upload**<br>• Suspensão/banimento previstos (cl. 9 e 11) e **inexistentes no código**<br>• `TermsModal.tsx:148-158` promete **compartilhamento de localização em tempo real** — `navigator.geolocation` tem **0 ocorrências** |
| **Alerta jurídico** | Foro de eleição em São Paulo/SP contra consumidor tende a ser afastado (CDC art. 51 IX; CPC art. 63 §3º). |
| **Ação** | Não reescrever agora. Produzir a tabela de decisão (texto muda × produto muda) para aprovação. |
| **Dependência** | AP-11. |
| **Critério de conclusão** | Cada uma das 21 divergências resolvida por alteração de texto ou de produto, com a decisão registrada. |

---

## F3-05 — Consentimento não granular e sem versionamento efetivo

| Campo | Conteúdo |
|---|---|
| **Problema** | Um único checkbox cobre Termos + Privacidade; e voltar de `/terms` marca aceite de **ambos** (`termsAgreed === 'true' \|\| privacyAgreed === 'true'`). `TERMS_VERSION`/`PRIVACY_VERSION` são importados e **nunca usados**; `terms_version` é gravado hard-coded `'1.0'` no trigger do banco. |
| **Evidência** | `pages/RegisterStudent.tsx:56-64`; `constants.ts:5-6`; `supabase/migrations/20260404_security_hardening_terms.sql:41` |
| **Impacto** | A cláusula 12 dos Termos (re-aceite em caso de alteração) é **inaplicável na prática**. Consentimento não granular é vício. |
| **Correção proposta** | 1. Checkboxes separados para Termos e Privacidade.<br>2. Usar `TERMS_VERSION`/`PRIVACY_VERSION` efetivamente no payload de cadastro.<br>3. Trigger grava a versão recebida, não `'1.0'`.<br>4. Mecanismo de re-aceite quando a versão armazenada < versão atual. |
| **Exige migration?** | ✅ SIM (alterar o trigger) |
| **Exige alteração de código?** | ✅ SIM |
| **Dependência** | Deve ser feito **depois** de F3-01 e F3-04 (senão versionaria um documento que vai mudar). |
| **Critério de conclusão** | Aceites separados e versionados; usuário com versão antiga recebe prompt de re-aceite. |

---

## F3-06 — Bases legais por finalidade — PENDENTE DE DEFINIÇÃO

| Campo | Conteúdo |
|---|---|
| **Problema** | A política fala em "bases legais legítimas" (`Privacy.tsx:64`) sem atribuir base legal por finalidade. |
| **Indeterminadas** | Contato de confiança (dado de terceiro), tokens FCM, geolocalização, renda declarada. |
| **Ação** | **PENDENTE DE DEFINIÇÃO.** Requer decisão jurídica do proprietário. Este plano **não inventa bases legais**. |
| **Ponto de aprovação** | **AP-12** — definição das bases legais por finalidade. |
| **Critério de conclusão** | Cada finalidade do data inventory tem base legal atribuída e registrada na política. |

---

## F3-07 — Terceiros: só o Asaas é nomeado

| Campo | Conteúdo |
|---|---|
| **Problema** | A política nomeia apenas o Asaas. Não nomeia **Supabase, Vercel, Firebase/Google (FCM), Google Maps/Places, Meta/WhatsApp**. |
| **Evidência** | `pages/Privacy.tsx:128-135` vs `lib/supabase.ts`, `contexts/AuthContext.tsx:119`, `lib/googleMaps.ts`, `vercel.json`, uso de `wa.me`. |
| **Correção proposta** | Seção de operadores/suboperadores nomeando cada um, com a finalidade e o tipo de dado que recebe. |
| **Dependência** | F3-01 (data inventory). |
| **Critério de conclusão** | Todos os terceiros que efetivamente recebem dado pessoal estão nomeados. |

---

## F3-08 — Transferência internacional (art. 33) não mencionada

| Campo | Conteúdo |
|---|---|
| **Problema** | Nenhum documento menciona transferência internacional de dados. |
| **Fatos** | Firebase/FCM e Google Maps processam fora do Brasil. Vercel é CDN global. Supabase está em `sa-east-1` (Brasil) ✅. **Ver CONFLITO-01** sobre a região da Vercel. |
| **Correção proposta** | Cláusula de transferência internacional identificando os destinos e a salvaguarda adotada. |
| **Dependência** | F3-07; e resolução do CONFLITO-01. |
| **Critério de conclusão** | Cláusula presente e coerente com a infraestrutura real. |

---

## F3-09 — Retenção — PENDENTE DE DEFINIÇÃO

| Campo | Conteúdo |
|---|---|
| **Problema** | Cláusula genérica "pelo tempo necessário" (`Privacy.tsx:168-171`), **sem prazo algum**, e **nenhuma rotina de expurgo no código**. |
| **Por que é crítico** | **É pré-requisito de F1-12.** Não se pode implementar exclusão de conta sem definir o que apaga, o que anonimiza e o que se retém por obrigação legal/fiscal. |
| **Ação** | **PENDENTE DE DEFINIÇÃO.** Ponto de aprovação **AP-05** (compartilhado com F1-12). |
| **Critério de conclusão** | Política de retenção documentada por categoria de dado, com prazo, e implementada. |

---

## F3-10 — Controlador e encarregado não identificados

| Campo | Conteúdo |
|---|---|
| **Problema** | Nenhum documento traz razão social, CNPJ ou endereço da empresa. O encarregado/DPO é apenas um e-mail, sem nome. |
| **Evidência** | `pages/Terms.tsx` e `pages/Privacy.tsx` integrais. |
| **Base** | CDC art. 46; LGPD art. 41 §1º. |
| **Correção proposta** | Adicionar identificação completa do controlador e nome do encarregado. |
| **Dependência** | Informação do proprietário. |
| **Critério de conclusão** | Dados presentes nos dois documentos. |

---

## F3-11 — Cookies: política descreve o que não existe e omite o que existe

| Campo | Conteúdo |
|---|---|
| **Problema** | A seção 8 (`Privacy.tsx:161-164`) descreve cookies "estritamente operacionais". O app **não usa `document.cookie` em lugar nenhum** — usa `localStorage`/`sessionStorage`, que a política omite. |
| **Fato positivo** | **Não existe nenhum analytics/tracker de terceiro** — grep por `gtag`, `googletagmanager`, `posthog`, `mixpanel`, `hotjar`, `clarity.ms`, `fbq(`, `amplitude`, `@sentry` → 0 resultados. Isso simplifica bastante a conformidade. |
| **Correção proposta** | Substituir a seção de cookies por uma seção de "armazenamento local", descrevendo o que é guardado no navegador. |
| **Critério de conclusão** | Seção descreve o armazenamento real. |

---

## F3-12 — Menores de idade não tratados

| Campo | Conteúdo |
|---|---|
| **Problema** | Nenhum documento trata menores. Não há verificação de idade do aluno. |
| **Contexto** | Habilitação exige 18 anos, mas o produto não verifica. |
| **Ação** | **PENDENTE DE DEFINIÇÃO** — decidir se haverá gate de idade ou apenas cláusula contratual. |
| **Critério de conclusão** | Decisão registrada e refletida em produto e/ou texto. |

---

## F3-13 — Política pública mostra só a versão Aluno ao visitante anônimo

| Campo | Conteúdo |
|---|---|
| **Problema** | `/privacy` e `/terms` são rotas públicas, mas o conteúdo é condicional ao papel (`Privacy.tsx:17`, `Terms.tsx:17`, fallback `'student'`). **O revisor anônimo da Play Console nunca vê a versão do Instrutor.** Adicionalmente, é SPA React — política renderizada por JS pode falhar em crawlers/validadores. |
| **Correção proposta** | Servir uma versão pública **completa** (ambos os perfis) em URL estável, preferencialmente como HTML estático servível sem JS. |
| **Dependência** | F3-01, F3-04 (o conteúdo precisa estar correto antes). |
| **Critério de conclusão** | URL pública retorna o documento completo com JS desabilitado. |

---

## F3-14 — Ícone `maskable` e screenshots ausentes

| Campo | Conteúdo |
|---|---|
| **Problema** | `public/manifest.json:12-23` tem apenas 192 e 512 PNG RGBA, **nenhum com `"purpose":"maskable"`**. `public/icons/` está vazio (só `.gitkeep`). Não há screenshots. |
| **Impacto** | Adaptive icon do TWA fica com letterbox/fundo branco. Screenshots são obrigatórios na listagem. |
| **Correção proposta** | Gerar ícone maskable com safe zone correta; produzir screenshots das telas principais nos dois perfis. |
| **Dependência** | F1-13 (empacotamento). |
| **Critério de conclusão** | Manifest com ícone maskable; conjunto de screenshots pronto. |

---

## F3-15 — Página de suporte / URL pública de contato

| Campo | Conteúdo |
|---|---|
| **Problema** | Os e-mails (`suporte@cnhja.com.br`, `privacidade@cnhja.com.br`) existem só nos documentos in-app. Não há página de suporte nem URL pública de contato. |
| **Nota** | `LGPD_EMAIL='lgpd@cnhja.com.br'` está declarado em `constants.ts:13` e **nunca é usado** — risco de canal divulgado divergir do real. |
| **Correção proposta** | Página pública de suporte/contato; consolidar os canais de e-mail (decidir se `lgpd@` existe de fato). |
| **Critério de conclusão** | URL pública de suporte acessível; canais consolidados. |

---

## F3-16 — Enquadramento sob Payments / Financial Services policy

| Campo | Conteúdo |
|---|---|
| **Problema** | Os pagamentos são de **serviço presencial real**, não de produto digital. A regra de Payments do Google Play exige Google Play Billing para produtos/serviços **digitais**; bens e serviços físicos/presenciais normalmente usam processador externo. |
| **Alerta** | ⚠️ **Esta leitura precisa ser confirmada na documentação oficial vigente do Google Play (Payments policy e Financial Services policy). Este plano NÃO afirma a regra atual com certeza.** |
| **Pontos a confirmar** | • Parcelamento em cartão com taxa repassada ao usuário pode atrair a Financial Services policy.<br>• Categoria do app e eventuais documentos regulatórios. |
| **Ação** | Consultar a documentação oficial antes da submissão. |
| **Critério de conclusão** | Enquadramento confirmado por fonte oficial e registrado. |

---

# 6. FASE 4 — REFUND LEGADO

> **Auditoria da hipótese realizada nesta etapa de planejamento.** Resultado abaixo. **Nada foi removido.**

## 6.1 Veredito da hipótese

A hipótese do proprietário era: *"parte do código de refund pertence a uma arquitetura antiga na qual uma parcela individual poderia ser reembolsada"*.

**Resultado: CONFIRMADA EM PARTE, com um conflito ativo.**

| Camada | Veredito |
|---|---|
| **Orquestração de refund** (`refund_operations`, `BookingCancellationCore`, `scope`) | **HIPÓTESE REFUTADA.** Nunca foi por parcela — sempre foi por *appointment* / *grupo de appointments*. |
| **Liquidação** (`InstallmentService.recordRefundSettlement`) | **HIPÓTESE CONFIRMADA.** Existe filtro por parcela individual (`installmentNumber`), reconhecido como bug e corrigido em **um** caller, mas **ainda ativo no outro**. |
| **Gate de elegibilidade** (`REASON_ALLOWED_STATUSES`) | **BATE EXATAMENTE** com o modelo declarado: refund só antes do aceite. Sem conflito. |

## 6.2 Respostas às perguntas de auditoria

**1. `SINGLE_APPOINTMENT` é parcela ou aula?** → **AULA dentro de um combo. NÃO é parcela.** Três evidências independentes:
- `lib/payments/BookingCancellationCore.ts:221-235` — o scope controla quais *appointments* são varridos; `SINGLE_APPOINTMENT` deixa `appointmentsToCancel = [appointment]`.
- `refund_operation_items` tem `appointment_id uuid` e **não tem** `installment_id` nem `installment_number`; unique key é `(refund_operation_id, appointment_id)`.
- Dados reais: `metadata` carrega `appointmentIds`, nunca ids de parcela.
- Reforço: em `:576` e `:593`, `SINGLE_APPOINTMENT` faz `.eq('provider_payment_id', paymentId)` **sem** filtro por `installment_number`.

**2. `refund_operation_items` é usada?** → **Existe. Usada por ninguém. 0 linhas.** Zero referências em `.ts`/`.tsx`; só aparece em 2 migrations. O `metadata.appointmentIds` cumpre a função.

**3. `PARTIALLY_COMPLETED` é alcançável?** → **Sim, mas SOMENTE por evidência externa do Asaas.** `api/asaas-webhook.ts:1138-1140` só entra nesse estado quando o Asaas devolve **menos** do que o app pediu. `RefundStateMachine.ts:14` exige `evidence.source !== 'local'` para sair. `BookingCancellationCore.ts:402` apenas **lê**. Confirma a leitura do proprietário.

**4. `recordRefundSettlement` opera sobre uma parcela ou o pagamento inteiro?** → **Depende do caller.** `lib/payments/InstallmentService.ts:288-298`:
```
if (dto.providerPaymentId) query = query.eq('provider_payment_id', dto.providerPaymentId);
else if (dto.groupId)      query = query.eq('group_id', dto.groupId);
else if (dto.appointmentId) query = query.eq('appointment_id', dto.appointmentId);
if (dto.installmentNumber) query = query.eq('installment_number', dto.installmentNumber);
```
| Caller | Passa `installmentNumber`? | Efeito |
|---|---|---|
| `supabase/functions/sync-payment-status/index.ts:159-164` | **NÃO** | marca todas as parcelas do pagamento |
| `api/asaas-webhook.ts:1242-1250` | **SIM** (`installmentNumber: instNum`) | marca **apenas uma** parcela |

**5. Existe caminho que estorna uma parcela sem as outras?** → **SIM, no webhook.** Ver F4-01.

**6. `REASON_ALLOWED_STATUSES` bate com o modelo?** → **SIM, exatamente.** `BookingCancellationCore.ts:58-65`: as três razões (`instructor_rejected`, `student_cancelled`, `auto_expired`) permitem apenas `pending`, `pending_approval`, `awaiting_payment`, `reserved`. Gate em `:203-217` lança `CancellationNotAllowedError` para `confirmed`/`scheduled`. Os 6 callers de produção passam por esse gate. **Nenhum caminho dispara refund via Core em aula aceita.**

**7. Testes do modelo antigo?** → **Um único arquivo**, e ele testa o modelo antigo **como bug**: `lib/payments/tests/InstallmentFullRefundFase3114.unit.test.ts:169-176` usa um mock `legacyBuggyRecordRefundSettlement` e assere *"Bug comprovado: apenas a parcela 1 era atualizada!"*.

**8. Código só alcançável por processos não agendados?** → **Sim.** `sync-payment-status` (a versão **correta**, sem `installmentNumber`) não está agendada. `api/reconcile-payment.ts` **não contém nenhuma referência a refund** — a premissa da pergunta não se sustenta. **Efeito líquido: a única rota de refund→parcelas que roda sozinha é a do webhook — a que tem o filtro legado.**

---

## 6.3 Itens da Fase 4

## F4-01 — `installmentNumber` no webhook: filtro legado ativo — **BLOQUEADOR**

| Campo | Conteúdo |
|---|---|
| **Classe** | **C — ambígua, com CONFLITO ENCONTRADO** |
| **Problema** | `api/asaas-webhook.ts:1242,1247` passa `installmentNumber: instNum` (`payload.payment?.installmentNumber \|\| 1`) para `recordRefundSettlement`, restringindo o update a **uma** parcela. |
| **Conflito interno** | O próprio repositório declara esse comportamento como **bug já corrigido** (`InstallmentFullRefundFase3114.unit.test.ts:84-94,169-176`). A correção foi aplicada a `sync-payment-status` mas **não** ao webhook — que é o caminho **vivo**. |
| **⚠️ CONFLITO-02 — agravante descoberto nesta etapa** | Consulta ao banco: `SELECT group_id, count(*) parcelas, count(distinct provider_payment_id) ppids FROM payment_installments WHERE total_installments > 1 GROUP BY group_id` → **4 grupos, cada um com 4 parcelas e 4 `provider_payment_id` DISTINTOS.**<br><br>Ou seja: **em produção, cada parcela tem seu próprio `provider_payment_id`.** Como o código faz `if (dto.providerPaymentId) ... else if (dto.groupId)`, o `providerPaymentId` **vence** e já seleciona exatamente 1 linha — **o `installmentNumber` é redundante**.<br><br>**Isso inverte a leitura do risco:** o problema não é o filtro por `installmentNumber`, é que **um refund integral de um pagamento 4x atinge apenas a parcela cujo `provider_payment_id` veio no webhook**, deixando as outras 3 em `PAID`. E o teste `InstallmentFullRefundFase3114` — que assere que "refund integral atinge as 4 parcelas via `provider_payment_id`" — **assume um formato de dados que não é o de produção**. |
| **O que precisa ser validado** | 1. Confirmar com o Asaas se um estorno de cobrança parcelada gera **um** evento `PAYMENT_REFUNDED` por parcela ou **um** para o conjunto.<br>2. Confirmar se o `group_id` é o identificador correto para atingir todas as parcelas.<br>3. Revisar se as fixtures de `InstallmentFullRefundFase3114` refletem o formato real. |
| **Correção proposta (preliminar)** | Provavelmente: no webhook, usar `groupId` em vez de `providerPaymentId` quando o refund for integral, e remover `installmentNumber`. **Mas não implementar antes da validação acima.** |
| **Exige migration?** | ❌ NÃO |
| **Exige alteração de código?** | ✅ SIM |
| **Testes necessários** | Refazer `InstallmentFullRefundFase3114` com fixtures que reproduzam o formato real (1 `provider_payment_id` por parcela). |
| **Dependências** | Validação junto ao Asaas. **Ponto de aprovação (AP-13 — novo).** |
| **Critério de conclusão** | Estorno integral de pagamento 4x marca **todas** as 4 parcelas como `REFUNDED`, comprovado por teste com fixtures realistas. |

---

## F4-02 — `installmentNumber` no DTO e no filtro — **REMOVER NA FASE 4** (condicionado)

| Campo | Conteúdo |
|---|---|
| **Classe** | **C — ambígua** |
| **Ocorrências** | `lib/payments/InstallmentService.ts:50` (campo do `RecordRefundDTO`), `:296-298` (filtro `.eq('installment_number', ...)`); cópia Deno em `supabase/functions/_shared/InstallmentService.ts:66-68`. |
| **Situação** | É o mecanismo do modelo antigo, ainda executável. |
| **Ação** | **REMOVER NA FASE 4**, condicionado à conclusão de F4-01. Se a validação confirmar que o modelo atual nunca precisa de refund por parcela, o campo e o filtro saem do DTO e da query nas **duas** cópias. |
| **Atenção** | `scripts/sync-shared.ts:51` marca `InstallmentService` como **BLOCKED / NOT_GENERATED** — as duas cópias divergem por decisão (94 vs 319 linhas). A remoção precisa ser feita manualmente nas duas. |
| **Critério de conclusão** | `grep -rn "installment_number" lib/payments/InstallmentService.ts supabase/functions/_shared/InstallmentService.ts` em contexto de refund → 0 resultados; testes verdes. |

---

## F4-03 — `AsaasRefundAdapter` — **LEGADO MORTO — REMOVER NA FASE 4**

| Campo | Conteúdo |
|---|---|
| **Classe** | **B — legado morto** |
| **Evidência** | `lib/payments/AsaasRefundAdapter.ts` (`adaptAsaasRefunds`, `:20,55`) é importado **apenas** por `lib/payments/tests/RefundAdapterAndStateMachine.unit.test.ts:1`. **Zero callers de produção.** |
| **Ação** | **REMOVER NA FASE 4** — o arquivo e o teste que só existe para ele. |
| **Atenção** | Verificar se `RefundAdapterAndStateMachine.unit.test.ts` também testa a `RefundStateMachine` (que é viva). Se sim, dividir o teste antes de remover. |
| **Critério de conclusão** | Arquivo removido; cobertura da `RefundStateMachine` preservada. |

---

## F4-04 — `refund_operation_items` — **LEGADO MORTO (tabela) — NÃO REMOVER**

| Campo | Conteúdo |
|---|---|
| **Classe** | **D — somente histórico/migration** |
| **Evidência** | 0 linhas; 0 referências em código; aparece só em `20260812_refund_operations_forensic.sql:33,63,106` e `20260814_refund_operations_privilege_hardening.sql`. |
| **Ação** | **NÃO REMOVER as migrations históricas** (regra permanente do projeto). Quanto à **tabela**: decidir se é dropada no reset ou mantida como provisão. **Recomendação: manter** — o custo é zero e o drop exigiria uma migration adicional. |
| **Critério de conclusão** | Decisão registrada. |

---

## F4-05 — `PARTIALLY_COMPLETED` e correlatos — **MANTER (classe A)**

| Campo | Conteúdo |
|---|---|
| **Classe** | **A — ainda usada pelo modelo atual** |
| **Ocorrências mantidas** | `RefundStateMachine.ts:1,9,12,13,14` e cópia `_shared:11,19-24`; CHECK `refund_operations_status_check` no banco; write em `api/asaas-webhook.ts:1138-1140`; leitura em `BookingCancellationCore.ts:402` / `_shared:412`; listas de retenção em `RefundOperationRepository.ts:234,241,306,313` e `_shared:245,252,317,324` (cálculo de `availableBalanceCents`); early-return de `PAYMENT_PARTIALLY_REFUNDED` em `asaas-webhook.ts:1088-1089,1226-1240`; skip em `sync-payment-status/index.ts:168-170`; rótulos de UI em `InstructorHistoryAdapter.ts:57,146`, `StudentHistoryAdapter.ts:55`, `financePresentationFormatter.ts:27`. |
| **Justificativa** | Estorno parcial decidido **fora** do app (pelo Asaas) é um evento real que o sistema precisa registrar e não mutar parcelas por conta própria. Não é legado. |
| **Ação** | **MANTER.** Nenhuma remoção. |

---

## F4-06 — `refund_operation_events` vazia com 2 operações — **INVESTIGAR**

| Campo | Conteúdo |
|---|---|
| **Classe** | **C — ambígua** |
| **Problema** | 0 linhas apesar de existirem 2 `refund_operations`. |
| **O que falta** | Ler `lib/payments/RefundOperationRepository.ts:332` (`reconcileTransition`) integralmente para saber se ele **deveria** inserir evento. Se sim, é um bug de trilha de auditoria. |
| **Ação** | Investigar. Não remover. |
| **Critério de conclusão** | Classificação definitiva (A/B/C/D) registrada. |

---

## F4-07 — `supabase/functions/create-booking` — **LEGADO MORTO — REMOVER NA FASE 4**

| Campo | Conteúdo |
|---|---|
| **Classe** | **B — legado morto** |
| **Evidência** | Nenhum `invoke('create-booking')` em `pages/`, `components/`, `hooks/`, `contexts/`, `lib/`. O único caminho vivo de compra é `pages/student/InstructorProfile.tsx:1073` → `fetch('/api/create-booking-intent')`. |
| **Riscos latentes** | `verify_jwt = false`; não aplica desconto; não valida data passada/domingo. |
| **Ação** | **REMOVER NA FASE 4.** Isso também resolve parte de F1-11. |
| **Atenção** | Confirmar que nenhum cliente externo (ex.: app antigo ainda instalado) a invoca antes de remover. |
| **Critério de conclusão** | Função removida do repositório e do deploy; entrada removida de `config.toml`. |

---

## F4-08 — Subsistema `Payout` — **INVESTIGAR (herdado de F2-03)**

| Campo | Conteúdo |
|---|---|
| **Classe** | **C — ambígua** |
| **Problema** | `PayoutEngine`, `PayoutWorker`, `PayoutRepository`, `PayoutStateMachine`, `PayoutKeyFactory`, `PayoutWorkerTypes` + 8 suítes de teste; tabela `payouts` com **0 linhas**; `PayoutWorker` importado apenas por testes. |
| **Pergunta** | O repasse é feito **inteiramente pelo split do Asaas** (tornando o subsistema legado), ou havia modelo próprio previsto? |
| **Ação** | Investigar e classificar. **Não remover agora.** Se confirmado legado, promover a "REMOVER NA FASE 4" — mas isso é uma remoção grande (6 módulos + 8 suítes) e merece aprovação própria. |
| **Critério de conclusão** | Classificação registrada; decisão de remoção aprovada ou descartada. |

---

## F4-09 — `api/reconcile-payment.ts` sem referência a refund

| Campo | Conteúdo |
|---|---|
| **Classe** | **C — ambígua** |
| **Fato** | `grep -i refund api/reconcile-payment.ts` → **zero linhas**. Só é chamado por `sync-payment-status/index.ts:284`, que não está agendada. |
| **Ação** | Determinar, junto com F1-14, se `reconcile-payment` tem propósito no modelo atual ou é legado. |
| **Critério de conclusão** | Classificação registrada; agendado ou removido. |

---

> ## REGRA FUNDAMENTAL DESTA FASE
>
> **Não alterar o modelo de negócio atual para acomodar código legado.**
> A ordem é: **(1)** confirmar a arquitetura atual → **(2)** limpar o legado.
> Nenhum item classificado como **B (legado morto)** será removido antes de os itens **A** estarem confirmados e testados.

---

# 7. FASE 5 — DEMAIS FUNCIONALIDADES

> Ordenadas por prioridade e dependência. **Nenhum item aqui é "melhoria" — todos derivam de descoberta da auditoria.**

| ID | Problema | Evidência | Arquivos | Impacto | Ação | Dependência | Teste | Critério de conclusão |
|---|---|---|---|---|---|---|---|---|
| **F5-01** | `reject-booking` cancela escopos diferentes conforme o entrypoint | `BookingCancellationCore.ts:128-130`: default de `instructor_rejected` com `group_id` é `FULL_GROUP`. `cancel-booking/index.ts:106-113` passa `SINGLE_APPOINTMENT`; `reject-booking` (Edge e Vercel) **não passa scope** | `supabase/functions/reject-booking/index.ts:62-68`, `api/reject-booking.ts:65-70`, `lib/payments/BookingCancellationCore.ts:128-130` | Mesmo ato de negócio cancela 1 aula ou o combo inteiro | Definir o escopo correto para "instrutor recusa" e passá-lo explicitamente nos 3 entrypoints | F1-04/F1-05 (trigger) | Teste por entrypoint validando o escopo | Os 3 entrypoints produzem o mesmo escopo, comprovado por teste |
| **F5-02** | `api/reject-booking.ts` reintroduz o falso sucesso | Devolve `200` incondicionalmente, inclusive para `pending_refund`, enquanto os dois Edge corrigiram com `409 REFUND_PENDING` | `api/reject-booking.ts:66-78` vs `cancel-booking/index.ts:115-140` | UI diz "aula cancelada e horário liberado" com o dinheiro retido | Aplicar o mesmo tratamento `409 REFUND_PENDING` | F5-01 | Teste: `pending_refund` → 409 | Paridade de resposta entre os 3 entrypoints |
| **F5-03** | `auto_complete_lessons` ignora `proposal_status` | `prosrc` filtra só `reschedule_requested_at IS NULL`; `propose_reschedule` grava `proposal_status` | RPC `auto_complete_lessons` | Aula com proposta pendente cujo horário passou é marcada `completed`; a proposta fica órfã e `accept_reschedule` falha com `INVALID_STATUS` | Adicionar `AND proposal_status IS DISTINCT FROM 'pending'` ao filtro | Nenhuma | Teste SQL: aula com proposta pendente não é auto-concluída | Aula com `proposal_status='pending'` sobrevive ao job |
| **F5-04** | `propose_reschedule` e `accept_reschedule` não validam a grade do instrutor | Só validam conflito de slot; `reschedule_appointment_direct` valida a grade inteira inline | RPCs no banco | Proposta pode nascer fora da grade (noite/sábado/almoço/domingo) e ser aceita | Reutilizar `reschedule_grid_violation` nas duas RPCs | F5-03 (mesma área) | Teste SQL: proposta para domingo é rejeitada | Grade validada nos 3 caminhos de remarcação |
| **F5-05** | Guarda de `provider_wallet_id` incompleta | `create-booking-intent.ts:212-217` exige `provider_account_id` **OU** `provider_wallet_id`; `AsaasProvider.ts:389` filtra `!!rule.walletId` → **split silenciosamente removido, 100% fica com a plataforma** | `api/create-booking-intent.ts:212-217`, `lib/payments/AsaasProvider.ts:386-405` | Instrutor não recebe; a plataforma fica com o valor integral sem saber | Exigir `provider_wallet_id` obrigatoriamente; e falhar explicitamente se o split for removido | F1-09 | Teste: instrutor sem wallet → erro explícito, não cobrança sem split | Nenhuma cobrança é criada sem split |
| **F5-06** | `returnUrl` do checkout usa roteamento hash | `create-booking-intent.ts:600` monta `${origin}/#/student/lessons`; `App.tsx:192` usa `BrowserRouter` | `api/create-booking-intent.ts:600`, `App.tsx:141,192` | Retorno cai em `/` → `/welcome` → `/student/home`. **Nunca chega a `/student/lessons`** | Remover o `#`; validar contra a configuração real do Asaas | CONFLITO-03 (domínio) | Teste de integração do retorno | Retorno do checkout aterrissa em `/student/lessons` |
| **F5-07** | Sem retry, backoff ou dead-letter de notificações | Esquema tem `attempts`, `max_attempts=5`, `retry`, `dead`, mas nenhuma função do banco grava esses estados; `notification-worker/index.ts:157-160` só faz `console.error`. 1 job travado em `processing` há 43 dias | `claim_notification_jobs` (RPC), `notification-worker/index.ts` | Notificações perdidas em silêncio, sem recuperação | Implementar incremento de `attempts`, backoff em `next_run_at`, transição para `retry`/`failed`/`dead`, e re-captura de `processing` preso | F1-06/07/08 | Teste: job que falha é reagendado; após `max_attempts` vai para `dead` | Nenhum job pode ficar preso indefinidamente |
| **F5-08** | Falha de push reportada como sucesso | `send-push-notification/index.ts:241-246` retorna `success:true` incondicionalmente, inclusive sem token (`:156-160`); o worker aceita e marca `sent` | `send-push-notification/index.ts`, `notification-worker/index.ts:142` | A métrica "61 sent" **não prova entrega de nada**. Entrega não observável | Retornar sucesso apenas se ao menos um envio teve êxito; distinguir "sem token" de "falha" | F1-06 | Teste: todos os envios falham → `success:false` | Job só vira `sent` quando houve entrega real |
| **F5-09** | Deep links de push mortos ponta a ponta | SW lê `event.notification.data?.url` (`firebase-messaging-sw.js:37`); payload nunca envia `url` (`send-push-notification/index.ts:196-204`). `target_screen` escrito e **nunca lido** (0 leituras) | `public/firebase-messaging-sw.js`, `send-push-notification/index.ts`, front | Toda notificação abre a home | Decidir: enviar `url` no payload **ou** rotear por `target_screen` no SW. Unificar ponta a ponta | F5-08 | Teste manual: clique em cada tipo de notificação abre a tela correta | Cada tipo de notificação abre a tela correspondente |
| **F5-10** | Token FCM não removido no logout | `AuthContext.tsx:383-388` só faz `signOut()` + `localStorage.clear()`; único DELETE em `fcm_tokens` é por erro do FCM | `contexts/AuthContext.tsx:383-388` | Em dispositivo compartilhado, pushes de A chegam ao dispositivo de B | Chamar `deleteToken()` do Firebase e remover a linha de `fcm_tokens` no logout | Nenhuma | Teste: após logout, o token não está em `fcm_tokens` | Logout remove o token do dispositivo |
| **F5-11** | Sem notificação de pagamento liberado, conclusão de aula ou refund | `payment_released` tem helper (`_shared/NotificationService.ts:342`) **nunca chamado**; conclusão e refund **não têm tipo nem emissor**. 5 dos 13 tipos do CHECK nunca foram emitidos | `_shared/NotificationService.ts`, `auto-complete-lessons`, `BookingCancellationCore` | Eventos financeiros acontecem sem nenhum aviso ao usuário — inclusive falhas silenciosas de cron | Emitir os 3 eventos faltantes; remover ou justificar os tipos sem emissor | F5-07, F5-08 | Teste por evento | Todo evento financeiro relevante gera notificação |
| **F5-12** | `cron.job_run_details` sem retenção | Taxa medida **3.169 linhas/dia** (=1440+1440+288+1), ~1,26 KB/linha → **+3,9 MB/dia, ~119 MB/mês, ~1,39 GB/ano**. A janela atual reconstituiu 117 MB em ~30 dias. Nenhum job de limpeza existe | `cron.job`, migrations de cron | **O incidente de 07–16/09 pode recorrer em ~30 dias.** ~97% é ruído de 2 jobs de minuto em minuto | Criar job de retenção (ex.: manter 14 dias). **Considerar também reduzir a frequência dos 2 jobs de minuto** — 61 jobs processados em 45 dias contra ~65.000 execuções | Etapa B3 (`VACUUM FULL`) pendente | Verificar que o job roda e mantém a janela | Tabela estabilizada abaixo de um teto definido |
| **F5-13** | `succeeded` do pg_cron não detecta falha HTTP real | `invoke_edge_function_cron` retorna o `request_id` do pg_net e **nunca lê `net._http_response`** | RPCs `invoke_edge_function_cron`, `invoke_vercel_cron` | Um HTTP 401/500 é registrado como `succeeded`. Crítico em `sync-gateway-fees` (1×/dia, sem retry): falha = 24h de taxas não reconciliadas, indistinguível de sucesso | Job de verificação que lê `net._http_response` e alerta em status ≠ 2xx | F5-12 | Teste: forçar 500 na função e verificar detecção | Falha de cron é detectável |
| **F5-14** | 35 `error.message` crus expostos ao usuário | grep em `pages/`. `InstructorAgenda.tsx:169,1043,1077,1188,1209,1227,1257` e `Lessons.tsx:765` mostram a mensagem **sem prefixo algum** | `pages/` (13 arquivos) | Mensagens do PostgREST em inglês com nomes de coluna/constraint expostas ao usuário final | Mapa de erros → mensagens em pt-BR; nunca renderizar `error.message` cru | Nenhuma | Grep de verificação | `grep -rn "error.message" pages/` em contexto de UI → 0 |
| **F5-15** | ~40 `catch` que só fazem `console.*` e 6 vazios | `lib/functions.ts:50`; `StudentHome.tsx:169,245,265`; `student/Profile.tsx:113`; `InstructorProfile.tsx:251`; `Lessons.tsx:271,490,536,860`; `InstructorAgenda.tsx:207,512,778,1178`; etc. | `pages/`, `lib/`, `contexts/` | Home, perfil, aulas e agenda podem aparecer **vazias sem nenhuma mensagem**. Nenhuma observabilidade (grep Sentry/Datadog → 0) | Exibir estado de erro ao usuário; adicionar observabilidade mínima | F5-14 | Teste: simular falha de rede e verificar que a tela informa | Nenhuma tela falha silenciosamente |
| **F5-16** | 5 `setLoading(true)` sem `finally` + `isProcessingPayment` que pode congelar | `Login.tsx:26`, `RegisterStudent.tsx:107`, `RegisterInstructor.tsx:114`, `ForgotPassword.tsx:21`, `UpdatePassword.tsx:49`; e `student/InstructorProfile.tsx:1015-1111` (após `CheckoutLauncher.launch` permanece `true`) | arquivos citados | Botão travado em exceção de rede; UI congelada em "processando" se o popup for bloqueado | Envolver em `try/finally`; tratar falha do `CheckoutLauncher` | Nenhuma | Teste: simular rejeição de promise e verificar que o loading encerra | Nenhum loading pode ficar preso |
| **F5-17** | Inconsistência de timezone na mesma tela | `InstructorFinance.tsx:252` formata data em **UTC** e `:257` formata hora no fuso **local**. `AuthContext` calcula `serverTimeOffset` (`:277-292`) e **nenhum formatador o usa** | `InstructorFinance.tsx`, `HistoryCardFormatter.ts:35`, `InstructorAgenda.tsx:1394`, `student/InstructorProfile.tsx:548,1312` | A mesma transação pode exibir data e hora de dias diferentes | Padronizar em `America/Sao_Paulo` em todos os formatadores | Nenhuma | Teste com fuso do dispositivo alterado | Mesma transação exibe data e hora coerentes em qualquer fuso |
| **F5-18** | Limpeza de código morto e resíduos | Seção O do relatório + F2-04 + F2-05 | Ver inventários | Ruído no repositório; scripts perigosos ao alcance | Remover após aprovação da lista de F2-04/F2-05 | F2-04, F2-05, F4-03, F4-07 | Build e bateria verdes após remoção | Repositório sem os itens aprovados para remoção |
| **F5-19** | `npm run lint` permanentemente quebrado; ESLint inexistente | `npx tsc --noEmit` → 9 erros, todos em `supabase/functions/` (especificadores Deno `npm:` e imports `.ts`). `ls .eslintrc* eslint.config.*` → não existe | `tsconfig.json`, `package.json` | Erros de tipo reais no código do app ficam mascarados; a equipe aprende a ignorar o lint | Adicionar `supabase/functions` ao `exclude` do tsconfig; introduzir ESLint com `react-hooks/exhaustive-deps` | Nenhuma | `npm run lint` verde | Lint verde e ESLint configurado |

---

# 8. CONFLITOS ENCONTRADOS

> Registrados conforme a regra: **não escolher silenciosamente entre relatório e código.**

## CONFLITO-01 — Região da Vercel (GRU1)

| | |
|---|---|
| **Declarado pelo proprietário** | "A região da Vercel foi posteriormente alterada para GRU1." |
| **Estado verificado do repositório** | `vercel.json` contém **apenas** um bloco `rewrites`. **Não há chave `regions`, nem `crons`, nem `headers`, nem `functions`.** |
| **Leitura** | A alteração para GRU1 **não está versionada**. Provavelmente foi feita no painel da Vercel (Project Settings → Functions → Region), que não se reflete no repositório. |
| **O que precisa ser validado** | Confirmar no painel da Vercel qual é a região atual das Serverless Functions. |
| **Ação no plano** | **NÃO planejar alteração de região.** O relatório (§N, P-27) listava "sem `regions`" como pendência — essa pendência está **SUSPENSA** até a verificação. F1-16 (headers) permanece válido e é independente. |

## CONFLITO-02 — `provider_payment_id` por parcela × modelo assumido pelo teste

| | |
|---|---|
| **Assumido pelo teste** | `InstallmentFullRefundFase3114.unit.test.ts:195-198` assere que um refund integral via `provider_payment_id` atinge as **4 parcelas**. |
| **Estado verificado do banco** | `SELECT group_id, count(*), count(DISTINCT provider_payment_id) FROM payment_installments WHERE total_installments > 1 GROUP BY group_id` → **4 grupos, cada um com 4 parcelas e 4 `provider_payment_id` DISTINTOS**. |
| **Leitura** | Em produção, cada parcela tem seu próprio `provider_payment_id`. Logo `.eq('provider_payment_id', X)` seleciona **1 linha**, não 4. O teste usa fixtures que não correspondem ao formato real. |
| **Consequência** | O risco real **não** é o filtro `installmentNumber` — é que um refund integral de pagamento 4x possa atingir apenas 1 parcela. **Isto eleva F4-01 a bloqueador.** |
| **O que precisa ser validado** | 1. Comportamento do Asaas em estorno de cobrança parcelada (um evento por parcela ou um para o conjunto). 2. Se `group_id` é o identificador correto. |

## CONFLITO-03 — Domínio de produção

| | |
|---|---|
| **Código** | `api/create-booking-intent.ts:600` usa fallback `https://autoescolabrasil.com`. |
| **Documentos e constantes** | `constants.ts:11-13` usa `cnhja.com.br` (suporte, privacidade, lgpd). `package.json:2` nomeia o pacote `autoescola-do-brasil`. |
| **Por que importa** | O `assetlinks.json` do TWA **precisa ficar no domínio do `start_url`**. Sem resolver isto, F1-13 não pode ser concluído. |
| **O que precisa ser validado** | Qual é o domínio de produção definitivo. |

## CONFLITO-04 — Migration de `cancelling` criada e não aplicada

| | |
|---|---|
| **Código** | `lib/payments/BookingCancellationCore.ts:253-268` declara *"THE `cancelling` LOCK IS GONE"*; teste `RefundHardeningP1201B.unit.test.ts:191` confirma. Existe `supabase/migrations/20260923_p1201b_04_drop_cancelling_status.sql`. |
| **Banco** | `appointments_status_check` **ainda contém** `'cancelling'`, e há **3 linhas nesse status** com `payment_status='paid'`. |
| **Leitura** | A migration foi escrita e **nunca aplicada**. Como o banco será resetado, as 3 linhas são descartáveis (F2-01); mas **a migration precisa ser aplicada** para que o CHECK final não aceite o status. |
| **Ação** | Incluir a aplicação dessa migration no procedimento de reset (F2-08), sob autorização. |

## CONFLITO-05 — Migrations não rastreadas (2 × 68)

| | |
|---|---|
| **Repositório** | 68 arquivos em `supabase/migrations/`. |
| **Banco** | `supabase_migrations.schema_migrations` tem **2 linhas** (`20260918004932`, `20260918012312`). |
| **Consequência já observada** | `20260308_fix_appointments_rls.sql` tem `USING(true)` para `appointments`, mas o **banco vivo** tem `uid=student_id OR uid=instructor_id`. A auditoria teve de resolver pelo catálogo (`pg_policy`), não pelas migrations. |
| **Hipótese** | `apply-migration.ts` na raiz (aplicador fora do fluxo oficial, F2-05) pode ser a causa. |
| **Leitura** | **As migrations não são fonte de verdade neste projeto.** Toda verificação deve ser feita pelo catálogo do PostgreSQL. |
| **O que precisa ser validado** | Se há migrations no repositório que **não** estão aplicadas (além de CONFLITO-04). Isso é pré-requisito do reset. |
| **Ação** | Item de F6 (auditoria final): reconciliar migrations × catálogo antes do reset. |

## CONFLITO-06 — Modificação não commitada em teste de refund

| | |
|---|---|
| **Fato** | `git status` mostra `M lib/payments/tests/RefundReconciliationFase31.unit.test.ts` com **+86 / −47 linhas**. |
| **Conteúdo** | O diff introduz um contrato chamado **"FASE 1.1.E InstallmentService Decoupling"**, declarando que `InstallmentService` NUNCA deve escrever em `payment_settlements`, criar `transactions` de `settlement_refund`, emitir `REFUND_CREATED` nem gerar `provider_settlement_id` artificial para refund. |
| **Problema** | Essa fase "1.1.E" **não aparece em nenhum commit** e não foi mencionada em nenhuma das auditorias anteriores desta sessão. |
| **O que precisa ser validado** | Quem fez essa alteração, quando, e se o contrato declarado nela é o modelo vigente. **Isso afeta diretamente a Fase 4** — se o desacoplamento já foi decidido, parte da classificação de legado muda. |
| **Ação** | **Resolver antes de iniciar a Fase 4.** Ponto de aprovação AP-14. |

## CONFLITO-07 — Relatório de auditoria não está no repositório

| | |
|---|---|
| **Fato** | `find . -name "*RELEASE-AUDIT*"` → nenhum resultado. `docs/audits/` contém apenas `P-1.23D.3B-cron-job-run-history.md`. |
| **Leitura** | O relatório `P-RELEASE-AUDIT-001` existe apenas como entrega no chat. Este plano mestre o referencia como origem, mas a evidência não está versionada. |
| **Ação** | **Recomendado:** commitar o relatório em `docs/audits/` junto com este plano, para que o contrato de escopo tenha sua evidência rastreável. **Ponto de aprovação AP-15.** |
| **Nota** | `docs/` inteiro está como **untracked** no git (`?? docs/`) — inclusive o documento da fase P-1.23D.3B. |

---

# 9. MATRIZ DE ESCOPO

Legenda — **Ação:** COR=corrigir · REM=remover · IMP=implementar · INV=investigar · DEC=decidir · DOC=documentar · VER=verificar
**Código / SQL / Dados / Teste:** ✅ sim · ❌ não · ⚠️ a definir

| ID | Item | Fase | Ação | Código | SQL | Dados | Teste | Status |
|---|---|---|---|---|---|---|---|---|
| F1-01 | INSERT em `appointments` sem guarda de preço/status | 1 | COR | ⚠️ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-02 | `profiles` legível por qualquer autenticado | 1 | COR | ✅ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-03 | `instructors` legível por `anon` | 1 | COR | ✅ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-04 | `confirmed → cancelled` pelo frontend | 1 | COR | ❌ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-05 | Aluno marca `completed`/`no_show` | 1 | COR | ✅ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-06 | `send-push-notification` sem auth | 1 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F1-07 | Telemetria vaza `CRON_SECRET` | 1 | REM | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F1-08 | `CRON_SECRET` fail-open | 1 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F1-09 | Asaas sandbox sem fail-closed | 1 | COR | ✅ | ❌ | ⚠️ | ✅ | PLANEJADO |
| F1-10 | 2 critical + 11 high em dependências | 1 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F1-11 | 3 Edge Functions `verify_jwt=false` não auditadas | 1 | INV | ⚠️ | ❌ | ❌ | ⚠️ | PLANEJADO |
| F1-12 | Exclusão de conta inexistente | 1 | IMP | ✅ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-13 | Nenhum artefato Android | 1 | IMP | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F1-14 | Reconciliação não agendada | 1 | IMP | ✅ | ⚠️ | ❌ | ✅ | PLANEJADO |
| F1-15 | Buckets públicos sem limite | 1 | COR | ⚠️ | ✅ | ❌ | ✅ | PLANEJADO |
| F1-16 | `vercel.json` sem headers de segurança | 1 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F1-17 | Leaked password protection desabilitado | 1 | COR | ❌ | ❌ | ❌ | ✅ | PLANEJADO |
| F2-01 | Registros financeiros presos (inventário) | 2 | DOC | ❌ | ❌ | ✅ | ❌ | PLANEJADO |
| F2-02 | `platform_fee` incoerente em 24/36 linhas | 2 | DEC | ❌ | ❌ | ✅ | ⚠️ | PLANEJADO |
| F2-03 | `payouts` vazia com subsistema completo | 2 | INV | ❌ | ❌ | ✅ | ❌ | PLANEJADO |
| F2-04 | Arquivos de evidência de teste | 2 | DOC | ❌ | ❌ | ✅ | ❌ | PLANEJADO |
| F2-05 | 15 scripts na raiz com `SERVICE_ROLE_KEY` | 2 | DOC | ❌ | ❌ | ❌ | ❌ | PLANEJADO |
| F2-06 | `gateway_fee_schedule` com tarifas do sandbox | 2 | DEC | ❌ | ⚠️ | ✅ | ❌ | PLANEJADO |
| F2-07 | `refund_operation_items`/`_events` vazias | 2 | INV | ❌ | ❌ | ✅ | ❌ | PLANEJADO |
| F2-08 | Procedimento de reset (preparação) | 2 | DOC | ❌ | ✅ | ✅ | ❌ | PLANEJADO |
| F3-01 | Política omite 11 categorias de dados | 3 | COR | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-02 | Afirmação falsa sobre exclusão na UI | 3 | COR | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-03 | Data Safety inconsistente | 3 | DOC | ❌ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-04 | 21 divergências Termos × código | 3 | DEC | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-05 | Consentimento não granular/sem versão | 3 | COR | ✅ | ✅ | ❌ | ✅ | PLANEJADO |
| F3-06 | Bases legais por finalidade | 3 | DEC | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-07 | Terceiros não nomeados | 3 | COR | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-08 | Transferência internacional não mencionada | 3 | COR | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-09 | Retenção não definida | 3 | DEC | ⚠️ | ⚠️ | ❌ | ❌ | PLANEJADO |
| F3-10 | Controlador e DPO não identificados | 3 | COR | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-11 | Cookies descritos incorretamente | 3 | COR | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-12 | Menores de idade não tratados | 3 | DEC | ⚠️ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-13 | Política pública só na versão Aluno | 3 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F3-14 | Ícone `maskable` e screenshots ausentes | 3 | IMP | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-15 | Página de suporte / contato público | 3 | IMP | ✅ | ❌ | ❌ | ❌ | PLANEJADO |
| F3-16 | Enquadramento Payments/Financial Services | 3 | VER | ❌ | ❌ | ❌ | ❌ | PLANEJADO |
| F4-01 | `installmentNumber` no webhook (CONFLITO-02) | 4 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F4-02 | `installmentNumber` no DTO e filtro | 4 | REM | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F4-03 | `AsaasRefundAdapter` legado morto | 4 | REM | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F4-04 | `refund_operation_items` (tabela) | 4 | DEC | ❌ | ⚠️ | ✅ | ❌ | PLANEJADO |
| F4-05 | `PARTIALLY_COMPLETED` e correlatos | 4 | DOC | ❌ | ❌ | ❌ | ❌ | PLANEJADO |
| F4-06 | `refund_operation_events` vazia | 4 | INV | ❌ | ❌ | ✅ | ⚠️ | PLANEJADO |
| F4-07 | `create-booking` legado morto | 4 | REM | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F4-08 | Subsistema `Payout` | 4 | INV | ⚠️ | ❌ | ✅ | ⚠️ | PLANEJADO |
| F4-09 | `api/reconcile-payment.ts` sem refund | 4 | INV | ⚠️ | ❌ | ❌ | ⚠️ | PLANEJADO |
| F5-01 | Escopo divergente de `reject-booking` | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-02 | Falso sucesso em `api/reject-booking.ts` | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-03 | `auto_complete_lessons` ignora `proposal_status` | 5 | COR | ❌ | ✅ | ❌ | ✅ | PLANEJADO |
| F5-04 | Remarcação por proposta não valida a grade | 5 | COR | ❌ | ✅ | ❌ | ✅ | PLANEJADO |
| F5-05 | Guarda de `provider_wallet_id` incompleta | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-06 | `returnUrl` do checkout com hash | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-07 | Sem retry/dead-letter de notificações | 5 | IMP | ✅ | ✅ | ❌ | ✅ | PLANEJADO |
| F5-08 | Falha de push reportada como sucesso | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-09 | Deep links de push mortos | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-10 | Token FCM não removido no logout | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-11 | Sem notificação de repasse/conclusão/refund | 5 | IMP | ✅ | ⚠️ | ❌ | ✅ | PLANEJADO |
| F5-12 | `cron.job_run_details` sem retenção | 5 | IMP | ❌ | ✅ | ✅ | ✅ | PLANEJADO |
| F5-13 | `succeeded` do pg_cron não detecta falha HTTP | 5 | IMP | ❌ | ✅ | ❌ | ✅ | PLANEJADO |
| F5-14 | 35 `error.message` crus na UI | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-15 | ~40 `catch` silenciosos | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-16 | Loadings sem `finally` | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-17 | Inconsistência de timezone | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-18 | Limpeza de código morto e resíduos | 5 | REM | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F5-19 | `npm run lint` quebrado; sem ESLint | 5 | COR | ✅ | ❌ | ❌ | ✅ | PLANEJADO |
| F6-01 | Auditoria de código pré-reset | 6 | VER | ❌ | ❌ | ❌ | ✅ | PLANEJADO |
| F6-02 | Reconciliação migrations × catálogo | 6 | VER | ❌ | ✅ | ❌ | ✅ | PLANEJADO |
| F6-03 | Execução do reset e validação | 6 | VER | ❌ | ✅ | ✅ | ✅ | PLANEJADO |
| F6-04 | Testes finais com banco limpo + go-live | 6 | VER | ❌ | ❌ | ✅ | ✅ | PLANEJADO |

---

# 10. FASE 6 — AUDITORIA FINAL

> Define o que precisa ser verificado para afirmar que o projeto está pronto para **(1)** reset do banco, **(2)** testes finais com banco limpo, **(3)** publicação.

## F6-01 — Auditoria de código pré-reset

**Gate: nada abaixo pode começar antes que isto passe.**

- [ ] Todos os 17 itens da Fase 1 com status CONCLUÍDO e critério objetivo atendido
- [ ] Todos os 9 itens da Fase 4 classificados; remoções aprovadas executadas; nada classificado como **A** removido
- [ ] Bateria oficial verde (as 4 falhas de baseline resolvidas ou reclassificadas com justificativa)
- [ ] `npm run lint` verde (F5-19)
- [ ] `npm audit` sem `critical`/`high` em runtime (F1-10)
- [ ] `npm run build` verde
- [ ] Nova suíte de testes de RLS cobrindo F1-01 a F1-05 — **hoje a cobertura nessa área é zero**
- [ ] `grep -rn "sandbox.asaas.com"` só dentro de `AsaasEnvironment.ts` (F1-09)
- [ ] `grep -rn "expectedMismatchCharacter"` → 0 (F1-07)
- [ ] `scripts/sync-shared.ts --check` verde
- [ ] Todos os 7 conflitos da seção 8 resolvidos e registrados

## F6-02 — Reconciliação migrations × catálogo

**Obrigatório por causa do CONFLITO-05.**

- [ ] Listar todas as 68+ migrations e determinar, **pelo catálogo**, quais estão aplicadas
- [ ] Aplicar as pendentes sob autorização (inclui `20260923_p1201b_04_drop_cancelling_status.sql`, CONFLITO-04)
- [ ] Popular `supabase_migrations.schema_migrations` corretamente, ou adotar formalmente o catálogo como fonte de verdade e documentar isso
- [ ] Decidir o destino de `supabase_schema.sql` e `supabase_migration_plan.sql` (F2-04)
- [ ] Confirmar que `apply-migration.ts` não será mais usado (F2-05)

## F6-03 — Execução do reset e validação

**Só após F6-01 e F6-02.**

- [ ] Backup completo do banco **antes** de qualquer DELETE
- [ ] Script de reset (F2-08) revisado e **aprovado explicitamente** (AP-10)
- [ ] `SELECT` de verificação ANTES executado e registrado
- [ ] Reset executado **manualmente pelo proprietário**
- [ ] `SELECT` de verificação DEPOIS executado e registrado
- [ ] `gateway_fee_schedule` repovoado com as **tarifas de produção** confirmadas (F2-06, AP-04)
- [ ] `platform_financial_settings` e `notification_config` intactos
- [ ] 4 cron jobs ativos e executando
- [ ] Policies, triggers e funções intactos (verificar pelo catálogo)

## F6-04 — Testes finais com banco limpo e checklist de go-live

**Fluxos ponta a ponta a executar com banco limpo e ambiente Asaas definido:**

- [ ] Cadastro de aluno e de instrutor
- [ ] Onboarding Asaas do instrutor (subconta + wallet)
- [ ] Compra de aula avulsa — PIX
- [ ] Compra de aula avulsa — cartão à vista
- [ ] Compra de combo — cartão 4x
- [ ] Verificação da identidade contábil: `gross = net + platform_fee + fee_amount` em **100%** das linhas novas
- [ ] Verificação do split: instrutor recebe exatamente 90% do `service_price`
- [ ] Aceite pelo instrutor
- [ ] Rejeição pelo instrutor + refund integral (validando F4-01 em pagamento 4x)
- [ ] Expiração automática + refund
- [ ] Cancelamento pelo aluno antes do aceite + refund
- [ ] Tentativa de cancelamento após o aceite → **deve ser bloqueada** (F1-04)
- [ ] Remarcação direta >24h
- [ ] Remarcação por proposta ≤24h (propor, aceitar, rejeitar, cancelar)
- [ ] Conclusão automática (`auto-complete-lessons`) com proposta pendente → **não deve concluir** (F5-03)
- [ ] Gorjeta: 100% ao instrutor, `platform_fee = 0`
- [ ] Notificações: nova solicitação, aceite, recusa, remarcação, **pagamento liberado, conclusão e refund** (F5-11)
- [ ] Push entregue de fato (não apenas `sent`) — F5-08
- [ ] Deep link abre a tela correta — F5-09
- [ ] **Exclusão de conta** in-app e por URL web (F1-12)
- [ ] Logout remove o token FCM (F5-10)
- [ ] Tentativas de ataque: INSERT com preço arbitrário, leitura de `profiles` alheio, leitura de `instructors` por `anon`, `UPDATE status` proibido, invocação de `send-push-notification` sem segredo → **todas devem falhar**
- [ ] Headers de segurança presentes em produção (F1-16)
- [ ] `assetlinks.json` validado; `.aab` instalando sem barra de URL (F1-13)
- [ ] Política e Termos públicos, completos e coerentes com o comportamento (Fase 3)
- [ ] Data Safety coerente com a política (F3-03)

---

# 11. FORA DO ESCOPO

> Explicitamente **NÃO** deve ser alterado durante as próximas correções.

## 11.1 Sistemas e ambientes

| Item | Razão |
|---|---|
| **ADMCNHJá** (`~/mnt/ADMCNHJá/adm-cnhja`) | Fora de escopo por instrução permanente do projeto até a Etapa H |
| **CNHJa-Sandbox** (`~/mnt/CNHJa-Sandbox`) | Cópia de trabalho. O projeto real é `D:\projetos\CNHJa\CNHJa` |
| **Configuração do painel Asaas** | Nenhuma alteração sem autorização explícita; a virada sandbox→produção é decisão comercial (Etapa I) |
| **Região da Vercel** | **CONFLITO-01** — não alterar sem verificar o estado atual |
| **Configuração do painel Supabase** | Exceto F1-17 (leaked password protection), que é ação manual do proprietário |
| **Migrations históricas já aplicadas** | Regra permanente: **nunca editar**. Correções vão em migrations novas |

## 11.2 Regras de negócio que NÃO mudam

| Item | Razão |
|---|---|
| **Comissão CNHJá = 10%; instrutor = 90%** | Invariante validado como correto no código |
| **Gorjeta: 0% de comissão, taxa descontada da gorjeta** | Invariante validado como correto em código e dados |
| **Gross-up da tarifa (aluno paga a taxa)** | Validado como matematicamente exato |
| **Refund somente antes do aceite** | Confirmado nesta auditoria como a arquitetura atual (F4, pergunta 6) |
| **Remarcação: >24h direta, ≤24h por proposta** | Arquitetura atual; validada por 57 asserts SQL |
| **Remarcação é por appointment, nunca amplia por `group_id`** | Regra estabelecida em P-1.20.5 |
| **`MAX_INSTALLMENTS = 4`** | Regra de produto (a unificação em fonte única é F5, não a mudança do valor) |
| **Modelo de split fixo (não percentual) para aulas** | Garante que a sobra de arredondamento nunca saia do instrutor |

## 11.3 Não fazer

- **Não reconstruir historicamente operações financeiras** — decisão explícita do proprietário
- **Não executar refunds reais** sobre os dados de teste
- **Não alterar os 5 registros de teste protegidos** até o reset
- **Não fazer refactor amplo** de nada que não esteja nesta matriz
- **Não alterar UI** além do estritamente necessário para os itens listados
- **Não criar "melhorias"** fora das descobertas da auditoria
- **Não alterar o modelo de negócio atual para acomodar código legado**
- **Não instalar nem remover dependências** fora do que F1-10 exige
- **Não usar `supabase db push`** — proibido permanentemente neste projeto
- **Não usar `git add .` / `git add -A`** — adicionar arquivos explicitamente
- **Não rodar as suítes `*.integration.test.ts` / `*.concurrency.test.ts`** antes de confirmar contra qual banco apontam (podem escrever em produção — hipótese que explica a existência dos 5 registros protegidos)

---

# 12. REGRAS DE EXECUÇÃO

1. **Nenhuma alteração destrutiva sem autorização explícita.** DELETE, DROP, TRUNCATE, remoção de arquivo e remoção de dependência exigem aprovação nominal para cada operação.

2. **Nenhum SQL de produção sem revisão.** Todo SQL é entregue como texto para revisão antes de qualquer execução. Claude **não executa** SQL de escrita em produção.

3. **Migrations somente versionadas.** Toda alteração de schema, policy, função ou trigger vira arquivo em `supabase/migrations/` com nome datado. **Nunca editar migration histórica** — sempre criar uma nova, corretiva.

4. **Nenhuma alteração de banco diretamente pelo Claude sem autorização.** O padrão é: Claude escreve a migration → proprietário revisa → proprietário aplica manualmente. Consultas `SELECT` de diagnóstico são permitidas.

5. **Não misturar limpeza de dados de teste com correções de código.** São fases separadas (2 e 1/4/5) e não devem compartilhar commits. O reset é evento único, na Fase 6.

6. **Não alterar regras de negócio para acomodar legado.** Primeiro confirmar a arquitetura atual, depois limpar o legado. Nenhum item classificado como **A** é removido.

7. **Não fazer deploy durante o planejamento nem durante a preparação.** Deploy é evento explícito, autorizado, e `main` → Vercel → **produção, sem preview branch**.

8. **Não ampliar escopo.** Se durante a execução surgir algo fora desta matriz, **reportar e parar** — não corrigir por conta própria. Novos achados entram como item novo, com ID, e passam por aprovação.

9. **Uma correção por vez, com evidência antes da próxima.** Princípio já estabelecido nas fases anteriores do projeto.

10. **O catálogo do PostgreSQL é a fonte de verdade sobre o estado do banco**, não as migrations (CONFLITO-05). Toda verificação usa `pg_policy`, `pg_proc`, `pg_constraint`, `pg_trigger`.

11. **Separar FATO / INFERÊNCIA / HIPÓTESE.** Onde não for possível confirmar, escrever **NÃO CONFIRMADO** e dizer o que falta.

12. **Nunca reproduzir secrets.** Se alguma consulta retornar token, chave ou credencial, redigir como `[REDACTED]` e sinalizar.

13. **Toda migration acompanha:** `SELECT` de verificação ANTES, o DDL/DML, `SELECT` de verificação DEPOIS, e procedimento de rollback.

---

# 13. ORDEM DE EXECUÇÃO

## 13.1 Diagrama de dependências

```
                    ┌──────────────────────────────────┐
                    │  ETAPA 0 — RESOLVER CONFLITOS    │
                    │  C-01 região · C-03 domínio      │
                    │  C-06 fase 1.1.E · C-07 evidência│
                    └────────────────┬─────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
        ▼                            ▼                            ▼
┌───────────────┐          ┌──────────────────┐        ┌──────────────────┐
│  FASE 1-A     │          │   FASE 4         │        │  DECISÕES DE     │
│  Banco/RLS    │          │   Refund legado  │        │  PRODUTO         │
│  F1-01..05,15 │          │   F4-01 primeiro │        │  AP-05 retenção  │
│               │          │   (bloqueador)   │        │  AP-11 cancel.   │
└───────┬───────┘          └────────┬─────────┘        └────────┬─────────┘
        │                           │                           │
        ▼                           │                           ▼
┌───────────────┐                   │                  ┌──────────────────┐
│  FASE 1-B     │                   │                  │   FASE 3         │
│  Edge/Cron    │                   │                  │   LGPD/Termos    │
│  F1-06,07,08  │                   │                  │   F3-01..16      │
│  F1-11,14     │                   │                  └────────┬─────────┘
└───────┬───────┘                   │                           │
        │                           │                           │
        ▼                           │                           ▼
┌───────────────┐                   │                  ┌──────────────────┐
│  FASE 1-C     │                   │                  │   F1-12          │
│  Deps/Headers │                   │                  │   Exclusão conta │
│  F1-09,10,16  │                   │                  └────────┬─────────┘
│  F1-17        │                   │                           │
└───────┬───────┘                   │                           ▼
        │                           │                  ┌──────────────────┐
        └───────────┬───────────────┴──────────────────│   F1-13          │
                    │                                  │   Android/TWA    │
                    ▼                                  └────────┬─────────┘
           ┌──────────────────┐                                 │
           │    FASE 5        │◀────────────────────────────────┘
           │    F5-01..19     │
           └────────┬─────────┘
                    │
                    ▼
           ┌──────────────────┐
           │    FASE 2        │  (inventário pode correr em paralelo desde o início;
           │    F2-08 script  │   o script de reset só faz sentido no fim)
           └────────┬─────────┘
                    │
                    ▼
           ┌──────────────────┐
           │    FASE 6        │
           │    F6-01..04     │
           └──────────────────┘
```

## 13.2 Ordem recomendada, com justificativa

| # | Bloco | Itens | Por que nesta posição |
|---|---|---|---|
| **0** | **Resolver conflitos** | C-01, C-03, C-06, C-07 | C-06 (fase "1.1.E") pode **mudar a classificação da Fase 4**. C-03 (domínio) bloqueia F1-13 e F5-06. Resolver antes evita retrabalho |
| **1** | **Decisões de produto** | AP-05 (retenção), AP-11 (cancelamento), AP-01/02/03 | São **pré-requisito** de F1-12 e da Fase 3. Decidir cedo evita implementar duas vezes |
| **2** | **FASE 1-A — Banco e RLS** | F1-01, F1-02, F1-03, F1-04, F1-05, F1-15 | **Maior risco, menor dependência.** F1-04 e F1-05 compartilham a mesma migration. Fecha a superfície de escrita e leitura antes de qualquer outra coisa |
| **3** | **FASE 1-B — Edge Functions e cron** | F1-06, F1-07, F1-08, F1-11, F1-14 | F1-06/07/08 compartilham o mecanismo de segredo. F1-11 pode **eliminar** `create-booking` (cruza com F4-07) |
| **4** | **FASE 4 — Refund legado** | F4-01 (primeiro), depois F4-02..09 | **F4-01 é bloqueador** e depende de validação junto ao Asaas — iniciar cedo por causa do tempo de resposta externo. As remoções (F4-02, 03, 07) só depois de F4-01 confirmado |
| **5** | **FASE 1-C — Dependências e infra** | F1-16 (headers) → F1-10 (deps) → F1-09 (Asaas env) → F1-17 | Headers **antes** do upgrade de deps, para que o CSP já proteja. F1-09 prepara o código; a virada de ambiente é decisão comercial posterior |
| **6** | **FASE 3 — LGPD e Termos** | F3-04, F3-06, F3-09 primeiro (decisões) → F3-01, 07, 08, 10, 11 (textos) → F3-05, 13 (mecânica) | O texto não pode ser escrito antes de o comportamento estar decidido |
| **7** | **F1-12 — Exclusão de conta** | — | Depende de F3-09 (retenção). É pré-requisito de F3-02, F3-03 e F1-13 |
| **8** | **F1-13 — Empacotamento Android** | — | Depende de C-03 (domínio), F1-12 (exclusão) e F3-13 (política pública). Empacotar antes seria submeter algo que será rejeitado |
| **9** | **FASE 5 — Demais pendências** | F5-01..19, na ordem da tabela | Todas dependem de a base estar estável. F5-18 (limpeza) depende de F4-03 e F4-07 |
| **10** | **FASE 2 — Preparação do reset** | F2-08 (script) | O inventário (F2-01..07) pode correr em paralelo desde o início; o **script** só faz sentido depois que o schema final estiver definido |
| **11** | **FASE 6 — Auditoria final e go-live** | F6-01 → F6-02 → F6-03 → F6-04 | Gates sequenciais e não puláveis |

## 13.3 O que pode correr em paralelo

- **Fase 2 (inventário)** — F2-01 a F2-07 são documentais e não bloqueiam nada. Podem ser feitos a qualquer momento.
- **Fase 4 (validação junto ao Asaas para F4-01)** — envolve espera externa; iniciar cedo.
- **Decisões de produto (AP-05, AP-11)** — não exigem código; podem correr desde o dia 1.
- **F3-14 (ícones e screenshots)** — trabalho de design, independente do código.

---

# 14. RISCOS

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| **R-A** | **Correções de RLS quebram fluxos existentes.** F1-01 a F1-03 revogam acessos que o frontend usa hoje | **Alta** | Alto | Mapear **todos** os consumidores antes de revogar. Não existe preview branch — testar com banco local ou efêmero. Criar a suíte de testes de RLS **antes** de aplicar as migrations |
| **R-B** | **Upgrade de `react-router-dom` quebra a navegação.** É a dependência de maior risco em F1-10 | **Média** | Alto | Atualizar isoladamente, em commit próprio, com smoke test manual de todas as rotas |
| **R-C** | **CSP quebra o Firebase SW ou o Google Maps.** F1-16 introduz política restritiva em app que carrega scripts de `gstatic.com` | **Alta** | Médio | Começar em `Content-Security-Policy-Report-Only`, coletar violações, depois endurecer |
| **R-D** | **F4-01 é mais grave do que o relatório indicava.** CONFLITO-02 sugere que refund integral de 4x pode atingir 1 parcela | **Média** | **Alto** | Validar com o Asaas antes de implementar. Reescrever as fixtures de `InstallmentFullRefundFase3114` com o formato real |
| **R-E** | **Remoção de legado remove algo vivo.** Fase 4 propõe remover `AsaasRefundAdapter`, `create-booking` e possivelmente o subsistema `Payout` | **Média** | Alto | Nenhuma remoção antes dos itens **A** confirmados e testados. Remover em commits separados e reversíveis |
| **R-F** | **CONFLITO-06 (fase "1.1.E") muda a classificação da Fase 4.** Há um contrato não commitado que declara desacoplamento do `InstallmentService` | **Média** | Médio | **Resolver o conflito antes de iniciar a Fase 4** (AP-14) |
| **R-G** | **Migrations pendentes desconhecidas.** CONFLITO-05 mostra que o registro não é confiável (2 × 68) | **Alta** | Alto | F6-02 é gate obrigatório. Reconciliar pelo catálogo antes do reset |
| **R-H** | **Rodar testes de integração escreve em produção.** As suítes `*.integration.test.ts` exigem credenciais; suspeita-se que apontem para produção (hipótese que explica os 5 registros protegidos) | **Média** | **Alto** | **Não rodá-las** antes de confirmar a configuração de conexão. Item de F6-01 |
| **R-I** | **Exclusão de conta quebra integridade referencial.** `appointments`, `transactions`, `reviews` referenciam o usuário | **Alta** | Médio | Definir a política de retenção primeiro (F3-09). Preferir anonimização a DELETE em cascata para registros financeiros |
| **R-J** | **Rejeição na Play Console mesmo após as correções.** Data Safety, classificação etária e enquadramento sob Payments policy não são verificáveis fora da Console | **Média** | Alto | F3-03 e F3-16. Confirmar o enquadramento na documentação oficial **antes** de submeter |
| **R-K** | **Reset do banco perde algo necessário.** Configurações de cron, tarifas, `notification_config` | **Baixa** | **Crítico** | Backup completo obrigatório. Lista explícita do que NÃO apagar (F2-08). Verificação ANTES e DEPOIS |
| **R-L** | **Incidente de cron recorre durante as correções.** Sem retenção, a tabela volta a 117 MB em ~30 dias | **Alta** | Médio | F5-12 deve ser priorizado dentro da Fase 5, ou antecipado se a janela de correção passar de 3 semanas |
| **R-M** | **Virada para produção do Asaas com tarifas do sandbox.** `gateway_fee_schedule` tem valores do painel sandbox | **Média** | **Alto** | F2-06 + AP-04. Confirmar as tarifas de produção antes da virada, não depois |
| **R-N** | **Escopo cresce durante a execução.** Auditoria encontrou 73 itens; a tentação de "aproveitar e corrigir" é real | **Alta** | Médio | Regra 8. Qualquer achado novo vira item com ID e passa por aprovação |

---

# 15. PONTOS QUE EXIGEM APROVAÇÃO ANTES DE QUALQUER MUDANÇA

| ID | Ponto de decisão | Bloqueia | Por que é decisão do proprietário |
|---|---|---|---|
| **AP-01** | **Estratégia para F1-01:** revogar `INSERT` de `authenticated` e mover a criação de aulas para RPC/backend (Opção A), **ou** trigger `BEFORE INSERT` com validação (Opção B) | F1-01 | A Opção A é mais segura mas exige alterar o bloqueio de horário do instrutor. Trade-off de escopo |
| **AP-02** | **Como expor o telefone do aluno ao instrutor** após aula confirmada: policy condicional em `profiles` **ou** RPC `SECURITY DEFINER` | F1-02, F1-03 | Afeta o desenho de acesso a dado pessoal e o data inventory da Fase 3 |
| **AP-03** | **O que fazer com o "marcar aula como concluída" do aluno** (`pages/student/Lessons.tsx:671-679`): remover da UI, ou converter em confirmação que não muda status | F1-05 | É mudança de comportamento visível ao usuário |
| **AP-04** | **Tarifas de produção do Asaas.** O `gateway_fee_schedule` atual veio do painel **sandbox** | F1-09, F2-06, F6-03 | Só o proprietário tem acesso ao painel de produção. Errar aqui significa cobrar valor errado do aluno |
| **AP-05** | **Política de retenção de dados:** o que apaga, o que anonimiza, o que se retém por obrigação fiscal/contábil e por quanto tempo | F1-12, F3-01, F3-09 | Decisão jurídica e de negócio. **Pré-requisito de exclusão de conta** |
| **AP-06** | **Estratégia de empacotamento Android:** Bubblewrap/TWA **ou** Capacitor | F1-13 | Decisão de arquitetura com consequências de manutenção de longo prazo |
| **AP-07** | **Onde agendar a reconciliação:** `vercel.json crons` **ou** `pg_cron`. Hoje o padrão do projeto acopla o agendamento financeiro à saúde do pg_net | F1-14 | Decisão de arquitetura de infraestrutura |
| **AP-08** | **Bucket `avatars` permanece público?** Torná-lo privado exige URLs assinadas e altera o código das telas | F1-15, F3-01 | Trade-off entre privacidade (LGPD) e complexidade |
| **AP-09** | **Destino das fixtures de `CommissionCnhJaP121B`**, que hoje são cópia literal de dados de produção de teste: congelar como sintéticas (recomendado) ou regenerar após o reset | F2-02, F6-01 | Afeta a validade da prova de que a comissão está correta |
| **AP-10** | **Escopo exato do reset do banco:** quais tabelas, em que ordem, o que preservar | F2-08, F6-03 | **Operação irreversível.** Exige aprovação nominal |
| **AP-11** | **Cancelamento após o aceite:** o texto dos Termos deve seguir o código (bloqueado em qualquer prazo), **ou** o código deve implementar a regra de 24h prometida? | F3-04 | **Decisão de produto**, não técnica. Muda o que o cliente pode fazer |
| **AP-12** | **Bases legais por finalidade** (LGPD art. 7º/11): contato de confiança, tokens FCM, geolocalização, renda declarada | F3-06 | Decisão jurídica. Este plano **não inventa bases legais** |
| **AP-13** | **Validação do comportamento do Asaas em estorno de cobrança parcelada:** um evento por parcela ou um para o conjunto? | F4-01 | Exige contato com o Asaas ou teste controlado em sandbox. É o que decide a correção de um bloqueador |
| **AP-14** | **Origem e validade do contrato "FASE 1.1.E"** encontrado não commitado em `RefundReconciliationFase31.unit.test.ts` (CONFLITO-06) | FASE 4 inteira | Se o desacoplamento do `InstallmentService` já foi decidido, parte da classificação de legado muda |
| **AP-15** | **Commitar o relatório `P-RELEASE-AUDIT-001` em `docs/audits/`** junto com este plano (CONFLITO-07) | Rastreabilidade | O contrato de escopo perde a evidência se o relatório existir só no chat |

---

# 16. CRITÉRIOS DE CONCLUSÃO

## 16.1 Por fase

| Fase | Critério de conclusão |
|---|---|
| **FASE 1** | Os 17 itens com critério objetivo atendido e verificado **pelo catálogo do PostgreSQL** (não pelas migrations). Suíte de testes de RLS criada e verde. `npm audit` sem `critical`/`high` em runtime. Build e bateria verdes |
| **FASE 2** | Inventário completo revisado e aceito. Nenhum dado alterado. Script de reset escrito, revisado e **aprovado** (AP-10) — **não executado** |
| **FASE 3** | Termos e Política reescritos e coerentes com o comportamento real, verificado item a item contra o data inventory. Bases legais e retenção **definidas** (AP-05, AP-12). Consentimento granular e versionado. Política pública completa acessível sem login e sem JS |
| **FASE 4** | Todas as 9 ocorrências classificadas (A/B/C/D/E) com evidência. F4-01 corrigido e comprovado por teste com fixtures realistas. Remoções aprovadas executadas em commits separados. **Nada classificado como A removido** |
| **FASE 5** | Os 19 itens com critério objetivo atendido. `npm run lint` verde. Nenhuma tela falha silenciosamente. Nenhum job de notificação pode ficar preso |
| **FASE 6** | F6-01 a F6-04 integralmente checados. Todos os 7 conflitos resolvidos. Veredito revisado de **NÃO APTO** para **APTO** ou **APTO COM PENDÊNCIAS**, com as pendências nomeadas |

## 16.2 Critério global de "pronto para publicar"

O projeto só pode ser declarado apto quando **todas** as condições abaixo forem verdadeiras:

1. **Zero bloqueadores** — os 21 itens marcados como bloqueador na seção 2 estão resolvidos com critério objetivo atendido.
2. **Superfície de escrita fechada** — nenhuma das 5 tentativas de ataque de F6-04 tem êxito.
3. **Invariante financeiro verde no banco limpo** — `gross = net + platform_fee + fee_amount` em **100%** das linhas geradas nos testes finais; instrutor recebe exatamente 90%.
4. **Ambiente Asaas explícito e fail-closed**, com tarifas de produção confirmadas.
5. **Exclusão de conta funcional** in-app e por URL web, coerente com a política de retenção definida.
6. **Documentos jurídicos coerentes com o comportamento**, verificados item a item.
7. **Artefato Android gerado e validado**, com `assetlinks.json` no domínio correto.
8. **Nenhum "NÃO VERIFICADO" remanescente** entre os 14 itens da lista final do relatório — ou cada remanescente registrado como risco aceito, com justificativa e assinatura do proprietário.

---

# 17. REGISTRO DE ESTADO DESTA ETAPA

**Nenhuma alteração foi executada nesta etapa.**

- ❌ Nenhum código alterado
- ❌ Nenhuma migration criada ou aplicada
- ❌ Nenhum SQL de escrita executado (apenas `SELECT` de diagnóstico)
- ❌ Nenhum dado deletado
- ❌ Nenhum deploy
- ❌ Nenhuma configuração de Supabase, Vercel ou Asaas alterada
- ❌ Nenhum bloqueador corrigido
- ❌ Nenhuma refatoração
- ❌ Nenhuma alteração de UI
- ❌ Nenhuma dependência instalada ou removida
- ❌ Nenhum commit ou push
- ✅ **Única entrega:** este documento

---

---

# 18. APÊNDICE v1.1 — NOVOS CONFLITOS E RESULTADO DAS ANÁLISES

> Acrescentado em 2026-09-24. Os conflitos C-01 a C-07 da seção 8 permanecem válidos e **não foram alterados**.

## 18.1 Novos conflitos

### CONFLITO-08 — `create-booking` é código morto no frontend mas está ATIVO no projeto

| | |
|---|---|
| **Estado do repositório** | Nenhum `invoke('create-booking')` em `pages/`, `components/`, `hooks/`, `contexts/`, `lib/`, `api/`. O único caminho de compra vivo é `pages/student/InstructorProfile.tsx:1073` → `fetch('/api/create-booking-intent')`. |
| **Estado do projeto Supabase** | A Edge Function `create-booking` está **ACTIVE**, versão 61, com `verify_jwt = false`. |
| **Leitura** | Um endpoint público, sem JWT obrigatório, que insere em `appointments` usando `SERVICE_ROLE_KEY`, continua **deployado e alcançável** — mesmo sendo inalcançável pelo app. A Estratégia A de AP-01 (revogar INSERT de `authenticated`) **não fecha esta porta**, porque ela usa `service_role`. |
| **Divergência a validar** | A análise de AP-01 afirma que a função "aceita preço vindo do corpo do request". A auditoria financeira anterior (`P-RELEASE-AUDIT-001`, §1.2) afirma o contrário: `supabase/functions/create-booking/index.ts:145-183` lê `day_price`/`night_price` de `instructor_categories` e o body só traz `date`/`time`. **As duas leituras não podem estar ambas certas.** |
| **O que precisa ser validado** | Ler `supabase/functions/create-booking/index.ts` integralmente e determinar: (a) se valida identidade internamente, apesar de `verify_jwt=false`; (b) se o preço vem do banco ou do body. |
| **Impacto** | Se não validar identidade, é criação de reserva não autenticada — bloqueador de severidade equivalente a F1-01. |
| **Relação** | Cruza F1-11 (3 Edge Functions não auditadas) e F4-07 (remover `create-booking` como legado morto). **Remover a função resolve os dois de uma vez** — mas remoção é Fase 4, e F4-07 ainda não foi autorizada. |

### CONFLITO-09 — `anon` e `authenticated` têm grants amplos em `appointments`

| | |
|---|---|
| **Evidência** | `information_schema.role_table_grants`: `anon` e `authenticated` possuem `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` em `public.appointments`. |
| **Leitura** | O v1.0 tratou F1-01 como um problema de **INSERT**. O grant real é muito mais amplo: `anon` tem `TRUNCATE` e `DELETE` na tabela. Hoje isso é contido **apenas** pelo RLS — não há uma segunda camada. |
| **O que precisa ser validado** | Se o mesmo padrão de grant se repete nas demais tabelas de `public` (a auditoria v1.0 mostrou grants amplos em quase todas). |
| **Impacto** | Não muda a prioridade de F1-01, mas **muda o escopo da correção**: a migration de AP-01 deveria revogar mais do que `INSERT`. |
| **Ação** | Registrado. **Nenhuma alteração feita** — depende de AP-01. |

### CONFLITO-10 — o teste não commitado de AP-14 tem contrato correto e mock quebrado

| | |
|---|---|
| **Origem** | `lib/payments/tests/RefundReconciliationFase31.unit.test.ts`, modificação não commitada, mtime **2026-08-28 22:56:24** — o mesmo timestamp de `supabase_schema.sql` e `supabase_migration_plan.sql`. Último commit que tocou o arquivo: `9ecdd52 chore(finance): freeze refund state before P0 forensic hardening`. Diff: **+86 / −47**. |
| **Conteúdo** | Reescreve o teste para asserir um contrato chamado **"FASE 1.1.E InstallmentService Decoupling"**: `InstallmentService` gerencia **apenas** o ciclo de vida de `payment_installments`; **nunca** escreve em `payment_settlements`, **nunca** cria `transactions` do tipo `settlement_refund`, **nunca** emite `REFUND_CREATED`, **nunca** gera `provider_settlement_id` artificial para refund. |
| **O contrato é o modelo atual?** | ✅ **SIM, CONFIRMADO.** `lib/payments/InstallmentService.ts:251-268` documenta que "a escrita em `payment_settlements` foi REMOVIDA daqui" na P-1.18P2.2, e `recordRefundSettlement` (`:275-318`) de fato apenas faz `UPDATE ... SET status='REFUNDED'`. Nenhuma escrita em settlements, nenhuma projeção, nenhum `provider_settlement_id`. |
| **O teste passa?** | ❌ **NÃO. O teste não executa.** Compilado e rodado nesta sessão: `TypeError: query.eq is not a function` em `InstallmentService.recordRefundSettlement`. O mock do teste foi escrito em 28/08 contra uma assinatura de query que o código **mudou depois**: hoje `recordRefundSettlement` encadeia `.eq()` sobre o resultado de `.select()`, e o mock não oferece esse encadeamento. |
| **Veredito** | O teste **antecipou corretamente** um contrato que o código adotou depois — mas ficou para trás na forma de consultar. **Deve ser INCORPORADO após corrigir o mock**, não revertido, não commitado como está. |
| **Alerta** | Este arquivo está na lista ALLOW de `scripts/run-tests.ts:63`. **Provavelmente é uma das 4 falhas do "baseline" de 39 testes / 35 PASS / 4 FAIL** registrado na auditoria v1.0 — ou seja, parte do baseline pode não ser baseline, e sim um teste quebrado há 27 dias. **A VERIFICAR** ao rodar a bateria oficial no Windows. |
| **Ação** | **Nenhuma.** AP-14 é análise-apenas. A correção do mock precisa de autorização própria. |

### CONFLITO-11 — deep links com e sem hash convivem no mesmo app

| | |
|---|---|
| **Evidência** | `App.tsx:192` usa `BrowserRouter` (rotas sem `#`). Mas `pages/InstructorProfile.tsx:105` gera `/i/:publicId` **sem** hash, enquanto `components/InstructorShareCard.tsx:15` e `pages/student/InstructorProfile.tsx:382` geram `/#/i/:publicId` **com** hash. |
| **Leitura** | Links compartilhados de dois lugares diferentes do app têm formatos incompatíveis. Os com `#` caem na raiz. |
| **Relação** | É a mesma classe de defeito de P-16 (`returnUrl` do checkout com hash), mas em superfície diferente. E **bloqueia F1-13**: um TWA com Digital Asset Links verifica o domínio, mas o deep link só funciona se a URL tiver o formato certo. |
| **Ação** | Registrado. Entra como item de Fase 5, junto com P-16. **Nenhuma alteração feita.** |

## 18.2 Resultado consolidado das análises do Grupo 2

### AP-01 — writers de `appointments`

**Resultado: a Estratégia A é barata.** Custo total confirmado: **um único fluxo a migrar.**

| Categoria | Achado |
|---|---|
| INSERTs por cliente com JWT | **Apenas 1**: `pages/InstructorAgenda.tsx:824-836` (bloqueio de horário pelo instrutor, `status='blocked'`, `price=0`) |
| INSERTs por `service_role` | `api/create-booking-intent.ts:573` (compra oficial) e `supabase/functions/create-booking/index.ts:213` (órfã — ver C-08). Nenhum afetado pela revogação |
| RPCs que inserem | **Nenhuma.** As 6 RPCs que tocam `appointments` fazem UPDATE ou DELETE |
| Testes/scripts | Todos usam `service_role` ou rodam como `postgres`. Nenhum afetado |
| Fluxos que quebram | **Apenas o bloqueio de horário do instrutor** |

**Achado colateral:** a policy `Instructors can block slots` valida `auth.uid() = instructor_id` e aceite de termos, mas **não exige `status='blocked'` nem `price=0`**. Um instrutor pode hoje inserir aula com `student_id` arbitrário, `status='confirmed'` e `price` arbitrário. São **dois** vetores independentes de INSERT não guardado, não um.

**Proposta:** criar `block_instructor_slot(date, time)` e `unblock_instructor_slot(uuid)` como `SECURITY DEFINER`, espelhando o cabeçalho de validação de `propose_reschedule`; trocar as duas chamadas em `InstructorAgenda.tsx`; **só então** revogar. Aproveitar a mesma migration para tratar C-09. Tratar `create-booking` separadamente (C-08).

**Alternativa de menor custo:** remover as policies `Students can create appointments` e `Students can book appointments` — nenhum código de cliente faz INSERT como aluno, então caem **hoje, sem mudança de frontend, com risco zero**.

### AP-02 — leitores de `profiles` e `instructors`

**10 leituras cruzadas confirmadas.** Colunas pedidas e nunca usadas: `profiles.email` em `InstructorAgenda.tsx:399`; `experience_level` e `cnh_process_type` em `student/Lessons.tsx:347`; `instructors.whatsapp` em `StudentHome.tsx:186` (usado apenas como flag booleana de completude — o número trafega à toa para todos os instrutores da vitrine).

**Proposta:** view `instructors_public` (sem `whatsapp`, sem `provider_*`, com `has_whatsapp` booleano); view `profiles_public` (`id, full_name, avatar_url, city`); RPC `get_instructor_whatsapp(uuid)` condicionada a vínculo de aula; RPC `get_student_contact_for_appointment(uuid)` com `phone` só para o instrutor da aula e só em status pago. Impacto: ~10 arquivos de frontend.

**Ponto aberto:** `student/InstructorProfile.tsx:1478` expõe o WhatsApp do instrutor **sem nenhuma condição de aula** — é decisão de produto se o contato pré-contrato deve continuar existindo.

### AP-04 — ambiente Asaas

**Os 7 fallbacks do v1.0 confirmados, nenhum outro encontrado.** Todos silenciosos: nenhum log, warn ou exceção quando `ASAAS_API_URL` está ausente.

**Achado novo e mais grave:** `gateway_fee_schedule` no banco tem 5 linhas cujos próprios `notes` dizem *"P-1.16A seed: painel Asaas **Sandbox**"* — e são **idênticas, faixa a faixa**, ao schedule embutido em `GatewayFeeModel.ts`. **Não existe fonte de verdade de produção**: o fallback e a fonte primária são a mesma tabela de sandbox. A única rotina que substituiria esses valores é `api/sync-fees.ts`, que consulta `{ASAAS_API_URL}/myAccount/fees` — o painel do ambiente que a variável apontar. Sem a variável em produção, o job diário **confirma perpetuamente os valores de sandbox**.

**Risco adicional confirmado:** `ASAAS_WEBHOOK_SECRET` ausente faz `AsaasProvider.ts:736` (`if (secret && ...)`) pular a validação inteira — mesmo padrão fail-open de F1-08.

### AP-05 e AP-12 — retenção e LGPD

Matriz completa produzida. **Nenhum prazo foi escolhido. Nenhuma base legal foi afirmada.**

**Achado estrutural:** `DELETE FROM auth.users` **falha hoje** para aluno e para instrutor. São **6 bloqueadores duros de FK**: `notifications`, `reviews` e `transactions` com `NO ACTION`; `payouts` com `RESTRICT`. A transação aborta limpa — não há exclusão parcial.

**Assimetria crítica:** `appointments.instructor_id` é `CASCADE`. Excluir um instrutor **apaga em cascata as aulas de todos os alunos dele**. O raio de destruição do instrutor é coletivo; o do aluno é individual.

**Resíduos que sobrevivem a qualquer delete:** bucket `avatars` (sem FK — 51 objetos, **43 órfãos**, publicamente acessíveis); `security_audit_logs` (IP e e-mail, tabela **imutável** por trigger); `cash_flow_projections.entity_id` (text, sem FK); `notifications.message` de terceiros citando o nome do excluído; dados no Asaas (CPF, endereço, nascimento, renda) fora do alcance local; `localStorage` no dispositivo.

**Conclusão de engenharia:** para o instrutor, `DELETE` não é viável nem com as FKs corrigidas. A anonimização com preservação de linhas é o único caminho que mantém integridade referencial.

**8 pontos ⚖️ REQUER VALIDAÇÃO JURÍDICA** registrados, incluindo: prazo de retenção financeira; `provider_customer_id` reter ou apagar; avaliações (direito do aluno × reputação do instrutor); `security_audit_logs` (eliminação × imutabilidade); `trusted_contact` (dado de terceiro nunca informado).

### AP-06 — Android

**Recomendação: começar por TWA/Bubblewrap.** Fundamentação específica deste app:

1. O único recurso nativo exercido é push FCM Web — que a TWA entrega **sem tocar uma linha** e o Capacitor obriga a reescrever em dois caminhos de código.
2. **Não há `signInWithOAuth`** em lugar nenhum (grep vazio). O maior atrito histórico do WebView não existe aqui.
3. Não há geolocalização, background task nem qualquer API fora do alcance do Chrome.
4. O ritmo de deploy contínuo na Vercel é preservado pela TWA e quebrado pelo Capacitor.
5. O código está em meio a uma auditoria de correções; TWA não adiciona superfície.

**Risco honesto da TWA:** o service worker **não tem handler `fetch` nem cache** — o app é 100% online. Numa rede ruim ele mostra o erro do Chrome, o que aproxima a política de "webview wrapper sem valor agregado". **Mitigação obrigatória antes de submeter:** página offline mínima. Segundo ponto: `index.html:11` carrega **Tailwind por CDN** — sem rede, o app aparece sem estilo algum.

### AP-07 — arquitetura de reconciliação

**Recomendação: `vercel.json crons` para o domínio financeiro**, mantendo os jobs 9-11 em pg_cron.

Razão: o defeito dominante não é a ausência de agendador, é a **ausência de observabilidade**. `invoke_edge_function_cron` e `invoke_vercel_cron` retornam o `request_id` do pg_net e **nunca leem `net._http_response`** — um HTTP 401/500 é registrado como `succeeded`. A Vercel registra sucesso/falha por execução, com retry e alerta nativos.

**Separar em três jobs de naturezas distintas:** (a) *reparador* — `reconcile-payment`, alta frequência; (b) *auditor* — `ReconciliationService`, diário, **somente leitura**, cujo produto é um alerta; (c) *reaper* de `refund_operations` em `REQUESTED` com lease expirado, usando o índice `idx_refund_operations_claim` que já existe para isso.

**Idempotência CONFIRMADA em 4 camadas** para `reconcile-payment`. **Ressalva OBSERVADA:** o upsert do `InstallmentService` não passa pela máquina de estados — reexecutar sobre parcela já `REFUNDED` a rebaixaria para `RECEIVED`. Caminho aberto, não reproduzido; merece teste.

**Buracos na cobertura do `IntegrityChecker`:** não verifica `refund_operations`, não verifica a identidade do gross-up, não verifica `transactions` presas em `PENDING`, e não verifica parcelas `RECEIVED` sem settlement (só a direção inversa).

### AP-08 — buckets

**Recomendação: manter `avatars` e `assets` públicos.**

`assets` **não tem alternativa**: o logo é exigido em 5 telas pré-autenticação (`Welcome`, `Login`, `RegisterStudent`, `RegisterInstructor`, `ForgotPassword`). Sem sessão, não há como assinar URL.

Para `avatars`, o benefício é marginal e o custo alto: a URL pública está **persistida em `profiles.avatar_url`** e consumida em ~8 arquivos; privatizar exige mudar a coluna para path, criar camada de assinatura e alterar todo ponto de render — trocando cache de CDN permanente por assinatura em lote no caminho crítico da tela principal.

**O risco real não é a visibilidade, é a ausência de ciclo de vida:** **43 de 51 objetos são órfãos** (84,3%). Um usuário tem 5 avatares e **nenhum é o atual**. `{ upsert: true }` não ajuda porque o nome contém `Date.now()`. Privatizar o bucket **não apaga uma única dessas fotos**.

**Prioridade recomendada, independente da decisão público/privado:** definir `file_size_limit` (5 MB) e `allowed_mime_types` nos dois buckets. É a **única defesa server-side** — hoje não há validação em nenhuma camada, e a chave `anon` está no fonte. É configuração, não exige mudança de código, não quebra objeto existente, e é instantaneamente reversível.

### AP-14 — ver CONFLITO-10

---

## 18.3 Itens do v1.0 cujo estado mudou com as análises

| Item v1.0 | Estado v1.1 |
|---|---|
| **F1-01** | Escopo **ampliado** por C-09 (grants vão além de INSERT) e **bifurcado** por C-08 (`create-booking` ativa não é fechada pela Estratégia A) |
| **F1-11** | Parcialmente respondido: `create-booking` é o caso crítico (C-08). `create-asaas-account` e `auto-complete-lessons` seguem **NÃO VERIFICADOS** |
| **F1-09** | Agravado: as tarifas do banco **são** do sandbox, e `sync-fees` as reconfirma diariamente |
| **F1-12** | Dependência técnica mapeada: 6 bloqueadores de FK; `DELETE` não é viável para instrutor |
| **F1-13** | Novo pré-requisito: C-11 (deep links hash/no-hash) além de C-03 (domínio) |
| **F1-14** | Arquitetura recomendada definida (AP-07) |
| **F1-15** | Recomendação: manter público, priorizar limites de MIME/tamanho e ciclo de vida |
| **F2-02** | **Resolvido**: fixtures congeladas como sintéticas (AP-09) |
| **F4-01** | Protocolo de validação preparado (AP-13) |
| **P-02** | Confirmado descartável — nenhum backfill será feito |

---

**FIM DO PLANO MESTRE (v1.1).**

Aguardando revisão e as 15 aprovações listadas na seção 15 antes de iniciar qualquer fase.
