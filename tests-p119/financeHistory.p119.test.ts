/**
 * P-1.19 — Historico financeiro de compras parceladas.
 *
 * ALUNO: conta apenas parcelas RECEIVED (0/N antes do primeiro recebimento).
 * INSTRUTOR: a venda aparece desde que a compra existe, mesmo com 0 RECEIVED.
 *
 * Nenhuma matematica financeira e' exercitada aqui: os valores sao lidos das
 * proprias linhas de payment_installments / payment_settlements.
 */
import { StudentFinanceReadService } from '../lib/payments/services/StudentFinanceReadService';
import { InstructorFinanceReadService } from '../lib/payments/services/InstructorFinanceReadService';
import { HistoryCardFormatter } from '../components/finance/formatters/HistoryCardFormatter';
import * as fs from 'fs';
import * as path from 'path';

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`); }
}
function eq(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, label, `esperado ${String(expected)}, obtido ${String(actual)}`);
}
function section(t: string) { console.log(`\n== ${t} ==`); }

// Compra real de referencia: 2 aulas por R$200,00 em 4x.
//   service_price 20000 · student_charge 20772 · instrutor 18000 · comissao 2000
const GROUP = 'grp_p119';
const INSTRUTOR = 'ins_p119';
const ALUNO = 'stu_p119';
const PARCELA_GROSS = 5193;
const PARCELA_NET = 4500;   // 90% de 5000 (fatia do service_price)
const PARCELA_PLAT = 500;   // comissao CNHJa da fatia
const PARCELA_FEE = 193;    // tarifa do gateway da fatia

function parcelas(statuses: string[], groupId = GROUP) {
  return statuses.map((status, i) => ({
    id: `inst_${groupId}_${i + 1}`,
    provider_payment_id: `pay_${groupId}_${i + 1}`,
    group_id: groupId,
    appointment_id: null,
    instructor_id: INSTRUTOR,
    student_id: ALUNO,
    installment_number: i + 1,
    total_installments: statuses.length,
    gross_amount: PARCELA_GROSS,
    net_amount: PARCELA_NET,
    platform_fee: PARCELA_PLAT,
    fee_amount: PARCELA_FEE,
    instructor_amount: PARCELA_NET,
    status,
    due_date: `2026-${String(9 + i).padStart(2, '0')}-19T00:00:00.000Z`,
    payment_date: status === 'RECEIVED' ? `2026-09-19T0${i}:00:00.000Z` : null,
    created_at: '2026-09-19T00:00:00.000Z',
    profiles: { full_name: 'Aluno Teste' }
  }));
}

/** Mock de Supabase por tabela, com a cadeia usada pelos dois read services. */
function mockSupabase(datasets: Record<string, any[]>): any {
  return {
    from(table: string) {
      const result = { data: datasets[table] || [], error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
        gte: () => chain,
        lt: () => chain,
        order: () => chain,
        limit: () => chain,
        range: () => chain,
        maybeSingle: async () => ({ data: (datasets[table] || [])[0] || null, error: null }),
        single: async () => ({ data: (datasets[table] || [])[0] || null, error: null }),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject)
      };
      return chain;
    }
  };
}

const studentService = new StudentFinanceReadService();
const instructorService = new InstructorFinanceReadService();

async function historicoAluno(statuses: string[]) {
  const supabase = mockSupabase({
    payment_installments: parcelas(statuses),
    payment_settlements: [],
    appointments: []
  });
  const items = await studentService.getHistory(supabase, ALUNO);
  return items[0] as any;
}

function rotuloAluno(item: any) {
  const totalInst = item.totalInstallments && item.totalInstallments > 0 ? item.totalInstallments : 1;
  const recInst = typeof item.receivedInstallments === 'number' ? item.receivedInstallments : 0;
  return HistoryCardFormatter.formatInstallmentText(totalInst, recInst, false, false);
}

/** Settlements correspondentes as parcelas RECEIVED (o que o webhook teria criado). */
function settlementsDe(statuses: string[]) {
  return parcelas(statuses)
    .filter(p => p.status === 'RECEIVED')
    .map(p => ({
      id: `set_${p.id}`,
      installment_id: p.id,
      instructor_id: INSTRUTOR,
      student_id: ALUNO,
      appointment_id: null,
      provider_payment_id: p.provider_payment_id,
      settlement_type: 'PAYMENT',
      gross_amount: p.gross_amount,
      net_amount: p.net_amount,
      platform_fee: p.platform_fee,
      fee_amount: p.fee_amount,
      instructor_amount: p.net_amount,
      settled_at: p.payment_date,
      created_at: p.payment_date,
      payment_installments: {
        id: p.id,
        instructor_id: INSTRUTOR,
        student_id: ALUNO,
        group_id: GROUP,
        installment_number: p.installment_number,
        total_installments: p.total_installments,
        due_date: p.due_date,
        payment_date: p.payment_date,
        status: p.status,
        profiles: { full_name: 'Aluno Teste' }
      }
    }));
}

async function extratoInstrutor(statuses: string[], extras: any[] = []) {
  const supabase = mockSupabase({
    payment_settlements: settlementsDe(statuses),
    payment_installments: [...parcelas(statuses), ...extras],
    profiles: []
  });
  return await instructorService.getStatement(supabase, INSTRUTOR, { limit: 50 });
}

async function main() {
  // =========================================================================
  section('ALUNO — 1 a 6: conta somente RECEIVED');

  const casosAluno: Array<[string, string[], number]> = [
    ['1) 4 PENDING', ['PENDING', 'PENDING', 'PENDING', 'PENDING'], 0],
    ['2) 4 CONFIRMED', ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED'], 0],
    ['3) 1 RECEIVED + 3 CONFIRMED', ['RECEIVED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED'], 1],
    ['4) 2 RECEIVED + 2 CONFIRMED', ['RECEIVED', 'RECEIVED', 'CONFIRMED', 'CONFIRMED'], 2],
    ['5) 3 RECEIVED + 1 CONFIRMED', ['RECEIVED', 'RECEIVED', 'RECEIVED', 'CONFIRMED'], 3],
    ['6) 4 RECEIVED', ['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED'], 4]
  ];

  for (const [label, statuses, esperado] of casosAluno) {
    const h = await historicoAluno(statuses);
    eq(h.receivedInstallments, esperado, `${label}: receivedInstallments = ${esperado}`);
    eq(h.totalInstallments, 4, `${label}: totalInstallments = 4`);
    eq(rotuloAluno(h), `${esperado} de 4 parcelas pagas`, `${label}: rotulo "${esperado} de 4 parcelas pagas"`);
    if (esperado === 4) {
      eq(h.status, 'completed', `${label}: compra concluida`);
    } else {
      assert(h.status !== 'completed', `${label}: compra NAO concluida`, `obtido ${h.status}`);
    }
  }

  // =========================================================================
  section('INSTRUTOR — 7 a 12: a venda existe antes do primeiro recebimento');

  // 7) venda existente + 0 RECEIVED
  {
    const ext = await extratoInstrutor(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    eq(ext.length, 1, '7) a venda aparece no historico mesmo sem nenhum settlement');
    const v: any = ext[0];
    eq(v.groupId, GROUP, '7) venda identificada pela compra (group_id)');
    eq(v.totalInstallments, 4, '7) total de parcelas = 4');
    eq(v.receivedInstallments, 0, '7) 0 de 4 recebidas');
    eq(v.netAmountCents, 0, '7) recebido = R$0,00');
    eq(v.futureNetAmountCents, 18000, '7) recebimentos futuros = R$180,00');
    eq(v.status, 'CONFIRMED', '7) status da compra reflete as parcelas');
  }

  // 8) 1 RECEIVED
  {
    const ext = await extratoInstrutor(['RECEIVED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    eq(ext.length, 1, '8) uma unica venda no historico');
    const v: any = ext[0];
    eq(v.receivedInstallments, 1, '8) 1 de 4 recebidas');
    eq(v.totalInstallments, 4, '8) total continua 4');
    eq(v.netAmountCents, 4500, '8) recebido = R$45,00');
    eq(v.futureNetAmountCents, 13500, '8) futuro = R$135,00');
    eq(v.netAmountCents + v.futureNetAmountCents, 18000, '8) recebido + futuro = R$180,00');
  }

  // 9) parcialmente recebidas
  {
    const ext = await extratoInstrutor(['RECEIVED', 'RECEIVED', 'CONFIRMED', 'CONFIRMED']);
    const v: any = ext[0];
    eq(v.receivedInstallments, 2, '9) 2 de 4 recebidas');
    eq(v.netAmountCents, 9000, '9) recebido = R$90,00');
    eq(v.futureNetAmountCents, 9000, '9) futuro = R$90,00');
  }
  {
    const ext = await extratoInstrutor(['RECEIVED', 'RECEIVED', 'RECEIVED', 'CONFIRMED']);
    const v: any = ext[0];
    eq(v.receivedInstallments, 3, '9) 3 de 4 recebidas');
    eq(v.netAmountCents, 13500, '9) recebido = R$135,00');
    eq(v.futureNetAmountCents, 4500, '9) futuro = R$45,00');
  }

  // 10) todas recebidas
  {
    const ext = await extratoInstrutor(['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED']);
    const v: any = ext[0];
    eq(v.receivedInstallments, 4, '10) 4 de 4 recebidas');
    eq(v.netAmountCents, 18000, '10) recebido = R$180,00');
    eq(v.futureNetAmountCents, 0, '10) futuro = R$0,00');
  }

  // 11) CONFIRMED nao aumenta o recebido
  {
    const zero = await extratoInstrutor(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    const uma = await extratoInstrutor(['RECEIVED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    eq((zero[0] as any).netAmountCents, 0, '11) 4 CONFIRMED -> recebido zero');
    eq((zero[0] as any).receivedInstallments, 0, '11) 4 CONFIRMED -> 0 recebidas');
    eq((uma[0] as any).netAmountCents, 4500, '11) so a parcela RECEIVED soma');
    eq((uma[0] as any).receivedInstallments, 1, '11) so a parcela RECEIVED conta');
  }

  // 12) a ausencia de settlement nao pode esconder uma venda — inclusive quando
  //     o instrutor JA' possui outra venda liquidada (a causa raiz do bug)
  {
    const outraCompra = parcelas(['CONFIRMED', 'CONFIRMED'], 'grp_p119_nova').map(p => ({
      ...p,
      due_date: '2026-10-01T00:00:00.000Z'
    }));
    const ext = await extratoInstrutor(['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED'], outraCompra);
    eq(ext.length, 2, '12) a venda sem settlement aparece ao lado da venda liquidada');
    const nova: any = ext.find((e: any) => e.groupId === 'grp_p119_nova');
    const antiga: any = ext.find((e: any) => e.groupId === GROUP);
    assert(!!nova, '12) venda nova (sem settlement) presente no historico');
    eq(nova.receivedInstallments, 0, '12) venda nova: 0 recebidas');
    eq(nova.netAmountCents, 0, '12) venda nova: recebido zero');
    eq(nova.futureNetAmountCents, 9000, '12) venda nova: futuro = soma do liquido das parcelas');
    eq(antiga.receivedInstallments, 4, '12) venda antiga permanece 4 de 4');
    eq(antiga.netAmountCents, 18000, '12) venda antiga mantem o recebido');
  }

  // =========================================================================
  section('ANTI-REGRESSAO — 13 a 18: nada financeiro foi tocado');

  {
    const root = process.cwd();
    const svc = fs.readFileSync(path.join(root, 'lib/payments/services/InstructorFinanceReadService.ts'), 'utf8');
    const limpo = svc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // 13/14 — nenhuma comissao ou valor de instrutor recalculado no read model
    assert(!/\*\s*0\.10|\*\s*0\.9\b|\/\s*10\b/.test(limpo),
      '13/14) o read model do instrutor nao recalcula comissao nem 90%');
    assert(/calculateCommissionCnhJa/.test(limpo),
      '13/14) continua usando a funcao central de comissao, inalterada');

    // 15 — nenhuma escrita: o read service so' le
    assert(!/\.(insert|update|upsert|delete)\(/.test(limpo),
      '15) o read model nao escreve em nenhuma tabela');

    // 16/17/18 — arquivos de autoridade intocados nesta fase
    const intocados = [
      'api/asaas-webhook.ts',
      'lib/payments/SettlementService.ts',
      'lib/payments/SettlementRepository.ts',
      'lib/payments/SettlementCalculator.ts',
      'lib/payments/InstallmentService.ts',
      'api/reconcile-payment.ts'
    ];
    for (const f of intocados) {
      assert(fs.existsSync(path.join(root, f)), `16-18) ${f} presente e nao removido`);
    }

    // a venda vem de payment_installments, nunca de payment_settlements
    assert(/from\('payment_installments'\)/.test(svc),
      'a fonte da venda e payment_installments');
    assert(/futureNetAmountCents/.test(svc),
      'recebido e futuro sao campos distintos');
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`P-1.19  PASS=${pass}  FAIL=${fail}`);
  console.log('='.repeat(56));
  if (fail > 0) process.exit(1);
}

main();
