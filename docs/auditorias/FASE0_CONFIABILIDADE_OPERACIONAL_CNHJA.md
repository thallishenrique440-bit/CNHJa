# Fase 0 — Preparação e confiabilidade operacional

| Campo | Valor |
|---|---|
| Data | 2026-10-01 |
| Base | `main` em `ea40f87`. Alterações desta fase são **locais e não commitadas**. |
| Estado | Implementado e testado localmente. Nada publicado, nenhuma migration aplicada, nenhuma escrita em banco ou no Asaas. |
| Leituras em produção | Consultas `SELECT` e leitura de logs das Edge Functions (somente leitura), para diagnóstico. |
| Novo fluxo de agendamento | **Não iniciado.** |
| Revisão de fechamento | Ver **§12** (02/10/2026): prevalece sobre as seções anteriores onde houver diferença. |

## 1. Resumo

| Parte | Resultado |
|---|---|
| 1. Notificações | **Causa raiz confirmada por log e corrigida localmente.** Dois defeitos independentes: o envio é recusado com 401 desde 30/09, e o worker nunca devolve à fila um job cujo envio falha. |
| 2. Conciliação | Confirmado que `sync-payment-status` **não é acionada por nada** em produção. Decisões do handler extraídas para funções testáveis; proposta de agendamento escrita, **não aplicada**. |
| 3. Cancelamento Pix | Investigação concluída. O comportamento "cobrança cancelada não pode mais ser paga" **não está documentado** e depende de confirmação do Asaas ou de homologação. |
| 4. Regressão dos estornos | Todas as suítes de estorno passam. A lógica de estorno não foi alterada. |

## 2. Parte 1 — Notificações

### 2.1 Fluxo [FATO]

1. `NotificationService.createNotification` insere em `notifications`.
2. O trigger `tr_enqueue_notification` cria a linha em `notification_jobs` com `status = 'pending'` (idempotente por chave primária `notification_id`).
3. O cron `notification-worker-job` (1/min) chama a Edge Function `notification-worker`.
4. O worker chama a RPC `claim_notification_jobs`, que move até N jobs de `pending` para `processing` (`FOR UPDATE SKIP LOCKED`), gravando `locked_at` e `locked_by`.
5. Para cada job, chama `send-push-notification`, que busca os tokens do usuário e envia ao FCM.
6. Em sucesso, chama `mark_notification_job_sent` (`processing → sent`).

Estados aceitos pela tabela: `pending, processing, retry, failed, sent, dead, cancelled, expired`. A tabela já tem `attempts`, `max_attempts` (5), `next_run_at`, `last_error`, `metadata` e um índice para recuperação de travas (`idx_notification_jobs_lock_reclamation`). **Nada disso era usado.**

### 2.2 Causas raiz confirmadas

**Causa A — o envio é recusado com HTTP 401.** [FATO]
Logs das Edge Functions, 01/10 entre 21:44 e 22:01 UTC, para cada job:

```
POST | 401 | …/functions/v1/send-push-notification
[auth] fn=send-push-notification authorized=false reason=missing_header
[NotificationWorker] Error processing job …: Edge Function returned a non-2xx status code
```

Desde o commit `ebbe0e7` (30/09, endurecimento de autenticação), `send-push-notification` exige `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`. O worker chamava `supabaseAdmin.functions.invoke(...)`, e o cabeçalho **não chega** à função (`reason=missing_header`). O último envio bem-sucedido é de 30/09 19:01 UTC; as funções foram republicadas às 21:45 UTC do mesmo dia. Por que a biblioteca não envia o cabeçalho nesse ambiente não foi determinado; a correção não depende disso.

**Causa B — falha de envio deixa o job preso para sempre.** [FATO]
No `catch` do worker (versão anterior, l. ~85–88) o erro era só registrado. O job permanecia em `processing`, com `attempts = 0`. A RPC de reivindicação só lê `pending`. Não existia nenhum código que devolvesse, expirasse ou encerrasse um job em `processing`. Confirma o achado: o worker só seleciona `pending` e não havia recuperação.

A causa B é anterior à A: o job mais antigo preso é de 12/08.

**Defeito adicional encontrado** [FATO]: `send-push-notification` responde `success: true` mesmo quando o FCM rejeita a mensagem para todos os aparelhos (as falhas vão dentro de `results`). O worker marcava `sent` sem olhar `results` — entrega não confirmada registrada como entregue. O mesmo ocorria quando o usuário não tinha nenhum aparelho registrado.

### 2.3 Situação dos 13 jobs presos [FATO]

| Job | Tipo | Idade (h) | Tokens do usuário |
|---|---|---|---|
| 1 | `booking_request` | ~1210 (12/08) | 1 |
| 3 | `booking_request`, `booking_expired` ×2 | ~26 | 1–2 |
| 2 | `booking_request` | 10 e 14 | 1 |
| 7 | `booking_expired` ×6, `booking_request` ×1 | ~2 | 1–2 |

Todos com `attempts = 0`, `last_error` nulo e notificação ainda não lida. Os 12 recentes correspondem aos 401 dos logs — **não foram entregues**. O de agosto não tem log disponível; não é possível afirmar se foi entregue.

Todos se referem a solicitações e expirações de aulas de teste já encerradas. Enviá-los agora seria ruído: pela política implementada (§2.4), **serão marcados `expired` e nenhum push atrasado será enviado**. Os avisos continuam visíveis dentro do aplicativo.

### 2.4 Correção implementada (sem alteração de schema)

**`supabase/functions/_shared/notificationQueue.ts`** (novo; sem dependência de Deno, testável em Node)

