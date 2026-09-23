/**
 * InstructorStatementLessonsP121A.unit.test.ts
 *
 * P-1.21A — o historico financeiro do instrutor passa a carregar data e
 * horario da aula.
 *
 * O que este arquivo prova:
 *   A) aula individual  -> lessons[] com 1 item (data/inicio/fim);
 *   B) pacote           -> lessons[] preserva TODAS as aulas, ordenadas;
 *   C) lancamento sem appointment correspondente -> historico nao quebra;
 *   D) lancamentos continuam aparecendo e com valores inalterados;
 *   E) nenhum calculo financeiro novo: os campos financeiros do DTO sao
 *      byte-a-byte os mesmos com e sem o enriquecimento.
 *
 * Alem do comportamento, um bloco estatico garante que `appointments` e' lida
 * SOMENTE para apresentacao (nenhuma coluna financeira no select).
 */
import { readFileSync } from 'node:fs';
import { InstructorFinanceReadService } from '../services/InstructorFinanceReadService.js';

let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string) => {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
};

const INSTRUCTOR = 'instr_1';

/** Linha de settlement: uma aula individual de R$100 (P-1.18E). */
const SINGLE = {
  id: 'set_single',
  installment_id: 'inst_single',
  instructor_id: INSTRUCTOR,
  student_id: 'stud_1',
  appointment_id: 'appt_single',
  provider_payment_id: 'pay_single',
  settlement_type: 'PAYMENT',
  gross_amount: 10199,
  net_amount: 9000,
  platform_fee: 1000,
  fee_amount: 199,
  instructor_amount: 9000,
  settled_at: '2026-09-23T00:00:00Z',
  created_at: '2026-09-23T00:00:00Z',
  payment_installments: {
    id: 'inst_single', instructor_id: INSTRUCTOR, student_id: 'stud_1',
    group_id: null, installment_number: 1, total_installments: 1,
    due_date: '2026-09-23T00:00:00Z', payment_date: '2026-09-23T00:00:00Z',
    status: 'RECEIVED', profiles: { full_name: 'Aluno Um' }
  }
};

/** Linha de settlement de um PACOTE de 3 aulas (mesmo group_id). */
const COMBO = {
  ...SINGLE,
  id: 'set_combo',
  installment_id: 'inst_combo',
  student_id: 'stud_2',
  appointment_id: 'appt_c1',
  provider_payment_id: 'pay_combo',
  gross_amount: 30597,
  net_amount: 27000,
  platform_fee: 3000,
  fee_amount: 597,
  instructor_amount: 27000,
  payment_installments: {
    id: 'inst_combo', instructor_id: INSTRUCTOR, student_id: 'stud_2',
    group_id: 'grp_combo', installment_number: 1, total_installments: 1,
    due_date: '2026-09-23T00:00:00Z', payment_date: '2026-09-23T00:00:00Z',
    status: 'RECEIVED', profiles: { full_name: 'Aluno Dois' }
  }
};

/** Settlement SEM aula correspondente em appointments (caso C). */
const ORPHAN = {
  ...SINGLE,
  id: 'set_orphan',
  installment_id: 'inst_orphan',
  student_id: 'stud_3',
  appointment_id: 'appt_inexistente',
  provider_payment_id: 'pay_orphan',
  payment_installments: {
    id: 'inst_orphan', instructor_id: INSTRUCTOR, student_id: 'stud_3',
    group_id: null, installment_number: 1, total_installments: 1,
    due_date: '2026-09-20T00:00:00Z', payment_date: '2026-09-20T00:00:00Z',
    status: 'RECEIVED', profiles: { full_name: 'Aluno Tres' }
  }
};

/** Aulas em `appointments`. As 3 do pacote sao inseridas FORA DE ORDEM. */
const APPOINTMENTS = [
  { id: 'appt_single', group_id: null, provider_payment_id: 'pay_single',
    date: '2026-09-24', start_time: '08:00:00', end_time: '09:00:00' },
  { id: 'appt_c3', group_id: 'grp_combo', provider_payment_id: 'pay_combo',
    date: '2026-10-10', start_time: '10:00:00', end_time: '11:00:00' },
  { id: 'appt_c1', group_id: 'grp_combo', provider_payment_id: 'pay_combo',
    date: '2026-09-26', start_time: '14:00:00', end_time: '15:00:00' },
  { id: 'appt_c2', group_id: 'grp_combo', provider_payment_id: 'pay_combo',
    date: '2026-10-03', start_time: '09:00:00', end_time: '10:00:00' },
];

