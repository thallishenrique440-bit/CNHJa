/**
 * FinanceUiCoherenceP122.unit.test.ts
 *
 * P-1.22 — coerencia visual entre o historico financeiro do ALUNO e o do
 * INSTRUTOR. Dois ajustes, ambos de APRESENTACAO:
 *
 *   1. INSTRUTOR: identificar aula avulsa x pacote (isCombo = lessonCount > 1),
 *      derivado dos dados que a P-1.21A ja entrega. Mesma origem logica do aluno.
 *   2. ALUNO: o horario da aula individual deixa de vazar os segundos
 *      ("10:00:00" -> "10:00"), reusando `formatLessonTimeRange`.
 *
 * Os dois adapters sao classes puras: recebem um objeto e devolvem o view model.
 * Nada aqui toca banco, servico, calculo financeiro ou remarcacao.
 */
import { readFileSync } from 'node:fs';
import { InstructorHistoryAdapter } from '../../../components/finance/adapters/InstructorHistoryAdapter.js';
import { StudentHistoryAdapter } from '../../../components/finance/adapters/StudentHistoryAdapter.js';

let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string) => {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
};

/**
 * O ICU do ambiente decide detalhes do pt-BR ("18 de set" x "18 set") e usa
 * ESPACO NAO-QUEBRAVEL em "R$ 90,00". Os asserts abaixo normalizam o espaco e
 * verificam a ESTRUTURA do texto, nunca uma string literal dependente de ICU.
 */
const norm = (v?: string) => (v || '').replace(/\u00A0/g, ' ');

const LESSON_1 = { id: 'a1', date: '2026-09-18', startTime: '07:00:00', endTime: '08:00:00' };
const LESSON_2 = { id: 'a2', date: '2026-09-18', startTime: '08:00:00', endTime: '09:00:00' };

/** Base financeira identica nos dois cenarios do instrutor: R$100, 10%, R$90. */
const instructorBase = {
  id: 'set_1',
  status: 'received',
  studentName: 'Cristina Aumeida',
  grossAmount: 10199,
  feeAmount: 199,
  platformFee: 1000,
  commissionCnhJaCents: 1000,
  netAmount: 9000,
  groupId: 'grp_1',
  totalInstallments: 1,
  receivedInstallments: 1,
};

