/**
 * P-1.16A — Modelo canonico de tarifa de gateway (Asaas).
 *
 * CONTRATO (P-1.15 / P-1.15.1):
 *   service_price          = preco definido pelo instrutor. NUNCA contem tarifa.
 *   gateway_fee_expected   = custo de processamento do metodo escolhido, no checkout.
 *   student_charge         = service_price + gateway_fee_expected.
 *
 * A tarifa NUNCA altera appointments.price.
 *
 * ESTE ARQUIVO NAO POSSUI IMPORTS. E' proposital: e' consumido tanto pelo
 * backend (api/, via extensao .js) quanto pelo bundle do browser (pages/, sem
 * extensao). Manter sem dependencias garante que frontend e backend calculem
 * exatamente o mesmo valor. Nao adicionar imports aqui.
 */

export type PaymentMethod = 'PIX' | 'CREDIT_CARD' | 'BOLETO';

/** Uma faixa de tarifa vigente. Espelha public.gateway_fee_schedule. */
export interface GatewayFeeRule {
  id: string | null;
  provider: string;
  method: string;
  /** Faixa de parcelamento coberta, inclusiva nos dois extremos. PIX usa 1..1. */
  installmentFrom: number;
  installmentTo: number;
  /** Percentual sobre o service_price, em pontos percentuais. Ex.: 2.99 */
  percent: number;
  /** Componente fixo por cobranca, em centavos. Ex.: 49 */
  fixedCents: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
}

export interface GatewayFeeQuote {
  servicePriceCents: number;
  gatewayFeeExpectedCents: number;
  studentChargeCents: number;
  method: string;
  installmentCount: number;
  /** null quando nenhuma faixa cobre a combinacao pedida. */
  rule: GatewayFeeRule | null;
  /** true quando a cotacao veio do schedule embutido, nao do banco. */
  usedFallback: boolean;
}

export const DEFAULT_FEE_PROVIDER = 'asaas';

/** Nome da tabela e lista de colunas. Compartilhados por backend e frontend
 *  para que os dois leiam exatamente o mesmo contrato de dados. */
export const GATEWAY_FEE_TABLE = 'gateway_fee_schedule';
export const GATEWAY_FEE_SELECT =
  'id, provider, method, installment_from, installment_to, percent, fixed_cents, effective_from, effective_to, source';

/**
 * Schedule embutido. FONTE UNICA de fallback para backend e frontend.
 *
 * Valores conforme o painel da conta Asaas Sandbox observado em 2026-09-18
 * (evidencia registrada na P-1.16A). Nao duplicar estes numeros em nenhum
 * outro arquivo: quem precisar deles importa esta constante.
 *
 * Em producao o banco (gateway_fee_schedule) e' a fonte de verdade; este
 * schedule so entra em cena se a leitura falhar, e nunca zera a tarifa.
 */
export const DEFAULT_GATEWAY_FEE_SCHEDULE: GatewayFeeRule[] = [
  { id: null, provider: 'asaas', method: 'PIX',         installmentFrom: 1,  installmentTo: 1,  percent: 0,    fixedCents: 199, effectiveFrom: '1970-01-01T00:00:00.000Z', effectiveTo: null, source: 'builtin' },
  { id: null, provider: 'asaas', method: 'CREDIT_CARD', installmentFrom: 1,  installmentTo: 1,  percent: 2.99, fixedCents: 49,  effectiveFrom: '1970-01-01T00:00:00.000Z', effectiveTo: null, source: 'builtin' },
  { id: null, provider: 'asaas', method: 'CREDIT_CARD', installmentFrom: 2,  installmentTo: 6,  percent: 3.49, fixedCents: 49,  effectiveFrom: '1970-01-01T00:00:00.000Z', effectiveTo: null, source: 'builtin' },
  { id: null, provider: 'asaas', method: 'CREDIT_CARD', installmentFrom: 7,  installmentTo: 12, percent: 3.99, fixedCents: 49,  effectiveFrom: '1970-01-01T00:00:00.000Z', effectiveTo: null, source: 'builtin' },
  { id: null, provider: 'asaas', method: 'CREDIT_CARD', installmentFrom: 13, installmentTo: 21, percent: 4.29, fixedCents: 49,  effectiveFrom: '1970-01-01T00:00:00.000Z', effectiveTo: null, source: 'builtin' }
];

