/**
 * syntheticFinanceFixtures.ts
 *
 * AP-09 — fixtures financeiras SINTETICAS e CONGELADAS.
 *
 * ------------------------------------------------------------------------
 * POR QUE ESTE ARQUIVO EXISTE
 * ------------------------------------------------------------------------
 * Antes do AP-09, `CommissionCnhJaP121B.unit.test.ts` carregava uma tabela
 * descrita no proprio cabecalho como "a copia literal dos 33 settlements
 * PAYMENT existentes em producao (consulta somente leitura em 2026-09-23)",
 * com as datas reais das transacoes. Isso cria tres problemas:
 *
 *   1. Regra 10 do contrato de execucao: dados financeiros reais nao devem
 *      ser usados como fixture.
 *   2. O banco sera integralmente limpo antes do lancamento (AP-10). Uma
 *      fixture ancorada em linhas de producao perde a referencia no reset e
 *      passa a "testar" um estado que nao existe mais.
 *   3. Datas reais de transacao sao dado de negocio e nao precisam estar
 *      versionadas no repositorio.
 *
 * ------------------------------------------------------------------------
 * O QUE MUDA E O QUE NAO MUDA
 * ------------------------------------------------------------------------
 * NAO MUDA: as identidades contabeis exercitadas, os arredondamentos de
 * borda e a cobertura de cada cenario. Cada linha da tabela antiga tem aqui
 * um equivalente estrutural.
 *
 * MUDA: os numeros nao sao mais lidos de producao — sao DERIVADOS das
 * regras do produto, o que torna o teste independente do estado do banco e
 * auto-explicativo.
 *
 * ------------------------------------------------------------------------
 * AS DUAS ERAS DE `platform_fee`
 * ------------------------------------------------------------------------
 * O banco carrega duas semanticas historicas para a coluna `platform_fee`:
 *
 *   LEGADO (ate P-1.18E)   platform_fee = comissao + taxa do gateway
 *   ATUAL  (P-1.18E ->)    platform_fee = comissao pura
 *
 * A era e' derivada da IDENTIDADE CONTABIL DA PROPRIA LINHA, nunca da data:
 *
 *   ATUAL  <=>  platform_fee + fee_amount + net_amount = gross_amount
 *   LEGADO <=>  platform_fee              + net_amount = gross_amount
 *
 * As duas identidades sao mutuamente exclusivas sempre que fee_amount > 0,
 * que e' o caso de toda cobranca real. Por isso a deteccao e' deterministica.
 *
 * ------------------------------------------------------------------------
 * INVARIANTES DO PRODUTO USADOS PARA GERAR AS FIXTURES
 * ------------------------------------------------------------------------
 *   AULA     service_price = valor do servico
 *            comissao CNHJa = round(service_price * 0,10)
 *            instrutor      = service_price - comissao        (= 90%)
 *            a taxa do gateway NAO reduz esses valores: e' somada ao que o
 *            aluno paga (gross-up)
 *
 *   GORJETA  comissao CNHJa = 0
 *            a taxa do gateway e' descontada da gorjeta
 *            o instrutor recebe o restante
 *
 * NADA neste arquivo escreve no banco, le variavel de ambiente ou faz rede.
 */

export type Era = 'legado' | 'atual';

/** Uma linha de settlement sintetica, em centavos. */
export interface SyntheticSettlement {
  /** Identificador do cenario, legivel em caso de falha. */
  readonly scenario: string;
  /** Descricao do que esta linha representa no negocio. */
  readonly describes: string;
  readonly grossAmount: number;
  readonly feeAmount: number;
  readonly platformFee: number;
  readonly netAmount: number;
  readonly expectedEra: Era;
  /** Comissao CNHJa pura que a UI deve exibir ao instrutor. */
  readonly expectedCommission: number;
}

/** Comissao da plataforma sobre uma aula: 10% do valor do servico. */
export const commissionOf = (servicePriceCents: number): number =>
  Math.round(servicePriceCents * 0.1);

/**
 * Constroi a linha no modelo ATUAL.
 *   platform_fee = comissao pura
 *   gross        = service_price + taxa do gateway   (gross-up)
 *   net          = service_price - comissao          (90% do servico)
 * Identidade: platform_fee + fee + net = gross.
 */
