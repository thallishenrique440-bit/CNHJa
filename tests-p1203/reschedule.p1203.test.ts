/**
 * P-1.20.3 — Remarcacao do aluno com mais de 24h nao pode regredir o status.
 *
 * NATUREZA DESTES TESTES: sao ESTRUTURAIS sobre o codigo-fonte. `confirmReschedule`
 * vive dentro de um componente React e faz chamadas diretas ao Supabase; nao ha'
 * harness de render neste projeto. O que se prova aqui e' o contrato do codigo:
 * quais campos a remarcacao escreve, quais NAO escreve, e que o par perigoso
 * (status='pending_approval' + payment_status='paid') nao pode mais nascer deste
 * caminho. Isso cobre exatamente o risco identificado, que e' de escrita.
 */
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

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const semComentarios = (src: string) =>
  src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Extrai o corpo de uma funcao declarada como `const nome = ...` ate' o proximo `const` de mesmo nivel. */
function corpoDaFuncao(src: string, nome: string): string {
  const i = src.indexOf(`const ${nome}`);
  if (i < 0) throw new Error(`Funcao ${nome} nao encontrada`);
  const j = src.indexOf('\n  const ', i + 10);
  return src.slice(i, j > 0 ? j : undefined);
}

const lessonsSrc = read('pages/student/Lessons.tsx');
const confirmReschedule = corpoDaFuncao(lessonsSrc, 'confirmReschedule');
const confirmRescheduleCodigo = semComentarios(confirmReschedule);
const requestReschedule = corpoDaFuncao(lessonsSrc, 'requestReschedule');
const requestRescheduleCodigo = semComentarios(requestReschedule);

// ---------------------------------------------------------------------------
section('A — aula ja aceita remarcada com >24h preserva o status');

eq(confirmRescheduleCodigo.includes('pending_approval'), false,
  'A) confirmReschedule nao contem pending_approval em codigo');
eq(/status\s*:/.test(confirmRescheduleCodigo), false,
  'A) confirmReschedule nao escreve o campo status em nenhum objeto');
assert(/\.update\(\{[\s\S]*?\}\)/.test(confirmRescheduleCodigo),
  'A) confirmReschedule continua fazendo update em appointments');
assert(/date:\s*dateKey/.test(confirmRescheduleCodigo), 'A) grava date');
assert(/start_time:\s*startTimeStr/.test(confirmRescheduleCodigo), 'A) grava start_time');
assert(/end_time:\s*endTimeStr/.test(confirmRescheduleCodigo), 'A) grava end_time');
assert(/rescheduled_at:\s*new Date\(\)\.toISOString\(\)/.test(confirmRescheduleCodigo),
  'A) grava rescheduled_at');
assert(/updated_at:\s*new Date\(\)\.toISOString\(\)/.test(confirmRescheduleCodigo),
  'A) grava updated_at');

// notificacao ao instrutor, reutilizando o RPC ja existente
assert(/create_unified_notification/.test(confirmRescheduleCodigo),
  'A) instrutor e notificado pelo RPC ja existente');
assert(/p_user_id:\s*lessonToReschedule\.instructorId/.test(confirmRescheduleCodigo),
  'A) a notificacao vai para o instrutor da aula');
assert(/remarcou/.test(confirmReschedule),
  'A) a mensagem diz que o aluno REMARCOU (nao "solicitou")');
assert(/novaDataStr|novaHoraStr/.test(confirmRescheduleCodigo),
  'A) a mensagem informa o novo horario');

// ---------------------------------------------------------------------------
section('B — aula pending_approval legitima nao e forcada para confirmed');