| Requisito | Como é atendido |
|---|---|
| Recuperar abandonados após prazo seguro | `recoverStaleJobs`: job em `processing` com `locked_at` há mais de 10 min (bem acima do tempo máximo de uma Edge Function) |
| Não reenviar já entregue | O worker grava `metadata.dispatch_started_at` **antes** de enviar e `metadata.dispatch_confirmed_at` ao confirmar. Na recuperação: confirmado → conclui como `sent` sem reenviar; iniciado sem resultado → **não reenvia** |
| Não marcar como entregue sem confirmação | `sent` só quando o provedor aceitou a mensagem para ao menos um aparelho. Envio de desfecho desconhecido vira `failed` (`dispatch_outcome_unknown`). Usuário sem aparelho vira `cancelled` (`no_recipient_devices`) |
| Sem duplicidade sob concorrência | Toda escrita é condicional a `status = 'processing'` **e** `locked_by` de quem leu; a reivindicação continua na RPC com `SKIP LOCKED` |
| Tentativas e erros rastreáveis | `attempts` incrementado a cada tentativa; `last_error` com o motivo; metadados de recuperação (`recovered_at`, `recovered_from_lock`) |
| Sem loop infinito | Espera crescente (1, 2, 4, 8 min; teto de 15) e limite `max_attempts` → `dead` |
| Falha permanente | Todos os aparelhos com token inválido, ou notificação inexistente → `failed`, sem nova tentativa |
| Nada preso sem tratamento | Todo job termina em `sent`, `cancelled`, `failed`, `dead` ou `expired`; o worker emite uma linha de log estruturada e em nível de erro quando há `dead`, `failed` ou transição não gravada |
| Notificações antigas | Mais de 60 min desde a criação → `expired`, sem envio. Configurável por `NOTIFICATION_MAX_AGE_MINUTES` |

**`supabase/functions/notification-worker/index.ts`** (alterado)
- Chama `send-push-notification` por `fetch`, enviando `Authorization: Bearer <service_role>` de forma explícita (corrige a causa A) e lendo o corpo também em respostas de erro.
- O ciclo passou a ser `runNotificationCycle`.
- A guarda `requireCronAuth` continua sendo a primeira ação do handler.

`send-push-notification` **não foi alterada**.

**Limitações da correção**
- A correção da causa A só pode ser comprovada após deploy; localmente não há runtime Deno nem FCM.
- O status `retry` existe no CHECK, mas a RPC não o seleciona; a nova tentativa usa `pending` com `next_run_at` futuro. Nenhum código produz `retry`.
- Entre a confirmação do FCM e a gravação de `dispatch_confirmed_at` existe uma janela de milissegundos em que uma queda do worker classifica o envio como "desfecho desconhecido" (`failed`). O push terá sido entregue; o registro dirá que não se sabe. É a escolha conservadora: nunca duplicar e nunca afirmar entrega sem prova.
- Não existe alerta ativo (e-mail, painel). Há apenas a linha de log em nível de erro; um alerta sobre ela é configuração externa.

### 2.5 Testes — `NotificationQueueFase0.unit.test.ts` (47 verificações, todas passam)

Executa o módulo real sobre banco em memória que reproduz as duas RPCs.

| Cenário pedido | Verificações |
|---|---|
| Pendente normal | 1a–1c |
| Worker interrompido após `processing` | 2a, 3a–3c |
| Recuperação após timeout | 3a–3f |
| Duas execuções concorrentes | 4a–4c |
| Falha temporária do FCM | 5a–5e |
| Falha permanente | 6a–6c |
| Já entregue | 7 |
| Idempotência | 8a–8b |
| Limite de tentativas | 9a–9d |
| Registros históricos inconsistentes (inclui o retrato dos 13 de produção) | 10a–10g |
| Interpretação da resposta do push (inclui o 401) | 11a–11i |
| Falha ao gravar o desfecho | 12a–12c |

## 3. Parte 2 — Conciliação financeira

### 3.1 Diagnóstico [FATO]

| Pergunta | Resposta |
|---|---|
| Como é acionada | Por requisição HTTP com `Authorization: Bearer <CRON_SECRET>` (`requireCronAuth`, fail-closed) |
| Agendamento ativo em produção | **Não existe.** `cron.job` tem 4 jobs; nenhum chama `sync-payment-status`. Nenhuma migration do repositório a agenda |
| O que consulta | (a) Operações de estorno paradas: `PENDING`/`UNKNOWN` sem movimento há mais de 10 min e `COMPLETED` nunca confirmadas, lote de 25 (`findStaleForReconciliation`). (b) Aulas em `reserved`, `pending_approval`, `awaiting_payment`, ou encerradas com `paid`/`refund_requested`, agrupadas por `group_id` |
| Pagamentos já conciliados | Em grupo aberto, delega a `/api/reconcile-payment` (Vercel), que é idempotente; depois grava `pending_approval`/`paid` com CAS em status aberto |
| Duplicidade de transações | Não cria transações; atualiza por chave. A liquidação fica no `SettlementService` |
| Interação com estornos | `reconcileRefundOperation`: somente GET; aplica a evidência com CAS na versão da operação; nunca emite POST |
| Asaas indisponível | Por operação: devolve `gateway_unreachable`/`gateway_unavailable` e não escreve. Por grupo: devolve erro para aquele grupo e segue |
| Divergência local × provedor | `REFUNDED` → alinha; recusa explícita → `refund_denied`/`paid`; ausência de evidência → preserva |
| Reexecução | Segura: decisões por estado atual, escritas condicionais |

