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

// ---------------------------------------------------------------------------
// Caminhos do contrato DOCUMENTADO de GET /v3/myAccount/fees (P-1.16B.3).
// Toda tarifa de cobranca vive sob a chave raiz `payment`.
// Nao acrescentar caminho que nao esteja na documentacao do Asaas.
// ---------------------------------------------------------------------------
const PIX_FIXED_PATHS = [
  ['payment', 'pix', 'fixedFeeValue']
];
const PIX_PERCENT_PATHS = [
  ['payment', 'pix', 'percentageFee']
];

/** Componente fixo por transacao de cartao, comum a todas as faixas. */
const CARD_FIXED_PATHS = [
  ['payment', 'creditCard', 'operationValue']
];

/**
 * Faixas de parcelamento do cartao. O contrato expressa cada faixa como um
 * percentual "ate N parcelas", o que mapeia exatamente para os intervalos ja
 * usados pelo gateway_fee_schedule.
 */
const CARD_TIERS: Array<{ from: number; to: number; percentPath: string[] }> = [
  { from: 1,  to: 1,  percentPath: ['payment', 'creditCard', 'oneInstallmentPercentage'] },
  { from: 2,  to: 6,  percentPath: ['payment', 'creditCard', 'upToSixInstallmentsPercentage'] },
  { from: 7,  to: 12, percentPath: ['payment', 'creditCard', 'upToTwelveInstallmentsPercentage'] },
  { from: 13, to: 21, percentPath: ['payment', 'creditCard', 'upToTwentyOneInstallmentsPercentage'] }
];

// PENDENTE DE DECISAO FINANCEIRA — NAO LIDO POR ESTE PARSER:
//   payment.creditCard.discountOneInstallmentPercentage
//   payment.creditCard.discountUpToSixInstallmentsPercentage
//   payment.creditCard.discountUpToTwelveInstallmentsPercentage
//   payment.creditCard.discountUpToTwentyOneInstallmentsPercentage
//   payment.creditCard.discountExpiration
//   payment.pix.fixedFeeValueWithDiscount / discountExpiration
//   payment.pix.percentageFee (lido apenas como guarda, nunca interpretado)
//   payment.pix.minimumFeeValue / maximumFeeValue
// Qual tarifa vale quando ha desconto vigente, e como representar piso/teto
// de PIX, sao decisoes de negocio. Ate que sejam tomadas, nenhum destes
// campos influencia o valor sincronizado.

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
      reason: `Resposta traz percentual de PIX (${pixPercent.path}=${pixPercent.value}); modelo atual so representa tarifa fixa — revisao manual necessaria`
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

  // ---- CARTAO: as quatro faixas documentadas ------------------------------
  // Uma faixa so' e' sincronizada quando o percentual DELA e o componente fixo
  // comum forem ambos extraidos. Um sozinho nao define a tarifa.
  const cardFixed = pick(asaasData, CARD_FIXED_PATHS);
  const cardFixedCents = cardFixed ? brlToCents(cardFixed.value) : null;

  for (const tier of CARD_TIERS) {
    const tierPercent = pick(asaasData, [tier.percentPath]);

    if (!tierPercent && !cardFixed) {
      unmapped.push({
        method: 'CREDIT_CARD', installmentFrom: tier.from, installmentTo: tier.to,
        reason: `Nem percentual (${tier.percentPath.join('.')}) nem fixo (${CARD_FIXED_PATHS[0].join('.')}) encontrados na resposta`
      });
      continue;
    }

    if (!tierPercent) {
      unmapped.push({
        method: 'CREDIT_CARD', installmentFrom: tier.from, installmentTo: tier.to,
        reason: `Percentual ${tier.percentPath.join('.')} nao encontrado; fixo sozinho nao define a tarifa`
      });
      continue;
    }

    if (!cardFixed) {
      // Gravar so' o percentual zeraria o componente fixo vigente.
      unmapped.push({
        method: 'CREDIT_CARD', installmentFrom: tier.from, installmentTo: tier.to,
        reason: `Componente fixo ${CARD_FIXED_PATHS[0].join('.')} nao encontrado; faixa mantida manual para nao zerar o fixo vigente`
      });
      continue;
    }

    if (tierPercent.value < 0 || tierPercent.value > MAX_PERCENT) {
      unmapped.push({
        method: 'CREDIT_CARD', installmentFrom: tier.from, installmentTo: tier.to,
        reason: `Percentual do cartao fora da banda de sanidade (${tierPercent.path}=${tierPercent.value})`
      });
      continue;
    }

    if (cardFixedCents === null) {
      unmapped.push({
        method: 'CREDIT_CARD', installmentFrom: tier.from, installmentTo: tier.to,
        reason: `Valor fixo do cartao fora da banda de sanidade (${cardFixed.path}=${cardFixed.value})`
      });
      continue;
    }

    ranges.push({
      method: 'CREDIT_CARD',
      installmentFrom: tier.from,
      installmentTo: tier.to,
      percent: tierPercent.value,
      fixedCents: cardFixedCents,
      evidence: { percent: tierPercent.path, fixed: cardFixed.path }
    });
  }

  return { ranges, unmapped };
}
