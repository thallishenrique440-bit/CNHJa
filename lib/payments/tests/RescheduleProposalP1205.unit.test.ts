/**
 * RescheduleProposalP1205.unit.test.ts
 *
 * P-1.20.5 — contrato estatico das migrations e da UI.
 *
 * O COMPORTAMENTO (57 asserts: proposta, aceite, recusa, cancelamento, grade,
 * conflito, combo, notificacoes, neutralidade financeira) foi exercitado
 * contra um PostgreSQL 16 REAL e efemero, fora de producao, pelo harness
 * `supabase/tests/p1205_reschedule.pgsql.sql`. Aquele arquivo e' SQL e nao
 * roda neste runner Node.
 *
 * Aqui garantimos o que nenhum teste de comportamento garante:
 *  - a UI do aluno nao oferece mais "Cancelar aula" para aula ja aceita;
 *  - o instrutor nao altera mais o horario com UPDATE direto;
 *  - as RPCs seguem o padrao de privilegio do projeto;
 *  - nenhum identificador financeiro entra no corpo das RPCs;
 *  - o workaround `p_type: 'system'` foi eliminado.
 */
import { readFileSync } from 'node:fs';

const assert = (value: boolean, message: string) => {
  if (!value) { console.error(`FAIL: ${message}`); throw new Error(`FAIL: ${message}`); }
  console.log(`PASS: ${message}`);
};

const strip = (t: string) =>
  t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

const M01 = readFileSync('supabase/migrations/20260923_p1205_01_reschedule_proposal_model.sql', 'utf-8');
const M02 = readFileSync('supabase/migrations/20260923_p1205_02_reschedule_notification_types.sql', 'utf-8');
const M03 = readFileSync('supabase/migrations/20260923_p1205_03_fix_reschedule_direct_notification.sql', 'utf-8');
const M04 = readFileSync('supabase/migrations/20260923_p1205_04_reschedule_proposal_rpcs.sql', 'utf-8');
const M05 = readFileSync('supabase/migrations/20260923_p1205_05_reschedule_direct_respects_proposal.sql', 'utf-8');

