/**
 * P-1.18F.3 — R1 e R2 no historico de parcelas do aluno.
 *
 * R1: parcela paga e' SOMENTE status RECEIVED.
 * R2: 'completed' so' quando TODAS as parcelas do grupo estao RECEIVED.
 *
 *   npx tsc tests-p118f3/studentHistory.p118f3.test.ts --outDir <tmp> ... && node <tmp>/...
 */
import { StudentFinanceReadService } from '../lib/payments/services/StudentFinanceReadService';
import { HistoryCardFormatter } from '../components/finance/formatters/HistoryCardFormatter';

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

const STUDENT = 'stu_p118f3';
const GROUP = 'grp_p118f3';

/** Monta as 4 linhas de payment_installments de uma compra 4x. */
function parcelas(statuses: string[], groupId = GROUP) {
  return statuses.map((status, i) => ({
    id: `inst_${groupId}_${i + 1}`,
    provider_payment_id: `pay_${groupId}_${i + 1}`,
    group_id: groupId,
    appointment_id: null,
    instructor_id: 'ins_1',
    gross_amount: 5193,
    fee_amount: 193,
    platform_fee: 500,
    net_amount: 4500,
    status,
    due_date: `2026-${String(9 + i).padStart(2, '0')}-19T00:00:00.000Z`,
    payment_date: status === 'RECEIVED' ? `2026-09-19T00:0${i}:00.000Z` : null,
    created_at: '2026-09-19T00:00:00.000Z',
    total_installments: statuses.length,
    installment_number: i + 1
  }));
}

