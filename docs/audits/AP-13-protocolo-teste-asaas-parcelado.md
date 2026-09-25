# AP-13 — Protocolo de teste controlado: cobrança parcelada e estorno no Asaas

| | |
|---|---|
| **Status** | **PREPARADO — NÃO EXECUTADO** |
| **Bloqueado para execução** | **SIM** — exige ambiente Sandbox confirmado e autorização explícita |
| **Origem** | MASTER-CORRECTION-PLAN v1.1, item F4-01 e CONFLITO-02 |
| **Data** | 2026-09-24 |

> Este documento **prepara** o teste. Nada aqui foi executado. Nenhuma cobrança foi criada, nenhum estorno foi disparado, nenhuma configuração do Asaas foi alterada.

---

## 1. Por que este teste precisa existir antes de qualquer correção

O `MASTER-CORRECTION-PLAN` registrou, em CONFLITO-02, uma divergência entre o que o teste do repositório assume e o que o banco de produção mostra.

**O que o teste assume** — `lib/payments/tests/InstallmentFullRefundFase3114.unit.test.ts:195-198` afirma que um estorno integral localizado por `provider_payment_id` atinge as **4 parcelas** de uma cobrança 4x.

**O que o banco mostra** (consulta read-only, 2026-09-24):

```sql
SELECT group_id, count(*) AS parcelas, count(DISTINCT provider_payment_id) AS ppids,
       max(total_installments) AS total
  FROM payment_installments
 WHERE total_installments > 1
 GROUP BY group_id;
```

| group_id | parcelas | ppids | total |
|---|---:|---:|---:|
| 1682be3d-… | 4 | **4** | 4 |
| 22c51e17-… | 4 | **4** | 4 |
| 7d1ed64a-… | 4 | **4** | 4 |
| d9d17cc2-… | 4 | **4** | 4 |

**Cada parcela tem `provider_payment_id` distinto.** Portanto `.eq('provider_payment_id', X)` seleciona **uma** linha, não quatro.

### Consequência para o código vivo

`lib/payments/InstallmentService.ts:288-298`:

```ts
if (dto.providerPaymentId)      query = query.eq('provider_payment_id', dto.providerPaymentId);
else if (dto.groupId)           query = query.eq('group_id', dto.groupId);
else if (dto.appointmentId)     query = query.eq('appointment_id', dto.appointmentId);
if (dto.installmentNumber)      query = query.eq('installment_number', dto.installmentNumber);
```

`api/asaas-webhook.ts:1242-1250` passa **`providerPaymentId` e `groupId` juntos**, mais `installmentNumber: payload.payment?.installmentNumber || 1`. Como o `if/else if` dá precedência ao `providerPaymentId`, o `groupId` nunca é usado nesse caminho.

**Hipótese a validar (H1):** um estorno integral de uma cobrança 4x marca como `REFUNDED` apenas a parcela cujo `provider_payment_id` chegou no webhook, deixando as outras três em `PAID`.

**Hipótese alternativa (H2):** o Asaas emite um evento `PAYMENT_REFUNDED` por parcela, e as quatro chegam — caso em que o comportamento atual converge para o resultado correto por repetição, e o defeito é apenas de robustez, não de correção.

**H1 e H2 levam a correções diferentes.** Por isso o teste precede o código.

---

## 2. Regras de segurança do teste

| # | Regra |
|---|---|
| 1 | **Executar exclusivamente em Sandbox.** Confirmar `ASAAS_API_URL` apontando para o ambiente sandbox **antes** de começar. |
| 2 | **Nenhuma operação em produção.** Nenhum estorno real, nenhuma cobrança real. |
| 3 | **Não alterar secrets.** Nenhuma chave é rotacionada, criada ou impressa. |
| 4 | **Conta de teste dedicada.** Aluno e instrutor de teste; não reutilizar contas reais. |
| 5 | Se em qualquer momento houver dúvida sobre o ambiente, **PARAR** e pedir confirmação. |
| 6 | O webhook aponta para o ambiente onde o teste roda. Se apontar para produção, **PARAR** — eventos de sandbox escreveriam no banco de produção. |
| 7 | Registrar tudo: payloads crus, ids, timestamps. O valor do teste é a evidência. |

### Pré-condição bloqueante

**Antes de qualquer passo**, confirmar (somente leitura):

- [ ] `ASAAS_API_URL` do ambiente onde o teste roda = URL de **sandbox**
- [ ] A URL de webhook configurada no painel Asaas **sandbox** aponta para um ambiente que **não é** o banco de produção `ohftsqsxymtrclnpadam`
- [ ] Existe um instrutor de teste com subconta e `provider_wallet_id` preenchido (sem wallet, o split é silenciosamente removido — ver F5-05)

