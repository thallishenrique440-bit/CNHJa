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
  /** P-1.18E: taxa REAL que o Asaas cobrara sobre studentChargeCents. */
  gatewayFeeChargedCents: number;
  /** P-1.18E: gatewayFeeExpectedCents - gatewayFeeChargedCents. >= 0. */
  surplusCents: number;
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

/** Divisao inteira exata para operandos nao negativos, sem passar por divisao
 *  fracionaria. Usada em todo o calculo de taxa para que nenhum resultado
 *  dependa de ponto flutuante. */
function idiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/**
 * P-1.18E — conversao de unidade da faixa.
 *
 * `percent` chega como numero fracionario (2.99) porque e' assim que vem do
 * banco e da API do Asaas. E' convertido UMA unica vez para centesimos de ponto
 * percentual (299); dai em diante toda a aritmetica da taxa e' inteira.
 */
export function rulePercentHundredths(rule: GatewayFeeRule | null): number {
  if (!rule) return 0;
  return Math.max(0, Math.round((Number(rule.percent) || 0) * 100));
}

/** Componente fixo da faixa, em centavos inteiros. */
export function ruleFixedCents(rule: GatewayFeeRule | null): number {
  if (!rule) return 0;
  return Math.max(0, Math.round(Number(rule.fixedCents) || 0));
}

/**
 * P-1.18E — TAXA REAL cobrada pelo Asaas sobre um total ja' formado.
 *
 * Modelo derivado na P-1.18D (secoes 3 a 5) e conferido contra quatro
 * evidencias reais, parcela a parcela:
 *
 *   base  = SC // n
 *   v_i   = base                (i < n)        v_n = SC - base*(n-1)
 *   fee_i = (v_i * P) // 10000 + (F // n)
 *   taxa  = soma dos fee_i
 *
 * O percentual incide sobre CADA PARCELA, e o componente fixo e' rateado entre
 * as parcelas com truncamento (o resto simplesmente nao e' cobrado).
 *
 * NAO substituir por (SC*P)//10000 + F: a diferenca chega a n centavos.
 * Evidencia: 4x de 21498 a 3,49%+49 custa 796, e nao 799 (P-1.18D secao 5).
 *
 * Evidencias reproduzidas exatamente:
 *   (10149, 1, PIX 0%+199)        -> 199
 *   (13519, 1, 2,99%+49)          -> 453
 *   (21498, 4, 3,49%+49)          -> 796
 *   (20747, 4, 3,49%+49)          -> 769
 */
export function gatewayFeeRealCents(
  studentChargeCents: number,
  installmentCount: number,
  rule: GatewayFeeRule | null
): number {
  if (!rule) return 0;
  const total = Math.max(0, Math.trunc(Number(studentChargeCents) || 0));
  const n = Math.max(1, Math.trunc(Number(installmentCount) || 1));
  const percentHundredths = rulePercentHundredths(rule);
  const fixedPerInstallment = idiv(ruleFixedCents(rule), n);
  const base = idiv(total, n);

  let fee = 0;
  for (let i = 1; i <= n; i++) {
    const value = i < n ? base : total - base * (n - 1);
    fee += idiv(value * percentHundredths, 10000) + fixedPerInstallment;
  }
  return fee;
}

/**
 * P-1.18E — MENOR total a cobrar do aluno que recupera service_price integral.
 *
 * Devolve o menor SC inteiro tal que
 *
 *   SC - gatewayFeeRealCents(SC, n, rule) >= service_price
 *
 * Algoritmo da P-1.18D secao 7:
 *   1. candidato de forma fechada  SC = ((SP + n*(F//n)) * 10000) // (10000 - P)
 *      — verificado exaustivamente (~1,2 milhao de casos) como sempre suficiente;
 *   2. descida de no maximo n centavos ate o minimo verdadeiro;
 *   3. subida de seguranca, caso o candidato nao satisfaca.
 *
 * BUSCA BINARIA E' PROIBIDA AQUI. g(SC) = SC - taxa(SC) NAO e' monotonica para
 * n >= 3: g(20747) = 19978 mas g(20748) = 19976 (P-1.18D secao 8c). Este
 * algoritmo nunca assume monotonicidade — parte de um ponto provadamente valido
 * e caminha um centavo por vez, verificando a condicao a cada passo.
 */