// =========================================================================
// 10. ESTRUTURA DA PROPOSTA
// =========================================================================
for (const col of ['proposed_date', 'proposed_start_time', 'proposed_end_time',
                   'proposed_by', 'proposal_status', 'proposal_created_at',
                   'proposal_resolved_at']) {
  assert(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`).test(M01),
    `10. coluna '${col}' criada`);
}
for (const st of ['pending', 'accepted', 'rejected', 'cancelled']) {
  assert(new RegExp(`'${st}'`).test(M01), `10. estado '${st}' no dominio`);
}
assert(/appointments_proposal_coherent_check/.test(M01),
  '10. constraint de coerencia do bloco de proposta');
assert(/appointments_proposed_by_is_party_check/.test(M01),
  '10. proposed_by so pode ser student_id ou instructor_id da propria linha');
assert(!/DROP COLUMN[\s\S]*reschedule_requested_at/.test(M01)
       && !/ALTER COLUMN\s+reschedule_requested_at/.test(M01),
  '10. reschedule_requested_at NAO e removido nem alterado');

// =========================================================================
// 9. TIPOS DE NOTIFICACAO
// =========================================================================
const NEW_TYPES = ['reschedule_requested', 'reschedule_accepted',
                   'reschedule_rejected', 'reschedule_applied'];
for (const t of NEW_TYPES) {
  assert(new RegExp(`'${t}'::text`).test(M02), `9. tipo '${t}' admitido pelo CHECK`);
}
const OLD_TYPES = ['booking_request', 'booking_accepted', 'booking_rejected',
                   'booking_cancelled', 'booking_expired', 'payment_released',
                   'reminder', 'system', 'tip'];
for (const t of OLD_TYPES) {
  assert(new RegExp(`'${t}'::text`).test(M02), `9. tipo preexistente '${t}' preservado`);
}
// os dois indices de idempotencia isentam os tipos de remarcacao
const groupIdx = M02.slice(M02.indexOf('CREATE UNIQUE INDEX idx_notifications_idempotency_group'),
                           M02.indexOf('DROP INDEX IF EXISTS public.idx_notifications_idempotency_appointment'));
const aptIdx = M02.slice(M02.indexOf('CREATE UNIQUE INDEX idx_notifications_idempotency_appointment'));
for (const t of NEW_TYPES) {
  assert(new RegExp(`'${t}'::text`).test(groupIdx),
    `9. indice de grupo isenta '${t}' (duas remarcacoes nao sao deduplicadas)`);
  assert(new RegExp(`'${t}'::text`).test(aptIdx),
    `9. indice de appointment isenta '${t}'`);
}
assert(/group_id IS NOT NULL/.test(groupIdx) && /group_id IS NULL/.test(aptIdx),
  '9. predicados originais dos dois indices preservados');

// =========================================================================
// 8. CORRECAO DA NOTIFICACAO DA P-1.20.4
// =========================================================================
assert(/CREATE OR REPLACE FUNCTION public\.reschedule_appointment_direct\(/.test(M03),
  '8. correcao por CREATE OR REPLACE, mesma funcao');
assert(/p_appointment_ids\s+uuid\[\]/.test(M03) && /p_new_date\s+date/.test(M03)
       && /p_new_start_time\s+time/.test(M03),
  '8. assinatura identica a versao em producao');
const notifBlock03 = M03.slice(M03.indexOf('PERFORM public.create_unified_notification'));
assert(/'reschedule_applied'/.test(notifBlock03),
  "8. tipo passou de 'booking_request' para 'reschedule_applied'");
assert(!/'booking_request'/.test(strip(M03)),
  "8. 'booking_request' nao aparece mais no codigo executavel");
assert(!/v_group_id,\s*\n\s*v_ids\[1\]/.test(strip(M03)),
  '8. p_group_id nao e mais v_gr' + 'oup_id (causa da colisao)');
assert(/NULL,\s*\n\s*v_ids\[1\]\s*\n\s*\);/.test(strip(M03)),
  '8. p_group_id agora e NULL e p_appointment_id continua v_ids[1]');
// nada alem da notificacao mudou
const bodyProd = strip(M03).slice(strip(M03).indexOf('AS $function$'));
for (const w of ['date           = p_new_date', 'start_time     = v_new_start',
                 'end_time       = v_new_end', 'rescheduled_at = pg_catalog.now()']) {
  assert(bodyProd.includes(w), `8. UPDATE preserva a escrita '${w.split(' ')[0]}'`);
}
for (const code of ['UNDER_24H', 'SLOT_NOT_IN_GRID', 'SLOT_TAKEN', 'NOT_OWNER',
                    'INVALID_STATUS', 'GROUP_MISMATCH', 'INSTRUCTOR_MISMATCH',
                    'NEW_SLOT_IN_PAST', 'STATE_CHANGED']) {
  assert(bodyProd.includes(code), `8. validacao '${code}' preservada`);
}

// =========================================================================
// compatibilidade P-1.20.4 x modelo de proposta (migration 05)
// =========================================================================
assert(/proposal_status = 'pending'/.test(strip(M05)),
  'M05: remarcacao direta passa a respeitar proposta pendente');
assert(/RESCHEDULE_PENDING/.test(M05),
  'M05: codigo de erro RESCHEDULE_PENDING mantido');

// =========================================================================
// 11. RPCs — seguranca e neutralidade financeira
// =========================================================================
const RPCS: Array<[string, string]> = [
  ['propose_reschedule', 'uuid\\[\\], date, time'],
  ['accept_reschedule', 'uuid\\[\\]'],
  ['reject_reschedule', 'uuid\\[\\]'],
  ['cancel_reschedule_proposal', 'uuid\\[\\]'],
  ['reschedule_grid_violation', 'uuid, date, time'],
  ['reschedule_slot_violation', 'uuid\\[\\], uuid, uuid, date, time'],
];
for (const [fn, sig] of RPCS) {
  assert(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`).test(M04),
    `11. ${fn} declarada`);
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(${sig}\\) FROM PUBLIC`).test(M04),
    `11. ${fn}: REVOKE de PUBLIC`);
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(${sig}\\) FROM anon`).test(M04),
    `11. ${fn}: REVOKE de anon`);
  assert(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(${sig}\\) TO authenticated`).test(M04),
    `11. ${fn}: GRANT somente a authenticated`);
}
assert((M04.match(/SECURITY DEFINER/g) || []).length === RPCS.length,
  '11. todas as funcoes sao SECURITY DEFINER');
assert((M04.match(/SET search_path TO 'pg_catalog', 'public'/g) || []).length === RPCS.length,
  '11. todas as funcoes fixam search_path');
assert((M04.match(/FOR UPDATE/g) || []).length === 4,
  '11. as 4 RPCs de estado travam as linhas (FOR UPDATE) — anti-TOCTOU');
assert((M04.match(/auth\.uid\(\)/g) || []).length >= 4,
  '11. toda RPC de estado valida auth.uid()');
assert((M04.match(/NOT_AUTHENTICATED/g) || []).length === 4,
  '11. as 4 RPCs de estado recusam chamada sem sessao');

// 14. financeiro
const body04 = strip(M04);
const FORBIDDEN = ['payment_installments', 'payment_settlements', 'refund_operations',
  'transactions', 'payment_status', 'price', 'payment_intent_id',
  'provider_payment_id', 'purchase_id', 'payment_id', 'provider_name',
  'asaas', 'BookingCancellationCore', 'RefundOperationRepository'];
for (const ident of FORBIDDEN) {
  assert(!new RegExp(`\\b${ident}\\b`).test(body04),
    `14. corpo das RPCs nao contem o identificador financeiro '${ident}'`);
}
assert(!/SET[\s\S]{0,80}\bstatus\s*=/.test(body04),
  '14. nenhuma RPC escreve a coluna status');

// 3. escopo appointment-level: nenhuma RPC alcanca linhas por group_id
for (const m of body04.split('UPDATE public.appointments').slice(1)) {
  const where = m.slice(0, m.indexOf(';'));
  assert(!/group_id\s*=/.test(where),
    '3. nenhum UPDATE seleciona linhas por group_id (escopo nunca vaza para o combo)');
}

// =========================================================================
// FASE A — a UI do aluno nao oferece mais "Cancelar aula" para aula aceita
// =========================================================================
const ui = readFileSync('pages/student/Lessons.tsx', 'utf-8');
assert(!/const handleCancelClick/.test(ui),
  'A. handleCancelClick (codigo morto, sem checagem de dbStatus) foi removido');

const decisionModal = ui.slice(ui.indexOf('{/* Decision Modal */}'),
                               ui.indexOf('{/* Reschedule Modal */}'));
const cancelIdx = decisionModal.indexOf('Cancelar aula');
assert(cancelIdx > -1, 'A. o link de cancelar continua existindo para os status onde e permitido');
const guardWindow = decisionModal.slice(Math.max(0, cancelIdx - 900), cancelIdx);
assert(/lessonForAction\.dbStatus !== 'confirmed'/.test(guardWindow)
       && /lessonForAction\.dbStatus !== 'scheduled'/.test(guardWindow),
  "A. 'Cancelar aula' so e renderizado quando dbStatus NAO e confirmed nem scheduled");

assert(!/requestReschedule\(/.test(ui),
  'C. o antigo requestReschedule (UPDATE em reschedule_requested_at + notificacao pelo cliente) sumiu');
assert(/\.rpc\('propose_reschedule'/.test(ui) || /'propose_reschedule' :/.test(ui),
  'C. o fluxo <=24h chama propose_reschedule');
assert(/accept_reschedule/.test(ui) && /reject_reschedule/.test(ui)
       && /cancel_reschedule_proposal/.test(ui),
  'E. a UI do aluno responde e retira propostas pelas RPCs');

// =========================================================================
// FASES D/E — instrutor
// =========================================================================
const ia = readFileSync('pages/InstructorAgenda.tsx', 'utf-8');
const rescheduleRegion = ia.slice(ia.indexOf('const runRescheduleRpc'),
                                  ia.indexOf('// --- NEW CANCEL FLOW START ---'));
assert(/\.rpc\(fn, args\)/.test(rescheduleRegion),
  'D. as acoes de remarcacao do instrutor passam por RPC');
assert(!/\.from\('appointments'\)[\s\S]{0,400}date:\s*dateStr/.test(rescheduleRegion),
  'D. o UPDATE direto de date/start_time/end_time pelo instrutor foi removido');
assert(/'propose_reschedule'/.test(rescheduleRegion)
       && /'accept_reschedule'/.test(rescheduleRegion)
       && /'reject_reschedule'/.test(rescheduleRegion)
       && /'cancel_reschedule_proposal'/.test(rescheduleRegion),
  'D/E. instrutor pode propor, aceitar, recusar e retirar');
assert(/p_appointment_ids: \[selectedLesson\.id\]/.test(rescheduleRegion),
  '3. o instrutor opera SEMPRE sobre uma unica aula');
// Comentarios fora: o texto que EXPLICA a remocao do workaround cita o proprio
// identificador. O que importa e o codigo que executa.
const stripComments = (src: string) =>
  src
    // comentarios JSX {/* ... */} e comentarios de bloco /* ... */
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
const iaCode = stripComments(ia);
assert(!/p_type: 'system'/.test(iaCode),
  "9. o workaround p_type: 'system' foi eliminado da agenda do instrutor");
assert(/Remarcar aula/.test(ia) && /isAccepted/.test(ia),
  'D. instrutor tem entrada propria de remarcacao para aula confirmed/scheduled');


// =========================================================================
// P-1.20.5 CORRECAO FINAL — o instrutor nao cancela aula ja aceita
//
// Regra: depois do aceite NAO existe cancelamento. Se o instrutor nao puder
// dar a aula, o caminho e' REMARCACAO — que nao gera reembolso, pagamento,
// comissao nem qualquer efeito financeiro.
// =========================================================================

// 1. confirmed -> nenhum caminho de cancelamento na agenda do instrutor
// 2. scheduled -> idem
assert(!/setViewState\('cancel_form'\)/.test(iaCode),
  "confirmed/scheduled: nao existe mais nenhum gatilho para o formulario de cancelamento do instrutor");
assert(!/Cancelar esta aula/.test(iaCode),
  'confirmed/scheduled: o botao "Cancelar esta aula" foi removido da UI do instrutor');
assert(!/dbStatus === 'confirmed'[\s\S]{0,400}cancel_form/.test(iaCode)
       && !/dbStatus === 'scheduled'[\s\S]{0,400}cancel_form/.test(iaCode),
  'confirmed/scheduled: nenhum bloco de cancelamento e renderizado a partir desses status');

// 3. confirmed/scheduled -> a REMARCACAO continua oferecida
const isAcceptedAt = iaCode.indexOf('const isAccepted');
assert(isAcceptedAt > -1, 'o ramo isAccepted existe na agenda do instrutor');
const acceptedBranch = iaCode.slice(isAcceptedAt, isAcceptedAt + 12000);
assert(/dbStatus === 'confirmed'/.test(acceptedBranch) && /dbStatus === 'scheduled'/.test(acceptedBranch),
  'confirmed/scheduled: continuam sendo os status que habilitam remarcacao');
assert(/if \(isAccepted\)[\s\S]{0,1500}Remarcar aula/.test(acceptedBranch),
  'confirmed/scheduled: o instrutor continua vendo "Remarcar aula"');

// 4. estados ANTERIORES ao aceite: os fluxos de cancelamento/reembolso ficam intactos
assert(/const handleRejectLesson/.test(iaCode) && /invokeSecureFunction\('reject-booking'/.test(iaCode),
  'pre-aceite: a recusa do combo (reject-booking) continua existindo');
assert(/Recusar Combo/.test(iaCode) && /Recusar/.test(iaCode),
  'pre-aceite: os botoes de recusa continuam na UI');
assert(/invokeSecureFunction\('cancel-booking'/.test(ui),
  'pre-aceite: o cancelamento do aluno (cancel-booking) continua existindo');

const core = readFileSync('lib/payments/BookingCancellationCore.ts', 'utf-8');
assert(/instructor_rejected: \['pending', 'pending_approval', 'awaiting_payment', 'reserved'\]/.test(core)
    && /student_cancelled: \['pending', 'pending_approval', 'awaiting_payment', 'reserved'\]/.test(core)
    && /auto_expired: \['pending', 'pending_approval', 'awaiting_payment', 'reserved'\]/.test(core),
  'pre-aceite: REASON_ALLOWED_STATUSES do P-1.20.1B intacta nos 3 motivos');
assert(/ACCEPTED_STATUSES = \['confirmed', 'scheduled'\]/.test(core),
  'pos-aceite: ACCEPTED_STATUSES continua sendo a fronteira do nao-cancelavel');

console.log('\n=== RescheduleProposalP1205: todos os asserts PASS ===');
