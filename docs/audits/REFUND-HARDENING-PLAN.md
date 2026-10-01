# REFUND-HARDENING-PLAN — Endurecimento do ciclo de estorno (CNHJá)

| Campo | Valor |
|---|---|
| **Data** | 2026-10-01 |
| **Ambiente de pagamento** | Asaas **Sandbox** (decisão AP-04) |
| **Relacionado** | `docs/audits/MASTER-CORRECTION-PLAN.md` §0.10 · F4-01..09 · AP-13 · AP-14 · C-10 |
| **Status geral** | Fase 1 implementada e testada localmente · **NÃO publicada** · Fases 2–6 apenas planejadas |

> Documento de referência para sessões futuras (Claude Code / Cowork). Distingue sempre:
> **implementado localmente** · **testado localmente** · **validado no banco** · **publicado**.
> Nada aqui autoriza deploy, SQL remoto ou chamadas ao Asaas.

---

## 1. Histórico do incidente

1. **Evento real `PAYMENT_REFUND_DENIED`** recebido do Asaas (Sandbox) para pagamento PIX, com a mensagem
   **"Falha ao processar a transferência."**. A documentação do Asaas descreve esse evento para boleto, mas ele foi observado em PIX no Sandbox.
2. **Operações duplicadas**: o mesmo pagamento (ex.: `pay_4lhb7…`) gerou **duas** operações `DENIED` para a mesma aula/valor.
3. **Causa raiz da duplicação**: a chave de idempotência (`refund:v1:`) incluía a **composição do split**. Quando o Asaas alterou o split
   do pagamento (split de 9000 centavos → revertido / lista vazia), a chave mudou e o sistema tratou a mesma obrigação como nova,
   emitindo **novo POST** de estorno.
4. **Risco do cron**: a expiração/cancelamento automático re-seleciona periodicamente agendamentos que continuam `pending_approval`/`paid`.
   Com a chave instável, cada execução poderia gerar um **novo POST** ao gateway (retentativa ilimitada de fato).
5. Correção anterior relacionada (já em `3bffc14`): resposta 200 do POST de estorno deixou de ser tratada como `COMPLETED`.

## 2. Regras de negócio confirmadas

- O aluno paga a aula.
- A **taxa do Asaas não é estornada**; é arcada pelo aluno.
- O valor solicitado no estorno é o **preço da aula**.
- Comissão da plataforma e valores do instrutor são **reconciliados conforme os registros existentes** (sem regra nova).
- Recusa e expiração usam o **mecanismo central** (`BookingCancellationCore`).
- Recusa do gateway **não pode** gerar retentativas automáticas ilimitadas.
- Nada financeiro é marcado como concluído **sem confirmação do gateway** (`COMPLETED` exige evidência; `acknowledged_at`).
- **Não** criar regras novas para split revertido / recuperação financeira (decisão pendente, ver §5).

## 3. Fase 1 — Idempotência

### 3.1 O que foi feito
| Item | Arquivo | Estado |
|---|---|---|
| Chave `refund:v2:` (provider + pagamento + parcela + escopo + itens + valor solicitado; **sem splits**) | `lib/payments/RefundOperationKey.ts` (`buildRefundObligationKey`) | implementado · testado localmente |
| Identidade da obrigação sem splits | idem | implementado · testado localmente |
| Busca de operações antigas (v1/v2) antes de criar | `RefundOperationRepository.findByObligation` + `BookingCancellationCore` | implementado · testado localmente |
| Ranking da busca: `COMPLETED` > ativos/parciais (`PENDING`, `UNKNOWN`, `REQUESTED`, `PARTIALLY_COMPLETED`) > `CONFLICT` > `DENIED`; empate → mais recente | `RefundOperationRepository.ts` | implementado · testado localmente (ajuste final 2026-10-01) |
| Snapshot do split em `metadata.split_snapshot` (+ `key_version: 'v2'`) | `BookingCancellationCore.ts` | implementado · testado localmente |
| Bloqueio de retentativa automática após `DENIED`/`CONFLICT` (sem POST) | `BookingCancellationCore.ts` (`explicitRetry` sem chamadores) | implementado · testado localmente |
| Compatibilidade com operações legadas `refund:v1:` (reaproveita a chave existente) | idem | implementado · testado localmente |
| Payload do estorno inalterado (valor = preço da aula; splitRefunds) | idem | verificado por revisão |
| Cópias `_shared` geradas por `scripts/sync-shared.ts` | `supabase/functions/_shared/*` | sincronizado (`--check` OK) |

