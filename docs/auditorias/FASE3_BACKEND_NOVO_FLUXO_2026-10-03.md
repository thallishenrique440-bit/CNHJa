# Fase 3 — Backend do novo fluxo de agendamento (03/10/2026)

Base: `main` em `c0c690b`. Alterações **locais, não commitadas**. Nenhum deploy, nenhuma migration nova, nenhuma ativação. A chave do novo fluxo fica **desligada por padrão**.

## Pontos de integração mapeados

| Ponto | Arquivo | Papel no novo fluxo |
|---|---|---|
| Criação | `api/create-booking-intent.ts` (Vercel) | Pedido sem cobrança (chave ligada); pagamento após o aceite (`action: 'pay_request'`) |
| Aceite | `supabase/functions/approve-booking` | `booking_request_accept` |
| Recusa | `supabase/functions/reject-booking` | `booking_request_reject` |
| Cancelamento do aluno | `supabase/functions/cancel-booking` | `booking_request_cancel_by_student` |
| Expiração | `supabase/functions/check-expired-bookings` (1/min) | Módulo C novo; Módulo A passa a ler só `legacy` |
| Confirmação | `api/asaas-webhook.ts` | `booking_request_confirm_payment`; reserva encerrada → `payment_exceptions` |
| Conciliação | `supabase/functions/sync-payment-status` (5/5 min) | Pedido pago → `booking_request_confirm_payment` |
| Notificações | `NotificationService` (Node e `_shared`) | Mesmo serviço; dois métodos novos no `_shared` |

O projeto tem 12 funções na Vercel (limite do plano Hobby). Por isso o pagamento do pedido usa o endpoint existente com `action: 'pay_request'`, sem arquivo novo.

## O que foi implementado

**Chave de ativação** (`lib/payments/BookingRequestService.ts`), lida só no servidor:
- `BOOKING_REQUEST_FLOW_ENABLED=true` liga; ausente ou qualquer outro valor = fluxo atual para todos.
- `BOOKING_REQUEST_FLOW_INSTRUCTORS=id1,id2` (opcional) restringe a instrutores de teste.
- A chave só decide na **criação**. Depois disso, cada função segue o `booking_flow` gravado na aula: desligar a chave não deixa pedidos existentes sem tratamento.

**A — Pedido.** Com a chave ligada, `create-booking-intent` grava as aulas em `pending` / `booking_flow = request`, com prazo de resposta igual ao início da primeira aula do pedido. Não cria cliente no provedor, cobrança, split nem parcelas. Notifica o instrutor (`sendBookingRequest`). A resposta é `{ mode: 'request', groupId, status: 'pending', responseDeadline, ... }`, **sem** `invoiceUrl`/`clientSecret`. A compra direta ganhou `mode: 'checkout'`, com o restante da resposta igual.

**B — Aceite e recusa.** As Edge Functions desviam para as funções atômicas antes do caminho atual. A recusa não passa pelo Core de cancelamento (não há cobrança nem estorno) e notifica o aluno sem mencionar reembolso. O cancelamento pelo aluno vale enquanto o pedido aguarda; o instrutor recebe `USE_REJECT` se tentar cancelar um pedido.

**C — Prazo.** Hoje o banco aplica a regra da Fase 2: prazo = aceite + 15 min, e aceite recusado (`TOO_LATE`) se alguma aula começar antes disso. A regra pedida para esta fase (`min(aceite + 15 min, início da aula)`, sem antecedência mínima) exige alterar `booking_request_accept` — ver **Pendência 1**. O backend usa o prazo devolvido pelo banco e já funciona com as duas regras.

**D — Pagamento** (`action: 'pay_request'`), passos idempotentes:
1. `booking_request_start_payment`: só dentro do prazo, decidido pelo banco.
2. Cobrança já vinculada → devolve a mesma (sem segunda cobrança).
3. Cobrança nova com **as mesmas regras** do fluxo atual. Tarifa, comissão de 10 %, split, recuperação de cliente e cronograma de parcelas foram movidos sem alteração para `lib/payments/BookingCharge.ts`, e o fluxo atual passou a usar esse mesmo módulo.
4. `booking_request_attach_payment`: se outra chamada vinculou antes, ou se o prazo venceu, a cobrança criada é cancelada no Asaas (`AsaasProvider.deletePayment`, novo).
5. Cronograma em `payment_installments`.
- Falha do provedor: nada é apagado. O pedido fica aguardando pagamento até o prazo e o aluno pode tentar de novo.
- A aula **não** é confirmada aqui.

**Confirmação** (webhook e conciliação): `RECEIVED`, `RECEIVED_IN_CASH` e `CONFIRMED` confirmam a reserva, a mesma regra que o webhook já aplica hoje. A liquidação continua só em `RECEIVED`.
- O webhook registra a transação `lesson_payment` e a liquidação exatamente como no fluxo atual e não reenvia o aviso de "nova solicitação" ao instrutor.
- Pagamento de reserva encerrada → `NOT_ACTIVE` → ocorrência em `payment_exceptions` (Fase 1). Nunca reativa a reserva.