> ⚠️ **Se o webhook de sandbox apontar para a mesma URL de produção**, este teste escreve em `payment_installments`, `payment_settlements` e `transactions` de produção. Nesse caso, **PARAR** e resolver a separação de ambientes antes de executar.

---

## 3. Cenário

### Cenário A — cobrança parcelada 4x no cartão (obrigatório)

1. Criar uma compra de **combo de 4 aulas** pelo fluxo normal do app (`/api/create-booking-intent`), em sandbox, com `paymentMethod = CREDIT_CARD` e `installmentCount = 4`.
2. Pagar com cartão de teste do sandbox.
3. Aguardar os webhooks de confirmação/recebimento.
4. **Registrar o estado completo antes do estorno** (seção 4).
5. Solicitar **estorno integral** da cobrança pelo painel do Asaas sandbox.
6. Capturar **todos** os webhooks gerados.
7. **Registrar o estado completo depois do estorno**.

### Cenário B — estorno de UMA parcela (condicional)

Executar **apenas se** o painel do Asaas sandbox oferecer estorno de parcela individual. Se não oferecer, isso já é uma resposta: o modelo atual não precisa suportar refund parcial de parcela, o que confirma a hipótese do proprietário na Fase 4.

### Cenário C — controle: cobrança 1x (obrigatório)

Mesma sequência com `installmentCount = 1`. Serve de linha de base: é o caso em que o código atual comprovadamente funciona.

---

## 4. Dados que precisam ser observados

### 4.1 No Asaas — na criação da cobrança

| Campo | Por que importa |
|---|---|
| `id` da cobrança-mãe | É o mesmo que o `id` da parcela 1? |
| `installment` | Identificador do **carnê**. É este que agrupa as 4 parcelas? |
| `id` de cada uma das 4 parcelas | Confirma se são distintos (esperado: sim) |
| `installmentNumber` de cada parcela | 1..4 |
| `externalReference` | Qual valor o app envia e se é o mesmo nas 4 parcelas |
| `split` de cada parcela | Como o `totalFixedValue` foi repartido (ver §6) |
| `value` / `netValue` de cada parcela | Tarifa real por parcela |

Consulta (somente leitura, sandbox):

```
GET {ASAAS_API_URL}/payments?installment={installmentId}
GET {ASAAS_API_URL}/installments/{installmentId}
```

### 4.2 No banco — antes e depois

```sql
-- Estado das parcelas
SELECT installment_number, provider_payment_id, group_id, status,
       gross_amount, net_amount, platform_fee, fee_amount, appointment_id
  FROM payment_installments
 WHERE group_id = '<GROUP_ID_DO_TESTE>'
 ORDER BY installment_number;

-- Liquidações
SELECT settlement_type, provider_payment_id, provider_settlement_id,
       gross_amount, net_amount, platform_fee, fee_amount, installment_id
  FROM payment_settlements
 WHERE provider_payment_id IN (SELECT provider_payment_id
                                 FROM payment_installments
                                WHERE group_id = '<GROUP_ID_DO_TESTE>');

-- Ledger de eventos do webhook
SELECT provider_event_id, type, processing_status, reason_code,
       provider_payment_id, created_at
  FROM transactions
 WHERE type = 'webhook_event'
   AND created_at > '<T0>'
 ORDER BY created_at;

-- Operações de estorno
SELECT id, scope, status, version, attempt_count, requested_amount_cents,
       completed_amount_cents, sent_at, lease_until, metadata
  FROM refund_operations
 WHERE created_at > '<T0>';

-- Aulas do grupo
SELECT id, status, payment_status, date, start_time
  FROM appointments
 WHERE group_id = '<GROUP_ID_DO_TESTE>'
 ORDER BY date, start_time;
```

### 4.3 Nos webhooks — capturar o payload cru de cada evento

Para **cada** evento recebido após o estorno, registrar:

| Campo | Pergunta que responde |
|---|---|
| `event` | Qual tipo: `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_REFUND_IN_PROGRESS`? |
| `payment.id` | Qual parcela este evento identifica? |
| `payment.installment` | Vem preenchido? É o id do carnê? |
| **`payment.installmentNumber`** | **Vem preenchido? Qual valor?** ← decide a correção |
| `payment.value` / `netValue` | Valores da parcela ou do total? |
| `payment.refunds[]` | Quantos, com que valores e status |
| `payment.status` | `REFUNDED` / `REFUND_REQUESTED` / outro |
| Quantidade total de eventos | **1 para o carnê, ou 4 (um por parcela)?** ← decide a correção |

> O corpo cru já é persistido em `transactions.raw_payload` (`api/asaas-webhook.ts:282`). Após o teste, extrair de lá — não depender de logs voláteis.

---

