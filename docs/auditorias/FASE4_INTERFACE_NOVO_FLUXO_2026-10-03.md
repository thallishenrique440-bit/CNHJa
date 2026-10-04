# Fase 4 — Interface do novo fluxo de agendamento (03/10/2026)

Branch `feat/booking-request-flow`, base `f2340b1` (Fase 3). Alterações **locais, não commitadas**. Nenhum deploy, nenhuma migration aplicada. Sem chave de ativação: o novo fluxo é o padrão.

## Telas e comportamentos

**Perfil do instrutor** (`pages/student/InstructorProfile.tsx`)
- O botão "Pagar agora" passa a ser "Solicitar horário(s)".
- O envio cria só o pedido: não abre o modal de pagamento nem o checkout, e não envia forma de pagamento.
- Com resposta `mode: 'request'`: aviso "Solicitação enviada. Aguardando o instrutor." e ida para "Minhas Aulas".
- Preservados: CPF/telefone obrigatórios, aviso de horário próximo, erros (férias, instrutor sem conta Asaas, horário ocupado), layout, categorias, horários e preços.

**Modal de pagamento** (`components/PaymentMethodModal.tsx`)
- Movido sem alteração visual da tela do instrutor: mesmos elementos, Pix, cartão, 1–4 parcelas, mesma tabela de tarifas e mesma função de cálculo (`quoteCheckout`).
- O servidor recalcula o valor cobrado.

**Minhas Aulas** (`pages/student/Lessons.tsx`)

| Estado (servidor) | Tela |
|---|---|
| `pending` (pedido) | Selo "Aguardando instrutor", sem pagamento; botão "Cancelar solicitação" (decisão de 03/10) |
| `reserved` / `awaiting_payment` (aceito) | Selo "Aguardando pagamento", "Pague até HH:MM", contador mm:ss e botão "Pagar" |
| `confirmed` | Comportamento atual |
| Recusado / cancelado / expirado | Some da lista (`cancelled` fora da consulta; `expired` oculto) |

Detalhes:
- **Contador:** calculado do `expires_at` gravado pelo servidor, com o desvio de relógio que o app já usa (`serverTimeOffset`). Ao zerar, mostra "Prazo encerrado" e pede atualização ao servidor. A validade é decidida no backend (`pay_request` devolve `RESERVATION_EXPIRED`).
- **"Pagar":** abre o modal existente para o pedido inteiro, com todas as aulas do grupo, inclusive de outros dias. Chama `/api/create-booking-intent` com `action: 'pay_request'` e só abre o checkout (`CheckoutLauncher`, como antes) quando a resposta for `mode: 'checkout'`. Uma cobrança já existente é devolvida pelo servidor. Clique duplo é ignorado. Falha de rede, prazo vencido e pedido indisponível têm mensagem própria.
- **Nunca marca pagamento:** a tela nunca altera o estado do pagamento; a confirmação vem do webhook ou da conciliação.
- **Cancelamento:** remove da lista todas as aulas do pedido (o servidor cancela o grupo).
- **Agrupamento:** os cartões do novo fluxo só se juntam dentro do mesmo pedido.

**Agenda do instrutor** (`pages/InstructorAgenda.tsx`)
- Pedido pendente: "Aguardando aprovação", com aceitar/recusar (inalterado).
- Aceito: "Aguardando pagamento" (o fluxo antigo continua "Processando...").
- Aceite: mensagem "Solicitação aceita. Aguardando o pagamento do aluno." e recarga da agenda, em vez de "pagamento capturado".
- Recusa de pedido: a confirmação não fala em estorno.
- Pedido recusado ou cancelado libera o horário.
- Mantidos o tempo real existente (`instructor-agenda-changes`) e o tratamento do combo como unidade, que o backend aplica ao grupo inteiro.

## Testes

| Verificação | Resultado |
|---|---|
| `BookingRequestUIFase4.unit.test.ts` (código-fonte das telas e contrato com o backend) | 22/22 |
| Suíte geral | 61 suítes, 57 passam, 4 falham (as mesmas 4 de antes) |
| TypeScript / build / `sync-shared --check` | 0 erros / concluído / sincronizado |

**Validação no aplicativo (itens 1–12): não executada.** Depende de:
1. aplicar `20261003_booking_request_accept_deadline.sql`;
2. publicar o backend da Fase 3 (Edge Functions `approve-booking`, `reject-booking`, `cancel-booking`, `check-expired-bookings`, `sync-payment-status` e a API na Vercel);
3. contas de teste (aluno e instrutor) e o Asaas em Sandbox.

Recomendação: usar o deploy de pré-visualização da Vercel desta branch (não a produção) para a homologação. O projeto não tem testes de componentes React; as telas não foram renderizadas automaticamente.

## Pendências e incompatibilidades

1. **Texto do perfil do instrutor** ("Importante: se o instrutor não aceitar ou recusar a solicitação, o valor da aula será devolvido...") não corresponde ao novo fluxo, em que nada é cobrado antes do aceite. Textos ficam para a Fase 7; não alterado.
2. **Atualização de "Minhas Aulas":** a tela atualiza a cada 60 s e no evento `refresh-lessons`. Não existe tempo real nessa tela; o aceite chega também por push.
3. **Backend e frontend devem ser publicados juntos** (ver Fase 3). A API em produção ainda é a anterior.
4. Nenhuma incompatibilidade de contrato encontrada: as telas usam exatamente as respostas da Fase 3 (`mode: 'request'` / `mode: 'checkout'`, `outcome`).
