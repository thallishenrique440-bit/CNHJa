/**
 * StatusAuthorityAP03AP11.unit.test.ts
 *
 * AP-03 — o aluno nao altera o status operacional da aula.
 * AP-11 — depois do aceite do instrutor nao ha cancelamento; ha REMARCACAO.
 *
 * Este arquivo e' uma bateria ESTATICA: le o codigo-fonte e a migration e
 * verifica que as regras estao expressas onde precisam estar. Nao abre
 * conexao, nao le variavel de ambiente, nao executa SQL.
 *
 * A bateria FUNCIONAL da matriz de transicao — que de fato executa UPDATEs
 * contra o trigger — e' supabase/tests/ap03_ap11_status_transition.pgsql.sql,
 * e roda em PostgreSQL efemero, nunca em producao.
 *
 * Por que estatico: o defeito que AP-03 e AP-11 fecham nao e' de calculo, e'
 * de AUTORIDADE. Ele so aparece quando um cliente com JWT de aluno escreve
 * direto em appointments. Um teste unitario com mock nao consegue reproduzir
 * isso — o que se pode garantir aqui e' que o caminho de escrita foi removido
 * do frontend e que a guarda existe na migration.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sobe a arvore ate achar o package.json do projeto. Robusto tanto quando o
 * teste roda de lib/payments/tests/ via tsx quanto de um diretorio de build.
 */
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

/** Remove comentarios de linha, de bloco e JSX para nao gerar falso positivo. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Remove comentarios SQL (`-- ...`). Sem isto, a prosa explicativa da propria
 * migration dispara as assercoes de escopo: o cabecalho diz, em portugues, que
 * ela "nao cria, altera nem remove tabela, coluna, indice, policy ou grant", e
 * a palavra "grant" em minusculas casava com a busca por GRANT.
 */
function stripSqlComments(src: string): string {
  return src.replace(/^\s*--.*$/gm, '');
}

console.log('\n======================================================');
console.log('🧪 AP-03 / AP-11: autoridade sobre o status da aula');
console.log('======================================================\n');

// ---------------------------------------------------------------------------
// A) AP-03 — o frontend do ALUNO nao escreve status operacional
// ---------------------------------------------------------------------------
console.log('A) frontend do aluno');

const lessonsRaw = read('pages/student/Lessons.tsx');
const lessons = stripComments(lessonsRaw);

assert(!/status:\s*'completed'/.test(lessons),
  "A1. pages/student/Lessons.tsx nao grava status: 'completed'");
assert(!/status:\s*'no_show'/.test(lessons),
  "A2. pages/student/Lessons.tsx nao grava status: 'no_show'");

