# Fase 0 — Confirmação e correção dos achados (02/10/2026)

Escopo: reavaliar cinco achados no estado atual do código e de produção, corrigir localmente o que for defeito comprovado e validar. **Nenhuma alteração foi aplicada em produção nesta tarefa.**

Estado de partida: branch `main`, `HEAD = origin/main = e63d5c8`; cron `sync-payment-status-job` ativo desde 02/10 16:20 UTC.

## Resumo

| # | Achado | Classificação |
|---|---|---|
| 1 | `service_role_key` em `notification_config` | Confirmado, depende de ação manual (migration preparada) |
| 2 | Migration do cron com cabeçalho "não aplicada" e versão divergente | Confirmado e corrigido (comentários); divergência de versão é risco residual documentado |
| 3 | Estado do Git | Não reproduzido como problema; uma decisão pendente sobre suítes removidas |
| 4 | Conciliação de pagamentos | Um defeito confirmado e corrigido; demais itens conferidos |
| 5 | Fila de notificações | Um defeito confirmado e corrigido; um risco residual que exige decisão |

---

## 1. Segredo `service_role_key` em `notification_config`

**Achado original.** A tabela guarda a chave secreta do projeto em texto puro e os papéis de cliente têm privilégios de tabela.

**Evidência atual** (consultas somente leitura ao catálogo; o valor não foi lido):

| Verificação | Resultado |
|---|---|
| Linha `service_role_key` | Ainda existe; 41 caracteres, formato `sb_secret_…` |
| Demais linhas | `app_base_url`, `edge_function_url` |
| RLS | Ativo, sem `FORCE`; **0 policies** |
| Privilégios de `anon` e `authenticated` | Todos: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER |
| Funções do banco que leem a tabela | `invoke_edge_function_cron`, `invoke_vercel_cron` — ambas `SECURITY DEFINER`, nenhuma usa `service_role_key` |
| Triggers, views, jobs do cron | Nenhum referencia a linha |
| Código do repositório | `NotificationService` grava `edge_function_url`; `sync-payment-status` lê `app_base_url`; ambos com a service role. Nenhum lê `service_role_key` |
| Migrations locais | A leitura da chave foi movida para o Vault em `20260711_migrate_service_role_to_vault.sql`; as referências anteriores são históricas |

**O RLS sem policies impede o acesso?** Sim. Com RLS ativo e nenhuma policy, `anon` e `authenticated` não leem nem alteram linhas, mesmo tendo privilégio de tabela. Uma ressalva: `TRUNCATE` não é filtrado por RLS, mas não é exposto pela API REST.

**Risco futuro.** Confirmado: os privilégios já estão concedidos, então uma única policy permissiva, ou o RLS desativado, tornaria a chave legível com a chave pública do aplicativo. A chave também aparece em qualquer exportação lógica do schema `public`.

**Classificação:** confirmado, depende de ação manual.

**Correção preparada (não aplicada):** `supabase/migrations/20261002_notification_config_remove_service_role_key.sql`
1. Aborta sem alterar nada se alguma função do banco ainda referenciar `notification_config` e `service_role_key`.
2. Remove a linha `service_role_key`.
3. Revoga todos os privilégios de `PUBLIC`, `anon` e `authenticated` na tabela.

Nenhuma mudança de código é necessária: não há dependência a remover. A rotação da chave não faz parte da migration.

---

## 2. Migration do cron de reconciliação

**Evidência atual.**
- O arquivo dizia "PROPOSTA. NAO APLICADA" e "conferir ANTES de aplicar".
- Histórico remoto: `20261002162000 schedule_sync_payment_status`. Arquivo local: `20261001_schedule_sync_payment_status.sql`.

**Classificação:** confirmado e corrigido (comentários).

**Correção.** Cabeçalho atualizado: data e forma da aplicação, versão remota, job criado, resultado da primeira execução e uma nota sobre a diferença de versão. **O SQL executável não foi alterado** (o diff contém somente linhas de comentário). O arquivo não foi renomeado.

