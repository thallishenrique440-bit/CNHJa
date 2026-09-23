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
 * A tabela FIXTURES abaixo e' a copia literal dos 33 settlements PAYMENT
 * existentes em producao (consulta somente leitura em 2026-09-23):
 * 23 legados (2026-08-10 -> 2026-09-19) e 10 atuais (2026-09-17 -> 2026-09-23).
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

/** [data, gross, fee, platform_fee, net, era esperada, comissao esperada] */
type Row = [string, number, number, number, number, 'legado' | 'atual', number];

const FIXTURES: Row[] = [
  // ---- 10 linhas legadas de R$100 (taxa embutida no platform_fee) ----------
  ['2026-08-10', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-08-11', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-08-11', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-08-12', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-08-12', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-08-12', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-08-12', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-09-11', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-09-16', 10149, 149, 1149, 9000, 'legado', 1000],
  ['2026-09-17', 10149, 149, 1149, 9000, 'legado', 1000],
  // ---- gorjeta (platform_fee = 0), ja' no modelo atual --------------------
  ['2026-09-17',  1000, 199,    0,  801, 'atual',     0],
  // ---- transicao P-1.18E: 13 linhas legadas de meia aula / pacote ---------
  ['2026-09-18',  5186, 192,  686, 4500, 'legado',  494],
  ['2026-09-18',  5186, 192,  686, 4500, 'legado',  494],
  ['2026-09-18',  5186, 192,  686, 4500, 'legado',  494],
  ['2026-09-18',  5374, 199,  874, 4500, 'legado',  675],
  ['2026-09-18',  5189, 193,  689, 4500, 'legado',  496],
  ['2026-09-18',  5374, 199,  874, 4500, 'legado',  675],
  ['2026-09-18', 13519, 453, 1819,11700, 'legado', 1366],
  ['2026-09-18',  5376, 199,  876, 4500, 'legado',  677],
  ['2026-09-18',  5374, 199,  874, 4500, 'legado',  675],
  ['2026-09-19',  5189, 193,  689, 4500, 'legado',  496],
  ['2026-09-19',  5186, 192,  686, 4500, 'legado',  494],
  ['2026-09-19',  5186, 192,  686, 4500, 'legado',  494],
  ['2026-09-19',  5186, 192,  686, 4500, 'legado',  494],
  // ---- 9 linhas ja' no modelo atual --------------------------------------
  ['2026-09-19',  5193, 193,  500, 4500, 'atual',   500],
  ['2026-09-22', 10199, 199, 1000, 9000, 'atual',  1000],
  ['2026-09-22', 10199, 199, 1000, 9000, 'atual',  1000],
  ['2026-09-22', 10199, 199, 1000, 9000, 'atual',  1000],
  ['2026-09-22', 10199, 199, 1000, 9000, 'atual',  1000],
  ['2026-09-22', 10199, 199, 1000, 9000, 'atual',  1000],
  ['2026-09-23', 13199, 199, 1300,11700, 'atual',  1300],
  ['2026-09-23', 10199, 199, 1000, 9000, 'atual',  1000],
  ['2026-09-23', 10199, 199, 1000, 9000, 'atual',  1000],
];

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

  // ---- C/D) TODAS as linhas de producao ----------------------------------
  let legados = 0, atuais = 0, erros = 0;
  for (const [d, g, f, p, n, era, esperado] of FIXTURES) {
    const isAtual = p + f + n === g;
    const isLegado = p + n === g;
    if (isAtual && !isLegado) atuais++;
    else if (isLegado && !isAtual) legados++;
    else erros++;

    const classificada = isAtual && !isLegado ? 'atual' : 'legado';
    if (classificada !== era || commission(p, f, g, n) !== esperado) {
      console.error(`      linha ${d} g=${g} f=${f} p=${p} n=${n}: ` +
        `era=${classificada} (esperado ${era}), comissao=${commission(p, f, g, n)} (esperado ${esperado})`);
      erros++;
    }
  }
  assert(erros === 0, 'C/D. as 33 linhas de producao classificam e calculam corretamente');
  assert(legados === 23, `C. exatamente 23 linhas legadas (obtido ${legados})`);
  assert(atuais === 10, `D. exatamente 10 linhas atuais (obtido ${atuais})`);

  // as duas identidades nunca colidem quando ha taxa de gateway
  const ambiguas = FIXTURES.filter(([, g, f, p, n]) =>
    f > 0 && (p + f + n === g) && (p + n === g));
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