**Hoje a função selecionaria** 1 aula (`cancelled`/`refund_requested`) e 2 operações (`COMPLETED` não confirmadas, de 30/09).

**Lacunas observadas** (não corrigidas nesta fase)
- Operações `REQUESTED` nunca enviadas (2, desde 22–23/09) não entram em nenhuma seleção.
- Operação `COMPLETED` confirmada cuja aula ficou para trás não é re-selecionada (teste D11).
- Aulas encerradas com `paid` (legado) são reconsultadas a cada execução, indefinidamente.
- A liquidação depende de `notification_config.app_base_url` e do `CRON_SECRET`; se faltarem, o grupo fica `reconcile_pending` sem alerta.
- Chamada do cron via `pg_net` não tem tempo limite configurado em `invoke_edge_function_cron`; a função segue rodando no servidor de funções mesmo que a chamada expire.

### 3.2 Alteração de código

- **`supabase/functions/_shared/syncPaymentDecision.ts`** (novo): `classifySyncGroup`, `classifyClosedGroupRefund`, `paymentStatusAfterRefundDenial`. São as mesmas condições que já existiam no handler, extraídas sem mudança de regra.
- **`supabase/functions/sync-payment-status/index.ts`**: 14 linhas inseridas, 10 removidas — as condições passam a vir das funções acima. Nenhuma regra, valor ou caminho de escrita foi alterado.

Motivo: o handler é código Deno e não podia ser testado. Os testes existentes sobre ele (`SyncPaymentStatusRefundFix`) usam uma **cópia** da lógica, que já divergiu do código real (a cópia trata `PARTIALLY_REFUNDED` como estorno a reconciliar; o handler ignora). Agora o teste exercita o mesmo módulo que o handler importa.

### 3.3 Proposta de agendamento — NÃO APLICADA

Mecanismo: o mesmo dos outros jobs (pg_cron → `public.invoke_edge_function_cron` → pg_net com `cron_secret` do Vault). Não exige novo segredo nem expõe nada ao frontend.

Arquivo: `supabase/migrations/20261001_schedule_sync_payment_status.sql`

```sql
-- NÃO APLICADA
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'sync-payment-status-job' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'sync-payment-status-job',
  '*/5 * * * *',
  $$SELECT public.invoke_edge_function_cron('sync-payment-status');$$
);
```

| Requisito | Atendimento |
|---|---|
| Periódico | A cada 5 min |
| Execuções concorrentes | O pg_cron não sobrepõe o próprio job, mas o job só enfileira a chamada HTTP; duas execuções da função podem coexistir. É seguro: escritas condicionais (teste D9) |
| Autenticação | `CRON_SECRET`, fail-closed |
| Sem segredo no frontend | Segredo lido do Vault dentro do banco |
| Observável | `cron.job_run_details`, `net._http_response`, logs da função |
| Timeout e falhas | Falha por grupo ou por operação não derruba a execução; a seguinte retoma |
| Sem duplicar operações financeiras | Só GET no gateway; nenhum POST de estorno |
| Não sobrescrever estorno protegido | `DENIED`/`CONFLICT` fora da seleção (C2); `refund_denied` fora do seletor de aulas (E3) |
| Não interferir em legado | Escrita de `pending_approval` com CAS em status aberto; grupo com aula encerrada é pulado |

**Efeito da primeira execução** (precisa da sua ciência): as duas operações `COMPLETED` não confirmadas de 30/09 serão revertidas para `DENIED` e as parcelas voltarão de `REFUNDED` para `RECEIVED`. As aulas correspondentes **não serão alteradas**: `revertUnconfirmedCompletion` só mexe em aulas com `payment_status` em `refunded` ou `refund_requested`, e essas duas estão em `failed`. O resultado será operação `DENIED`, parcela `RECEIVED` e aula `expired/failed` — mais correto que hoje, mas ainda não o estado final desejado. A correção desses registros continua sendo trabalho manual, autorizado caso a caso.

### 3.4 Testes — `SyncReconciliationFase0.unit.test.ts` (33 verificações, todas passam)

| Cenário pedido | Verificações | Código exercitado |
|---|---|---|
| Recebido e não conciliado; webhook ausente | A1 | decisão real do handler |
| Já conciliado | A2 + `tests-p118p26/reconcilePayment` (135) | decisão + endpoint de liquidação |
| Webhook duplicado | D3 | `reconcileRefundOperation` |
| Divergência Asaas × banco | A5–A7, B1, D4 | decisão + Core |
| Estorno em andamento | B2, C3, D6 | decisão + repositório + Core |
| `refund_denied` | B3–B5, C2, D5 | idem |
| Falha de comunicação | D7–D8 | Core |
| Execuções repetidas | D3 | Core |
| Execuções concorrentes | D9 | Core |
| Falha parcial | D10–D11 | Core |
| Handler usa as decisões e não emite estorno | E1–E6 | leitura do código-fonte |

O laço principal do handler (leitura do Asaas, chamadas ao banco) **não foi executado**: exige Deno.

## 4. Parte 3 — Cancelamento de cobrança Pix (investigação)

