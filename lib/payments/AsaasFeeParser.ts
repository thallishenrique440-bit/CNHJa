/**
 * P-1.16B — Extracao das tarifas oficiais de GET /v3/myAccount/fees.
 *
 * REGRA CENTRAL: so e' sincronizada a faixa cujos DOIS componentes
 * (percentual e fixo) puderem ser extraidos de forma inequivoca do JSON.
 * Nada e' inferido, nada e' fabricado, nada e' copiado do painel.
 * Faixa nao extraida => permanece sob gestao manual, com o motivo registrado.
 *
 * Sem imports: modulo puro, testavel com respostas mockadas.
 */

export interface ParsedFeeRange {
  method: 'PIX' | 'CREDIT_CARD';
  installmentFrom: number;
  installmentTo: number;
  percent: number;
  fixedCents: number;
  /** Caminhos do JSON que originaram cada componente (auditoria). */
  evidence: { percent: string; fixed: string };
}

export interface UnmappedFeeRange {
  method: 'PIX' | 'CREDIT_CARD';
  installmentFrom: number;
  installmentTo: number;
  reason: string;
}

export interface ParseAsaasFeesResult {
  ranges: ParsedFeeRange[];
  unmapped: UnmappedFeeRange[];
}

/**
 * Banda de sanidade para um componente fixo, em centavos.
 * Um valor fora dela indica que o campo nao e' o que supomos (ou mudou de
 * escala). Nesse caso a faixa e' recusada em vez de gravar numero errado.
 */
const MIN_FIXED_CENTS = 0;
const MAX_FIXED_CENTS = 5000; // R$50,00
const MAX_PERCENT = 30;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Converte um valor monetario da API Asaas para centavos.
 *
 * A API do Asaas expressa dinheiro em reais decimais (ex.: payment.value =
 * 101.49), portanto a conversao e' sempre x100. NAO ha heuristica de escala:
 * adivinhar se "1.99" sao reais ou centavos produziria tarifa errada em
 * silencio. Valores fora da banda de sanidade sao recusados.
 */
function brlToCents(v: number): number | null {
  const cents = Math.round(v * 100);
  if (!Number.isFinite(cents) || cents < MIN_FIXED_CENTS || cents > MAX_FIXED_CENTS) return null;
  return cents;
}

/** Procura um numero em varios caminhos possiveis; devolve o valor e o caminho. */
function pick(root: any, paths: string[][]): { value: number; path: string } | null {
  for (const path of paths) {
    let cur: any = root;
    let ok = true;
    for (const key of path) {
      if (cur === null || cur === undefined || typeof cur !== 'object') { ok = false; break; }
      cur = cur[key];
    }
    if (!ok) continue;
    const n = num(cur);
    if (n !== undefined) return { value: n, path: path.join('.') };
  }
  return null;
}

// Caminhos ja praticados pelo parser anterior (P-1.16A), preservados.
const PIX_FIXED_PATHS = [
  ['pix', 'fixedFee'],
  ['pix', 'fee'],
  ['paymentMethods', 'pix', 'fixedFee'],
  ['paymentMethods', 'pix', 'fixedValue'],
  ['pixFee']
];
const PIX_PERCENT_PATHS = [
  ['pix', 'percentualFee'],
  ['pix', 'percentageFee'],
  ['paymentMethods', 'pix', 'percentualFee'],
  ['paymentMethods', 'pix', 'percentageFee']
];
const CARD_1X_PERCENT_PATHS = [
  ['card', 'creditCard', 'fee'],
  ['paymentMethods', 'creditCard', 'fee'],
  ['paymentMethods', 'creditCard', 'percentageFee'],
  ['creditCardFee']
];
const CARD_1X_FIXED_PATHS = [
  ['card', 'creditCard', 'fixedFee'],
  ['card', 'creditCard', 'operationValue'],
  ['paymentMethods', 'creditCard', 'fixedFee'],
  ['paymentMethods', 'creditCard', 'operationValue']
];