export function atual(
  scenario: string,
  describes: string,
  servicePriceCents: number,
  gatewayFeeCents: number
): SyntheticSettlement {
  const platformFee = commissionOf(servicePriceCents);
  return {
    scenario,
    describes,
    grossAmount: servicePriceCents + gatewayFeeCents,
    feeAmount: gatewayFeeCents,
    platformFee,
    netAmount: servicePriceCents - platformFee,
    expectedEra: 'atual',
    expectedCommission: platformFee,
  };
}

/**
 * Constroi a MESMA operacao economica no modelo LEGADO.
 *   platform_fee = comissao + taxa do gateway   (a dupla contagem historica)
 *   gross        = platform_fee + net
 * Identidade: platform_fee + net = gross.
 *
 * O instrutor recebe exatamente o mesmo `net` nas duas eras — foi sempre a
 * receita declarada da plataforma que estava inflada, nunca o repasse.
 */
export function legado(
  scenario: string,
  describes: string,
  servicePriceCents: number,
  gatewayFeeCents: number
): SyntheticSettlement {
  const commission = commissionOf(servicePriceCents);
  const platformFee = commission + gatewayFeeCents;
  const netAmount = servicePriceCents - commission;
  return {
    scenario,
    describes,
    grossAmount: platformFee + netAmount,
    feeAmount: gatewayFeeCents,
    platformFee,
    netAmount,
    expectedEra: 'legado',
    expectedCommission: commission,
  };
}

/**
 * Gorjeta: a plataforma nao cobra comissao e a taxa sai do valor enviado.
 * Identidade: 0 + fee + net = gross, ou seja, e' do modelo ATUAL.
 */
export function gorjeta(
  scenario: string,
  describes: string,
  tipGrossCents: number,
  gatewayFeeCents: number
): SyntheticSettlement {
  return {
    scenario,
    describes,
    grossAmount: tipGrossCents,
    feeAmount: gatewayFeeCents,
    platformFee: 0,
    netAmount: tipGrossCents - gatewayFeeCents,
    expectedEra: 'atual',
    expectedCommission: 0,
  };
}

// ---------------------------------------------------------------------------
// Tarifas sinteticas de gateway.
//
// Sao valores de FORMATO realista (percentual + fixo), escolhidos para
// exercitar arredondamento, NAO copiados de nenhum painel. A tarifa real de
// producao e' assunto do AP-04 e do seed pos-reset, nao deste arquivo.
// ---------------------------------------------------------------------------
export const FEE_PIX_SINTETICA = 199;
export const FEE_CARTAO_1X_SINTETICA = 193;
export const FEE_CARTAO_4X_SINTETICA = 453;
export const FEE_PEQUENA_SINTETICA = 149;

// ---------------------------------------------------------------------------
// Precos de servico sinteticos, em centavos.
// ---------------------------------------------------------------------------
export const AULA_AVULSA = 10_000;      // R$ 100,00 — comissao 1000, net 9000
export const MEIA_AULA = 5_000;         // R$  50,00 — comissao  500, net 4500
export const COMBO_TRES_AULAS = 13_000; // R$ 130,00 — comissao 1300, net 11700
export const COMBO_QUATRO_AULAS = 20_000;
export const VALOR_IMPAR = 7_777;       // exercita Math.round da comissao

/**
 * Conjunto congelado de cenarios financeiros.
 *
 * Cada linha declara o que representa. Nenhuma corresponde a uma transacao
 * real: os valores sao construidos pelas funcoes acima a partir dos
 * invariantes do produto.
 */