**A divergência causa problema?**
- Não é específica desta migration: as 7 entradas do histórico remoto usam versões de 14 dígitos e nomes diferentes dos arquivos locais, e a pasta local tem dezenas de arquivos que não constam no histórico.
- Consequência prática: `supabase db push`, `db pull` e `migration list` não funcionam de forma confiável neste projeto (já observado: `db push --dry-run` aborta). Um `db push` forçado tentaria reaplicar arquivos antigos.
- Não há risco para o que está em produção enquanto as migrations continuarem sendo aplicadas uma a uma pela API.

**Solução recomendada (não executada, exige decisão):** fazer um baseline único — gerar o schema atual de produção como migration inicial, arquivar a pasta atual e alinhar o histórico com `supabase migration repair`. Até lá, manter a regra: aplicar pela API e registrar no cabeçalho do arquivo a versão remota.

---

## 3. Estado do Git

| Verificação | Resultado |
|---|---|
| Branch | `main` |
| `HEAD` × `origin/main` | Iguais: `e63d5c8` ("feat(phase-0): improve operational reliability and clean legacy tests") |
| Fase 0 | Integralmente commitada em `e63d5c8`: os dois módulos `_shared`, as duas funções, a migration, as duas suítes, `run-tests.ts` e o relatório da Fase 0 |
| Modificado antes desta tarefa | `supabase/.temp/cli-latest` (arquivo do CLI; não tocado) |
| Não rastreados antes desta tarefa | `Claude outputs/`, 4 arquivos `baseline-*.txt`, 11 relatórios em `docs/auditorias/` |
| Removidos do disco (nunca rastreados) | `_to_delete/`, `tests-p118e/`, `tests-p116a/gatewayFee.p116a.test.ts` — não recuperáveis pelo Git |

**Removidos no commit `e63d5c8`** (14 arquivos, 2.733 linhas): `tests-p110/`, `tests-p116a/feeSync.p116b.test.ts`, `tests-p117/`, `tests-p118f3/`, `tests-p118p22/`, `tests-p118p26/`, `tests-p119/`, `tests-p1203/`, `tests/e2e-booking.ts`.

- A mensagem do commit indica remoção intencional ("clean legacy tests") e nenhuma dessas suítes fazia parte de `scripts/run-tests.ts`.
- Ponto de atenção: `tests-p118p26/reconcilePayment.p118p26.test.ts` (135 verificações) era a única cobertura de `/api/reconcile-payment`, o endpoint que o cron agora chama a cada 5 minutos. As suítes de taxa (`p116b`), preço (`p117`) e remarcação (`p1203`) também não têm equivalente na suíte principal.
- Nada foi restaurado. Os arquivos continuam recuperáveis a partir de `ea40f87`.

**Classificação:** não reproduzido como problema (nada da Fase 0 se perdeu); **decisão pendente** sobre manter ou recuperar a suíte `p118p26`.

Os 11 relatórios de auditoria não rastreados existem só nesta máquina.

---

## 4. Cron e reconciliação de pagamentos

| Item | Resultado | Evidência |
|---|---|---|
| Idempotência | Confirmada | Escritas levam ao mesmo estado final; operações de estorno usam controle de versão; liquidação delegada a `/api/reconcile-payment` |
| Execuções concorrentes | Confirmada | O pg_cron não sobrepõe o job; a função tem limite de execução inferior a 5 minutos; transições de aula são condicionais ao estado |
| `DENIED`, `CONFLICT` e terminais fora | Confirmado | `findStaleForReconciliation` seleciona só `PENDING`/`UNKNOWN` parados e `COMPLETED` sem confirmação; o seletor de aulas não inclui `refund_denied` nem `refunded` |
| Sem chamadas de estorno | Confirmado | A função só emite `GET` ao Asaas; nenhum `POST` de estorno |
| Falhas do Asaas | Confirmado | Resposta não-2xx encerra o grupo sem escrita; timeout de 15 s com novas tentativas no cliente; status desconhecido cai em "nenhuma ação" |
| `refund_denied` / `refunded` | Compatível | Recusa leva aula encerrada a `refund_denied` e aula aberta a `paid`; `refunded` só com confirmação do gateway |
| Execução interrompida | **Defeito confirmado e corrigido** | Abaixo |

