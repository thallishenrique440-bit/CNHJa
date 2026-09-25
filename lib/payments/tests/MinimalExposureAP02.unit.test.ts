/**
 * MinimalExposureAP02.unit.test.ts
 *
 * AP-02 / F1-02 / F1-03 — exposicao minima de profiles e instructors.
 *
 * Bateria ESTATICA: le a migration e o frontend. Nao abre conexao, nao le
 * variavel de ambiente, nao executa SQL. A bateria FUNCIONAL (RLS, grants e
 * RPCs avaliados com SET ROLE) e' supabase/tests/ap02_profiles_instructors_exposure.pgsql.sql,
 * executada em PostgreSQL efemero, nunca em producao.
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

/** Conteudo de todos os `.select(`...`)` de um arquivo, concatenado. */
const selects = (src: string) =>
  (src.match(/\.select\(\s*(`[\s\S]*?`|'[^']*'|"[^"]*")/g) || []).join('\n');

console.log('\n======================================================');
console.log('🧪 AP-02: exposicao minima de profiles / instructors');
console.log('======================================================\n');

// ---------------------------------------------------------------------------
// A) migration
// ---------------------------------------------------------------------------
console.log('A) migration');
const MIG = 'supabase/migrations/20260925_ap02_profiles_instructors_minimal_exposure.sql';
let migRaw = '';
try { migRaw = read(MIG); } catch { /* tratado abaixo */ }
const mig = stripSqlComments(migRaw);

assert(migRaw.length > 0, 'A1. a migration existe');
assert(/DROP POLICY IF EXISTS "Authenticated users can read profiles" ON public\.profiles/.test(mig),
  'A2. remove a leitura USING (true) de profiles');
assert(/DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public\.instructors/.test(mig),
  'A3. remove a leitura USING (true) de instructors');
assert(/ON public\.profiles\s+FOR SELECT TO authenticated\s+USING \(auth\.uid\(\) = id\)/.test(mig),
  'A4. profiles: SELECT somente da propria linha');
assert(/ON public\.instructors\s+FOR SELECT TO authenticated\s+USING \(auth\.uid\(\) = id\)/.test(mig),
  'A5. instructors: SELECT somente da propria linha');

const viewBody = (name: string) => {
  const m = mig.match(new RegExp(`CREATE OR REPLACE VIEW public\\.${name} AS([\\s\\S]*?);`));
  return m ? m[1] : '';
};
const pp = viewBody('profiles_public');
const ip = viewBody('instructors_public');
const SENSIVEIS = ['cpf', 'email', 'phone', 'trusted_contact', 'security_message',
  'provider_customer_id', 'provider_account_id', 'provider_wallet_id', 'provider_status',
  'provider_onboarding_completed', 'payouts_enabled', 'experience_level', 'cnh_process_type'];
assert(pp.length > 0 && ip.length > 0, 'A6. as 2 views existem');
for (const col of SENSIVEIS) {
  assert(!new RegExp(`\\.${col}\\b`).test(pp) && !new RegExp(`\\.${col}\\b`).test(ip),
    `A7. coluna sensivel fora das views: ${col}`);
}
assert(!/\bi\.whatsapp\s*(,|$)/m.test(ip) && /AS has_whatsapp/.test(ip),
  'A8. instructors_public expoe so has_whatsapp, nunca o numero');

assert(/GRANT SELECT ON public\.profiles_public\s+TO authenticated;/.test(mig) &&
       !/GRANT SELECT ON public\.profiles_public[^;]*anon/.test(mig),
  'A9. profiles_public: somente authenticated');
assert(/GRANT SELECT ON public\.instructors_public TO anon, authenticated;/.test(mig),
  'A10. instructors_public: anon + authenticated (vitrine e link publico)');
assert(/REVOKE ALL ON public\.profiles\s+FROM anon;/.test(mig) &&
       /REVOKE ALL ON public\.instructors\s+FROM anon;/.test(mig),
  'A11. anon perde acesso direto as tabelas base');
assert(!/GRANT[^;]*TO (PUBLIC|anon)[^;]*;/.test(mig.replace(/GRANT SELECT ON public\.instructors_public TO anon, authenticated;/, '')),
  'A12. nenhum outro GRANT a anon/PUBLIC');

for (const fn of ['get_instructor_whatsapp', 'get_student_contact_for_appointment']) {
  const body = (mig.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}[\\s\\S]*?\\$function\\$;`)) || [''])[0];
  assert(/SECURITY DEFINER/.test(body) && /SET search_path TO 'pg_catalog', 'public'/.test(body),
    `A13. ${fn}: SECURITY DEFINER com search_path explicito`);
  assert(/auth\.uid\(\)/.test(body), `A14. ${fn}: autoriza pelo chamador (auth.uid())`);
  assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid\\)\\s+FROM PUBLIC, anon;`).test(mig) &&
         new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\)\\s+TO authenticated;`).test(mig),
    `A15. ${fn}: EXECUTE somente authenticated`);
}
const contact = (mig.match(/FUNCTION public\.get_student_contact_for_appointment[\s\S]*?\$function\$;/) || [''])[0];
assert(/a\.instructor_id = v_uid/.test(contact), 'A16. contato do aluno so para o instrutor da aula');
assert(/a\.status IN \('pending_approval', 'confirmed', 'scheduled', 'completed', 'no_show'\)/.test(contact),
  'A17. contato do aluno so em aula paga/aceita');
assert(!/\b(INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE|ALTER TABLE)\b/i.test(mig),
  'A18. a migration nao altera dados nem schema de tabela');
assert(!/appointments_(security|insert)/.test(mig) && !/check_appointments_/.test(mig),
  'A19. nao toca as guardas de appointments (AP-01/AP-03/AP-11)');

// ---------------------------------------------------------------------------
// B) frontend — nenhum leitor cruzado pede coluna sensivel
// ---------------------------------------------------------------------------
console.log('\nB) frontend');
const home = stripComments(read('pages/StudentHome.tsx'));
const sip = stripComments(read('pages/student/InstructorProfile.tsx'));
const lessons = stripComments(read('pages/student/Lessons.tsx'));
const agenda = stripComments(read('pages/InstructorAgenda.tsx'));
const shortLink = stripComments(read('pages/InstructorShortLink.tsx'));

for (const [nome, src] of [['StudentHome', home], ['student/InstructorProfile', sip],
                           ['student/Lessons', lessons], ['InstructorShortLink', shortLink]] as const) {
  assert(!/\.from\(['"]instructors['"]\)/.test(src),
    `B1. ${nome}: nao le a tabela instructors (usa instructors_public)`);
  assert(!/\bwhatsapp\s*,/.test(selects(src)) && !/provider_/.test(selects(src)),
    `B2. ${nome}: nenhum select pede whatsapp ou provider_*`);
}
assert(/\.from\(['"]instructors_public['"]\)/.test(home) &&
       /\.from\(['"]instructors_public['"]\)/.test(sip) &&
       /\.from\(['"]instructors_public['"]\)/.test(shortLink) &&
       /instructors_public!instructor_id/.test(lessons),
  'B3. vitrine, perfil, aulas e link curto usam instructors_public');
assert(/has_whatsapp === true/.test(home), 'B4. vitrine usa has_whatsapp como criterio de completude');

assert(/rpc\(\s*'get_instructor_whatsapp'/.test(sip) && /rpc\(\s*'get_instructor_whatsapp'/.test(lessons),
  'B5. perfil e aulas obtem o WhatsApp pela RPC');

const agendaSel = selects(agenda);
assert(/profiles:profiles_public!student_id/.test(agenda),
  'B6. agenda le nome/foto do aluno por profiles_public');
assert(!/\b(phone|email|cpf|trusted_contact)\b/.test(agendaSel),
  'B7. agenda nao pede phone/email/cpf/trusted_contact em nenhum select');
assert(/rpc\(\s*'get_student_contact_for_appointment'/.test(agenda),
  'B8. agenda obtem o contato do aluno pela RPC');
assert(/studentPhone: apt\.profiles\?\.phone/.test(agenda) &&
       /experience: apt\.profiles\?\.experience_level/.test(agenda),
  'B9. agenda preserva o mapeamento de telefone/experiencia para a tela');

assert((sip.match(/profiles:profiles_public!student_id/g) || []).length === 2,
  'B10. as 2 listas de avaliacoes do perfil usam profiles_public');

console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) process.exit(1);