**Fatos confirmados no código**
1. O CNHJá "cancela" uma cobrança com `DELETE /payments/{id}` (`BookingCancellationCore.ts`, caminho não pago, l. ~697–711).
2. O resultado **não é verificado**: resposta não-OK gera apenas `console.warn` e o fluxo segue, liberando o horário.
3. O corpo da resposta não é lido; o campo `deleted` nunca é conferido.
4. Antes do `DELETE` o Core faz `GET` do pagamento; se estiver pago, segue o caminho de estorno.
5. A nova tentativa do aluno (`create-booking-intent.ts:522-536`) encerra as aulas anteriores no banco **sem** cancelar a cobrança anterior no Asaas.
6. A cobrança é criada com vencimento na data do dia (`AsaasProvider.ts:354`), não no prazo da reserva.
7. Pagamento que chega para reserva encerrada só gera log (`asaas-webhook.ts:883-893`); a liquidação e o split já ocorreram antes dessa verificação.
8. O banco de produção nunca recebeu um evento `PAYMENT_DELETED` nem `PAYMENT_RESTORED` — ou o webhook não assina esses eventos, ou nenhuma cobrança foi removida com sucesso. Não foi possível distinguir.

**Fatos confirmados na documentação do Asaas** (lida por resumidor automático; conferir no original)
- `DELETE /v3/payments/{id}` devolve `{ deleted: boolean, id }`. É essa a resposta que confirma a remoção.
- "A remoção não representa estorno, reembolso ou devolução de valores já pagos."
- Recomenda consultar o estado da cobrança antes de remover.
- Gera o evento `PAYMENT_DELETED`. Uma cobrança removida pode ser restaurada.

**Não documentado**
- Se o QR Code Pix de uma cobrança removida ainda pode ser pago.
- Quais status permitem a remoção.
- Se o comportamento é o mesmo em Sandbox e produção.

**Respostas às perguntas**

| # | Pergunta | Resposta |
|---|---|---|
| 1 | O que o CNHJá considera cobrança cancelada | Nada verificável: emite o `DELETE` e segue, com qualquer resposta |
| 2 | O que confirma o cancelamento | HTTP 200 com `deleted: true` (documentado); `PAYMENT_DELETED` como segunda evidência |
| 3 | Cobrança Pix cancelada ainda pode ser paga? | **Não sabemos.** Hipótese: não. Não documentado |
| 4 | Como o sistema identifica pagamento após tentativa de cancelamento | Não identifica como caso próprio: cai no ramo "reserva expirada", que só loga |
| 5 | Como webhook e conciliação devem reagir | Registrar o pagamento sem reserva válida em fila rastreável; não confirmar aula em horário ocupado; não estornar automaticamente (desenho em `AUDITORIA_NOVO_FLUXO_AGENDAMENTO_CNHJA.md`, §8) |
| 6 | Sandbox × produção | Não documentado para remoção. Para estorno Pix há indícios de diferença |
| 7 | O que precisa de confirmação do Asaas | (a) QR Code de cobrança removida pode ser pago? (b) Se for, como o pagamento aparece (status, evento)? (c) Quais status permitem remover? (d) `PAYMENT_DELETED` é emitido por padrão ou exige assinatura? (e) É possível definir expiração em minutos para o QR Code de uma cobrança Pix? (f) Há diferença em Sandbox? |

Nenhuma chamada de escrita ao Asaas foi feita. A hipótese do item 3 pode ser testada em Sandbox sem movimentar dinheiro real (criar cobrança, remover, tentar pagar a partir de outra conta Sandbox), mediante autorização.

## 5. Parte 4 — Regressão dos estornos

A lógica de estorno **não foi alterada** nesta fase (`BookingCancellationCore`, `RefundOperationRepository`, `RefundOperationKey`, `RefundConfirmation`, `RefundStateMachine` sem diferença em relação ao commit).

| Suíte | Resultado |
|---|---|
| `RefundIdempotencyFase1` | 48/48 |
| `RefundHardeningP1201B` | 88/88 |
| `RefundLifecycleConfirmation` | 95/95 |
| `ExpirationRefundDecouplingFase2` | 87/87 |
| `RefundConcurrencyFase2B1` | 43/43 |
| `InstallmentProjectionRefundStateFase2` | 22/22 |
| `RefundOperationRepository`, `RefundOperationTransition`, `RefundOperationContract`, `RefundAdapterAndStateMachine` | passam |
| `CancelBookingFase3110`, `ConstraintAndCancellationCore` | passam |
| `SyncPaymentStatusRefundFix`, `SyncPaymentStatusAuthR2`, `PaymentStateService` | passam |
| `tests-p118p26/reconcilePayment` | 135/135 |

Dois testes existentes precisaram de ajuste, por descreverem o código antigo — não por falha de estorno:
- `EdgeAuthBloco3`, B8: afirmava que o worker chama o push por `functions.invoke` "sem mudança no chamador". Essa era exatamente a chamada que recebia 401. Passou a exigir o cabeçalho explícito. B3: passou a reconhecer `runNotificationCycle` como o primeiro trabalho do handler.
- `ExpirationRefundDecouplingFase2`, 7g: conferia um trecho literal do `sync-payment-status` que foi movido para o módulo compartilhado.

## 6. Validação

| Verificação | Resultado |
|---|---|
| Suíte completa (`scripts/run-tests.ts`) | 56 executadas, **52 passam**, 4 falham |
| Linha de base anterior | 54 executadas, 50 passam, 4 falham |
| Falhas | As mesmas 4, pelos mesmos motivos: `RefundBlockersFase31177` e `RefundCorrectionsFase31175` (`supabaseKey is required`), `RefundOperationRpcSecurity` (asserção de privilégios), `RefundReconciliationFase31` (`query.eq is not a function`). Preexistentes; não alteradas |
| TypeScript (código Node e frontend) | 0 erros |
| Build do frontend | concluído |
| Código compartilhado (`sync-shared --check`) | sincronizado |

