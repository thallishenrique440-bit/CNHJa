/**
 * CommissionCnhJaP121B.unit.test.ts
 *
 * P-1.21B — a "Comissao CNHJa" exibida ao instrutor.
 *
 * O banco carrega DUAS semanticas de `platform_fee`:
 *   LEGADO (ate P-1.18E)   platform_fee = comissao + taxa do gateway
 *   ATUAL  (P-1.18E ->)    platform_fee = comissao pura
 *
 * A era e' derivada da IDENTIDADE CONTABIL DA PROPRIA LINHA, nunca da data:
 *   ATUAL  <=>  platform_fee + fee_amount + net_amount = gross_amount
 *   LEGADO <=>  platform_fee + net_amount             = gross_amount
 *
 * AP-09 — as fixtures deixaram de ser producao.
 *
 * Ate 2026-09-24 a tabela FIXTURES deste arquivo era, nas palavras do proprio
 * cabecalho, "a copia literal dos 33 settlements PAYMENT existentes em
 * producao", com as datas reais das transacoes. Isso violava a regra de nao
 * usar dado financeiro real como fixture e, pior, amarrava o teste a um estado
 * de banco que sera integralmente descartado no reset (AP-10).
 *
 * As linhas agora vem de lib/payments/tests/fixtures/syntheticFinanceFixtures,
 * onde cada cenario e' DERIVADO dos invariantes do produto (comissao de 10%,
 * repasse de 90%, gross-up da tarifa, gorjeta sem comissao) em vez de lido do
 * banco. A cobertura contabil e' equivalente: as duas eras, aula avulsa, meia
 * aula, combo, combo parcelado, valor impar com arredondamento e gorjeta.
 *
 * NADA neste arquivo escreve no banco. A funcao sob teste e' pura.
 */
import { InstructorFinanceReadService } from '../services/InstructorFinanceReadService.js';

let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string) => {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
};

const service = new InstructorFinanceReadService();
/** A funcao e' privada por desenho; o teste a exercita diretamente. */
const commission = (p: number, f: number, g: number, n: number): number =>
  (service as any).calculateCommissionCnhJa(p, f, g, n);

import {
  SYNTHETIC_SETTLEMENTS,
  assertFixturesAreCoherent,
  type SyntheticSettlement,
} from './fixtures/syntheticFinanceFixtures.js';

/** Conjunto congelado e sintetico. Ver o modulo de fixtures. */
const FIXTURES: readonly SyntheticSettlement[] = SYNTHETIC_SETTLEMENTS;