**Hora do pagamento × hora do webhook.** A decisão usa o **estado atual da reserva**, não o horário de chegada do webhook. Enquanto a reserva está ativa o horário segue protegido, então um pagamento que chega com atraso de rede é confirmado. A expiração com cobrança vinculada consulta o Asaas antes:
- pago → não expira (aguarda a confirmação);
- não pago → cancela a cobrança e só então expira;
- sem resposta, ou falha ao cancelar → não faz nada e tenta no ciclo seguinte.
O pagamento depois da expiração só é possível se o cancelamento falhar; nesse caso vira exceção.

**E — Expiração.** Módulo C em `check-expired-bookings` (já roda a cada minuto; nenhuma mudança de frequência). Usa `runRequestExpiryCycle` + `booking_request_expire` e notifica aluno e instrutor (`sendBookingRequestExpired`). O Módulo A (fluxo atual) passou a filtrar `booking_flow = 'legacy'` e não toca pedidos.

**F — Notificações.** Mesmo serviço e mesma fila.
- Instrutor: `sendBookingRequest` no pedido.
- Aluno: `sendBookingRequestAccepted` (novo; não diz "confirmada"), `sendBookingRejected` (sem reembolso), `sendBookingRequestExpired` (novo).
- Instrutor no cancelamento: `sendBookingCancelled`.
- Os dois textos novos são provisórios, para revisão na Fase 7.
- A deduplicação continua sendo a da RPC `create_unified_notification`.

## Fluxo atual após as alterações

Com a chave desligada, o comportamento é idêntico:
- `create-booking-intent` grava `awaiting_payment` com 5 min, cria cliente e cobrança e devolve `invoiceUrl`.
- Webhook, aceite, recusa, cancelamento, expiração (Módulos A e B) e conciliação seguem os caminhos de antes. Os desvios só disparam com `booking_flow = 'request'`, que não existe enquanto a chave estiver desligada.

Mudanças no código do caminho atual (sem efeito de comportamento):
- Regras de cobrança movidas para `BookingCharge.ts`; o teste D confere tarifa, total, comissão e split contra a fórmula original.
- "Nova tentativa" e Módulo A filtram `legacy`.
- Resposta da compra direta com `mode: 'checkout'`.

## Testes

| Suíte | Tipo | Resultado |
|---|---|---|
| `BookingRequestFase3.pg.test.ts` | **PostgreSQL 17.9 real** (`embedded-postgres`), migration da Fase 2 aplicada, **conexões independentes** | 23/23 |
| `BookingRequestFase3.unit.test.ts` | Regras puras + leitura do código dos handlers | 25/25 |
| `PaymentExceptionFase1.unit.test.ts` | Ajuste: o webhook tem uma 4ª chamada (pagamento tardio do novo fluxo) | 61/61 |
| Suíte geral | — | 60 suítes: 56 passam, 4 falham (as mesmas 4 de antes) |
| TypeScript / build / `sync-shared --check` | — | 0 erros / concluído / sincronizado |

Concorrência real: a sessão A trava o grupo em transação aberta; a sessão B fica comprovadamente bloqueada no mesmo bloqueio e, ao seguir, é recusada. São mais 15 rodadas de disparo simultâneo em combo de 3 aulas, e as disputas de vínculo de cobrança e de confirmação também usam 2 sessões.

Cobertura dos 20 itens pedidos: 1–9, 11–19 cobertos. Item 10 coberto **pela regra atual** (`TOO_LATE`); a regra nova depende da Pendência 1. Item 20: regressão sem falha nova.

**Não executado:** os handlers HTTP (Vercel e Edge) não rodaram, só a leitura do código. O provedor foi simulado. Nenhuma chamada real ao Asaas.

## Pendências e riscos

1. **Regra do prazo (exige migration — autorização pendente).** Para `min(aceite + 15 min, início da aula)` e "não aceitar após o início", `booking_request_accept` precisa:
   - calcular `v_first_start := min((date + start_time) AT TIME ZONE 'America/Sao_Paulo')` do grupo;
   - recusar (`TOO_LATE`) só se `v_first_start <= now()`;
   - gravar `expires_at := least(now() + janela, v_first_start)`.
   Isso é uma migration `CREATE OR REPLACE FUNCTION`, sem tabela ou coluna nova; as demais funções não mudam. Não criei o arquivo, conforme a regra 8.
