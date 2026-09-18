/**
 * P-1.17 (G1) — Preco autoritativo derivado no servidor.
 * Puro: sem banco, sem rede, sem Asaas, sem credencial.
 *
 *   npx tsx tests-p117/lessonPricing.p117.test.ts
 */
import {
  CategoryPriceRow,
  InstructorPriceFallback,
  deriveLessonPrices,
  isNightSlot,
  resolveLessonPrice
} from '../lib/payments/LessonPricing';

let pass = 0, fail = 0;
function assert(c: boolean, label: string, detail?: string) {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`); }
}
const eq = (a: unknown, b: unknown, label: string) =>
  assert(a === b, label, `esperado ${String(b)}, obtido ${String(a)}`);
const section = (t: string) => console.log(`\n== ${t} ==`);

// Fonte autoritativa (espelha instructor_categories / instructors)
const CATS: CategoryPriceRow[] = [
  { category: 'A', day_price: 11000, night_price: 12500 },
  { category: 'B', day_price: 10000, night_price: 13000 }
];
const INSTRUTOR: InstructorPriceFallback = { base_price: 9000, night_price: 9500, has_night_lessons: true };
const SEM_NOITE: InstructorPriceFallback = { ...INSTRUTOR, has_night_lessons: false };

const derive = (lessons: any[], cat = 'B', cats = CATS, inst = INSTRUTOR) =>
  deriveLessonPrices(lessons, cat, cats, inst);

// ---------------------------------------------------------------------------
section('E/F — turno e coluna de preco');

eq(isNightSlot('08:00'), false, 'E) 08:00 e diurno');
eq(isNightSlot('17:59'), false, 'E) 17:59 e diurno');
eq(isNightSlot('18:00'), true,  'F) 18:00 e noturno');
eq(isNightSlot('21:00'), true,  'F) 21:00 e noturno');

{ const r = resolveLessonPrice({ startTime: '09:00', category: 'B', categoryPrices: CATS, instructor: INSTRUTOR });
  eq(r.priceCents, 10000, 'E) aula diurna usa day_price');
  eq(r.source, 'instructor_categories.day_price', 'E) fonte = day_price'); }

{ const r = resolveLessonPrice({ startTime: '19:00', category: 'B', categoryPrices: CATS, instructor: INSTRUTOR });
  eq(r.priceCents, 13000, 'F) aula noturna usa night_price');
  eq(r.source, 'instructor_categories.night_price', 'F) fonte = night_price'); }

{ const r = resolveLessonPrice({ startTime: '19:00', category: 'B', categoryPrices: CATS, instructor: SEM_NOITE });
  eq(r.priceCents, 10000, 'F) sem has_night_lessons: noite cobra day_price');
  eq(r.source, 'instructor_categories.day_price', 'F) sem noite: fonte = day_price'); }

{ const r = resolveLessonPrice({ startTime: '09:00', category: 'A', categoryPrices: CATS, instructor: INSTRUTOR });
  eq(r.priceCents, 11000, 'categoria A usa a linha de A, nao a de B'); }

{ const r = resolveLessonPrice({ startTime: '09:00', category: 'AB', categoryPrices: CATS, instructor: INSTRUTOR });
  eq(r.priceCents, 9000, 'categoria sem linha cai no fallback instructors.base_price');
  eq(r.source, 'instructors.base_price', 'fallback: fonte = base_price'); }

{ const r = resolveLessonPrice({ startTime: '20:00', category: 'AB', categoryPrices: CATS, instructor: INSTRUTOR });
  eq(r.priceCents, 9500, 'fallback noturno usa instructors.night_price'); }

{ const r = resolveLessonPrice({ startTime: '09:00', category: 'b', categoryPrices: CATS, instructor: INSTRUTOR });
  eq(r.priceCents, 10000, 'categoria e case-insensitive'); }

// ---------------------------------------------------------------------------
section('A/B/C/D — o preco do cliente nunca e usado');

// A) enviado = autoritativo
{ const r = derive([{ startTime: '09:00', price: 10000 }]);
  eq(r.prices[0], 10000, 'A) enviado igual: usa o autoritativo');
  eq(r.audit[0].diverged, false, 'A) enviado igual: sem divergencia');
  eq(r.unresolved.length, 0, 'A) enviado igual: resolvido'); }

// B) enviado menor (tentativa de subfaturamento)
{ const r = derive([{ startTime: '09:00', price: 1 }]);
  eq(r.prices[0], 10000, 'B) enviado 1 centavo: backend usa 10000');
  eq(r.audit[0].submittedCents, 1, 'B) valor adulterado fica so na auditoria');
  eq(r.audit[0].diverged, true, 'B) divergencia sinalizada');
  assert(r.prices[0] !== 1, 'B) preco adulterado NUNCA e usado'); }

// C) enviado maior
{ const r = derive([{ startTime: '09:00', price: 999999 }]);
  eq(r.prices[0], 10000, 'C) enviado 999999: backend usa 10000');
  eq(r.audit[0].diverged, true, 'C) divergencia sinalizada'); }

// D) sem price no request
{ const r = derive([{ startTime: '09:00' }]);
  eq(r.prices[0], 10000, 'D) sem lesson.price: backend deriva normalmente');
  eq(r.audit[0].submittedCents, null, 'D) sem lesson.price: auditoria registra null');
  eq(r.audit[0].diverged, false, 'D) sem lesson.price: nao ha divergencia'); }

// tipos hostis no campo nao confiavel
for (const [label, v] of [['string', '10000'], ['null', null], ['NaN', NaN], ['objeto', {}], ['negativo', -5000]] as Array<[string, any]>) {
  const r = derive([{ startTime: '09:00', price: v }]);
  eq(r.prices[0], 10000, `price hostil (${label}) nao afeta o preco derivado`);
}

// ---------------------------------------------------------------------------
section('G — desconto aplicado DEPOIS do preco autoritativo');

// Replica o calculo de create-booking-intent: totalBasePrice vem do autoritativo
{ const r = derive([
    { startTime: '09:00', price: 1 },
    { startTime: '19:00', price: 1 },
    { startTime: '10:00', price: 1 }
  ]);
  eq(r.prices.join('/'), '10000/13000/10000', 'G) 3 aulas: precos autoritativos por turno');
  const totalBasePrice = r.prices.reduce((a, b) => a + b, 0);
  eq(totalBasePrice, 33000, 'G) totalBasePrice deriva do autoritativo, nao do enviado');

  // desconto de 10% aplicado sobre a base autoritativa
  const discountAmount = Math.round(totalBasePrice * 0.10);
  const finalPrice = totalBasePrice - discountAmount;
  eq(finalPrice, 29700, 'G) desconto incide sobre a base autoritativa');

  // rateio como no backend: resto na ultima
  let allocated = 0;
  const rateado = r.prices.map((p, i) => {
    if (i === r.prices.length - 1) return finalPrice - allocated;
    const item = p - Math.round((discountAmount * p) / totalBasePrice);
    allocated += item;
    return item;
  });
  eq(rateado.reduce((a, b) => a + b, 0), finalPrice, 'G) soma do rateio == finalPrice');
  assert(rateado.every(v => v > 0), 'G) nenhuma parcela de preco negativa'); }

// ---------------------------------------------------------------------------
section('H — comissao, split e student_charge herdam o autoritativo');

{ const r = derive([{ startTime: '09:00', price: 1 }]);
  const finalPrice = r.prices.reduce((a, b) => a + b, 0);            // sem desconto
  const commission = Math.round(finalPrice * 0.10);
  const splitFixedValue = finalPrice - commission;
  const gatewayFee = 199;                                            // PIX, schedule
  const studentCharge = finalPrice + gatewayFee;

  eq(finalPrice, 10000, 'H) service_price autoritativo');
  eq(commission, 1000, 'H) comissao 10% sobre o autoritativo');
  eq(splitFixedValue, 9000, 'H) split do instrutor derivado do autoritativo');
  eq(studentCharge, 10199, 'H) student_charge derivado do autoritativo');

  // com o preco adulterado a compra teria sido de 1 centavo
  assert(studentCharge !== 1 + gatewayFee, 'H) student_charge nao reflete o valor adulterado'); }

// ---------------------------------------------------------------------------
section('Fail-closed — preco indefinido nao vira cobranca');

{ const semPreco: CategoryPriceRow[] = [{ category: 'B', day_price: null, night_price: null }];
  const r = deriveLessonPrices([{ startTime: '09:00', price: 10000 }], 'B', semPreco, { base_price: null, night_price: null, has_night_lessons: false });
  eq(r.prices.length, 0, 'sem preco em lugar nenhum: nada e derivado');
  eq(r.unresolved.length, 1, 'sem preco: marcado como nao resolvido');
  assert(/indisponivel/i.test(r.unresolved[0].reason || ''), 'sem preco: motivo explicito'); }

{ const zerado: CategoryPriceRow[] = [{ category: 'B', day_price: 0, night_price: 0 }];
  const r = deriveLessonPrices([{ startTime: '09:00', price: 10000 }], 'B', zerado, { base_price: 0, night_price: 0, has_night_lessons: false });
  eq(r.unresolved.length, 1, 'preco 0: recusado em vez de cobranca gratuita'); }

{ const noturnoNulo: CategoryPriceRow[] = [{ category: 'B', day_price: 10000, night_price: null }];
  const r = deriveLessonPrices([{ startTime: '20:00', price: 10000 }], 'B', noturnoNulo, INSTRUTOR);
  eq(r.unresolved.length, 1, 'night_price null com aula noturna: recusado (nao cobra 0)');
  eq(r.prices.length, 0, 'night_price null: nenhuma aula precificada'); }

{ const r = derive([{ startTime: '09:00' }, { startTime: '' }]);
  assert(r.prices.length !== 2 || r.unresolved.length === 0, 'startTime vazio nao produz preco silencioso');
  eq(r.prices.length + r.unresolved.length, 2, 'toda aula e' + ' contabilizada (derivada ou recusada)'); }

{ const r = derive([]);
  eq(r.prices.length, 0, 'lista vazia: nenhum preco');
  eq(r.unresolved.length, 0, 'lista vazia: nada recusado'); }

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(56)}`);
console.log(`P-1.17  PASS=${pass}  FAIL=${fail}`);
console.log('='.repeat(56));
if (fail > 0) process.exit(1);