/** Converte uma linha de public.gateway_fee_schedule no tipo de dominio. */
export function mapGatewayFeeRow(row: Record<string, any>): GatewayFeeRule {
  return {
    id: row.id ?? null,
    provider: String(row.provider ?? DEFAULT_FEE_PROVIDER),
    method: String(row.method ?? '').toUpperCase(),
    installmentFrom: Number(row.installment_from ?? 1),
    installmentTo: Number(row.installment_to ?? row.installment_from ?? 1),
    percent: Number(row.percent ?? 0),
    fixedCents: Number(row.fixed_cents ?? 0),
    effectiveFrom: String(row.effective_from ?? '1970-01-01T00:00:00.000Z'),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    source: String(row.source ?? 'manual')
  };
}

export function mapGatewayFeeRows(rows: Array<Record<string, any>> | null | undefined): GatewayFeeRule[] {
  if (!rows || rows.length === 0) return [];
  return rows.map(mapGatewayFeeRow);
}

function toTime(iso: string | null | undefined, fallback: number): number {
  if (!iso) return fallback;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? fallback : t;
}

/**
 * Parcelamento so existe no cartao. PIX e BOLETO sao cobranca unica, entao um
 * installmentCount > 1 vindo do cliente e' normalizado para 1 — caso contrario
 * a faixa PIX (1..1) nao resolveria e a cobranca seria recusada sem motivo.
 */
export function normalizeInstallmentCount(method: string, installmentCount: unknown): number {
  const n = Math.max(1, Math.trunc(Number(installmentCount) || 1));
  return String(method || '').toUpperCase() === 'CREDIT_CARD' ? n : 1;
}

export interface ResolveFeeRuleInput {
  method: string;
  installmentCount: number;
  provider?: string;
  /** Instante de referencia da vigencia. Default: agora. */
  at?: string | Date;
}

/**
 * Resolve a faixa vigente para (provider, method, installmentCount, data).
 *
 * Criterio de desempate, nesta ordem:
 *   1. vigencia mais recente (effective_from maior);
 *   2. faixa mais especifica (intervalo de parcelas mais estreito).
 * Assim, uma faixa nova publicada hoje substitui a antiga sem apagar historico,
 * e uma faixa dedicada a "4x" prevalece sobre uma faixa "2x-6x".
 */
export function resolveGatewayFeeRule(
  rules: GatewayFeeRule[],
  input: ResolveFeeRuleInput
): GatewayFeeRule | null {
  const provider = (input.provider || DEFAULT_FEE_PROVIDER).toLowerCase();
  const method = String(input.method || '').toUpperCase();
  const count = normalizeInstallmentCount(method, input.installmentCount);
  const atTime = input.at instanceof Date
    ? input.at.getTime()
    : toTime(typeof input.at === 'string' ? input.at : null, Date.now());

  const eligible = rules.filter(r =>
    String(r.provider || '').toLowerCase() === provider &&
    String(r.method || '').toUpperCase() === method &&
    count >= r.installmentFrom &&
    count <= r.installmentTo &&
    toTime(r.effectiveFrom, 0) <= atTime &&
    (r.effectiveTo === null || toTime(r.effectiveTo, Number.MAX_SAFE_INTEGER) > atTime)
  );

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const byEffective = toTime(b.effectiveFrom, 0) - toTime(a.effectiveFrom, 0);
    if (byEffective !== 0) return byEffective;
    return (a.installmentTo - a.installmentFrom) - (b.installmentTo - b.installmentFrom);
  });

  return eligible[0];
}

/**
 * gateway_fee_expected = round(service_price * percent / 100 + fixed)
 *
 * O calculo e' feito em aritmetica inteira ate a divisao final para que o
 * resultado nao dependa de erro de ponto flutuante. `percent` e' convertido
 * para centesimos de ponto percentual (2.99 -> 299).
 *
 * Exemplo do contrato: R$130,00 em 1x, 2,99% + R$0,49
 *   (13000 * 299 + 49 * 10000) / 10000 = 437.7 -> 438 centavos = R$4,38
 */