**Não executados**
- Edge Functions em Deno (ausente na máquina): `notification-worker` e `sync-payment-status` foram validadas por leitura; os módulos que elas importam foram executados em Node.
- Envio real ao FCM e recebimento em aparelho.
- A migration de agendamento.
- Chamadas ao Asaas.
- As 10 suítes da lista de bloqueio do runner.

## 7. Arquivos modificados nesta fase

| Arquivo | Tipo |
|---|---|
| `supabase/functions/_shared/notificationQueue.ts` | novo |
| `supabase/functions/notification-worker/index.ts` | alterado |
| `supabase/functions/_shared/syncPaymentDecision.ts` | novo |
| `supabase/functions/sync-payment-status/index.ts` | alterado (+14/−10) |
| `supabase/migrations/20261001_schedule_sync_payment_status.sql` | novo, **não aplicado** |
| `lib/payments/tests/NotificationQueueFase0.unit.test.ts` | novo |
| `lib/payments/tests/SyncReconciliationFase0.unit.test.ts` | novo |
| `lib/payments/tests/EdgeAuthBloco3.unit.test.ts` | 2 asserções atualizadas |
| `lib/payments/tests/ExpirationRefundDecouplingFase2.unit.test.ts` | 1 asserção atualizada |
| `scripts/run-tests.ts` | 2 suítes na allow-list |
| `docs/auditorias/FASE0_CONFIABILIDADE_OPERACIONAL_CNHJA.md` | este relatório |

Preexistentes e não tocados: `lib/payments/tests/RefundReconciliationFase31.unit.test.ts`, `supabase/.temp/cli-latest`.

**Textos do aplicativo:** nenhum arquivo em `pages/`, `components/` ou `NotificationService` foi alterado. Títulos e mensagens de notificação permanecem idênticos.

## 8. Configurações externas ainda necessárias

1. **Deploy** de `notification-worker` e `sync-payment-status` (não autorizado nesta fase).
2. **Aplicação da migration de agendamento**, pela API de migrations (o CLI não consegue comparar o histórico), depois do deploy da função.
3. **Opcional:** variável `NOTIFICATION_MAX_AGE_MINUTES` na função `notification-worker` (padrão 60).
4. **Opcional:** alerta de log para a linha `[NotificationWorker] cycle … needs_attention=N` com N > 0.
5. **Asaas:** confirmação das questões da §4.

## 9. Riscos e limitações remanescentes

1. A correção do 401 só se comprova em produção após o deploy. Se o cabeçalho explícito também não chegar, os jobs passarão a `dead` após 5 tentativas (~15 min) em vez de ficarem presos — o defeito ficaria visível, não resolvido.
2. Depois do deploy, os 13 jobs presos viram `expired` no primeiro ciclo. Se preferir reenviar os recentes, ajuste `NOTIFICATION_MAX_AGE_MINUTES` antes; não recomendo.
3. Notificações com mais de 60 min passam a não ser enviadas por push. É mudança de comportamento: antes, um job pendente seria enviado a qualquer tempo.
4. Usuário sem aparelho registrado passa a `cancelled` em vez de `sent`. Relatórios que contem `sent` mudam de significado (ficam mais corretos).
5. A extração no `sync-payment-status` não foi executada em Deno. Um erro de digitação quebraria a função; ela hoje não é chamada por nada, então o impacto seria nulo até o agendamento.
6. Lacunas da conciliação listadas em §3.1 permanecem.
7. `notification_config` contém uma chave chamada `service_role_key` com valor preenchido (não li o valor). Segredo em tabela comum; vale revisar se ainda é necessário, dado que os jobs usam o Vault.
8. Cancelamento de cobrança: nenhuma correção feita; apenas investigado.

## 10. Checklist para revisão humana antes de qualquer deploy

- [ ] Revisar o diff de `notification-worker/index.ts` e `_shared/notificationQueue.ts`.
- [ ] Revisar o diff de `sync-payment-status/index.ts` (+14/−10) contra `_shared/syncPaymentDecision.ts`.
- [ ] Confirmar o prazo de validade do push (60 min) e o destino dos 13 jobs presos (`expired`).
- [ ] Verificar as duas funções com Deno (`deno check`) em máquina que o tenha.
- [ ] Publicar `notification-worker` primeiro e observar um ciclo: log `sent > 0` e ausência de 401 em `send-push-notification`.
- [ ] Confirmar push recebido em aparelho real.
- [ ] Conferir `notification_jobs`: nenhum `processing` com mais de 10 min.
- [ ] Decidir sobre a primeira execução da conciliação (efeito em §3.3) antes de agendar.
- [ ] Publicar `sync-payment-status`; chamar uma vez manualmente e ler a resposta antes de agendar.
- [ ] Aplicar a migration de agendamento e conferir `cron.job` e `cron.job_run_details`.
- [ ] Encaminhar ao Asaas as perguntas da §4.
- [ ] Commit e push pelo proprietário.

## 11. Confirmações

- **Corrigido localmente:** envio de push (cabeçalho de autorização), recuperação de jobs presos, tentativas com limite, tratamento de falha permanente, registro fiel de entrega; decisões da conciliação testáveis.
- **Pendente:** deploy; agendamento da conciliação; confirmação do Asaas sobre cancelamento Pix; tratamento do cancelamento de cobrança no código; registros históricos.
- **Banco e serviços externos:** nenhuma alteração. Somente consultas de leitura e leitura de logs.
- **Deploy, commit, push:** nenhum.
- **Textos do aplicativo:** intactos.
- **Fase 1 do novo agendamento:** não iniciada.

---