export function parseAsaasFees(asaasData: any): ParseAsaasFeesResult {
  const ranges: ParsedFeeRange[] = [];
  const unmapped: UnmappedFeeRange[] = [];

  if (!asaasData || typeof asaasData !== 'object') {
    return {
      ranges: [],
      unmapped: [
        { method: 'PIX', installmentFrom: 1, installmentTo: 1, reason: 'Resposta do Asaas vazia ou nao-objeto' },
        { method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, reason: 'Resposta do Asaas vazia ou nao-objeto' }
      ]
    };
  }

  // ---- PIX ----------------------------------------------------------------
  const pixFixed = pick(asaasData, PIX_FIXED_PATHS);
  const pixPercent = pick(asaasData, PIX_PERCENT_PATHS);

  if (!pixFixed) {
    unmapped.push({ method: 'PIX', installmentFrom: 1, installmentTo: 1, reason: 'Componente fixo do PIX nao encontrado na resposta' });
  } else if (pixPercent && pixPercent.value !== 0) {
    // A conta passou a ter PIX percentual: o modelo atual assume tarifa
    // puramente fixa. Recusar em vez de gravar so' o fixo e perder o percentual.
    unmapped.push({
      method: 'PIX', installmentFrom: 1, installmentTo: 1,
      reason: `Resposta traz percentual de PIX (${pixPercent.path}=${pixPercent.value}); revisao manual necessaria`
    });
  } else {
    const cents = brlToCents(pixFixed.value);
    if (cents === null) {
      unmapped.push({
        method: 'PIX', installmentFrom: 1, installmentTo: 1,
        reason: `Valor fixo do PIX fora da banda de sanidade (${pixFixed.path}=${pixFixed.value})`
      });
    } else {
      // percent = 0 nao e' inferencia de campo ausente: e' a definicao de uma
      // tarifa puramente fixa, e so' se aplica porque a resposta NAO trouxe
      // percentual de PIX (verificado acima).
      ranges.push({
        method: 'PIX', installmentFrom: 1, installmentTo: 1,
        percent: 0, fixedCents: cents,
        evidence: { percent: pixPercent ? pixPercent.path : 'ausente (tarifa puramente fixa)', fixed: pixFixed.path }
      });
    }
  }

  // ---- CARTAO 1x ----------------------------------------------------------
  const cardPercent = pick(asaasData, CARD_1X_PERCENT_PATHS);
  const cardFixed = pick(asaasData, CARD_1X_FIXED_PATHS);

  if (!cardPercent && !cardFixed) {
    unmapped.push({ method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, reason: 'Nem percentual nem fixo do cartao 1x encontrados na resposta' });
  } else if (!cardPercent) {
    unmapped.push({ method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, reason: 'Percentual do cartao 1x nao encontrado; fixo sozinho nao define a tarifa' });
  } else if (!cardFixed) {
    // Caso real observado: a resposta traz o percentual mas nao o componente
    // fixo (R$0,49 no painel). Gravar so' o percentual zeraria o fixo.
    unmapped.push({ method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, reason: 'Componente fixo do cartao 1x nao encontrado na resposta; faixa mantida manual para nao zerar o fixo vigente' });
  } else if (cardPercent.value < 0 || cardPercent.value > MAX_PERCENT) {
    unmapped.push({ method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, reason: `Percentual do cartao fora da banda de sanidade (${cardPercent.path}=${cardPercent.value})` });
  } else {
    const cents = brlToCents(cardFixed.value);
    if (cents === null) {
      unmapped.push({ method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, reason: `Valor fixo do cartao fora da banda de sanidade (${cardFixed.path}=${cardFixed.value})` });
    } else {
      ranges.push({
        method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1,
        percent: cardPercent.value, fixedCents: cents,
        evidence: { percent: cardPercent.path, fixed: cardFixed.path }
      });
    }
  }

  // ---- CARTAO PARCELADO ---------------------------------------------------
  // As faixas 2x-6x, 7x-12x e 13x-21x nao tem representacao conhecida em
  // /myAccount/fees. Nao ha caminho de JSON confirmado, portanto nao ha o que
  // extrair: permanecem manuais. NAO inventar campo nem copiar o painel.
  for (const [from, to] of [[2, 6], [7, 12], [13, 21]] as Array<[number, number]>) {
    unmapped.push({
      method: 'CREDIT_CARD', installmentFrom: from, installmentTo: to,
      reason: 'Faixa de parcelamento sem campo confirmado em /myAccount/fees; gestao manual'
    });
  }

  return { ranges, unmapped };
}
