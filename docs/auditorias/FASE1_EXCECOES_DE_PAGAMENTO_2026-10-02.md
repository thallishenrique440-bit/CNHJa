# Fase 1 — Registro e reconciliação de exceções de pagamento (02/10/2026)

Base: `main` em `7f445f1`. Alterações **locais, não commitadas**. Nenhuma migration aplicada, nenhum deploy, nenhuma chamada ao Asaas, nenhum SQL executado em produção nesta tarefa.

Estado: implementado e testado localmente. **Não equivale a homologação do fluxo financeiro.**

## 1. Estrutura encontrada antes das alterações

| Item | Situação |
|---|---|
| Repositório | Limpo, exceto `supabase/.temp/cli-latest` (arquivo do CLI, não tocado) e relatórios não rastreados |
| Webhook em produção | `api/asaas-webhook.ts` (Vercel). Três saídas para pagamento sem reserva, todas só com log e evento `PROCESSED` |
| Ledger de eventos | Tabela `transactions`, `type = webhook_event`, com `provider_payment_id`, `raw_payload`, `processing_status` |
| Parcelas | `payment_installments`; estados `PENDING, AUTHORIZED, CONFIRMED, RECEIVED, OVERDUE, REFUNDED, CHARGEBACK, CANCELLED, FAILED` |
| Conciliação | `supabase/functions/sync-payment-status/index.ts`, acionada pelo job `sync-payment-status-job` |
| Código compartilhado | `lib/payments/` é a fonte; `supabase/functions/_shared/` é gerado por `npx tsx scripts/sync-shared.ts` (lista explícita de arquivos) |
| Validação oficial | `npx tsx scripts/run-tests.ts`, `npx tsc --noEmit`, `npx vite build`, `npx tsx scripts/sync-shared.ts --check` |

**Achado que mudou o desenho da varredura.** A máquina de estados das parcelas só permite `CANCELLED → PENDING`. Quando a reserva expira, a parcela vira `CANCELLED`; um pagamento que chega depois **não** leva a parcela a `RECEIVED`. Uma varredura só sobre parcelas recebidas não encontraria o caso típico. Por isso a varredura usa também o ledger de eventos, que registra a chegada do aviso de pagamento independentemente da parcela.

## A. Arquivos

| Arquivo | Situação | Função |
|---|---|---|
| `supabase/migrations/20261002_payment_exceptions.sql` | Novo | Tabela `payment_exceptions`. **Não aplicada** |
| `lib/payments/PaymentExceptionService.ts` | Novo | Regra de decisão, registro idempotente, avanço de fase e varredura do banco |
| `supabase/functions/_shared/PaymentExceptionService.ts` | Novo (gerado) | Cópia para as Edge Functions |
| `lib/payments/tests/PaymentExceptionFase1.unit.test.ts` | Novo | 61 verificações |
| `api/asaas-webhook.ts` | Alterado | Chama o serviço nas três saídas, antes de `PROCESSED`; a leitura das aulas passou a trazer `id`, `payment_status`, aluno e instrutor |
| `supabase/functions/sync-payment-status/index.ts` | Alterado | Novo passo `reconcilePaymentExceptions`, dentro do job existente |
| `scripts/sync-shared.ts` | Alterado | Inclui o serviço na lista de arquivos gerados |
| `scripts/run-tests.ts` | Alterado | Inclui a suíte nova |
| `docs/auditorias/AUDITORIA_NOVO_FLUXO_AGENDAMENTO_CNHJA.md` | Alterado antes desta tarefa | §8.4 (decisão ADMCNHJá) |
| Este relatório | Novo | — |

## B. Migration (NÃO APLICADA)