**Defeito: interrupção no caminho "estorno negado".**
A função fechava a transação pendente (`failed`) **antes** de atualizar as aulas, e não verificava o erro de nenhuma das duas escritas. A transação pendente é o que faz o grupo voltar a ser tratado; se a execução parasse entre as duas escritas, ou se a atualização da aula falhasse, a aula ficaria em `refund_requested` indefinidamente e o grupo seria reportado como sucesso. O caminho "estorno confirmado" tinha a ordem certa, mas também ignorava erros.

**Correção** em `supabase/functions/sync-payment-status/index.ts`:
- Estorno negado: aulas primeiro, transação por último; erro em qualquer escrita interrompe o grupo.
- Estorno confirmado: erro na aula interrompe antes de fechar a transação.
- A consulta das aulas das operações de estorno passou a registrar o erro (o comportamento já era seguro: sem as aulas, nada é processado).

A janela de reconciliação e os critérios de seleção **não foram alterados**.

Este caminho usa transações de estorno pendentes (mecanismo anterior às `refund_operations`); o caminho principal de estornos já era protegido por controle de versão.

**Observação sem correção:** aulas sem `group_id` são agrupadas com um identificador sintético e a verificação do grupo consulta `group_id` com esse valor. Comportamento anterior à Fase 0; não foi alterado por não haver registro sem `group_id` comprovado.

---

## 5. Fila de notificações

| Item | Resultado |
|---|---|
| Falhas voltam à fila | Confirmado: falha passageira → `pending` com tentativa contada |
| Limite e backoff | Confirmado: 1, 2, 4, 8 min (teto 15); 5 tentativas → `dead` |
| Recuperação de `processing` | Confirmado: após 10 min, com escrita condicional a `status` e `locked_by` |
| `sent` só após confirmação | Confirmado: exige ao menos um aparelho aceito pelo FCM |
| Notificações críticas expiradas | Confirmado: 60 min, viram `expired`, entram em `criticalUndelivered` |
| Corrida entre workers | Confirmado: o claim é atômico e toda transição é condicional; o segundo worker não altera linhas |
| Logs sem dados sensíveis | Confirmado: identificador, tipo e desfecho; sem conteúdo de mensagem |
| Contagem de tentativas | **Defeito confirmado e corrigido** |
| Resultado desconhecido × duplicidade | **Parcial — risco residual que exige decisão** |

**Defeito: tentativas zeradas quando a leitura do job falha.**
Depois do claim, o worker lê `attempts` e `metadata` dos jobs. Se essa leitura falhasse, o código assumia `attempts = 0` e metadados vazios: o job era enviado, e em caso de falha gravava `attempts = 1`, apagando as tentativas anteriores. Um job com falha persistente poderia nunca chegar a `dead`.

**Correção** em `supabase/functions/_shared/notificationQueue.ts`: sem o estado do job, o worker não envia, registra o erro e deixa o job para a recuperação, que o devolve à fila contando a tentativa.

**Risco residual: resposta ambígua do envio.**
- Quando o worker morre depois de iniciar o envio, o job vira `failed` e não é reenviado (regra documentada).
- Quando a chamada a `send-push-notification` falha por rede, timeout ou erro 500, o worker trata como falha passageira e **reenvia**. Nesses casos o push pode já ter chegado a algum aparelho — por exemplo, se o FCM aceitou um aparelho e a função falhou em outro.
- Efeito possível: push duplicado. Alternativa: não reenviar e aceitar push perdido em falhas de rede comuns.
- Não alterei: é uma escolha entre duplicar e perder um aviso crítico, e a correção completa passa por tornar `send-push-notification` idempotente por notificação, o que muda uma função fora deste escopo.