## 5. Resultado esperado × resultado real

Preencher durante a execução. A coluna **Real** é o produto do teste.

### 5.1 Cenário A — estorno integral de 4x

| # | Observação | Esperado se **H1** | Esperado se **H2** | Real |
|---|---|---|---|---|
| A1 | `provider_payment_id` distintos por parcela | 4 distintos | 4 distintos | |
| A2 | Nº de eventos `PAYMENT_REFUNDED` recebidos | **1** | **4** | |
| A3 | `payment.installmentNumber` no evento | ausente ou 1 | 1,2,3,4 | |
| A4 | Parcelas em `REFUNDED` após o estorno | **1 de 4** ❌ | **4 de 4** ✅ | |
| A5 | Parcelas restantes em `PAID` | 3 | 0 | |
| A6 | Linhas em `payment_settlements` type=`REFUND` | 1 | 4 | |
| A7 | `refund_operations.status` final | — | `COMPLETED` | |
| A8 | `appointments.payment_status` das 4 aulas | divergente | `refunded` nas 4 | |

### 5.2 Cenário C — controle 1x

| # | Observação | Esperado | Real |
|---|---|---|---|
| C1 | Nº de eventos `PAYMENT_REFUNDED` | 1 | |
| C2 | Parcela em `REFUNDED` | 1 de 1 ✅ | |
| C3 | Settlement de `REFUND` criado | 1 | |

### 5.3 Cenário B — estorno de parcela (se disponível)

| # | Observação | Esperado | Real |
|---|---|---|---|
| B1 | O painel permite estornar parcela individual? | — | |
| B2 | Evento gerado | `PAYMENT_PARTIALLY_REFUNDED`? | |
| B3 | Efeito em `payment_installments` | nenhum (early-return em `asaas-webhook.ts:1226-1240`) | |

---

## 6. Pergunta secundária a aproveitar no mesmo teste

O `MASTER-CORRECTION-PLAN` registra como **NÃO VERIFICADO** o rateio do split entre parcelas: `lib/payments/AsaasProvider.ts:396` envia `totalFixedValue` para cobranças parceladas, e o repositório assume que o Asaas divide corretamente.

Como o Cenário A já cria uma cobrança 4x com split, **registrar também**:

| Observação | Por quê |
|---|---|
| `split` retornado em cada uma das 4 parcelas | Confirma como o `totalFixedValue` foi repartido |
| Soma dos `fixedValue` das 4 parcelas | Deve igualar `service_price − comissão` (90%) |
| O que acontece quando `totalFixedValue` não é divisível por 4 | Onde cai o centavo residual |

Isso fecha um NÃO VERIFICADO sem custo adicional.

---

## 7. Como o resultado vira correção

| Resultado | Leitura | Correção que se torna correta |
|---|---|---|
| **H1 confirmada** (1 evento, 1 parcela marcada) | Defeito real e explorável | Em `api/asaas-webhook.ts:1242-1250`, deixar de passar `providerPaymentId` e `installmentNumber` em estorno integral e passar apenas `groupId`, de modo que as 4 parcelas sejam atingidas. Reescrever as fixtures de `InstallmentFullRefundFase3114` com o formato real (um `provider_payment_id` por parcela). |
| **H2 confirmada** (4 eventos, 4 parcelas) | Converge por repetição | O `installmentNumber` é redundante e deve sair por higiene (F4-02), mas não há defeito funcional. Ainda assim, corrigir as fixtures do teste, que descrevem um formato de dados inexistente. |
| **Resultado misto** | Comportamento depende de método/situação | **PARAR.** Não corrigir. Registrar como novo conflito e reavaliar o escopo da Fase 4. |

Em **nenhum** dos casos o código é alterado antes de o resultado estar registrado neste documento.

---

## 8. Checklist de execução

- [ ] Pré-condições da seção 2 confirmadas, incluindo a separação de webhook
- [ ] Autorização explícita do proprietário para executar
- [ ] `T0` registrado (timestamp de início)
- [ ] Cenário C (controle 1x) executado e registrado
- [ ] Cenário A (4x) executado — estado ANTES registrado
- [ ] Estorno integral solicitado no painel sandbox
- [ ] Todos os webhooks capturados de `transactions.raw_payload`
- [ ] Estado DEPOIS registrado
- [ ] Cenário B avaliado (ou registrado como indisponível)
- [ ] Observações de split (seção 6) registradas
- [ ] Tabelas 5.1 / 5.2 / 5.3 preenchidas na coluna **Real**
- [ ] Veredito H1 / H2 / misto registrado
- [ ] **Só então** propor a alteração de código

---

**NADA DESTE PROTOCOLO FOI EXECUTADO.** Aguardando confirmação do ambiente sandbox e autorização explícita.
