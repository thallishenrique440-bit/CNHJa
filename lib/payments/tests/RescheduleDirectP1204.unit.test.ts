/**
 * RescheduleDirectP1204.unit.test.ts
 *
 * P-1.20.4 FASE 1 — contrato estatico da RPC `reschedule_appointment_direct`.
 *
 * O COMPORTAMENTO da RPC (as 20 validacoes, idempotencia, SLOT_TAKEN, grupo,
 * grade) foi exercitado contra um PostgreSQL 16 REAL e efemero, fora de
 * producao — 27 asserts, 0 falhas. Aquele harness e' SQL e nao roda neste
 * runner Node.
 *
 * O que este arquivo garante, e que nenhum teste de comportamento garante, e'
 * que o CORPO da funcao continue financeiramente neutro e que os privilegios
 * sigam o padrao seguro do projeto. E' a mesma tecnica de
 * RefundOperationRpcSecurity.unit.test.ts, que inspeciona a migration em disco.
 */
import { readFileSync } from 'node:fs';

const assert = (value: boolean, message: string) => {
  if (!value) { console.error(`FAIL: ${message}`); throw new Error(`FAIL: ${message}`); }
  console.log(`PASS: ${message}`);
};

const MIGRATION = 'supabase/migrations/20260923_p1204_01_reschedule_appointment_direct.sql';
const sql = readFileSync(MIGRATION, 'utf-8');

/** Corpo da funcao, sem comentarios de linha — o que realmente executa. */
const body = sql
  .slice(sql.indexOf('AS $function$'), sql.indexOf('$function$;') + 11)
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