export function minimumStudentChargeCents(
  servicePriceCents: number,
  installmentCount: number,
  rule: GatewayFeeRule | null
): number {
  const servicePrice = Math.max(0, Math.trunc(Number(servicePriceCents) || 0));
  if (!rule) return servicePrice;

  const n = Math.max(1, Math.trunc(Number(installmentCount) || 1));
  const percentHundredths = rulePercentHundredths(rule);
  const fixedCharged = n * idiv(ruleFixedCents(rule), n);
  const denominator = 10000 - percentHundredths;

  // Faixa com percentual >= 100% e' invalida (o sync limita a 30% e o schedule
  // embutido vai ate 4,29%). Sem denominador positivo nao ha gross-up possivel:
  // devolve o service_price e deixa a decisao com o chamador, que e' fail-closed.
  if (denominator <= 0) return servicePrice;

  const candidate = idiv((servicePrice + fixedCharged) * 10000, denominator);

  // 2. descida em JANELA FIXA, guardando o MENOR valor valido.
  //
  // Correcao P-1.18E sobre o pseudocodigo da P-1.18D secao 7: um laco
  // "while (o anterior ainda satisfaz)" para no primeiro centavo invalido, e
  // como g(SC) nao e' monotonica isso pode deixar para tras um SC menor e
  // valido. Exemplo real: SP = 19978 em 4x — o candidato e' 20750, 20749 NAO
  // satisfaz, mas 20747 satisfaz e e' o minimo. A janela percorre todos os
  // passos e fica com o menor que satisfaz.
  //
  // Largura da janela: o excesso do candidato sobre o minimo verdadeiro e' no
  // maximo n (medido em varredura independente, SP de 100 a 200000, n de 1 a 6).
  // n + 2 e' margem.
  let charge = candidate;
  for (let step = 1; step <= n + 2; step++) {
    const lower = candidate - step;
    if (lower < servicePrice) break;
    if (lower - gatewayFeeRealCents(lower, n, rule) >= servicePrice) charge = lower;
  }

  // 3. subida de seguranca — nao observada em nenhum caso, mantida por prudencia.
  // O limite de passos evita laco infinito diante de uma faixa corrompida.
  let guard = 0;
  while (charge - gatewayFeeRealCents(charge, n, rule) < servicePrice && guard < 10000) {
    charge += 1;
    guard += 1;
  }

  return charge;
}

/**
 * gateway_fee_expected = student_charge - service_price
 *
 * P-1.18E: deixou de ser "percentual sobre o service_price mais o fixo". Agora
 * e' a diferenca exata necessaria para que, DEPOIS da taxa real do Asaas, reste
 * exatamente o service_price. `installmentCount` e' obrigatorio no cartao — a
 * taxa de 1x nao vale para o parcelado.
 */
export function calculateGatewayFeeCents(
  servicePriceCents: number,
  rule: GatewayFeeRule | null,
  installmentCount: number = 1
): number {
  if (!rule) return 0;
  const servicePrice = Math.max(0, Math.trunc(Number(servicePriceCents) || 0));
  return minimumStudentChargeCents(servicePrice, installmentCount, rule) - servicePrice;
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

  // P-1.18E — o total cobrado e' o MINIMO que recupera o service_price integral
  // apos a taxa real. A tarifa esperada e' a diferenca, nunca um segundo calculo
  // independente: assim a identidade student_charge - fee = service_price vale
  // por construcao, e nao por coincidencia de arredondamento.
  const studentChargeCents = minimumStudentChargeCents(servicePriceCents, installmentCount, rule);
  const gatewayFeeExpectedCents = studentChargeCents - servicePriceCents;
  const gatewayFeeChargedCents = gatewayFeeRealCents(studentChargeCents, installmentCount, rule);

  return {
    servicePriceCents,
    gatewayFeeExpectedCents,
    studentChargeCents,
    gatewayFeeChargedCents,
    // Sobra de arredondamento: o que sobra depois de o Asaas descontar a taxa
    // real. Sempre >= 0 e, nos casos medidos, <= 1 centavo. Nao sai do
    // instrutor, que recebe 90% do service_price via totalFixedValue.
    surplusCents: gatewayFeeExpectedCents - gatewayFeeChargedCents,
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