## 12. Fechamento da Fase 0 e preparação para ativação (revisão de 02/10/2026)

Esta seção **prevalece** sobre o que está acima onde houver diferença — em especial sobre o "efeito da primeira execução" da §3.3 e sobre a validade única de 60 minutos da §2.4.

**Decisão de negócio incorporada:** aulas passadas não são objeto de recuperação nem de conciliação histórica; serão excluídas depois e são descartáveis para a operação futura.

### 12.1 Escopo histórico — regra de elegibilidade da conciliação

Implementada em `supabase/functions/_shared/syncPaymentDecision.ts` e aplicada em `sync-payment-status/index.ts`.

**Regra exata**

> Um grupo de aulas, ou uma operação de estorno, é processado somente se a **aula que termina por último** termina em ou depois de `limite`, onde `limite = max(agora − tolerância, data mínima)`.

| Parâmetro | Padrão | Configuração |
|---|---|---|
| Tolerância após o fim da aula | 24 horas | `SYNC_PAST_LESSON_GRACE_HOURS` |
| Data mínima (corte fixo, opcional) | nenhuma | `SYNC_MIN_LESSON_DATE=AAAA-MM-DD` |

- Fim da aula = `date` + `end_time` em horário de Brasília (−03:00). Sem `end_time`: início + 60 minutos.
- Registro sem data ou com data inválida **não é elegível** (dado faltando nunca libera processamento).

**Onde é aplicada**
1. **Grupos de aulas:** depois de ler as aulas do grupo e **antes** de qualquer consulta ao Asaas. Grupo histórico devolve `skipped / historical_lessons`, sem consulta e sem escrita.
2. **Operações de estorno:** a função busca até 100 candidatas, descarta as históricas e só então monta o lote de 25. Operações antigas não ocupam o lugar das válidas.

**Casos limítrofes**

| Caso | Tratamento |
|---|---|
| Aula futura | Elegível |
| Aula em andamento | Elegível (o fim ainda não chegou) |
| Aula que termina exatamente agora | Elegível |
| Aula encerrada há menos de 24 h, com pagamento ou estorno ainda em processamento | Elegível — é a janela em que um webhook atrasado ou um estorno pendente ainda precisa ser fechado |
| Aula encerrada há exatamente 24 h | Elegível; com 24 h e 1 min, não |
| Aula encerrada há mais de 24 h | Ignorada, mesmo com pagamento ou estorno em aberto |
| Combo com aulas antigas e ao menos uma futura | Elegível inteiro (o pagamento é do grupo) |
| Operação de estorno sem aulas identificáveis | Não elegível |
| Aula anterior à data mínima configurada | Ignorada, mesmo dentro da tolerância |

**O que a regra não faz:** não altera, não exclui e não marca nenhum registro histórico. Eles simplesmente deixam de ser lidos pelo job. Nenhuma operação antiga é concluída ou negada.

**Consequência a conhecer:** um estorno que continue pendente por mais de 24 h depois do fim da aula deixa de ser conciliado automaticamente e passa a depender do webhook ou de ação manual. Para a operação corrente isso é raro (o desfecho do estorno chegou em minutos em todos os casos observados); o valor é configurável.

Não foi usado pré-filtro por data na consulta: em um combo a aula selecionada pode ser antiga e o grupo continuar válido por causa de outra aula futura.

### 12.2 Notificações — revisão do worker

| Item | Confirmação |
|---|---|
| Cabeçalho de autorização | `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` enviado explicitamente por `fetch`. O cabeçalho `apikey` **deixou de ser enviado**: a chamada fica no mesmo formato das chamadas do cron, que comprovadamente chegam às funções com o `Authorization` intacto |
| Recuperação de `processing` | Após 10 minutos sem conclusão, com escrita condicional (`status` + `locked_by`) |
| Retentativas limitadas | Espera de 1, 2, 4, 8 min (teto 15); `max_attempts` = 5 → `dead` |
| Sem reenvio do já entregue | Marcadores `dispatch_started_at` / `dispatch_confirmed_at`; confirmado → conclui `sent` sem reenviar; iniciado sem resultado → `failed`, sem reenviar |
| Expiração de antigas | Por tipo (abaixo) |
| Tratamento de críticas | Abaixo |
| Observabilidade de `dead` | Abaixo |

**Hipótese sobre a causa do 401** [não comprovada]: a chave guardada em `notification_config` tem o formato `sb_secret_…`, o que indica que o projeto usa as chaves de API novas. Com `functions.invoke`, a chamada leva o cabeçalho `apikey` além do `Authorization`; o `Authorization` não chegou à função. As chamadas do cron, que levam só `Authorization`, chegam. A correção reproduz o formato que funciona. Só o deploy confirma.

**Tratamento diferenciado**

| Grupo | Tipos | Validade do push | Se não for entregue |
|---|---|---|---|
| Temporalmente críticas | `booking_request`, `booking_accepted`, `booking_rejected`, `booking_cancelled`, `booking_expired` | 60 min (`NOTIFICATION_MAX_AGE_MINUTES`) | Entra em `criticalUndelivered`; ciclo registrado em nível de erro; uma linha `CRITICAL_UNDELIVERED notification_id=… type=… outcome=…` |
| Demais | lembrete, caixinha, repasse, remarcação, sistema | 24 h (`NOTIFICATION_STANDARD_MAX_AGE_MINUTES`) | Estado final registrado; sem alerta de crítica |

"Crítica" aqui significa que o aviso só serve se chegar logo. Por isso a validade é **curta**: um push de "nova solicitação" entregue horas depois é pior que nenhum. O aviso continua disponível dentro do aplicativo.