function run() {
  console.log('\n======================================================');
  console.log('🧪 P-1.22: coerencia visual aluno x instrutor');
  console.log('======================================================\n');

  // =====================================================================
  // A) INSTRUTOR — aula individual
  // =====================================================================
  const single = InstructorHistoryAdapter.toViewModel({
    ...instructorBase, type: 'lesson',
    lessons: [LESSON_1], lessonCount: 1, isCombo: false,
  } as any);

  assert(single.lessons.isCombo === false, 'A. aula individual NAO e marcada como combo');
  assert(single.lessons.items === undefined,
    'A. aula individual nao lista aulas na gaveta (o subtitulo ja diz)');
  assert(/\b18\b/.test(norm(single.header.subtitle))
      && /às 07:00 - 08:00$/.test(norm(single.header.subtitle)),
    `A. aula individual mostra data e horario no subtitulo (obtido: ${single.header.subtitle})`);
  assert(!/:\d{2}:\d{2}/.test(norm(single.header.subtitle)),
    'A. o subtitulo do instrutor nao traz segundos');
  assert(!/Pacote/.test(single.header.subtitle || ''),
    'A. aula individual nao usa a palavra "Pacote"');
  assert(single.details.breakdownTitle === undefined,
    'A. aula individual sem titulo de gaveta de pacote');
  const singleValor = (single.details.breakdownItems ?? []).find(i => /Valor/.test(i.label));
  assert(singleValor?.label === 'Valor da aula:',
    `A. aula individual mantem o rotulo "Valor da aula:" (obtido: ${singleValor?.label})`);

  // =====================================================================
  // B) INSTRUTOR — pacote
  // =====================================================================
  const combo = InstructorHistoryAdapter.toViewModel({
    ...instructorBase, id: 'set_2', type: 'lesson',
    lessons: [LESSON_1, LESSON_2], lessonCount: 2, isCombo: true,
  } as any);

  assert(combo.lessons.isCombo === true, 'B. pacote e marcado como combo');
  assert(norm(combo.header.subtitle) === 'Pacote • 2 aulas',
    `B. pacote se identifica no cabecalho (obtido: ${combo.header.subtitle})`);
  assert(combo.lessons.lessonCount === 2, 'B. quantidade de aulas preservada');
  assert(combo.lessons.items?.length === 2, 'B. as 2 aulas continuam listadas');
  assert(/\b18\b/.test(norm(combo.lessons.items?.[0]?.dateFormatted))
      && combo.lessons.items?.[0]?.timeRangeFormatted === '07:00 - 08:00',
    `B. aula 1: data e horario inalterados (obtido: ${combo.lessons.items?.[0]?.dateFormatted} / ${combo.lessons.items?.[0]?.timeRangeFormatted})`);
  assert(/\b18\b/.test(norm(combo.lessons.items?.[1]?.dateFormatted))
      && combo.lessons.items?.[1]?.timeRangeFormatted === '08:00 - 09:00',
    'B. aula 2: data e horario inalterados');

  // =====================================================================
  // E) FINANCEIRO — identico nos dois cenarios do instrutor
  // =====================================================================
  const fin = (vm: any) => JSON.stringify({
    amount: vm.amount.valueFormatted,
    breakdown: (vm.details.breakdownItems ?? []).map((i: any) => i.valueFormatted),
  });
  assert(single.amount.valueFormatted === combo.amount.valueFormatted,
    'E. valor recebido identico com e sem a flag de combo');
  const comissao = (vm: any) =>
    (vm.details.breakdownItems ?? []).find((i: any) => /Comiss/.test(i.label))?.valueFormatted;
  assert(comissao(single) === comissao(combo),
    `E. comissao identica nos dois (${comissao(single)})`);
  assert(norm(comissao(single)) === '-R$ 10,00',
    `E. comissao exibida = R$ 10,00 (obtido ${comissao(single)})`);
  const recebeu = (vm: any) =>
    (vm.details.breakdownItems ?? []).find((i: any) => /recebeu/i.test(i.label))?.valueFormatted;
  assert(norm(recebeu(single)) === 'R$ 90,00',
    `E. "Voce recebeu" = R$ 90,00 (obtido ${recebeu(single)})`);
  assert(recebeu(single) === recebeu(combo), 'E. liquido identico nos dois');
  assert(fin(single).replace('aula', 'pacote') !== '' && single.metadata.groupId === 'grp_1'
      && combo.metadata.groupId === 'grp_1',
    'E. group_id preservado nos dois');

  // =====================================================================
  // C) ALUNO — aula individual sem segundos
  // =====================================================================
  const studentBase = {
    id: 'hist_1',
    status: 'completed',
    isFinancial: true,
    instructorName: 'Alex Brandão',
    grossAmountCents: 10199,
    feeAmountCents: 199,
    lessonPriceCents: 10000,
    totalInstallments: 1,
    receivedInstallments: 1,
    groupId: 'grp_1',
  };

  const stSingle = StudentHistoryAdapter.toViewModel({
    ...studentBase, type: 'lesson', isCombo: false, lessonCount: 1,
    appointmentDate: '2026-09-22', appointmentTime: '10:00:00',
    lessons: [{ id: 'a9', date: '2026-09-22', startTime: '10:00:00', endTime: '11:00:00' }],
  } as any);

  assert(/^Alex Brandão • .*\b22\b.* às 10:00$/.test(norm(stSingle.header.subtitle)),
    `C. aluno: horario sem segundos (obtido: ${stSingle.header.subtitle})`);
  assert(!/10:00:00/.test(stSingle.header.subtitle || ''),
    'C. aluno: "10:00:00" nao aparece mais');
  assert(/\b22\b/.test(norm(stSingle.header.subtitle)) && /set/.test(norm(stSingle.header.subtitle)),
    'C. aluno: a data continua a mesma (sem deslocamento de fuso)');
  assert(stSingle.header.title === '🚗 Aula', 'C. aluno: titulo de aula individual inalterado');

  // =====================================================================
  // D) ALUNO — combo inalterado
  // =====================================================================
  const stCombo = StudentHistoryAdapter.toViewModel({
    ...studentBase, id: 'hist_2', type: 'combo', isCombo: true, lessonCount: 2,
    appointmentDate: '2026-09-18', appointmentTime: '07:00:00',
    lessons: [LESSON_1, LESSON_2],
    latestPaymentDate: '2026-09-18T12:00:00Z',
  } as any);

  assert(stCombo.header.title === 'Combo • 2 aulas',
    `D. aluno: combo mantem o titulo (obtido: ${stCombo.header.title})`);
  assert(stCombo.header.subtitle === 'Alex Brandão',
    'D. aluno: subtitulo do combo continua sendo so o instrutor');
  assert(stCombo.lessons.items?.length === 2, 'D. aluno: combo lista as 2 aulas');
  assert(stCombo.lessons.items?.[0]?.timeRangeFormatted === '07:00 - 08:00',
    'D. aluno: horarios do combo inalterados');

  // =====================================================================
  // estatico: o escopo da fase
  // =====================================================================
  const page = readFileSync('pages/InstructorFinance.tsx', 'utf-8');
  assert(/isCombo: \(entry\.lessonCount \?\? 0\) > 1/.test(page),
    'estatico: isCombo derivado de lessonCount, sem consulta nova');
  const svc = readFileSync('lib/payments/services/InstructorFinanceReadService.ts', 'utf-8');
  assert(!/isCombo/.test(svc),
    'estatico: o read service NAO foi tocado pela P-1.22');
  const studentSvc = readFileSync('lib/payments/services/StudentFinanceReadService.ts', 'utf-8');
  assert(!/formatLessonTimeRange/.test(studentSvc),
    'estatico: o read service do aluno NAO foi tocado pela P-1.22');

  console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
  if (failed > 0) process.exit(1);
}

run();