export const SYNTHETIC_SETTLEMENTS: readonly SyntheticSettlement[] = [
  // --- Modelo ATUAL --------------------------------------------------------
  atual('ATUAL-AULA-PIX', 'aula avulsa paga por PIX',
    AULA_AVULSA, FEE_PIX_SINTETICA),
  atual('ATUAL-AULA-CARTAO-1X', 'aula avulsa no cartao a vista',
    AULA_AVULSA, FEE_CARTAO_1X_SINTETICA),
  atual('ATUAL-MEIA-AULA', 'meia aula / aula de menor valor',
    MEIA_AULA, FEE_CARTAO_1X_SINTETICA),
  atual('ATUAL-COMBO-3', 'combo de tres aulas',
    COMBO_TRES_AULAS, FEE_PIX_SINTETICA),
  atual('ATUAL-COMBO-4-PARCELADO', 'combo de quatro aulas parcelado no cartao',
    COMBO_QUATRO_AULAS, FEE_CARTAO_4X_SINTETICA),
  atual('ATUAL-VALOR-IMPAR', 'valor impar: comissao exige arredondamento',
    VALOR_IMPAR, FEE_CARTAO_1X_SINTETICA),
  atual('ATUAL-TAXA-PEQUENA', 'mesma aula com tarifa de gateway menor',
    AULA_AVULSA, FEE_PEQUENA_SINTETICA),

  // --- Gorjeta (comissao zero, ja no modelo atual) -------------------------
  gorjeta('GORJETA-PADRAO', 'gorjeta de R$ 10,00: 0% de comissao',
    1_000, FEE_PIX_SINTETICA),
  gorjeta('GORJETA-MAIOR', 'gorjeta de R$ 50,00: 0% de comissao',
    5_000, FEE_PIX_SINTETICA),

  // --- Modelo LEGADO: as MESMAS operacoes, com a taxa embutida -------------
  legado('LEGADO-AULA-PIX', 'aula avulsa por PIX antes da P-1.18E',
    AULA_AVULSA, FEE_PIX_SINTETICA),
  legado('LEGADO-AULA-TAXA-PEQUENA', 'aula avulsa com tarifa menor, era legada',
    AULA_AVULSA, FEE_PEQUENA_SINTETICA),
  legado('LEGADO-MEIA-AULA', 'meia aula antes da P-1.18E',
    MEIA_AULA, FEE_CARTAO_1X_SINTETICA),
  legado('LEGADO-COMBO-3', 'combo de tres aulas antes da P-1.18E',
    COMBO_TRES_AULAS, FEE_PIX_SINTETICA),
  legado('LEGADO-COMBO-4-PARCELADO', 'combo parcelado antes da P-1.18E',
    COMBO_QUATRO_AULAS, FEE_CARTAO_4X_SINTETICA),
  legado('LEGADO-VALOR-IMPAR', 'valor impar na era legada',
    VALOR_IMPAR, FEE_CARTAO_1X_SINTETICA),
] as const;

/**
 * Identificadores sinteticos, para substituir ids reais de producao em
 * testes. Sao deliberadamente reconheciveis como fictícios.
 */
export const SYNTHETIC_IDS = {
  appointment: '00000000-0000-4000-8000-00000000a001',
  appointmentSecundario: '00000000-0000-4000-8000-00000000a002',
  student: '00000000-0000-4000-8000-00000000c001',
  instructor: '00000000-0000-4000-8000-00000000d001',
  providerPayment: 'pay_synthetic_fixture_0001',
  providerPaymentSecundario: 'pay_synthetic_fixture_0002',
  groupId: '00000000-0000-4000-8000-00000000e001',
} as const;

/**
 * Guarda de sanidade das proprias fixtures: garante que cada linha satisfaz a
 * identidade da era que ela declara. Se esta funcao falhar, o defeito esta na
 * fixture, nao no codigo sob teste.
 */
export function assertFixturesAreCoherent(): string[] {
  const problems: string[] = [];
  for (const s of SYNTHETIC_SETTLEMENTS) {
    const somaAtual = s.platformFee + s.feeAmount + s.netAmount;
    const somaLegado = s.platformFee + s.netAmount;
    if (s.expectedEra === 'atual' && somaAtual !== s.grossAmount) {
      problems.push(
        `${s.scenario}: declara ATUAL mas ${s.platformFee}+${s.feeAmount}+${s.netAmount} != ${s.grossAmount}`
      );
    }
    if (s.expectedEra === 'legado' && somaLegado !== s.grossAmount) {
      problems.push(
        `${s.scenario}: declara LEGADO mas ${s.platformFee}+${s.netAmount} != ${s.grossAmount}`
      );
    }
    if (s.feeAmount > 0 && somaAtual === s.grossAmount && somaLegado === s.grossAmount) {
      problems.push(`${s.scenario}: ambiguo — as duas identidades fecham`);
    }
  }
  return problems;
}
