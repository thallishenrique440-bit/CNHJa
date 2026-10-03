# Fase 2 — Integridade e operações atômicas do novo fluxo (03/10/2026)

Base: `main` em `bae677a`. Arquivos locais ainda **não commitados**. Migration **aplicada em produção em 03/10/2026** (ver seção final). Nada publicado. O novo fluxo continua **desligado**: nenhuma tela ou backend chama as funções novas.

## Escopo (auditoria §17, Fase 2)

"Banco: RPCs atômicas, coluna de aceite, tabela de exceções, função de disponibilidade". A tabela de exceções já foi entregue na Fase 1.

## Estruturas verificadas antes (catálogo de produção, somente leitura)

- `appointments` não tinha coluna de aceite nem marca de fluxo.
- CHECK de status: `pending, pending_approval, confirmed, scheduled, completed, cancelled, expired, no_show, reserved, awaiting_payment, blocked, cancelling` (sem `rejected`).
- Índices únicos `idx_unique_active_slot` e `idx_unique_student_active_slot` já protegem contra reserva dupla.
- Triggers existentes: AP-01 (insert), AP-03/AP-11 (update), férias e `set_updated_by`.
- `get_instructor_availability` de produção inclui o ramo de férias (AP-05/A) e tem `EXECUTE` para `anon` e `authenticated`.
- Não havia RPC de aceite, pagamento ou expiração.

## Migration `supabase/migrations/20261003_booking_request_atomic_ops.sql`

| Item | Efeito |
|---|---|
| `booking_flow text NOT NULL DEFAULT 'legacy'` + CHECK (`legacy`, `request`) | Todas as linhas existentes ficam `legacy`; o fluxo atual não muda |
| `accepted_at timestamptz` + CHECK (só em linhas `request`) | Momento do aceite |
| Índice parcial `idx_appointments_request_active_expiry` | Expiração do novo fluxo |
| Trigger `appointments_booking_flow_guard_trigger` | Cliente (`anon`/`authenticated`) não grava nem altera `booking_flow`/`accepted_at` e não muda o status de linhas `request`; service role não é afetada; fluxo atual inalterado |
| `booking_request_accept` | `pending → reserved`, grava `accepted_at`, prazo de pagamento = aceite + 15 min (relógio do banco) |
| `booking_request_reject` | `pending → cancelled` (`instructor_rejected`, `released`); recusa com cobrança vinculada é negada |
| `booking_request_cancel_by_student` | `pending → cancelled` (`student_cancelled`, `released`); grupo inteiro; disputa o mesmo bloqueio do aceite |
| `booking_request_start_payment` | `reserved → awaiting_payment`, só dentro do prazo |
| `booking_request_attach_payment` | Vincula UMA cobrança; uma segunda é negada (`PAYMENT_CONFLICT`) |
| `booking_request_confirm_payment` | `reserved/awaiting_payment → confirmed/paid`; reserva encerrada devolve `NOT_ACTIVE` (vira exceção da Fase 1) |
| `booking_request_expire` | `pending/reserved/awaiting_payment → expired`, só após o prazo; com cobrança vinculada exige verificação prévia do provedor |
| `get_instructor_availability` | Cópia da versão de produção com um ramo novo: pedido próprio do novo fluxo = `my_request` |

Padrão de todas as operações: bloqueio das linhas do grupo (`FOR UPDATE`), avaliação do grupo inteiro, um `UPDATE` condicional e conferência do número de linhas (divergência aborta a transação). Repetir a chamada devolve `ALREADY_*` sem escrever. `EXECUTE` só para `service_role`. Nenhuma função toca tabelas financeiras nem linhas `legacy`.

Rollback no cabeçalho do arquivo (seguro só sem linhas `request`).

## Testes

`lib/payments/tests/BookingRequestAtomicOpsFase2.pg.test.ts` — **PostgreSQL real em memória (PGlite 0.5.8, PostgreSQL 18.3)**, com esquema mínimo equivalente ao de produção, os triggers AP-01/AP-03 das migrations do repositório e o arquivo da migration aplicado sem alterações. 63 verificações, 0 falhas.