// ---- assinatura e input minimo -------------------------------------------
assert(/CREATE OR REPLACE FUNCTION public\.reschedule_appointment_direct\(/.test(sql),
  'RPC declarada com o nome aprovado');
assert(/p_appointment_ids\s+uuid\[\]/.test(sql) && /p_new_date\s+date/.test(sql) && /p_new_start_time\s+time/.test(sql),
  'input minimo: apenas ids, data e hora');
assert(!/p_instructor_id|p_student_id|p_status|p_price|p_payment/.test(sql),
  'nenhum parametro de instrutor, aluno, status ou financeiro e recebido');
assert(/RETURNS jsonb/.test(sql), 'retorna jsonb');

// ---- seguranca -------------------------------------------------------------
assert(/SECURITY DEFINER/.test(sql), 'SECURITY DEFINER');
assert(/SET search_path TO 'pg_catalog', 'public'/.test(sql), 'search_path fixo');
assert(/REVOKE ALL ON FUNCTION public\.reschedule_appointment_direct\(uuid\[\], date, time\) FROM PUBLIC/.test(sql),
  'REVOKE de PUBLIC');
assert(/REVOKE ALL ON FUNCTION public\.reschedule_appointment_direct\(uuid\[\], date, time\) FROM anon/.test(sql),
  'REVOKE de anon');
assert(/GRANT EXECUTE ON FUNCTION public\.reschedule_appointment_direct\(uuid\[\], date, time\) TO authenticated/.test(sql),
  'GRANT somente a authenticated');

// ---- 17/18/20: neutralidade financeira ------------------------------------
const FORBIDDEN_WRITE_TARGETS = [
  'payment_installments', 'payment_settlements', 'refund_operations', 'transactions',
  'payment_status', 'price', 'payment_intent_id', 'provider_payment_id',
  'purchase_id', 'payment_id', 'provider_name'
];
for (const ident of FORBIDDEN_WRITE_TARGETS) {
  assert(!new RegExp(`\\b${ident}\\b`).test(body),
    `20. corpo da RPC nao contem o identificador financeiro '${ident}'`);
}

const FORBIDDEN_CALLS = [
  'BookingCancellationCore', 'SettlementService', 'InstallmentService',
  'asaas', 'Asaas', 'refund', 'estorno'
];
for (const ident of FORBIDDEN_CALLS) {
  assert(!new RegExp(ident).test(body),
    `17/18. corpo da RPC nao referencia '${ident}'`);
}

// ---- UPDATE: somente as 5 colunas permitidas -------------------------------
const updateBlock = body.slice(body.indexOf('UPDATE public.appointments a'), body.indexOf('GET DIAGNOSTICS'));
const ALLOWED = ['date', 'start_time', 'end_time', 'rescheduled_at', 'updated_at'];
const assigned = Array.from(updateBlock.matchAll(/^\s*(?:SET\s+)?(\w+)\s*=/gm)).map(m => m[1]);
assert(assigned.length === ALLOWED.length && assigned.every(c => ALLOWED.includes(c)),
  `UPDATE escreve exatamente [${ALLOWED.join(', ')}] — encontrado [${assigned.join(', ')}]`);
assert(!/\bstatus\s*=/.test(updateBlock),
  'P-1.20.3 preservado: o UPDATE nunca escreve `status`');

// ---- validacoes obrigatorias presentes -------------------------------------
const REQUIRED = [
  ['NOT_AUTHENTICATED', /auth\.uid\(\)/],
  ['1. propriedade', /NOT_OWNER/],
  ['2. mesmo grupo', /GROUP_MISMATCH/],
  ['3. status elegivel', /INVALID_STATUS/],
  ['4. proposta pendente', /RESCHEDULE_PENDING/],
  ['5. regra das 24h', /UNDER_24H/],
  ['5b. 24h em America/Sao_Paulo no servidor', /America\/Sao_Paulo/],
  ['6. novo horario futuro', /NEW_SLOT_IN_PAST/],
  ['7. mesmo instrutor', /INSTRUCTOR_MISMATCH/],
  ['8. grade de agendamento', /SLOT_NOT_IN_GRID/],
  ['9. conflito', /SLOT_TAKEN/],
  ['9b. reusa check_appointment_conflict', /public\.check_appointment_conflict\(/],
  ['13. idempotencia', /already_at_requested_slot/],
  ['trava de linha', /FOR UPDATE/],
  ['notificacao server-side', /public\.create_unified_notification\(/],
  ['23505 nao vaza', /WHEN unique_violation THEN/]
] as const;
for (const [label, re] of REQUIRED) {
  assert(re.test(body) || re.test(sql), `validacao presente: ${label}`);
}

// ---- grade: espelha api/create-booking-intent.ts, nao a UI de remarcacao ---
// A UNICA validacao de grade server-side ja existente no projeto esta em
// api/create-booking-intent.ts:314-360, dentro de `for (const lesson of lessons)`:
// cada aula do pacote e validada individualmente. Estes asserts garantem que a
// RPC nao volte a usar valores hardcoded.
assert(/i\.lunch_active/.test(body) && /i\.lunch_start_slot/.test(body) && /i\.lunch_duration/.test(body),
  'grade: almoco vem da config do instrutor (lunch_active/lunch_start_slot/lunch_duration)');
assert(!/IN \(12, 13\)|IN \(12,13\)/.test(body),
  'grade: nenhum horario de almoco hardcoded 12/13');
assert(/11 \* 60 \+ 10/.test(body),
  'grade: limite de sabado sem work_saturday_afternoon e 11:10, igual ao create-booking-intent');
assert(/v_minutes >= 18 \* 60/.test(body),
  'grade: aula noturna bloqueada a partir das 18:00, igual ao create-booking-intent');
const loopBody = body.slice(body.indexOf('FOR v_rec IN'), body.indexOf('IF v_changed = 0'));
for (const reason of ['outside_agenda_slots', 'night_not_allowed', 'saturday_limit', 'lunch']) {
  assert(new RegExp(`'${reason}'`).test(loopBody),
    `grade: '${reason}' e verificado DENTRO do loop por slot (vale para todo o grupo)`);
}
assert(/'sunday'/.test(body) && !/'sunday'/.test(loopBody),
  'grade: domingo e regra de data, verificada uma vez fora do loop');

// ---- a UI passou a chamar a RPC -------------------------------------------
const ui = readFileSync('pages/student/Lessons.tsx', 'utf-8');
// Comentarios fora: o que importa e o codigo que executa (os comentarios
// explicam justamente o que foi removido e citariam os identificadores).
const confirmBlock = ui
  .slice(ui.indexOf('const confirmReschedule'), ui.indexOf('const confirmCancellation'))
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
// P-1.20.5: o mesmo picker agora escolhe entre a RPC direta (>24h) e a de
// proposta (<=24h). A chamada deixou de ser um literal e virou um ternario.
assert(/\.rpc\(\s*rescheduleMode === 'propose' \? 'propose_reschedule' : 'reschedule_appointment_direct'/.test(confirmBlock),
  'Lessons.tsx: confirmReschedule chama reschedule_appointment_direct no modo direto');
assert(!/\.from\('appointments'\)[\s\S]{0,200}\.update\(/.test(confirmBlock),
  'Lessons.tsx: confirmReschedule nao faz mais UPDATE direto em appointments');
assert(!/create_unified_notification/.test(confirmBlock),
  'Lessons.tsx: a notificacao deixou de ser emitida pelo cliente');
assert(/SLOT_TAKEN/.test(confirmBlock),
  'Lessons.tsx: trata SLOT_TAKEN com a mensagem de conflito ja existente');

console.log('\n=== RescheduleDirectP1204: todos os asserts PASS ===');