```sql
CREATE TABLE IF NOT EXISTS public.payment_exceptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  exception_type          text NOT NULL
    CONSTRAINT payment_exceptions_type_check
    CHECK (exception_type IN ('payment_without_valid_booking')),
  provider                text NOT NULL DEFAULT 'asaas',
  provider_payment_id     text NOT NULL,
  installment_number      integer,

  group_id                text,
  appointment_ids         uuid[] NOT NULL DEFAULT '{}',
  student_id              uuid,
  instructor_id           uuid,

  amount_cents            integer,
  net_amount_cents        integer,
  currency                text NOT NULL DEFAULT 'BRL',
  billing_type            text,

  provider_payment_status text NOT NULL,
  provider_payment_phase  text NOT NULL
    CONSTRAINT payment_exceptions_phase_check
    CHECK (provider_payment_phase IN ('other', 'authorized', 'received')),
  received_at             timestamptz,

  booking_state           text NOT NULL
    CONSTRAINT payment_exceptions_booking_state_check
    CHECK (booking_state IN ('no_group', 'not_found', 'expired', 'cancelled', 'rejected', 'mixed_invalid', 'partially_invalid')),
  booking_snapshot        jsonb NOT NULL DEFAULT '[]'::jsonb,
  split_snapshot          jsonb,

  detected_by             text NOT NULL
    CONSTRAINT payment_exceptions_detected_by_check
    CHECK (detected_by IN ('webhook', 'reconciliation')),
  detected_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  source_event_id         text,

  status                  text NOT NULL DEFAULT 'open'
    CONSTRAINT payment_exceptions_status_check
    CHECK (status IN ('open', 'resolved')),
  resolution              text,
  resolution_notes        text,
  resolved_by             uuid,
  resolved_at             timestamptz,

  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_exceptions_unique_payment UNIQUE (exception_type, provider_payment_id),

  CONSTRAINT payment_exceptions_received_check
    CHECK (provider_payment_phase <> 'received' OR received_at IS NOT NULL),
  CONSTRAINT payment_exceptions_resolved_check
    CHECK (status <> 'resolved' OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);

COMMENT ON TABLE public.payment_exceptions IS
  'Fase 1: pagamento recebido sem reserva valida. Uma linha por pagamento do provedor. Gestao futura pelo ADMCNHJa. Nenhuma automacao estorna, confirma aula ou apaga registros a partir desta tabela.';

CREATE INDEX IF NOT EXISTS idx_payment_exceptions_status_detected
  ON public.payment_exceptions (status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_exceptions_group
  ON public.payment_exceptions (group_id)
  WHERE group_id IS NOT NULL;

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_exceptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_exceptions TO service_role;
```

| Elemento | Explicação |
|---|---|
| `UNIQUE (exception_type, provider_payment_id)` | Uma ocorrência por pagamento do provedor. Parcelas diferentes do mesmo grupo têm pagamentos diferentes e geram linhas próprias |
| `provider_payment_status` + `provider_payment_phase` | O primeiro guarda o estado original (`CONFIRMED`, `RECEIVED`); o segundo é a leitura do CNHJá (`authorized` ≠ `received`) |
| `CHECK` de recebimento | Fase `received` exige `received_at` |
| `CHECK` de resolução | `resolved` exige `resolved_at` e `resolution` |
| Sem chave estrangeira | A ocorrência precisa existir sem reserva, sem grupo e sem aula, e não pode ser apagada em cascata |
| Índices | Fila por estado e data; busca por grupo |
| RLS e privilégios | RLS ativo, **sem policies**. `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated` **e `service_role`**, seguido de `GRANT SELECT, INSERT, UPDATE` para `service_role`. Resultado previsto: clientes sem nenhum privilégio; `service_role` sem `DELETE` e sem `TRUNCATE` (ver §H) |

Riscos da migration:
- **Ordem:** o código novo depende da tabela. Se o webhook for publicado antes da migration, as três saídas passam a responder 500.
- **Rollback:** `DROP TABLE` só é seguro com a tabela vazia ou com dados descartáveis, e exige voltar o código antes.
- **Histórico de migrations:** o projeto não usa `db push`; a aplicação é pela API, e a versão remota terá outro número.
- **Não validado:** nenhum comando deste arquivo foi executado em PostgreSQL.

## C. Fluxo implementado

**Regra única de decisão** (`evaluateBooking`), usada pelo webhook e pela conciliação, sempre com o estado atual das aulas:

| Situação das aulas do grupo | Decisão |
|---|---|
| Sem grupo identificado | Registrar (`no_group`) |
| Grupo sem aulas | Registrar (`not_found`) |
| Nenhuma aula `expired`/`cancelled`/`rejected` | Não registrar (reserva válida) |
| Alguma aula encerrada e alguma com `payment_status` `paid`, `refund_requested`, `refund_denied` ou `refunded` | **Não registrar**: o pagamento já foi atribuído à reserva; é assunto do fluxo de estorno |
| Todas encerradas, sem pagamento reconhecido | Registrar (`expired`, `cancelled`, `rejected` ou `mixed_invalid`) |
| Parte encerrada, sem pagamento reconhecido | Registrar (`partially_invalid`) |

**Webhook.** Nas três saídas já existentes (sem grupo, grupo sem aulas, aula encerrada) o serviço é chamado antes de `finalizeLedger('PROCESSED')`. A resposta ao Asaas e o restante do fluxo não mudaram.

**Conciliação.** A cada execução do job existente, o passo novo:
1. lê os eventos de pagamento do ledger das últimas 72 h (`PAYMENT_EXCEPTION_LOOKBACK_HOURS`), com o tipo de evento filtrado no banco (`raw_payload->>event`) antes do limite de 200, ignorando caixinhas;
2. lê as parcelas em `CONFIRMED`/`RECEIVED` da mesma janela;
3. descarta os pagamentos que já têm ocorrência na mesma fase ou em fase mais avançada;
4. lê as aulas pelo grupo, ou pelo pagamento quando não há grupo;
5. aplica a regra acima e registra.

Não há consulta ao Asaas, nenhuma escrita em outra tabela e nenhum cron novo. Se a varredura falhar, o erro vai para o log e para a resposta, e o restante da conciliação continua.

**Convergência.** As duas origens gravam com `INSERT … ON CONFLICT (exception_type, provider_payment_id) DO NOTHING`. Quem chega depois encontra a linha e, no máximo, avança a fase do pagamento (`other → authorized → received`) com escrita condicional à fase lida. Nunca regride, nunca altera `status` nem os campos de resolução.

**Estados do Asaas.**

| Estado | Leitura | Efeito |
|---|---|---|
| `RECEIVED`, `RECEIVED_IN_CASH` | Recebimento efetivo | Fase `received`, com `received_at` |
| `CONFIRMED` | Cartão autorizado, não liquidado | Fase `authorized`, sem `received_at`; avança quando o recebimento chegar |
| Demais (`PENDING`, `OVERDUE`, …) | Sem pagamento | Não gera ocorrência |

**Falha de persistência e retentativa.**
- O serviço lança `PaymentExceptionPersistenceError`; no webhook ela chega ao `catch` final, que grava o evento como `FAILED` e responde **HTTP 500**.
- No reenvio, só eventos `PROCESSED` são encerrados por idempotência; `FAILED`/`PENDING` são reabertos e reprocessados.
- **Depende de confirmação externa:** que o Asaas reenvia após HTTP 500, por quanto tempo, e se pausa a fila após falhas repetidas. O código não comprova isso.
- Independentemente do reenvio, o evento fica no ledger e a varredura da conciliação registra a ocorrência no ciclo seguinte.

## D. Testes

| Comando | Resultado |
|---|---|
| `npx tsx lib/payments/tests/PaymentExceptionFase1.unit.test.ts` | 61 verificações, 0 falhas (após as correções da §H) |
| `npx tsx scripts/run-tests.ts` | 57 suítes executadas, **53 passam**, 4 falham |
| Falhas | As mesmas 4 anteriores a esta tarefa: `RefundBlockersFase31177` e `RefundCorrectionsFase31175` ("supabaseKey is required"), `RefundOperationRpcSecurity`, `RefundReconciliationFase31` ("query.eq is not a function"). Nenhuma falha nova |
| `npx tsc --noEmit -p .` | 0 erros fora de `supabase/functions` |
| `npx vite build` | Concluído |
| `npx tsx scripts/sync-shared.ts --check` | Sincronizado |

Cobertura dos 13 cenários pedidos:

| # | Cenário | Tipo |
|---|---|---|
| 1 | Recebido + reserva inválida gera ocorrência | Unitário, banco em memória |
| 2 | Autorizado ≠ liquidado | Unitário |
| 3 | Evento repetido não duplica | Unitário |
| 4 | Webhook e conciliação convergem | Unitário |
| 5 | Pagamentos distintos do mesmo grupo | Unitário |
| 6 | Evento atrasado não regride | Unitário |
| 7 | Resolvida não é reaberta | Unitário |
| 8 | Falha de persistência não vira processado | Unitário (o serviço lança) + leitura do código-fonte do webhook |
| 9 | Sem grupo ou sem aula | Unitário |
| 10 | Conciliação não altera aulas nem estorna | Unitário |
| 11 | Conciliação não chama o Asaas | Unitário (`fetch` bloqueado) + código-fonte |
| 12 | Reserva válida continua igual | Unitário + código-fonte |
| 13 | Concorrência sem duplicata | Unitário, com o mock reproduzindo a restrição única |

Limitações:
- O handler do webhook **não é executado** nos testes; a integração é verificada pela leitura do código-fonte (posição da chamada, ausência de `catch`, caminho de erro).
- A restrição única, os `CHECK`, o RLS e os privilégios **não foram validados em PostgreSQL real**: o mock reproduz o comportamento esperado, não o banco.
- A Edge Function não foi executada em Deno.

## E. Segurança

- Nenhuma alteração remota: RLS, privilégios, secrets e configurações de produção intactos.
- A migration proposta **cria** RLS e privilégios para a tabela nova, apenas; não toca em objetos existentes.
- Nenhuma credencial lida ou gravada. Os logs novos trazem só o identificador do pagamento, o resultado e o estado da reserva.

## F. Pendências

**Validação com PostgreSQL real**
1. Aplicar a migration e conferir restrições, RLS e privilégios.
2. Comprovar a unicidade com duas inserções do mesmo pagamento.
3. Critério da auditoria (§18): simular um pagamento órfão em teste e conferir que existe exatamente um registro.

**Confirmação externa (Asaas)**
4. Política de reenvio de webhook após HTTP 500 e eventual pausa da fila.

**Limitação conhecida, para avaliação futura**
5. Pagamento cujo aviso nunca chegou ao sistema, ou não foi persistido no ledger, não é detectado por uma varredura só no banco.
6. A varredura lê até 200 eventos **de pagamento** e 200 parcelas por execução, na janela de 72 h (ver §H).

**Observações fora do escopo (não alteradas)**
7. Com a parcela já `CANCELLED`, o pagamento tardio não transiciona a parcela; o webhook registra só um aviso. A auditoria (lacuna 5) descreve liquidação antes da validação — isso ocorre quando a parcela ainda não foi cancelada. Vale reavaliar na Fase 3.
8. A tabela não tem trilha de histórico própria (quem alterou o quê). O ADMCNHJá precisará definir se registra o histórico em `metadata` ou em tabela de eventos.

**ADMCNHJá (futuro)**
9. Consulta, acompanhamento e resolução das ocorrências. Até lá, consulta manual pela query do item (d) da migration.

## G. Próxima etapa (não executada)

1. Revisar a migration e este diff.
2. Commit e push (pelo proprietário).
3. Aplicar a migration pela API de migrations, com autorização específica, e rodar as verificações (a)–(c) do arquivo.
4. Publicar a Vercel (webhook) **depois** da migration.
5. Publicar `sync-payment-status`.
6. Conferir uma execução do cron: a resposta deve trazer `payment_exceptions` com contadores e sem erro.
7. Em Sandbox, executar o cenário de pagamento órfão e conferir o registro único.

## H. Correções da revisão final (02/10/2026)

