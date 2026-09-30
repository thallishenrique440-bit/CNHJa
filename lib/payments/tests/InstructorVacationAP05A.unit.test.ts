/**
 * InstructorVacationAP05A.unit.test.ts
 *
 * AP-05 / TRILHA A — ferias do instrutor (liga/desliga manual).
 *
 * Bateria ESTATICA: le a migration, a API e o frontend. Nao abre conexao, nao
 * le variavel de ambiente, nao executa SQL. A bateria FUNCIONAL (banco) e'
 * supabase/tests/ap05a_instructor_vacation.pgsql.sql (itens A-O, R-U),
 * executada em PostgreSQL efemero, nunca em producao.
 *
 * Itens da especificacao cobertos aqui: P, Q, V, W + estrutura da migration.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json')) &&
        existsSync(resolve(dir, 'supabase'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string) => {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
};

const stripSqlComments = (src: string) => src.replace(/^\s*--.*$/gm, '');
const stripComments = (src: string) => src
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const fnBody = (sql: string, name: string) =>
  (sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`)) || [''])[0];

console.log('\n======================================================');
console.log('🧪 AP-05/A: ferias do instrutor');
console.log('======================================================\n');

// ---------------------------------------------------------------------------
// A) migration
// ---------------------------------------------------------------------------
console.log('A) migration');
const MIG = 'supabase/migrations/20260925_ap05a_instructor_vacation.sql';
let migRaw = '';
try { migRaw = read(MIG); } catch { /* tratado abaixo */ }
const mig = stripSqlComments(migRaw);

assert(migRaw.length > 0, 'A1. a migration existe');
assert(/ADD COLUMN IF NOT EXISTS on_vacation boolean NOT NULL DEFAULT false/.test(mig) &&
       /ADD COLUMN IF NOT EXISTS vacation_changed_at timestamptz/.test(mig),
  'A2. colunas on_vacation (NOT NULL DEFAULT false) e vacation_changed_at');

const rpc = fnBody(mig, 'set_instructor_vacation');
assert(/SECURITY DEFINER/.test(rpc) && /SET search_path TO 'pg_catalog', 'public'/.test(rpc),
  'A3. set_instructor_vacation: SECURITY DEFINER + search_path explicito');
assert(/v_uid\s+uuid := auth\.uid\(\)/.test(rpc) && /WHERE i\.id = v_uid/.test(rpc) && /WHERE id = v_uid/.test(rpc),
  'A4. RPC so le e altera a linha do proprio chamador');
assert(!/p_instructor_id/.test(rpc), 'A5. RPC nao aceita id de instrutor como parametro');
assert(/INSERT INTO public\.instructor_vacation_events \(instructor_id, active, changed_at, actor_user_id\)/.test(rpc),
  'A6. RPC registra o evento em instructor_vacation_events');
// Bloqueador do Work: os CHECK reais de security_audit_logs recusam eventos de ferias.
assert(!/security_audit_logs/.test(mig), 'A6b. nenhum comando executavel escreve/altera security_audit_logs');
assert(!/'database'/.test(mig) && !/instructor_vacation_(on|off)/.test(mig),
  "A6c. sem environment='database' e sem event_type instructor_vacation_on/off");
assert(/CREATE TABLE IF NOT EXISTS public\.instructor_vacation_events/.test(mig) &&
       /ALTER TABLE public\.instructor_vacation_events ENABLE ROW LEVEL SECURITY;/.test(mig) &&
       !/CREATE POLICY[^;]*instructor_vacation_events/.test(mig),
  'A6d. historico: tabela propria com RLS habilitado e SEM policies (fail-closed)');
assert(/REVOKE ALL ON public\.instructor_vacation_events FROM PUBLIC, anon, authenticated;/.test(mig) &&
       !/GRANT[^;]*instructor_vacation_events/.test(mig),
  'A6e. historico: nenhum privilegio para client');