2. **Textos** das duas notificações novas: provisórios (Fase 7).
3. **Troca de forma de pagamento** depois de criada a cobrança (Pix ↔ cartão): o endpoint devolve a cobrança existente. Trocar exigiria cancelar e recriar — a decidir.
4. **Cancelamento da cobrança no Asaas** impede o pagamento posterior: hipótese da auditoria (§8.1), ainda não comprovada em Sandbox.
5. **Dependências de teste novas:** `embedded-postgres` 17.9 (binário do PostgreSQL de ~100 MB, só em desenvolvimento).
6. **Frontend (Fase 4):** com a chave ligada, a tela atual não sabe tratar `mode: 'request'` (não abre checkout, mas mostra erro). A chave só deve ser ligada junto com a Fase 4.

## Confirmação

Nenhum commit, push, deploy, migration, alteração de interface ou ativação em produção.

---

## Finalização (03/10/2026, decisões definitivas do proprietário)

Esta seção **prevalece** sobre as anteriores onde houver diferença.

**Sem chave de ativação.** O novo fluxo é o padrão: toda solicitação vira pedido sem cobrança (`create-booking-intent`, `const requestFlow = true`). `isBookingRequestFlowEnabled` e as variáveis `BOOKING_REQUEST_FLOW_*` foram removidas. O ramo de compra direta do fluxo anterior fica no código, sem uso, até a remoção do legado (Fase 9). As reservas antigas (`booking_flow = 'legacy'`) continuam tratadas pelo caminho anterior (webhook, aceite, expiração Módulos A/B, conciliação).

**Prazo definitivo** — migration local `supabase/migrations/20261003_booking_request_accept_deadline.sql` (**não aplicada**). Altera só `booking_request_accept`:
- `expires_at = least(aceite + 15 min, início da primeira aula do grupo)`, no relógio do banco;
- sem antecedência mínima;
- aceite recusado (`TOO_LATE`) só depois do início da aula.

Segurança, `search_path`, privilégios, bloqueio do grupo e idempotência mantidos. Nenhuma tabela, coluna, CHECK ou outra função alterada. As funções de pagamento já exigem `expires_at > now()`: não há pagamento iniciado depois do início da aula.

Item da seção anterior resolvido: Pendência 1. Itens que deixam de valer: ativação gradual e a pendência 6 sobre "ligar a chave".

**Testes da finalização** (PostgreSQL 17.9 real, `BookingRequestFase3.pg.test.ts`, agora com as duas migrations): 29/29.

| Caso | Resultado |
|---|---|
| Aceite 6 min antes da aula | Aceito; prazo = início da aula; pagamento permitido nesses 6 min |
| Aula em 30 min | Prazo = aceite + 15 min |
| Prazo exatamente no início da aula | Depois do início não inicia pagamento; a reserva expira |
| Aceite depois do início | `TOO_LATE`, nada muda |
| Combo | Grupo inteiro aceito; prazo único = início da primeira aula |
| Segurança da função alterada | `SECURITY DEFINER`, `search_path` fixo, `EXECUTE` só `service_role` |

Os demais casos (concorrência real, cobrança, webhook, cron, pagamento tardio, isolamento do legado, integridade financeira) continuam aprovados na mesma suíte. `BookingRequestFase3.unit.test.ts`: 23/23 (testes da chave substituídos pela verificação de que ela não existe).

`BookingRequestAtomicOpsFase2.pg.test.ts` continua validando o arquivo da Fase 2 isolado. O caso C6 (`TOO_LATE` para aula a 10 min) descreve a regra anterior, que a migration de prazo substitui.

**Regressão:** 60 suítes, 56 passam, 4 falham — as mesmas 4 de antes, nenhuma nova. TypeScript 0 erros; build concluído; `sync-shared` sincronizado.

**Riscos e pendências que restam:**
1. **Ordem de publicação.** Sem chave, o backend passa a criar pedidos assim que publicado, e a tela atual (antes da Fase 4) não sabe tratar `mode: 'request'`: mostraria erro em vez de abrir o checkout. Como a Vercel publica automaticamente a cada push na `main`, **o commit desta fase na `main` publica o comportamento novo**. Recomendação: commitar em branch separada, ou só publicar junto com a Fase 4. As Edge Functions só mudam com deploy manual.
2. **Migration do prazo:** aplicar antes (ou junto) da publicação do backend; sem ela, aulas a menos de 15 min continuam recusadas (`TOO_LATE`).
3. **Pagamento concluído no último minuto.** Se o webhook chegar depois do prazo, mas antes do cron expirar a reserva (até 1 min), a aula é confirmada, porque o horário estava protegido. O Asaas não informa a hora exata do pagamento (só a data). Pagamento depois da expiração vira exceção (Fase 1) e segue para conciliação/remarcação (decisão 11).
4. **Cobrança cancelada não pode ser paga:** hipótese não verificada em Sandbox. A reserva só é liberada depois de o cancelamento ser aceito pelo Asaas.
5. Textos dos dois avisos novos: provisórios (Fase 7). Troca Pix ↔ cartão após criar a cobrança: não suportada (devolve a existente).