// A regressao especifica: o UPDATE em lote com .in('id', lessonIds).
const updateEmLote =
  /from\(['"]appointments['"]\)[\s\S]{0,400}?\.update\(\{[\s\S]{0,300}?status:[\s\S]{0,300}?\}\)[\s\S]{0,200}?\.in\(\s*['"]id['"]/;
assert(!updateEmLote.test(lessons),
  "A3. nao ha UPDATE de status em lote (.in('id', ...)) no fluxo do aluno");

// O fluxo legitimo do aluno tem de continuar existindo.
assert(/from\(['"]reviews['"]\)[\s\S]{0,200}?\.insert\(/.test(lessons),
  'A4. o aluno continua podendo registrar a avaliacao (insert em reviews)');

// A remocao tem de estar documentada no proprio arquivo.
assert(/AP-03/.test(lessonsRaw),
  'A5. a remocao esta documentada no arquivo, citando AP-03');

// ---------------------------------------------------------------------------
// B) AP-03 — o INSTRUTOR continua podendo, agora com CAS
// ---------------------------------------------------------------------------
console.log('\nB) frontend do instrutor');

const agendaRaw = read('pages/InstructorAgenda.tsx');
const agenda = stripComments(agendaRaw);

assert(/status:\s*'completed'/.test(agenda),
  "B1. InstructorAgenda continua gravando status: 'completed'");
assert(/status:\s*'no_show'/.test(agenda),
  "B2. InstructorAgenda continua gravando status: 'no_show'");

/** Conta quantos UPDATEs de status possuem CAS por status. */
function updatesDeStatusComCas(src: string): { total: number; comCas: number } {
  const blocos = src.split(/\.from\(['"]appointments['"]\)/).slice(1);
  let total = 0, comCas = 0;
  for (const b of blocos) {
    const janela = b.slice(0, 700);
    if (!/\.update\(/.test(janela)) continue;
    if (!/status:\s*'(completed|no_show)'/.test(janela)) continue;
    total++;
    if (/\.in\(\s*['"]status['"]\s*,\s*\[[^\]]*'(confirmed|scheduled)'/.test(janela)) comCas++;
  }
  return { total, comCas };
}

const cas = updatesDeStatusComCas(agenda);
assert(cas.total >= 2,
  `B3. ha ao menos 2 UPDATEs de status no instrutor (encontrados ${cas.total})`);
assert(cas.total === cas.comCas,
  `B4. TODOS os UPDATEs de status do instrutor tem CAS por status (${cas.comCas}/${cas.total})`);

// ---------------------------------------------------------------------------
// C) AP-11 — a UI nao oferece cancelamento depois do aceite
// ---------------------------------------------------------------------------
console.log('\nC) AP-11 na interface');

assert(/dbStatus\s*!==\s*'confirmed'\s*&&[\s\S]{0,80}?dbStatus\s*!==\s*'scheduled'/.test(lessons),
  "C1. o botao de cancelar e' condicionado a aula NAO aceita");

assert(/Remarcar aula/.test(lessons),
  'C2. a alternativa oferecida ao aluno continua sendo remarcar');

// O seletor >24h / <=24h nao pode ter sido tocado.
assert(/rescheduleMode/.test(lessons) && /'direct'/.test(lessons) && /'propose'/.test(lessons),
  'C3. os dois modos de remarcacao (>24h direta, <=24h proposta) seguem intactos');

// ---------------------------------------------------------------------------
// D) A migration expressa a matriz
// ---------------------------------------------------------------------------
console.log('\nD) migration da guarda de transicao');

const MIG = 'supabase/migrations/20260924_ap03_ap11_appointments_status_transition_guard.sql';
let migRaw = '';
try { migRaw = read(MIG); } catch { /* tratado abaixo */ }
/** Corpo executavel, sem a prosa do cabecalho. */
const mig = stripSqlComments(migRaw);

assert(migRaw.length > 0, 'D1. a migration existe no repositorio');
assert(/CREATE OR REPLACE FUNCTION public\.check_appointments_update_security/.test(mig),
  'D2. substitui a funcao de trigger existente');
assert(/SECURITY DEFINER/.test(mig) && /SET search_path TO 'public'/.test(mig),
  'D3. preserva SECURITY DEFINER e search_path');
assert(/OLD\.status/.test(mig),
  'D4. a nova guarda considera OLD.status (a antiga so olhava NEW.status)');
assert(/v_is_instructor/.test(mig) && /v_is_student/.test(mig),
  'D5. a guarda distingue o ator (aluno x instrutor)');
assert(/NOT v_is_instructor[\s\S]{0,200}?AP-03/.test(mig),
  'D6. completed/no_show restritos ao instrutor, citando AP-03');
assert(/OLD\.status IN \('confirmed', 'scheduled'\)[\s\S]{0,300}?AP-11/.test(mig),
  'D7. cancelamento apos o aceite e negado, citando AP-11');
assert(/remarcacao/.test(mig),
  'D8. a mensagem de erro direciona para a remarcacao');

// As 7 guardas financeiras tem de continuar todas la.
for (const col of ['payment_status', 'payment_intent_id', 'provider_payment_id',
                   'purchase_id', 'payment_id', 'price', 'provider_name']) {
  assert(new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`).test(mig),
    `D9. guarda financeira preservada: ${col}`);
}

// A migration nao pode extrapolar o escopo autorizado.
assert(!/\bDROP\s+POLICY\b/i.test(mig) && !/\bCREATE\s+POLICY\b/i.test(mig),
  'D10. a migration nao mexe em policies (INSERT depende de AP-01, ainda aberta)');
assert(!/\bREVOKE\b/i.test(mig) && !/\bGRANT\b/i.test(mig),
  'D11. a migration nao mexe em grants');
assert(!/\bALTER TABLE\b/i.test(mig) && !/\bDELETE\s+FROM\b/i.test(mig)
       && !/\bUPDATE\s+public\./i.test(mig) && !/\bTRUNCATE\b/i.test(mig),
  'D12. a migration nao altera schema de tabela nem toca dados');
assert(/SOMENTE o trigger BEFORE UPDATE/i.test(migRaw),
  'D13. o escopo declarado e apenas o trigger de UPDATE');

// ---------------------------------------------------------------------------
// E) A bateria funcional SQL existe e nao aponta para producao
// ---------------------------------------------------------------------------
console.log('\nE) bateria funcional SQL');

const SQLT = 'supabase/tests/ap03_ap11_status_transition.pgsql.sql';
let sqltRaw = '';
try { sqltRaw = read(SQLT); } catch { /* tratado abaixo */ }
const sqlt = stripSqlComments(sqltRaw);

assert(sqltRaw.length > 0, 'E1. a bateria funcional existe');
assert(/AP-03/.test(sqltRaw) && /AP-11/.test(sqltRaw),
  'E2. a bateria cobre explicitamente AP-03 e AP-11');
// O identificador do projeto de producao pode aparecer no cabecalho como
// advertencia; o que nao pode e' estar em comando executavel.
assert(!/ohftsqsxymtrclnpadam/.test(sqlt),
  'E3. nenhum comando executavel da bateria referencia o projeto de producao');
assert(/service_role/.test(sqlt),
  'E4. ha caso de nao-regressao provando que service_role nao e afetado');

console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) process.exit(1);