assert(/BEFORE UPDATE OR DELETE ON public\.instructor_vacation_events/.test(mig) &&
       /BEFORE TRUNCATE ON public\.instructor_vacation_events/.test(mig),
  'A6f. historico: imutavel (UPDATE/DELETE/TRUNCATE)');
const hvTable = (mig.match(/CREATE TABLE IF NOT EXISTS public\.instructor_vacation_events \(([\s\S]*?)\);/) || ['', ''])[1];
assert(!/REFERENCES/i.test(hvTable), 'A6g. historico sem FK (nao cria bloqueador para a exclusao de conta)');
assert(/FOR UPDATE;/.test(rpc), 'A6h. RPC trava a propria linha (FOR UPDATE)');
const harness = read('supabase/tests/ap05a_harness_ext.pgsql.sql');
assert(harness.includes("ADD CONSTRAINT chk_security_audit_environment") &&
       harness.includes("'production'::character varying, 'preview'::character varying, 'development'::character varying") &&
       harness.includes("ADD CONSTRAINT chk_security_audit_event_type") &&
       harness.includes("'LOGIN_FAILED'::character varying, 'UNAUTHORIZED_ACCESS'::character varying, 'BANK_INFO_CHANGE'::character varying, 'ROLE_CHANGE'::character varying"),
  'A6i. o harness reproduz os CHECK constraints reais de security_audit_logs');
assert(/REVOKE ALL ON FUNCTION public\.set_instructor_vacation\(boolean\) FROM PUBLIC, anon;/.test(mig) &&
       /GRANT EXECUTE ON FUNCTION public\.set_instructor_vacation\(boolean\) TO authenticated;/.test(mig),
  'A7. EXECUTE apenas authenticated');

const guard = fnBody(mig, 'guard_instructor_vacation_columns');
assert(!/SECURITY DEFINER/.test(guard) && /current_user IN \('anon', 'authenticated'\)/.test(guard),
  'A8. guarda de coluna usa current_user (nao e SECURITY DEFINER)');
assert(/BEFORE INSERT OR UPDATE ON public\.instructors/.test(mig), 'A9. guarda em INSERT e UPDATE de instructors');

const ins = fnBody(mig, 'check_appointments_insert_authority');
for (const trecho of ["'Criacao de aula exige usuario autenticado. (AP-01)'",
                      "IF NEW.status IS DISTINCT FROM 'blocked' THEN",
                      "IF NEW.price IS DISTINCT FROM 0 THEN",
                      "OR NEW.proposal_status     IS NOT NULL THEN"]) {
  assert(ins.includes(trecho), `A10. corpo AP-01 preservado: ${trecho.slice(0, 40)}`);
}
assert(/INSTRUCTOR_ON_VACATION/.test(ins) &&
       ins.indexOf('INSTRUCTOR_ON_VACATION') > ins.indexOf("auth.role() IN ('authenticated', 'anon')") &&
       /NOT \(NEW\.status = 'blocked' AND NEW\.student_id IS NULL\)/.test(ins),
  'A11. bloco de ferias fora do IF de role (vale inclusive para service_role); so bloqueio sem aluno passa');

const avail = fnBody(mig, 'get_instructor_availability');
assert(/v_caller_id IS DISTINCT FROM p_instructor_id/.test(avail) && /i\.on_vacation/.test(avail) &&
       /generate_series\(0, 15\)/.test(avail),
  'A12. disponibilidade: em ferias todos os horarios 07-22 indisponiveis para terceiros');
assert(/'pending_approval'/.test(avail) && /'my_reservation'/.test(avail),
  'A13. disponibilidade: logica original preservada');

const grid = fnBody(mig, 'reschedule_grid_violation');
assert(/RETURN 'instructor_on_vacation'/.test(grid) && /RETURN 'lunch'/.test(grid) && /RETURN 'sunday'/.test(grid),
  'A14. grade de remarcacao: novo motivo instructor_on_vacation, motivos antigos preservados');
