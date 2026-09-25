/**
 * InsertAuthorityAP01.unit.test.ts
 *
 * AP-01 / BL-01 — autoridade de CRIACAO de appointments, + C-08 e C-09.
 *
 * Bateria ESTATICA: le a migration, a Edge Function create-booking, o
 * config.toml e o frontend. Nao abre conexao, nao le variavel de ambiente,
 * nao executa SQL. A bateria FUNCIONAL do trigger e'
 * supabase/tests/ap01_appointments_insert_authority.pgsql.sql (PostgreSQL
 * efemero, nunca producao).
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

console.log('\n======================================================');
console.log('🧪 AP-01: autoridade de criacao de appointments');
console.log('======================================================\n');

// ---------------------------------------------------------------------------
// A) migration
// ---------------------------------------------------------------------------
console.log('A) migration');
const MIG = 'supabase/migrations/20260925_ap01_appointments_insert_authority.sql';
let migRaw = '';
try { migRaw = read(MIG); } catch { /* tratado abaixo */ }
const mig = stripSqlComments(migRaw);

assert(migRaw.length > 0, 'A1. a migration existe');
assert(/CREATE TRIGGER appointments_insert_authority_trigger\s+BEFORE INSERT ON public\.appointments/.test(mig),
  'A2. cria trigger BEFORE INSERT em appointments');
assert(/SECURITY DEFINER/.test(mig) && /SET search_path TO 'public'/.test(mig),
  'A3. funcao SECURITY DEFINER com search_path fixo');
assert(/auth\.role\(\) IN \('authenticated', 'anon'\)/.test(mig),
  'A4. regra aplicada a authenticated E anon; service_role fora');
assert(/NEW\.status IS DISTINCT FROM 'blocked'/.test(mig),
  "A5. via client so status 'blocked' e aceito");
assert(/NEW\.instructor_id IS DISTINCT FROM v_uid/.test(mig) && /FROM public\.instructors/.test(mig),
  'A6. bloqueio so pelo proprio instrutor, e o ator precisa ser instrutor');
assert(/NEW\.student_id IS NOT NULL/.test(mig), 'A7. bloqueio nao pode ter aluno');
assert(/NEW\.price IS DISTINCT FROM 0/.test(mig), 'A8. bloqueio exige price = 0');
for (const col of ['payment_intent_id', 'provider_payment_id', 'purchase_id',
                   'payment_id', 'group_id', 'expires_at', 'proposal_status']) {
  assert(new RegExp(`NEW\\.${col}\\s+IS NOT NULL`).test(mig), `A9. coluna bloqueada no INSERT: ${col}`);
}
assert(/NEW\.payment_status IS NOT NULL AND NEW\.payment_status <> 'pending'/.test(mig),
  'A10. payment_status nao pode ser definido via client');

// C-09
assert(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES\s+ON public\.appointments FROM anon/.test(mig),
  'A11. C-09: anon perde toda escrita + TRUNCATE/TRIGGER/REFERENCES');
assert(/REVOKE TRUNCATE, TRIGGER, REFERENCES\s+ON public\.appointments FROM authenticated/.test(mig),
  'A12. C-09: authenticated perde TRUNCATE/TRIGGER/REFERENCES');
assert(!/\bGRANT\b/.test(mig), 'A13. a migration nao concede nenhum privilegio');

// policies
assert(/DROP POLICY IF EXISTS "Students can create appointments"/.test(mig) &&
       /DROP POLICY IF EXISTS "Students can book appointments"/.test(mig),
  'A14. remove as 2 policies de INSERT de aluno');
assert(!/DROP POLICY IF EXISTS "Instructors can block slots"/.test(mig),
  'A15. mantem a policy de bloqueio do instrutor');
assert(!/\bCREATE POLICY\b/.test(mig), 'A16. nao cria policy nova');

// escopo
assert(!/check_appointments_update_security/.test(mig),
  'A17. nao toca a guarda de UPDATE (AP-03/AP-11)');
assert(!/\bALTER TABLE\b/i.test(mig) && !/\bDELETE\s+FROM\b/i.test(mig) &&
       !/\bUPDATE\s+public\./i.test(mig) && !/\bTRUNCATE\s+(TABLE\s+)?public/i.test(mig),
  'A18. nao altera schema de tabela nem toca dados');

// ---------------------------------------------------------------------------
// B) o caminho legitimo do frontend cabe na regra
// ---------------------------------------------------------------------------
console.log('\nB) frontend');
const agenda = stripComments(read('pages/InstructorAgenda.tsx'));
const ins = agenda.match(/\.from\('appointments'\)\s*\.insert\(\{([\s\S]*?)\}\)/);
assert(!!ins, 'B1. InstructorAgenda faz o INSERT de bloqueio');
const body = ins ? ins[1] : '';
assert(/status:\s*'blocked'/.test(body) && /price:\s*0\b/.test(body),
  "B2. o INSERT de bloqueio usa status 'blocked' e price 0");
assert(/instructor_id:\s*session\?\.user\?\.id/.test(body) && !/student_id/.test(body),
  'B3. o INSERT de bloqueio usa o proprio instrutor e nao envia aluno');

const lessons = stripComments(read('pages/student/Lessons.tsx'));
const perfil = stripComments(read('pages/student/InstructorProfile.tsx'));
const insertAluno = /\.from\('appointments'\)\s*\.(insert|upsert)\(/;
assert(!insertAluno.test(lessons) && !insertAluno.test(perfil),
  'B4. o frontend do aluno nao insere appointments (compra e backend)');

// ---------------------------------------------------------------------------
// C) C-08 — create-booking fail-closed
// ---------------------------------------------------------------------------
console.log('\nC) C-08 create-booking');
const cbRaw = read('supabase/functions/create-booking/index.ts');
const cb = stripComments(cbRaw);
assert(/status:\s*410/.test(cb), 'C1. create-booking responde 410');
assert(!/SERVICE_ROLE/.test(cb), 'C2. create-booking nao usa mais service_role');
assert(!/\.insert\(/.test(cb) && !/\.update\(/.test(cb), 'C3. create-booking nao escreve no banco');
const cfg = read('supabase/config.toml');
assert(/\[functions\.create-booking\]\s*\n\s*verify_jwt\s*=\s*true/.test(cfg),
  'C4. config.toml: create-booking com verify_jwt = true');

assert(!/invoke\(\s*['"]create-booking['"]/.test(perfil + lessons + agenda),
  'C5. nenhuma tela invoca create-booking');

console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) process.exit(1);