Usuário sem aparelho registrado não conta como crítica não entregue (não há o que entregar).

**Observabilidade dos jobs `dead`**
- Log por ciclo: `[NotificationWorker] cycle … dead=N … needs_attention=N critical_undelivered=N` (nível de erro quando N > 0).
- Uma linha por job: `DEAD_JOB notification_id=…`. Somente identificador e tipo; nenhum conteúdo de mensagem ou dado pessoal.
- Consulta de acompanhamento (somente leitura):

```sql
SELECT j.status, n.type, count(*) AS n, max(j.updated_at) AS ultimo, max(j.last_error) AS exemplo_de_erro
  FROM notification_jobs j JOIN notifications n ON n.id = j.notification_id
 WHERE j.status IN ('dead','failed','expired')
    OR (j.status = 'processing' AND j.locked_at < now() - interval '10 minutes')
 GROUP BY 1, 2 ORDER BY 1, 2;
```

Não existe alerta ativo (e-mail, painel). Um alerta sobre essas linhas de log é configuração externa.

**Destino dos 13 jobs presos:** todos são dos tipos `booking_request` e `booking_expired` (críticos) e têm mais de 60 minutos → `expired` no primeiro ciclo após o deploy. Nenhum push atrasado é enviado.

**Comandos de deploy — NÃO EXECUTADOS**

```bash
supabase functions deploy notification-worker --project-ref ohftsqsxymtrclnpadam
```

```bash
supabase functions deploy sync-payment-status --project-ref ohftsqsxymtrclnpadam
```

- `verify_jwt = false` já está declarado para as duas em `supabase/config.toml`; não é preciso passar `--no-verify-jwt`.
- `send-push-notification` **não precisa** de novo deploy (não foi alterada).
- Os módulos `_shared/notificationQueue.ts` e `_shared/syncPaymentDecision.ts` são empacotados junto com cada função.
- O código precisa estar commitado antes, para o deploy corresponder a um commit.
- Ordem: `notification-worker` primeiro; observar um ciclo; depois `sync-payment-status`.

Opcional, depois do deploy, para um corte fixo do histórico (ajustar a data):

```bash
supabase secrets set SYNC_MIN_LESSON_DATE=2026-10-02 --project-ref ohftsqsxymtrclnpadam
```

### 12.3 Conciliação — revisão da migration de agendamento

`supabase/migrations/20261001_schedule_sync_payment_status.sql` (não aplicada). O SQL executável não mudou; a nota de pré-requisitos no cabeçalho foi atualizada para a regra de elegibilidade.

| Item | Confirmação |
|---|---|
| Frequência | A cada 5 minutos (`*/5 * * * *`) |
| Autenticação | `CRON_SECRET`, lido do Vault por `invoke_edge_function_cron`; a função recusa sem ele (fail-closed) |
| Concorrência | O pg_cron não sobrepõe o próprio job; duas execuções da função ainda podem coexistir e isso é seguro: escritas condicionais, CAS de versão nas operações (teste D9) |
| Segredos | Nenhum segredo no arquivo, no repositório ou no frontend |
| Idempotência | A migration remove o job de mesmo nome antes de recriar; a função é reexecutável |
| Escopo | Restrito a registros com obrigação operacional vigente (§12.1) |
| Estornos protegidos | `DENIED` e `CONFLICT` fora da seleção de operações; `refund_denied` e `refunded` fora do seletor de aulas; nenhuma chamada de estorno |

**Simulação da primeira execução** — somente leitura, sobre os dados de produção lidos em 02/10/2026 às 01:02 UTC, com a configuração padrão (24 h, sem data mínima). A função **não foi executada**.

Operações de estorno:

| Operação | Estado | Fim da última aula | Candidata? | Resultado |
|---|---|---|---|---|
| `3de5673a…` | `REQUESTED` | 22/09 | não (status fora da seleção) | ignorada |
| `e6f090c0…` | `REQUESTED` | 24/09 | não | ignorada |
| `ad5a3efa…` | `COMPLETED` não confirmada | 30/09 20:00 UTC (29 h antes) | sim | **ignorada — histórica** |
| `73653e34…` | `COMPLETED` não confirmada | 30/09 23:00 UTC (26 h antes) | sim | **ignorada — histórica** |
| `7fcd9741…`, `2cc1048f…`, `c6ca24ab…`, `fe8e415f…` | `DENIED` | 01/10 | não (estado protegido) | ignoradas |

Aulas:

| Registro | Selecionado pela consulta? | Resultado |
|---|---|---|
| 1 aula `cancelled` / `refund_requested`, de 12/08 | sim | **ignorada — histórica** |
| 3 aulas `cancelling` / `paid` | não | ignoradas |
| 3 aulas `expired` / `refund_denied` | não | ignoradas |
| 21 `completed` / `paid` e demais encerradas | não | ignoradas |

**Total: 0 operações conciliadas, 0 grupos processados, 0 consultas ao Asaas, 0 escritas.** Não existe hoje nenhuma aula futura no banco (a mais distante é de 01/10).

Diferença em relação ao que a §3.3 descrevia: sem a regra de elegibilidade, a primeira execução reverteria as duas operações de 30/09 para `DENIED` e voltaria as parcelas a `RECEIVED`. Com a regra, isso **não acontece**.

Observação: as aulas de 01/10 ainda estão dentro das 24 h, mas nenhuma delas é selecionada (operações `DENIED`, aulas `refund_denied`). Para tornar o corte independente do horário do deploy, definir `SYNC_MIN_LESSON_DATE`.