assert(/BEFORE UPDATE OF date, start_time ON public\.appointments/.test(mig),
  'A15. trigger de remarcacao efetiva durante ferias');
assert(/CREATE OR REPLACE VIEW public\.instructors_public[\s\S]*?p\.city,\s*i\.on_vacation\s*FROM/.test(mig),
  'A16. instructors_public expoe on_vacation (coluna nova ao final)');

// escopo
assert(!/check_appointments_update_security/.test(mig), 'A17. nao toca a guarda AP-03/AP-11');
assert(!/\b(transactions|payment_installments|payment_settlements|refund_operations)\b/.test(mig),
  'A18. nao toca tabelas financeiras');
// TRUNCATE so pode aparecer como evento de gatilho (BEFORE TRUNCATE ON ...), nunca como comando.
assert(!/\bDELETE FROM\b|(^|;)\s*TRUNCATE\s+(TABLE\s+)?public\.|\bUPDATE public\.appointments\b|\bDROP COLUMN\b|FOREIGN KEY|REFERENCES/im.test(mig),
  'A19. nao apaga dados, nao altera appointments, nao mexe em FKs');
const migNoStrings = mig.replace(/'(?:[^']|'')*'/g, "''");
assert((migNoStrings.match(/\bTRUNCATE\b/g) || []).length === (migNoStrings.match(/BEFORE TRUNCATE ON/g) || []).length,
  'A19b. toda ocorrencia de TRUNCATE e clausula de gatilho de imutabilidade');
assert(!/prevent_security_audit_mutation/.test(mig),
  'A20. nao altera a imutabilidade de security_audit_logs');

// ---------------------------------------------------------------------------
// P) perfil direto / link curto
// ---------------------------------------------------------------------------
console.log('\nP) perfil publico do instrutor');
const sip = stripComments(read('pages/student/InstructorProfile.tsx'));
assert(/on_vacation,/.test(sip) && /onVacation: data\.on_vacation === true/.test(sip),
  'P1. o perfil le on_vacation da vitrine');