eq(/status\s*:\s*['"]confirmed['"]/.test(confirmRescheduleCodigo), false,
  'B) nao forca confirmed');
eq(/status\s*:\s*['"]scheduled['"]/.test(confirmRescheduleCodigo), false,
  'B) nao forca scheduled');
assert(!/status/.test(confirmRescheduleCodigo.split('.update(')[1]?.split('})')[0] || ''),
  'B) o payload do update nao menciona status — o estado vigente e preservado por omissao');

// ---------------------------------------------------------------------------
section('C — o texto nao promete mais aprovacao do instrutor');

eq(/Aguarde a aprova/i.test(confirmReschedule), false,
  'C) texto "Aguarde a aprovação do instrutor" removido');
const toastMatch = confirmReschedule.match(/addToast\((["'])(.*?)\1/);
assert(!!toastMatch, 'C) existe um toast de sucesso');
if (toastMatch) {
  const texto = toastMatch[2];
  assert(!/aprova/i.test(texto), `C) o toast nao menciona aprovacao ("${texto}")`);
  assert(/remarcada/i.test(texto), 'C) o toast diz que a aula foi remarcada');
  assert(/notificado/i.test(texto), 'C) o toast diz que o instrutor foi notificado');
}

// ---------------------------------------------------------------------------
section('D — nenhum caminho de refund a partir da remarcacao');

for (const proibido of ['cancel-booking', 'processCancellation', 'BookingCancellationCore', 'auto_expired']) {
  eq(confirmRescheduleCodigo.includes(proibido), false,
    `D) confirmReschedule nao referencia ${proibido}`);
}
assert(!/payment_status/.test(confirmRescheduleCodigo),
  'D) confirmReschedule nao toca payment_status');
assert(!/payment_installments|payment_settlements|transactions/.test(confirmRescheduleCodigo),
  'D) confirmReschedule nao toca nenhuma tabela financeira');

// ---------------------------------------------------------------------------
section('E — o par perigoso do cron nao pode mais nascer daqui');

{
  // O modulo B de check-expired-bookings seleciona exatamente esta combinacao.
  const cron = read('supabase/functions/check-expired-bookings/index.ts');
  assert(/\.eq\('status',\s*'pending_approval'\)/.test(cron),
    'E) o cron realmente filtra status=pending_approval (premissa do risco)');
  assert(/\.eq\('payment_status',\s*'paid'\)/.test(cron),
    'E) o cron realmente filtra payment_status=paid (premissa do risco)');
  assert(/auto_expired/.test(cron),
    'E) o cron realmente chama o cancelamento com auto_expired');

  // e a remarcacao nao escreve nenhum dos dois campos
  eq(/status\s*:|payment_status\s*:/.test(confirmRescheduleCodigo), false,
    'E) a remarcacao nao escreve status nem payment_status — o par nao pode ser criado');
}

// ---------------------------------------------------------------------------
section('F — fluxos fora do escopo permanecem intactos');

// <24h: continua sendo apenas um carimbo
assert(/reschedule_requested_at:\s*new Date\(\)\.toISOString\(\)/.test(requestRescheduleCodigo),
  'F) requestReschedule (<24h) continua gravando reschedule_requested_at');
eq(/date:|start_time:|end_time:|status:/.test(requestRescheduleCodigo), false,
  'F) requestReschedule (<24h) continua sem alterar horario nem status');

// instrutor: arquivo intocado nesta fase
{
  const agenda = read('pages/InstructorAgenda.tsx');
  assert(/rescheduled_at:\s*new Date\(\)\.toISOString\(\)/.test(agenda),
    'F) o fluxo do instrutor continua gravando rescheduled_at');
  assert(/reschedule_requested_at:\s*null/.test(agenda),
    'F) o fluxo do instrutor continua limpando reschedule_requested_at');
}

// financeiro/autoridades intocadas
for (const arquivo of [
  'lib/payments/BookingCancellationCore.ts',
  'supabase/functions/check-expired-bookings/index.ts',
  'supabase/functions/cancel-booking/index.ts',
  'api/reconcile-payment.ts'
]) {
  assert(fs.existsSync(path.join(root, arquivo)), `F) ${arquivo} presente e nao removido`);
}

console.log(`\n${'='.repeat(56)}`);
console.log(`P-1.20.3  PASS=${pass}  FAIL=${fail}`);
console.log('='.repeat(56));
if (fail > 0) process.exit(1);