### 12.4 Segurança — `service_role_key` em `notification_config`

Investigado pelo catálogo, **sem ler o valor**.

| Verificação | Resultado |
|---|---|
| Existe a linha | Sim, com valor de 41 caracteres no formato `sb_secret_…` (chave secreta do projeto) |
| RLS na tabela | Ativo, **sem nenhuma policy** → `anon` e `authenticated` não leem nem escrevem linhas pela API |
| Privilégios concedidos | `anon` e `authenticated` têm **todos** os privilégios de tabela (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) |
| Quem consegue ler | `postgres`, `service_role` e qualquer função `SECURITY DEFINER` |
| Funções que leem a tabela | `invoke_edge_function_cron` e `invoke_vercel_cron` — **nenhuma usa `service_role_key`**; usam só as URLs. O segredo do cron vem do Vault |
| Views sobre a tabela | Nenhuma |
| Realtime | Tabela fora das publicações |
| Vault | Já contém `service_role_key` e `cron_secret` |

**Conclusão**
- A chave **não está acessível** hoje a usuários anônimos ou autenticados: a única barreira é o RLS sem policies.
- É uma proteção de camada única. Se alguém criar uma policy permissiva ou desativar o RLS, a chave do projeto fica legível com a chave pública, porque os privilégios de tabela estão todos concedidos.
- A linha é **resíduo sem uso**: nenhuma função a lê, e o mesmo segredo já está no Vault.
- Está em texto puro em uma tabela comum; aparece em qualquer exportação ou backup lógico do schema `public`.

**Correção proposta — NÃO APLICADA** (envolve escrita; requer autorização específica)

```sql
-- NÃO APLICADA
-- 1. Remover o segredo sem uso da tabela comum (o Vault já o contém).
DELETE FROM public.notification_config WHERE key = 'service_role_key';

-- 2. Retirar os privilégios de tabela dos papéis de cliente.
REVOKE ALL ON TABLE public.notification_config FROM anon, authenticated;
```

Antes de aplicar: confirmar que nenhuma Edge Function ou rotina fora do repositório lê essa linha (no repositório, só `app_base_url` e `edge_function_url` são lidos). Recomendação adicional, a decidir: como o valor ficou exposto em tabela comum, considerar rotacionar a chave secreta do projeto.

### 12.5 Validação final

| Verificação | Resultado |
|---|---|
| Suíte completa | 56 executadas, **52 passam**, 4 falham |
| Linha de base (Fase 2 + correções) | 54 executadas, 50 passam, 4 falham |
| Falhas | As mesmas 4 preexistentes, pelos mesmos motivos |
| `NotificationQueueFase0` | 55/55 (eram 47; +8 de tratamento por tipo e observabilidade) |
| `SyncReconciliationFase0` | 51/51 (eram 33; +18 de elegibilidade) |
| Suítes de estorno | Inalteradas: 48, 88, 95, 87, 43, 22; `reconcilePayment` 135 |
| `EdgeAuthBloco3` | 46/46 |
| TypeScript (Node e frontend) | 0 erros |
| Build do frontend | concluído |
| Código compartilhado | sincronizado |

Não executados: Edge Functions em Deno; envio real ao FCM; a migration; a função de conciliação; qualquer chamada ao Asaas.

**Confirmações**
- Nenhum registro histórico foi alterado. Nesta revisão foram feitas duas consultas `SELECT`.
- Nenhuma cobrança foi criada, cancelada ou estornada.
- Nenhuma migration foi aplicada.
- Nenhum deploy foi realizado.
- Nenhum texto do aplicativo foi modificado (diff vazio em `pages/`, `components/`, `NotificationService` e `send-push-notification`).
- Nenhum arquivo do motor de estorno foi modificado.
- Nenhum commit ou push; `HEAD` continua em `ea40f87`.

Arquivos desta fase (acumulado): `supabase/functions/_shared/notificationQueue.ts`, `supabase/functions/_shared/syncPaymentDecision.ts`, `supabase/functions/notification-worker/index.ts`, `supabase/functions/sync-payment-status/index.ts`, `supabase/migrations/20261001_schedule_sync_payment_status.sql`, as duas suítes novas, duas suítes com asserções atualizadas, `scripts/run-tests.ts` e este relatório.

### 12.6 Ações que dependem de autorização para produção

Em ordem.

1. [ ] **Commit e push** do código da Fase 0 (pelo proprietário).
2. [ ] **Deploy de `notification-worker`.**
3. [ ] Conferir um ciclo: log sem 401 em `send-push-notification`; os 13 jobs em `expired`; nenhum `processing` com mais de 10 min.
4. [ ] Gerar uma notificação de teste e confirmar o recebimento em aparelho real.
5. [ ] **Deploy de `sync-payment-status`.**
6. [ ] (Opcional) Definir `SYNC_MIN_LESSON_DATE` com a data de ativação.
7. [ ] Chamar a conciliação **uma vez** manualmente e ler a resposta: esperado `checked=0`, grupos `skipped / historical_lessons`.
8. [ ] **Aplicar a migration de agendamento** (pela API de migrations) e conferir `cron.job` e `cron.job_run_details`.
9. [ ] **Segurança:** autorizar a remoção de `service_role_key` de `notification_config` e a revogação de privilégios; decidir sobre a rotação da chave.
10. [ ] Encaminhar ao Asaas as perguntas sobre cancelamento de cobrança Pix (§4).
11. [ ] Exclusão dos registros históricos, quando decidida (fora desta fase).

A Fase 1 do novo fluxo de agendamento não foi iniciada.