assert(/Instrutor em férias/.test(sip), 'P2. mostra "Instrutor em férias"');
assert(/!showPreviewBanner && !instructor\.onVacation && \(\s*<div className="px-6 pb-6 pt-4">\s*<h2[^>]*>Horários disponíveis/.test(sip),
  'P3. grade de horarios nao e renderizada em ferias');
assert(/if \(instructor\.onVacation\) return;/.test(sip), 'P4. nao consulta disponibilidade em ferias');
assert(/disabled=\{[^}]*instructor\.onVacation\}/.test(sip), 'P5. botao de agendar desabilitado em ferias');
assert(/if \(instructor\.onVacation\) \{\s*addToast/.test(sip), 'P6. handleBook recusa nova reserva em ferias');
assert(/data\.code === 'INSTRUCTOR_ON_VACATION'/.test(sip), 'P7. trata o 409 da API (ferias ativadas depois de abrir a tela)');
const shortLink = stripComments(read('pages/InstructorShortLink.tsx'));
assert(/instructors_public/.test(shortLink) && /navigate\(`\/student\/instructor\/\$\{data\.id\}`/.test(shortLink),
  'P8. link curto continua resolvendo para o perfil (que exibe as ferias)');

// ---------------------------------------------------------------------------
// Q) create-booking-intent
// ---------------------------------------------------------------------------
console.log('\nQ) create-booking-intent');
const api = stripComments(read('api/create-booking-intent.ts'));
assert(/provider_account_id, [^']*on_vacation'\)/.test(api), 'Q1. le on_vacation do instrutor');
const i409 = api.indexOf("code: 'INSTRUCTOR_ON_VACATION'");
assert(/if \(instructor\?\.on_vacation === true\) \{\s*return res\.status\(409\)/.test(api),
  'Q2. responde 409 para nova reserva de instrutor em ferias');
assert(/está em férias no momento e não está aceitando novas aulas/.test(api), 'Q3. mensagem clara');
const iCleanup = api.indexOf("cancelled_reason: 'user_retry_new_attempt'");
const iInsert = api.indexOf(".insert(appointmentsToInsert)");
assert(i409 > 0 && i409 < iCleanup && i409 < iInsert,
  'Q4. a recusa ocorre antes de QUALQUER escrita (nao toca checkout existente)');
assert(/dbError\.message\.includes\('INSTRUCTOR_ON_VACATION'\)/.test(api),
  'Q5. corrida (ferias ligadas apos a checagem): erro do trigger vira 409');

// ---------------------------------------------------------------------------
// R) checkout ja iniciado: nenhum caminho de conclusao consulta ferias
// ---------------------------------------------------------------------------
console.log('\nR) checkout iniciado antes das ferias');
for (const p of ['api/asaas-webhook.ts', 'lib/payments/BookingCancellationCore.ts',
                 'supabase/functions/_shared/BookingCancellationCore.ts',
                 'supabase/functions/approve-booking/index.ts',
                 'supabase/functions/sync-payment-status/index.ts']) {
  assert(!/on_vacation|vacation/i.test(read(p)), `R1. ${p} nao consulta ferias`);
}

// ---------------------------------------------------------------------------
// V, W) botao Ferias
// ---------------------------------------------------------------------------
console.log('\nV/W) botao Ferias');
const instructorProfile = stripComments(read('pages/InstructorProfile.tsx'));
const studentProfile = read('pages/student/Profile.tsx');
assert(/🏖️ Entrar em férias/.test(instructorProfile) && /🏖️ Sair das férias/.test(instructorProfile),
  'W1. perfil do instrutor tem o botao Ferias (entrar/sair)');
assert(/rpc\('set_instructor_vacation', \{ p_active: next \}\)/.test(instructorProfile),
  'W2. o botao usa a RPC (nunca UPDATE direto)');
assert(!/on_vacation\s*:/.test(instructorProfile.replace(/data\?\.on_vacation/g, '')),
  'W3. o salvar perfil nao envia on_vacation');
assert(/Suas aulas já marcadas continuarão normalmente, mas novos alunos não poderão agendar aulas com você enquanto estiver em férias\./.test(instructorProfile),
  'W4. confirmacao clara ao entrar em ferias');
assert(/Sair da conta/.test(instructorProfile), 'W5. "Sair da conta" mantido no instrutor');
assert(!/f[ée]rias|vacation/i.test(studentProfile), 'V1. perfil do aluno NAO tem botao Ferias');
assert(/Sair da conta/.test(studentProfile), 'V2. "Sair da conta" mantido no aluno');

// ---------------------------------------------------------------------------
// Agenda, vitrine e remarcacao (UI)
// ---------------------------------------------------------------------------
console.log('\nUI complementar');
const agenda = stripComments(read('pages/InstructorAgenda.tsx'));
assert(/on_vacation'\)/.test(agenda) && /🏖️ Em férias/.test(agenda), 'U1. agenda do instrutor indica "Em férias"');
const home = stripComments(read('pages/StudentHome.tsx'));
assert(/\.eq\('on_vacation', false\)/.test(home) && /isAvailable/.test(home),
  'U2. vitrine exclui instrutor em ferias (a linha permanece no banco)');
const lessons = stripComments(read('pages/student/Lessons.tsx'));
assert(/vacationData\?\.on_vacation === true/.test(lessons) &&
       /reason === 'instructor_on_vacation'/.test(lessons) &&
       /includes\('INSTRUCTOR_ON_VACATION'\)/.test(lessons),
  'U3. remarcacao do aluno: pre-checagem + mensagens para os 3 caminhos');

// ---------------------------------------------------------------------------
// Fora de escopo: exclusao de conta nao foi implementada
// ---------------------------------------------------------------------------
assert(!/Excluir conta|deleteAccount|delete-account/i.test(instructorProfile + studentProfile),
  'X1. exclusao de conta NAO implementada nesta etapa');

console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) process.exit(1);