/** Mock minimo do cliente Supabase: cada tabela devolve seu proprio dataset. */
function mockSupabase(datasets: Record<string, any[]>): any {
  return {
    from(table: string) {
      const result = { data: datasets[table] || [], error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
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

const service = new StudentFinanceReadService();

async function historico(statuses: string[]) {
  const supabase = mockSupabase({
    payment_installments: parcelas(statuses),
    payment_settlements: [],
    appointments: []
  });
  const items = await service.getHistory(supabase, STUDENT);
  const item = items.find(i => i.groupId === GROUP || (i as any).groupId === GROUP) || items[0];
  return item as any;
}

/** Rotulo que o aluno le, exatamente como o adapter o monta. */
function rotulo(item: any) {
  const totalInst = item.totalInstallments && item.totalInstallments > 0 ? item.totalInstallments : 1;
  const recInst = typeof item.receivedInstallments === 'number' ? item.receivedInstallments : 0;
  return HistoryCardFormatter.formatInstallmentText(totalInst, recInst, false, false);
}

async function main() {
  // -------------------------------------------------------------------------
  section('A — 4/4 RECEIVED');
  {
    const h = await historico(['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED']);
    eq(h.receivedInstallments, 4, 'A) receivedInstallments = 4');
    eq(h.totalInstallments, 4, 'A) totalInstallments = 4');
    eq(rotulo(h), '4 de 4 parcelas pagas', 'A) rotulo = "4 de 4 parcelas pagas"');
    eq(h.status, 'completed', 'A) uiStatus = completed');
  }

  // -------------------------------------------------------------------------
  section('B — 3 RECEIVED + 1 PENDING');
  {
    const h = await historico(['RECEIVED', 'RECEIVED', 'RECEIVED', 'PENDING']);
    eq(h.receivedInstallments, 3, 'B) receivedInstallments = 3');
    eq(rotulo(h), '3 de 4 parcelas pagas', 'B) rotulo = "3 de 4 parcelas pagas"');
    assert(h.status !== 'completed', 'B) uiStatus NAO e completed', `obtido ${h.status}`);
    eq(h.status, 'pending', 'B) uiStatus = pending');
  }

  // -------------------------------------------------------------------------
  section('C — 1 RECEIVED + 3 PENDING');
  {
    const h = await historico(['RECEIVED', 'PENDING', 'PENDING', 'PENDING']);
    eq(h.receivedInstallments, 1, 'C) receivedInstallments = 1');
    eq(rotulo(h), '1 de 4 parcelas pagas', 'C) rotulo = "1 de 4 parcelas pagas"');
    assert(h.status !== 'completed', 'C) uiStatus NAO e completed — era o bug R2', `obtido ${h.status}`);
  }

  // -------------------------------------------------------------------------
  section('D — 0 RECEIVED + 4 PENDING');
  {
    const h = await historico(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    eq(h.receivedInstallments, 0, 'D) receivedInstallments = 0');
    eq(rotulo(h), '0 de 4 parcelas pagas', 'D) rotulo = "0 de 4 parcelas pagas"');
    assert(h.status !== 'completed', 'D) uiStatus NAO e completed', `obtido ${h.status}`);
    eq(h.status, 'pending', 'D) uiStatus = pending');
  }

  // -------------------------------------------------------------------------
  section('E — CONFIRMED nao conta como paga (R1)');
  {
    const h = await historico(['RECEIVED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    eq(h.receivedInstallments, 1, 'E) CONFIRMED nao incrementa a contagem');
    eq(rotulo(h), '1 de 4 parcelas pagas', 'E) rotulo = "1 de 4 parcelas pagas"');
    assert(h.status !== 'completed', 'E) uiStatus NAO e completed', `obtido ${h.status}`);
  }
  {
    const h = await historico(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    eq(h.receivedInstallments, 0, 'E) 4 CONFIRMED = 0 pagas (credito ainda futuro)');
    assert(h.status !== 'completed', 'E) 4 CONFIRMED NAO e completed', `obtido ${h.status}`);
  }

  // -------------------------------------------------------------------------
  section('F — PAID nao conta como paga (R1)');
  {
    const h = await historico(['RECEIVED', 'PAID', 'PAID', 'PAID']);
    eq(h.receivedInstallments, 1, 'F) PAID nao incrementa a contagem');
    eq(rotulo(h), '1 de 4 parcelas pagas', 'F) rotulo = "1 de 4 parcelas pagas"');
    assert(h.status !== 'completed', 'F) uiStatus NAO e completed', `obtido ${h.status}`);
  }

  // -------------------------------------------------------------------------
  section('G — compras a vista preservadas');
  {
    const h = await historico(['RECEIVED']);
    eq(h.receivedInstallments, 1, 'G) 1x recebida: receivedInstallments = 1');
    eq(h.totalInstallments, 1, 'G) 1x: totalInstallments = 1');
    eq(rotulo(h), 'A vista'.replace('A vista', 'À vista'), 'G) rotulo = "À vista"');
    eq(h.status, 'completed', 'G) 1x recebida continua completed');
  }
  {
    const h = await historico(['PENDING']);
    eq(h.receivedInstallments, 0, 'G) 1x pendente: receivedInstallments = 0');
    eq(h.status, 'pending', 'G) 1x pendente continua pending');
  }
  {
    const h = await historico(['CONFIRMED']);
    eq(h.receivedInstallments, 0, 'G) 1x CONFIRMED nao e paga');
    assert(h.status !== 'completed', 'G) 1x CONFIRMED NAO e completed', `obtido ${h.status}`);
  }

  // -------------------------------------------------------------------------
  section('Estados nao relacionados a parcelamento preservados');
  {
    const h = await historico(['REFUNDED', 'REFUNDED', 'REFUNDED', 'REFUNDED']);
    eq(h.status, 'refunded', 'compra integralmente estornada continua refunded');
  }
  {
    const h = await historico(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
    eq(h.status, 'failed', 'compra falha continua failed');
  }
  {
    const h = await historico(['CANCELLED']);
    eq(h.status, 'failed', 'CANCELLED continua mapeado para failed');
  }

  // -------------------------------------------------------------------------
  section('Evidencia real do Sandbox (compra 7d1ed64a) continua 4/4');
  {
    const h = await historico(['RECEIVED', 'RECEIVED', 'RECEIVED', 'RECEIVED']);
    eq(rotulo(h), '4 de 4 parcelas pagas',
      'o 4/4 do Sandbox permanece correto: as 4 estao mesmo RECEIVED');
    eq(h.status, 'completed', 'e o status geral continua completed');
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`P-1.18F.3  PASS=${pass}  FAIL=${fail}`);
  console.log('='.repeat(56));
  if (fail > 0) process.exit(1);
}

main();