### 3.2 Validação no banco
- Consulta executada **pelo usuário** no Supabase:
  `SELECT COUNT(*) FROM refund_operations WHERE NOT (metadata ? 'appointmentIds');` → **0**.
  Ou seja, todas as operações históricas têm `metadata.appointmentIds` e são encontráveis por `findByObligation`.
- Nenhuma consulta remota foi executada pelo Claude.

### 3.3 Testes
- `lib/payments/tests/RefundIdempotencyFase1.unit.test.ts` — **48/48 PASS** (blocos 1–7 + bloco 8 de ranking:
  COMPLETED+PENDING coexistindo → COMPLETED escolhida, 0 POST, PENDING intacta; empate → mais recente; CONFLICT > DENIED; ativo > recusa; obrigação distinta não interfere).
- Regressões de estorno (ver relatório da sessão / §0.10 do plano mestre).

### 3.4 Ressalvas remanescentes
- **Não publicado** (Edge Functions e Vercel não atualizadas).
- Agendamento com operação `DENIED` permanece `pending_approval`/`paid` e é re-selecionado pelo cron (sem POST, só log de erro) → **Fase 2**.
- Operações órfãs `REQUESTED` (09-22/23) não cobertas por `findStaleForReconciliation` → **Fase 5**.
- Operações legadas `COMPLETED` sem `acknowledged_at` (`pay_q8q4hj3gapnj2g2g`, `pay_wxwagobv3yqiqhh4`) → **Fase 5**.
- Reconciliação apenas manual (decisão R1).
- O índice único de operação ativa por pagamento não impede, por si só, a coexistência de `COMPLETED` + `PENDING`; o ranking cobre esse caso na leitura.

## 4. Fases 2–6 (planejamento — nada implementado)

### Fase 2 — Estado operacional e fim do reprocessamento
- Definir o estado do agendamento quando o estorno falha (`DENIED`/`CONFLICT`) para que o cron pare de re-selecioná-lo.
- Evitar logs de erro repetidos a cada minuto. Depende da decisão §5.2.

### Fase 3 — Splits e alertas de reconciliação
- Detectar split revertido sem estorno principal e **alertar**; **sem solução financeira automática**.

### Fase 4 — Fila de revisão manual
- Fila de casos `DENIED`/`CONFLICT`/divergências para revisão humana.
- Base para futura integração com o **ADMCNHJá**; **sem UI agora**.

### Fase 5 — Reconciliação automatizada
- Incluir órfãs `REQUESTED`/`PENDING`/`UNKNOWN`.
- **Consulta ao gateway antes de qualquer retentativa.**
- Agendamento e monitoramento da reconciliação.

### Fase 6 — Webhooks e auditoria
- Idempotência global de webhooks (dedup por id de evento; entrega at-least-once).
- Trilha de auditoria completa; evitar contabilização em dobro.

## 5. Decisões pendentes (não decididas aqui)
1. Retentativa após recusa só com **autorização humana**?
2. **Estado operacional** do agendamento quando o estorno falha.
3. Tratamento financeiro de **split revertido sem estorno principal**.
4. Estrutura da **fila de revisão** no ADMCNHJá.
5. Investigação com o Asaas da **recusa de estorno PIX no Sandbox** ("Falha ao processar a transferência.").

## 6. Pendências antes do deploy da Fase 1
- Revisão final e autorização do usuário.
- Commit seletivo (sem `git add .`; excluir C-10, `supabase/.temp/cli-latest`, `_to_delete/`, `baseline-*`, `tests -File |`, `tests-p116a/`, `tests-p118e/`, arquivos AP-05A só-CRLF).
- Deploy das Edge Functions que importam `_shared/BookingCancellationCore` e da Vercel (se aplicável), somente após autorização.
- Validação pós-deploy em Sandbox (cancelamento, recusa, expiração) sem gerar POST duplicado.
