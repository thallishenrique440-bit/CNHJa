/**
 * RefundConfirmation — mecanismo UNICO de interpretacao do estado de um estorno
 * a partir do objeto de pagamento do Asaas.
 *
 * Usado pelos tres caminhos que observam o gateway:
 *   - resposta do `POST /payments/{id}/refund` (BookingCancellationCore);
 *   - payload dos webhooks de estorno (api/asaas-webhook.ts);
 *   - `GET /payments/{id}` da reconciliacao (sync-payment-status).
 *
 * POR QUE POR OPERACAO, E NAO PELO STATUS DO PAGAMENTO
 *   A regra financeira do produto devolve ao aluno SOMENTE o valor do servico;
 *   a taxa do Asaas nao e' devolvida. Como o aluno pagou servico + taxa, TODO
 *   estorno feito pelo app e' PARCIAL para o Asaas (o pagamento pode ficar
 *   PARTIALLY_REFUNDED, ou mesmo RECEIVED, com um item em `refunds[]`). Por isso
 *   a conclusao de uma operacao e' decidida casando o ITEM de estorno com o
 *   valor pedido pela operacao — nunca pelo HTTP 2xx, e nunca exigindo
 *   `status === 'REFUNDED'` do pagamento.
 *
 * O `id` devolvido no corpo do POST e' o do PAGAMENTO (`pay_...`). Ele NUNCA e'
 * usado como id do estorno.
 *
 * Modulo puro: sem I/O, sem Deno, sem Node. Gerado para `_shared/`.
 */

export type RefundOutcome = 'COMPLETED' | 'PENDING' | 'DENIED' | 'UNKNOWN' | 'NONE';

export interface RefundInterpretation {
  outcome: RefundOutcome;
  /** status do pagamento no Asaas (ex.: RECEIVED, PARTIALLY_REFUNDED, REFUNDED) */
  asaasPaymentStatus: string | null;
  /** status do item de estorno casado (ex.: DONE, PENDING, CANCELLED) */
  refundItemStatus: string | null;
  /** id do ESTORNO, se o Asaas o fornecer; nunca o id do pagamento */
  providerRefundId: string | null;
  endToEndIdentifier: string | null;
  matchedAmountCents: number | null;
  /** codigo da decisao, para auditoria */
  decision: string;
}

const DONE = ['DONE', 'REFUNDED', 'COMPLETED'];
const PENDING = [
  'PENDING', 'IN_PROGRESS', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'WAITING_AUTHORIZATION',
  'AWAITING_CRITICAL_ACTION_AUTHORIZATION', 'AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION'
];
const DENIED = ['CANCELLED', 'CANCELED', 'DENIED', 'REFUND_DENIED', 'FAILED', 'REJECTED'];
const PAID_NO_REFUND = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

const toCents = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

const upper = (v: unknown): string => String(v ?? '').trim().toUpperCase();

/** Id de estorno plausivel: string, diferente do pagamento e sem prefixo de pagamento. */
function refundIdOf(item: any, paymentId: string | null | undefined): string | null {
  const id = item && typeof item.id === 'string' ? item.id.trim() : '';
  if (!id) return null;
  if (paymentId && id === paymentId) return null;
  if (id.startsWith('pay_')) return null;
  return id;
}

function classify(status: string): RefundOutcome {
  if (DONE.includes(status)) return 'COMPLETED';
  if (PENDING.includes(status)) return 'PENDING';
  if (DENIED.includes(status)) return 'DENIED';
  return 'UNKNOWN';
}

const RANK: Record<RefundOutcome, number> = { COMPLETED: 3, PENDING: 2, DENIED: 1, UNKNOWN: 0, NONE: 0 };

export interface InterpretOptions {
  paymentId: string | null | undefined;
  requestedAmountCents: number;
  /** ids de estorno ja' atribuidos a OUTRAS operacoes do mesmo pagamento */
  excludeProviderRefundIds?: string[];
  /** id de estorno ja' conhecido desta operacao (casa por id antes de valor) */
  knownProviderRefundId?: string | null;
}

/**
 * Interpreta o objeto de pagamento do Asaas para UMA operacao de estorno.
 * Nunca infere conclusao de HTTP 2xx; ausencia de informacao => UNKNOWN.
 */