export function calculateGatewayFeeCents(servicePriceCents: number, rule: GatewayFeeRule | null): number {
  if (!rule) return 0;
  const base = Math.max(0, Math.round(Number(servicePriceCents) || 0));
  const percentHundredths = Math.round((Number(rule.percent) || 0) * 100);
  const fixed = Math.round(Number(rule.fixedCents) || 0);
  const totalScaled = base * percentHundredths + fixed * 10000;
  return Math.max(0, Math.round(totalScaled / 10000));
}

export interface QuoteCheckoutInput extends ResolveFeeRuleInput {
  servicePriceCents: number;
  /** Schedule lido do banco. Vazio ou ausente cai no schedule embutido. */
  rules?: GatewayFeeRule[] | null;
}

/**
 * Cotacao completa do checkout. Unico ponto onde student_charge e' formado.
 * Backend e frontend devem chamar esta funcao e nada mais.
 */
export function quoteCheckout(input: QuoteCheckoutInput): GatewayFeeQuote {
  const servicePriceCents = Math.max(0, Math.round(Number(input.servicePriceCents) || 0));
  const method = String(input.method || '').toUpperCase();
  const installmentCount = normalizeInstallmentCount(method, input.installmentCount);

  // P-1.16B — PRIORIDADE: schedule do banco > schedule embutido.
  //
  // O embutido e' protecao de bootstrap/emergencia: so' entra quando o banco
  // nao devolveu faixa NENHUMA (tabela vazia ou leitura falhou). Se o banco
  // respondeu mas nao cobre a combinacao pedida, a resposta correta e'
  // "sem faixa" (rule = null) — e o chamador recusa a compra. Cair no
  // embutido nesse caso mascararia indefinidamente uma falha de sincronizacao
  // ou uma faixa realmente inexistente.
  const provided = input.rules && input.rules.length > 0 ? input.rules : null;
  let rule = provided ? resolveGatewayFeeRule(provided, { ...input, method, installmentCount }) : null;
  let usedFallback = false;

  if (!rule && !provided) {
    rule = resolveGatewayFeeRule(DEFAULT_GATEWAY_FEE_SCHEDULE, {
      ...input,
      method,
      installmentCount,
      at: undefined
    });
    usedFallback = rule !== null;
  }

  const gatewayFeeExpectedCents = calculateGatewayFeeCents(servicePriceCents, rule);

  return {
    servicePriceCents,
    gatewayFeeExpectedCents,
    studentChargeCents: servicePriceCents + gatewayFeeExpectedCents,
    method,
    installmentCount,
    rule,
    usedFallback
  };
}

/**
 * Rateio canonico de um total por n parcelas: floor nas n-1 primeiras e o
 * resto integral na ultima. Mesma regra ja praticada por
 * InstallmentService.recordInitialSchedule; exposta aqui para que o frontend
 * exiba exatamente os mesmos valores que serao cobrados.
 */
export function splitIntoInstallments(totalCents: number, installmentCount: number): number[] {
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const n = Math.max(1, Math.trunc(Number(installmentCount) || 1));
  const base = Math.floor(total / n);
  const parts: number[] = [];
  let allocated = 0;
  for (let i = 1; i < n; i++) {
    parts.push(base);
    allocated += base;
  }
  parts.push(total - allocated);
  return parts;
}

/** Snapshot congelado da tarifa aplicada a uma compra (auditoria). */
export interface AppliedFeeSnapshot {
  feeRuleId: string | null;
  feePercentApplied: number;
  feeFixedCents: number;
  paymentMethod: string;
  installmentCount: number;
  feeSource: string;
  feeEffectiveFrom: string | null;
}

export function buildAppliedFeeSnapshot(quote: GatewayFeeQuote): AppliedFeeSnapshot {
  return {
    feeRuleId: quote.rule?.id ?? null,
    feePercentApplied: quote.rule ? Number(quote.rule.percent) : 0,
    feeFixedCents: quote.rule ? Math.round(Number(quote.rule.fixedCents)) : 0,
    paymentMethod: quote.method,
    installmentCount: quote.installmentCount,
    feeSource: quote.usedFallback ? 'builtin' : (quote.rule?.source ?? 'unknown'),
    feeEffectiveFrom: quote.rule?.effectiveFrom ?? null
  };
}