**D1 — privilégios.** Correção de uma afirmação anterior deste relatório: a versão inicial da migration dizia "`service_role` sem `DELETE`", mas só fazia `GRANT SELECT, INSERT, UPDATE` e revogava apenas `PUBLIC`, `anon` e `authenticated`. No Supabase, tabela nova em `public` recebe por padrão todos os privilégios para `anon`, `authenticated` e `service_role` (observado em produção em `notification_config`, que tinha os 7 privilégios para os três papéis sem nenhum `GRANT` na migration de criação). A `service_role` manteria `DELETE` e `TRUNCATE`. Agora o `REVOKE ALL` inclui a `service_role` e vem antes do `GRANT`.

Privilégios previstos após a aplicação:

| Papel | Privilégios |
|---|---|
| `PUBLIC`, `anon`, `authenticated` | Nenhum |
| `service_role` | `SELECT`, `INSERT`, `UPDATE` |
| `postgres` (dono da tabela) | Todos, por ser o dono |

Verificação local: o teste 12m2–12m5 aplica os `REVOKE`/`GRANT` da migration, na ordem, sobre os privilégios padrão. **Não é validação do PostgreSQL**: a confirmação real é a consulta (b) do arquivo, depois da aplicação.

**D2 — filtro do ledger.** A consulta passou a filtrar `raw_payload->>event` em `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`, `PAYMENT_UPDATED` no banco, antes do limite de 200. Sem isso, eventos de criação, visualização ou split ocupavam as vagas e um órfão mais antigo podia ficar de fora. O limite não foi aumentado.
- Compatibilidade: `raw_payload` é o JSON do Asaas gravado pelo webhook (`raw_payload: payload`), com `event` na raiz e em maiúsculas — o mesmo campo que o webhook lê (`payload?.event`). O operador `->>` devolve texto, e `.in()` do supabase-js gera `raw_payload->>event=in.(...)`, sintaxe aceita pelo PostgREST. **Não executado contra o banco real.**
- Teste 14: 250 eventos irrelevantes mais recentes que o órfão. O controle (14a) mostra que, sem o filtro, o órfão fica fora dos 200 lidos; com o filtro, ele é registrado (14b), é o único candidato (14c) e uma segunda varredura não duplica (14d).

**D3 — janela de 72 h e recuperação.**
- A varredura só lê eventos e parcelas das últimas 72 h. Um pagamento cujo webhook falhou em registrar a ocorrência, e que não foi reenviado pelo Asaas, só é recuperado se o cron rodar com sucesso dentro dessa janela.
- **Recuperação após indisponibilidade superior a 72 h** (conciliação parada, falha repetida da varredura):
  1. Calcular as horas desde o início da indisponibilidade, com folga.
  2. Definir temporariamente `PAYMENT_EXCEPTION_LOOKBACK_HOURS` com esse valor nos segredos de `sync-payment-status`.
  3. Deixar uma execução do cron ocorrer, ou acionar a função uma vez, e conferir na resposta `payment_exceptions.created` e a ausência de erro.
  4. Se a janela tiver mais de 200 eventos de pagamento, repetir até `created = 0`, ou reduzir a janela em etapas.
  5. Remover a variável (volta às 72 h).
  É idempotente: repetir a execução não duplica ocorrências.
- A recuperação depende de o evento estar gravado no ledger (`transactions`, `type = webhook_event`). Pagamento cujo aviso nunca chegou ao sistema não é detectado por nenhuma varredura no banco.

**Decisão B4 — mantido o HTTP 500.** Quando a gravação da ocorrência falha, o webhook continua gravando o evento como `FAILED` e respondendo 500; nada é marcado como sucesso. A recuperação local é a varredura, dentro da janela. **Pendente de confirmação externa:** se o Asaas reenvia após 500, por quanto tempo, e se pausa a fila de webhooks após falhas consecutivas — o que, se ocorrer, também atrasaria eventos de pagamentos válidos. Por isso a migration deve ser aplicada antes do deploy do webhook.

## Confirmações

- Nenhuma migration aplicada remotamente.
- Nenhuma Edge Function ou frontend publicado.
- Nenhuma chamada financeira externa.
- Nenhuma alteração destrutiva: o diff só acrescenta código; nenhuma lógica de estorno, split, confirmação de aula, reserva ou cancelamento foi modificada.
- Nenhum commit ou push.