export function interpretRefundState(payment: any, opts: InterpretOptions): RefundInterpretation {
  const base = {
    asaasPaymentStatus: null as string | null,
    refundItemStatus: null as string | null,
    providerRefundId: null as string | null,
    endToEndIdentifier: null as string | null,
    matchedAmountCents: null as number | null
  };

  if (!payment || typeof payment !== 'object') {
    return { ...base, outcome: 'UNKNOWN', decision: 'no_payment_object' };
  }

  const paymentStatus = upper(payment.status) || null;
  base.asaasPaymentStatus = paymentStatus;
  const exclude = new Set((opts.excludeProviderRefundIds || []).filter(Boolean));
  const rawRefunds = payment.refunds;
  const refunds: any[] = Array.isArray(rawRefunds) ? rawRefunds.filter((r) => r && typeof r === 'object') : [];

  // 1. Casa por id conhecido da operacao; senao, por valor igual ao pedido.
  let candidates = opts.knownProviderRefundId
    ? refunds.filter((r) => refundIdOf(r, opts.paymentId) === opts.knownProviderRefundId)
    : [];
  if (candidates.length === 0) {
    candidates = refunds.filter((r) => {
      const id = refundIdOf(r, opts.paymentId);
      if (id && exclude.has(id)) return false;
      return toCents(r.value) === opts.requestedAmountCents;
    });
  }

  if (candidates.length > 0) {
    // Preferencia: concluido > pendente > recusado; empate -> o mais recente.
    const best = candidates
      .map((r) => ({ r, outcome: classify(upper(r.status)), at: Date.parse(r.dateCreated || r.effectiveDate || '') || 0 }))
      .sort((a, b) => RANK[b.outcome] - RANK[a.outcome] || b.at - a.at)[0];
    return {
      outcome: best.outcome,
      asaasPaymentStatus: paymentStatus,
      refundItemStatus: upper(best.r.status) || null,
      providerRefundId: refundIdOf(best.r, opts.paymentId),
      endToEndIdentifier: typeof best.r.endToEndIdentifier === 'string' ? best.r.endToEndIdentifier : null,
      matchedAmountCents: toCents(best.r.value),
      decision: best.outcome === 'UNKNOWN' ? 'refund_item_status_unrecognized' : 'refund_item_matched'
    };
  }

  // 2. Sem item casado: so' o status do pagamento.
  const paymentValueCents = toCents(payment.value);
  if (paymentStatus === 'REFUNDED' && refunds.length === 0 && paymentValueCents !== null
      && opts.requestedAmountCents >= paymentValueCents) {
    // Estorno integral sem detalhamento (so' possivel se o pedido cobre o total).
    return { ...base, outcome: 'COMPLETED', matchedAmountCents: opts.requestedAmountCents, decision: 'payment_fully_refunded' };
  }
  if (paymentStatus === 'REFUND_REQUESTED' || paymentStatus === 'REFUND_IN_PROGRESS') {
    return { ...base, outcome: 'PENDING', decision: 'payment_refund_in_progress' };
  }
  if (Array.isArray(rawRefunds) && refunds.length === 0 && paymentStatus && PAID_NO_REFUND.includes(paymentStatus)) {
    // Afirmacao POSITIVA do gateway: pagamento recebido e lista de estornos vazia.
    return { ...base, outcome: 'NONE', decision: 'no_refund_on_gateway' };
  }
  if (refunds.length > 0) {
    return { ...base, outcome: 'UNKNOWN', decision: 'no_refund_item_for_requested_amount' };
  }
  return { ...base, outcome: 'UNKNOWN', decision: 'insufficient_refund_information' };
}

/**
 * Motivo de recusa seguro para persistir: extrai `errors[].description` quando
 * o corpo e' JSON, remove sequencias que parecem documento/telefone e e-mails,
 * e limita o tamanho. Nunca persiste o corpo cru.
 */
export function sanitizeProviderMessage(raw: unknown, max = 300): string | null {
  if (raw === null || raw === undefined) return null;
  let text = typeof raw === 'string' ? raw : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.errors)) {
      const d = parsed.errors.map((e: any) => [e?.code, e?.description].filter(Boolean).join(': ')).filter(Boolean).join(' | ');
      if (d) text = d;
    } else if (parsed && typeof parsed.message === 'string') {
      text = parsed.message;
    }
  } catch { /* texto simples */ }
  const cleaned = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\d[\d.\-/ ]{9,}\d/g, '[num]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