---

## Arquivos alterados nesta tarefa

| Arquivo | Alteração |
|---|---|
| `supabase/functions/_shared/notificationQueue.ts` | Job sem estado lido não é enviado nem tem tentativas zeradas |
| `supabase/functions/sync-payment-status/index.ts` | Ordem e verificação de erro nas escritas de estorno negado/confirmado; log de falha na leitura das aulas |
| `supabase/migrations/20261001_schedule_sync_payment_status.sql` | Somente comentários do cabeçalho |
| `supabase/migrations/20261002_notification_config_remove_service_role_key.sql` | Novo; proposta não aplicada |
| `lib/payments/tests/NotificationQueueFase0.unit.test.ts` | +2 verificações (14a, 14b) |
| `lib/payments/tests/SyncReconciliationFase0.unit.test.ts` | +3 verificações (G1–G3) |
| `docs/auditorias/FASE0_CONFIRMACAO_CORRECAO_ACHADOS_2026-10-02.md` | Este relatório |

## Testes

| Verificação | Resultado |
|---|---|
| `NotificationQueueFase0` | 57/57 |
| `SyncReconciliationFase0` | 54/54 |
| Suíte geral (`scripts/run-tests.ts`) | 56 executadas, 52 passam, 4 falham |
| Falhas | As mesmas 4 anteriores a esta tarefa: `RefundBlockersFase31177`, `RefundCorrectionsFase31175`, `RefundOperationRpcSecurity`, `RefundReconciliationFase31`. Nenhuma falha nova |
| TypeScript (fora de `supabase/functions`) | 0 erros |
| Build do frontend | Concluído |
| Código compartilhado (`sync-shared --check`) | Sincronizado |

**Não testado:** execução das Edge Functions em Deno; comportamento real do PostgreSQL (RLS, privilégios, a migration nova); FCM; Asaas. As verificações G1–G3 conferem o código-fonte da função, não uma execução dela. A suíte geral foi executada antes de acrescentar G1–G3; a suíte que as contém foi executada depois, isoladamente.

## Riscos residuais

1. As correções das duas funções só valem em produção depois de novo deploy; até lá o cron roda a versão publicada.
2. Push duplicado em resposta ambígua do envio (seção 5).
3. Histórico de migrations local e remoto não reconciliáveis pelo CLI (seção 2).
4. `/api/reconcile-payment` sem suíte de testes no repositório (seção 3).
5. Chave secreta em tabela comum até a migration ser aplicada; rotação a decidir.
6. Sem alerta ativo sobre `DEAD_JOB` / `CRITICAL_UNDELIVERED`.

## Ações manuais pendentes

1. Autorizar a aplicação de `20261002_notification_config_remove_service_role_key.sql` e decidir sobre a rotação da chave.
2. Commit e push das alterações desta tarefa.
3. Autorizar o deploy de `notification-worker` e `sync-payment-status`.
4. Decidir sobre a recuperação da suíte `tests-p118p26`.
5. Decidir a política para resposta ambígua do envio de push.
6. Decidir sobre o baseline do histórico de migrations.
7. Decidir se os relatórios não rastreados em `docs/auditorias/` entram no repositório.

## Confirmação

Nenhuma alteração foi aplicada em produção: nenhuma migration, nenhum SQL de escrita, nenhum deploy, nenhuma chamada ao Asaas, nenhum envio de notificação, nenhum segredo lido ou alterado. Foram executadas apenas consultas `SELECT` ao catálogo e a contagens. Nenhum texto de interface foi modificado. Nenhum commit ou push foi feito.