/** Mock encadeavel: qualquer sequencia de metodos resolve nos dados da tabela. */
function makeClient(opts: { withAppointments: boolean }) {
  const chain = (rows: any[]): any => {
    const node: any = {
      select: () => chain(rows),
      eq: () => chain(rows),
      in: () => chain(rows),
      order: () => chain(rows),
      limit: () => chain(rows),
      range: () => chain(rows),
      then: (resolve: any) => resolve({ data: rows, error: null })
    };
    return node;
  };

  return {
    from: (table: string) => {
      if (table === 'payment_settlements') return chain([SINGLE, COMBO, ORPHAN]);
      if (table === 'payment_installments') return chain([]);
      if (table === 'profiles') return chain([]);
      if (table === 'appointments') {
        // Simula o ambiente sem enriquecimento: a tabela nao responde.
        return opts.withAppointments ? chain(APPOINTMENTS) : undefined;
      }
      return undefined;
    }
  } as any;
}

async function run() {
  console.log('\n======================================================');
  console.log('🧪 P-1.21A: data/horario da aula no extrato do instrutor');
  console.log('======================================================\n');

  const service = new InstructorFinanceReadService();

  const withAppt = await service.getStatement(
    makeClient({ withAppointments: true }) as any, INSTRUCTOR);
  const withoutAppt = await service.getStatement(
    makeClient({ withAppointments: false }) as any, INSTRUCTOR);

  const byId = (list: any[], id: string) => list.find(e => e.id === id);

  // ---- D: os lancamentos continuam todos la ------------------------------
  assert(withAppt.length === 3, 'D. os 3 lancamentos continuam no extrato');
  assert(withoutAppt.length === 3, 'D. sem appointments, os 3 tambem continuam');

  // ---- A: aula individual ------------------------------------------------
  const single = byId(withAppt, 'set_single');
  assert(!!single, 'A. lancamento da aula individual presente');
  assert(single?.lessons?.length === 1, 'A. lessons[] tem exatamente 1 aula');
  assert(single?.lessonCount === 1, 'A. lessonCount = 1');
  assert(single?.lessons?.[0]?.date === '2026-09-24', 'A. data da aula chega ao DTO');
  assert(single?.lessons?.[0]?.startTime === '08:00:00', 'A. horario de inicio chega ao DTO');
  assert(single?.lessons?.[0]?.endTime === '09:00:00', 'A. horario de termino chega ao DTO');

  // ---- B: pacote ---------------------------------------------------------
  const combo = byId(withAppt, 'set_combo');
  assert(combo?.lessons?.length === 3, 'B. pacote preserva as 3 aulas, nenhuma perdida');
  assert(combo?.lessonCount === 3, 'B. lessonCount = 3');
  assert(
    JSON.stringify(combo?.lessons?.map((l: any) => l.id)) ===
      JSON.stringify(['appt_c1', 'appt_c2', 'appt_c3']),
    'B. aulas ordenadas por data/hora mesmo vindo fora de ordem do banco'
  );

  // ---- C: lancamento sem aula correspondente -----------------------------
  const orphan = byId(withAppt, 'set_orphan');
  assert(!!orphan, 'C. lancamento sem appointment continua sendo exibido');
  assert(orphan?.lessons === undefined, 'C. sem aula, lessons[] fica indefinido (nao quebra)');
  assert(orphan?.netAmountCents === 9000, 'C. valores do lancamento orfao intactos');

  // ---- E: nenhum calculo financeiro novo ---------------------------------
  const FIN = ['grossAmountCents', 'netAmountCents', 'platformFeeCents',
               'feeAmountCents', 'commissionCnhJaCents', 'status'];
  const fin = (e: any) => FIN.map(k => `${k}=${e?.[k]}`).join('|');
  for (const id of ['set_single', 'set_combo', 'set_orphan']) {
    assert(fin(byId(withAppt, id)) === fin(byId(withoutAppt, id)),
      `E. ${id}: campos financeiros identicos com e sem enriquecimento`);
  }
  assert(byId(withAppt, 'set_single')?.netAmountCents === 9000,
    'E. aula de R$100 continua com net = R$90,00');
  assert(byId(withAppt, 'set_single')?.platformFeeCents === 1000,
    'E. platform_fee continua R$10,00 (nao tocado nesta fase)');

  // ---- estatico: `appointments` e lida so para apresentacao --------------
  const src = readFileSync('lib/payments/services/InstructorFinanceReadService.ts', 'utf-8');
  const apptBlock = src.slice(src.indexOf("from('appointments')"),
                              src.indexOf("from('appointments')") + 400);
  for (const col of ['gross_amount', 'net_amount', 'platform_fee', 'fee_amount',
                     'instructor_amount', 'price']) {
    assert(!apptBlock.includes(col),
      `estatico: o select de appointments nao le a coluna '${col}'`);
  }
  assert(apptBlock.includes('date') && apptBlock.includes('start_time')
         && apptBlock.includes('end_time'),
    'estatico: o select de appointments traz date/start_time/end_time');

  console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
  if (failed > 0) process.exit(1);
}

await run();