| Grupo | Cobre |
|---|---|
| A | Linhas existentes preservadas; migration reaplicável; CHECKs |
| B | Pedidos para o mesmo horário (instrutor, aluno, contra aula do fluxo atual) |
| C | Aceite, repetição, instrutor errado, grupo legado, tarde demais, pedido vencido, grupo inconsistente |
| D | Aceite × recusa e aceite × cancelamento do aluno, nas duas ordens; repetições; cobrança vinculada; horário liberado |
| E–G | Início do pagamento, vínculo único da cobrança, confirmação, repetição, pagamento divergente |
| H | Expiração, repetição, pagamento após expiração, cobrança vinculada, aula confirmada |
| I | Privilégios das funções, `SECURITY DEFINER`, proteção das colunas e do status das linhas `request`, AP-03 preservado no fluxo atual |
| J | Disponibilidade (`my_request`, `my_reservation`, férias) |
| K | Fluxo atual e tabelas financeiras intactos |

Suíte geral: 58 suítes, 54 passam, 4 falham (as mesmas 4 de antes). TypeScript: 0 erros fora de `supabase/functions`. Build concluído.

**Limites:** PGlite tem uma única conexão — as chamadas "concorrentes" são sequenciais; a disputa real entre duas sessões não foi executada. Banco de produção (PostgreSQL 17.6, objetos reais) não testado.

## Pendências

1. Aplicar a migration (autorização) e rodar as verificações (a)–(c) do arquivo.
2. Teste com duas conexões simultâneas em PostgreSQL real.
3. Decisões da §19 ainda abertas (ver relatório ao proprietário).
4. Uso das funções pelo backend: Fase 3.

## Decisões do proprietário (03/10/2026)

1. **Cancelamento pelo aluno** enquanto aguarda o instrutor: permitido. Implementado como `booking_request_cancel_by_student` (grupo inteiro, horário liberado na hora). A disputa com o aceite é resolvida pelo bloqueio comum das linhas; testado nas duas ordens em sequência. Consequência: no novo fluxo o cliente não altera status diretamente — o botão "Cancelar" chamará o backend (Fase 3).
2. **Prazo de pagamento:** horário-limite e contagem regressiva discreta, calculados no aparelho a partir de `expires_at`; o backend (`booking_request_start_payment`, `booking_request_attach_payment`) continua sendo a autoridade.
3. **Fase 3:** análise e preparação em paralelo; integração sobre o contrato desta fase; validação integrada só com a migration aplicada e verificada; deploy e ativação sob aprovação.

Interface e sequência atualizada: `AUDITORIA_NOVO_FLUXO_AGENDAMENTO_CNHJA.md`, §17.1 e §17.2.

## Aplicação em produção (03/10/2026)

**Conferência prévia (somente leitura):**
- Nenhum objeto novo existia (colunas, funções, índice).
- A definição de `get_instructor_availability` em produção era idêntica à usada como base.
- Os 4 triggers existentes permaneciam os mesmos.
- A suíte PGlite estava em 63/63.
- Resultado: sem bloqueantes.

**Aplicação:** 15:23:49 UTC, pela API de migrations. Registro no histórico: `20261003152349 booking_request_atomic_ops`.

**Verificações pós-aplicação (somente leitura):**

| Item | Resultado |
|---|---|
| Colunas | `booking_flow text NOT NULL DEFAULT 'legacy'`; `accepted_at timestamptz` nulável |
| CHECKs | `appointments_booking_flow_check` e `appointments_accepted_at_flow_check` presentes; `appointments_status_check` inalterado |
| Índices | `idx_appointments_request_active_expiry` criado; índices únicos de horário inalterados |
| Triggers | `appointments_booking_flow_guard_trigger` acrescentado; os 4 anteriores mantidos |
| Funções | 9 objetos; hash do corpo de cada um **idêntico** ao gerado a partir do arquivo local; todas `SECURITY DEFINER` com `search_path=public` |
| Privilégios | `booking_request_*`: EXECUTE só para `service_role` (`anon` e `authenticated` negados); `get_instructor_availability` manteve os privilégios anteriores |
| Registros existentes | 37 aulas, todas `legacy`, nenhuma com `accepted_at`; hash do conteúdo das aulas (sem as colunas novas) igual ao de antes |
| Financeiro | Hash de `transactions` e `payment_installments` igual ao de antes |
| Fluxo atual | Primeiro ciclo depois da aplicação: `check-expired-bookings` e `notification-worker` com sucesso, respostas HTTP 200 |

**Não verificado:** disputa real entre duas sessões simultâneas (exige criar pedidos de teste, fora desta autorização); execução das funções em produção (nenhuma foi chamada).