async function run() {
  console.log('\n======================================================');
  console.log('🧪 P-1.21B: comissao CNHJa exibida ao instrutor');
  console.log('======================================================\n');

  // ---- A) registro ATUAL de R$100 ----------------------------------------
  assert(commission(1000, 199, 10199, 9000) === 1000,
    'A. atual: platform_fee=1000, fee=199 -> comissao = 1000 (R$ 10,00)');
  assert(commission(1000, 199, 10199, 9000) !== 801,
    'A. o R$ 8,01 da formula antiga nao aparece mais');

  // ---- B) registro LEGADO equivalente ------------------------------------
  assert(commission(1149, 149, 10149, 9000) === 1000,
    'B. legado: platform_fee=1149 (comissao+taxa) -> comissao pura = 1000');

  // ---- C/D) TODOS os cenarios sinteticos ---------------------------------
  // Guarda de sanidade das proprias fixtures: se isto falhar, o defeito esta
  // na fixture, nao na funcao sob teste.
  const fixtureProblems = assertFixturesAreCoherent();
  assert(fixtureProblems.length === 0,
    `fixtures coerentes com a era que declaram${fixtureProblems.length ? ': ' + fixtureProblems.join(' | ') : ''}`);

  let legados = 0, atuais = 0, erros = 0;
  for (const row of FIXTURES) {
    const { scenario, grossAmount: g, feeAmount: f, platformFee: p,
            netAmount: n, expectedEra: era, expectedCommission: esperado } = row;
    const isAtual = p + f + n === g;
    const isLegado = p + n === g;
    if (isAtual && !isLegado) atuais++;
    else if (isLegado && !isAtual) legados++;
    else erros++;

    const classificada = isAtual && !isLegado ? 'atual' : 'legado';
    if (classificada !== era || commission(p, f, g, n) !== esperado) {
      console.error(`      ${scenario} g=${g} f=${f} p=${p} n=${n}: ` +
        `era=${classificada} (esperado ${era}), comissao=${commission(p, f, g, n)} (esperado ${esperado})`);
      erros++;
    }
  }
  const nAtuais = FIXTURES.filter(r => r.expectedEra === 'atual').length;
  const nLegados = FIXTURES.filter(r => r.expectedEra === 'legado').length;
  assert(erros === 0, `C/D. os ${FIXTURES.length} cenarios sinteticos classificam e calculam corretamente`);
  assert(legados === nLegados, `C. ${nLegados} cenarios legados (obtido ${legados})`);
  assert(atuais === nAtuais, `D. ${nAtuais} cenarios atuais (obtido ${atuais})`);
  assert(FIXTURES.length > 0, 'o conjunto de fixtures nao esta vazio');

  // as duas identidades nunca colidem quando ha taxa de gateway
  const ambiguas = FIXTURES.filter(r =>
    r.feeAmount > 0 &&
    (r.platformFee + r.feeAmount + r.netAmount === r.grossAmount) &&
    (r.platformFee + r.netAmount === r.grossAmount));
  assert(ambiguas.length === 0,
    'as duas identidades sao mutuamente exclusivas com fee_amount > 0');

  // ---- E) o caso de R$100 atual, fim a fim -------------------------------
  const INSTRUCTOR = 'instr_1';
  const SETTLEMENT = {
    id: 'set_1', installment_id: 'inst_1', instructor_id: INSTRUCTOR,
    student_id: 'stud_1', appointment_id: 'appt_1', provider_payment_id: 'pay_1',
    settlement_type: 'PAYMENT',
    gross_amount: 10199, net_amount: 9000, platform_fee: 1000,
    fee_amount: 199, instructor_amount: 9000,
    settled_at: '2026-09-23T00:00:00Z', created_at: '2026-09-23T00:00:00Z',
    payment_installments: {
      id: 'inst_1', instructor_id: INSTRUCTOR, student_id: 'stud_1', group_id: null,
      installment_number: 1, total_installments: 1, due_date: '2026-09-23T00:00:00Z',
      payment_date: '2026-09-23T00:00:00Z', status: 'RECEIVED',
      profiles: { full_name: 'Aluno Um' }
    }
  };
  /** Gorjeta: sem installment_id. G) nao pode ser afetada. */
  const TIP = {
    ...SETTLEMENT, id: 'set_tip', installment_id: null, provider_payment_id: 'pay_tip',
    gross_amount: 1000, net_amount: 801, platform_fee: 0, fee_amount: 199,
    instructor_amount: 801, payment_installments: null
  };
  /** Estorno: valores negados pelo multiplicador. G) nao pode ser afetado. */
  const REFUND = {
    ...SETTLEMENT, id: 'set_ref', installment_id: 'inst_ref',
    provider_payment_id: 'pay_ref', settlement_type: 'REFUND'
  };

  const chain = (rows: any[]): any => ({
    select: () => chain(rows), eq: () => chain(rows), in: () => chain(rows),
    order: () => chain(rows), limit: () => chain(rows), range: () => chain(rows),
    then: (resolve: any) => resolve({ data: rows, error: null })
  });
  const client: any = {
    from: (t: string) => {
      if (t === 'payment_settlements') return chain([SETTLEMENT, TIP, REFUND]);
      if (t === 'payment_installments') return chain([]);
      return undefined;
    }
  };

  const statement = await service.getStatement(client, INSTRUCTOR);
  const byId = (id: string) => statement.find((e: any) => e.id === id) as any;

  assert(byId('set_1')?.commissionCnhJaCents === 1000,
    'E. R$100 atual: comissao exibida = R$ 10,00');
  assert(byId('set_1')?.netAmountCents === 9000,
    'E. R$100 atual: instrutor recebe R$ 90,00');

  // ---- F) nenhum outro campo e afetado -----------------------------------
  const e = byId('set_1');
  assert(e?.grossAmountCents === 10199, 'F. grossAmountCents inalterado');
  assert(e?.netAmountCents === 9000, 'F. netAmountCents inalterado');
  assert(e?.platformFeeCents === 1000, 'F. platformFeeCents inalterado');
  assert(e?.feeAmountCents === 199, 'F. feeAmountCents inalterado');
  assert(e?.grossAmountCents - e?.feeAmountCents - e?.platformFeeCents === e?.netAmountCents,
    'F. a identidade contabil da linha continua fechando');

  // ---- G) gorjeta e estorno ----------------------------------------------
  const tip = byId('set_tip');
  assert(tip?.isTip === true, 'G. gorjeta continua marcada como isTip');
  assert(tip?.commissionCnhJaCents === 0,
    'G. gorjeta: comissao 0 (antes a formula antiga produzia -199)');
  assert(tip?.netAmountCents === 801, 'G. gorjeta: liquido inalterado');

  const ref = byId('set_ref');
  assert(ref?.status === 'REFUNDED', 'G. estorno continua marcado como REFUNDED');
  assert(ref?.netAmountCents === -9000, 'G. estorno: liquido negativo preservado');
  assert(ref?.commissionCnhJaCents === -1000,
    'G. estorno: comissao negada corretamente (identidade sobrevive ao sinal)');

  // ---- casos de borda ----------------------------------------------------
  assert(commission(1000, 0, 10000, 9000) === 1000,
    'borda: fee_amount = 0 -> as duas identidades coincidem, comissao = platform_fee');
  assert(commission(1000, 199, 0, 0) === 1000,
    'borda: identidade indeterminada -> platform_fee cru, nunca negativo');

  console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
  if (failed > 0) process.exit(1);
}

await run();
