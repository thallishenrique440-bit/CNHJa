/**
 * EdgeAuthBloco3.unit.test.ts
 *
 * Bloco 3 (Fase 1-B) — F1-06, F1-07, F1-08, N-06, N-03.
 *
 * A) COMPORTAMENTAL: supabase/functions/_shared/cronAuth.ts executado de fato,
 *    com ambiente simulado (sem rede, sem Deno, sem secrets reais).
 * B) ESTATICO: a guarda esta aplicada em cada Edge Function, antes de qualquer
 *    trabalho; a telemetria do segredo sumiu; N-06 e N-03 corrigidos.
 *
 * As Edge Functions importam de https://esm.sh e nao carregam no Node; por isso
 * a parte de handler e' verificada estaticamente.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyBearerSecret,
  timingSafeEqual,
  requireBearerSecret,
  requireCronAuth,
} from '../../../supabase/functions/_shared/cronAuth.js';

function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'supabase'))) return dir;
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
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// Segredos SINTETICOS, apenas para o teste.
const SECRET = 'synthetic-cron-secret-0123456789';
const SERVICE_KEY = 'synthetic.service.role.jwt';
const ANON_KEY = 'synthetic.anon.jwt';

/** Executa fn capturando tudo o que for logado. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const lines: string[] = [];
  const sink = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = sink; console.warn = sink; console.error = sink; console.info = sink;
  try {
    const value = await fn();
    return { value, logs: lines.join('\n') };
  } finally {
    Object.assign(console, orig);
  }
}

const reqWith = (auth?: string, method = 'POST') =>
  new Request('https://example.invalid/fn', {
    method,
    headers: auth === undefined ? {} : { Authorization: auth },
  });

async function run() {
  console.log('\n======================================================');
  console.log('🧪 Bloco 3: F1-06 / F1-07 / F1-08 / N-06 / N-03');
  console.log('======================================================\n');

  // ---------------------------------------------------------------------------
  // A) cronAuth — comportamento
  // ---------------------------------------------------------------------------
  console.log('A) cronAuth (comportamental)');

  let r = await verifyBearerSecret(`Bearer ${SECRET}`, undefined);
  assert(!r.ok && r.status === 500 && r.reason === 'not_configured', 'A1. sem CRON_SECRET: 500 fail-closed');
  r = await verifyBearerSecret(`Bearer ${SECRET}`, '');
  assert(!r.ok && r.status === 500, 'A2. CRON_SECRET vazio: 500 fail-closed');
  r = await verifyBearerSecret(null, SECRET);
  assert(!r.ok && r.status === 401 && r.reason === 'missing_header', 'A3. sem header: 401');
  r = await verifyBearerSecret('Bearer errado', SECRET);
  assert(!r.ok && r.status === 401 && r.reason === 'mismatch', 'A4. segredo incorreto: 401');
  r = await verifyBearerSecret(`Bearer ${SECRET}x`, SECRET);
  assert(!r.ok && r.status === 401, 'A5. segredo com sufixo: 401');
  r = await verifyBearerSecret(`bearer ${SECRET}`, SECRET);
  assert(!r.ok && r.status === 401, 'A6. prefixo em minusculas nao e aceito: 401');
  r = await verifyBearerSecret(SECRET, SECRET);
  assert(!r.ok && r.status === 401, 'A7. segredo sem "Bearer ": 401');
  r = await verifyBearerSecret(`Bearer ${SECRET}`, SECRET);
  assert(r.ok, 'A8. segredo correto: autorizado');

  assert(await timingSafeEqual('abc', 'abc') && !(await timingSafeEqual('abc', 'abd')) &&
         !(await timingSafeEqual('abc', 'abcd')) && !(await timingSafeEqual('', 'a')),
    'A9. timingSafeEqual: igualdade exata, inclusive com tamanhos diferentes');

  // requireCronAuth (a guarda usada pelos 3 jobs)
  const envOk = (n: string) => (n === 'CRON_SECRET' ? SECRET : undefined);
  const envMissing = () => undefined;
  let g = await captureLogs(() => requireCronAuth(reqWith(`Bearer ${SECRET}`), 'job', envMissing));
  assert(g.value?.status === 500, 'A10. guarda cron sem CRON_SECRET: Response 500');
  g = await captureLogs(() => requireCronAuth(reqWith('Bearer nope'), 'job', envOk));
  assert(g.value?.status === 401, 'A11. guarda cron com segredo incorreto: Response 401');
  g = await captureLogs(() => requireCronAuth(reqWith(), 'job', envOk));
  assert(g.value?.status === 401, 'A12. guarda cron sem header: Response 401');
  g = await captureLogs(() => requireCronAuth(reqWith(`Bearer ${SECRET}`), 'job', envOk));
  assert(g.value === null, 'A13. guarda cron com segredo correto: segue (null)');
  const body401 = await (await requireCronAuth(reqWith('Bearer nope'), 'job', envOk))!.json();
  assert(JSON.stringify(body401) === '{"error":"Unauthorized"}', 'A14. corpo 401 nao expoe detalhe');

  // F1-07: nenhum log expoe o segredo, hash, tamanho ou caractere divergente
  const probes = [`Bearer ${SECRET.slice(0, -1)}Z`, 'Bearer x', '', `Bearer ${SECRET} `];
  let allLogs = '';
  for (const h of probes) {
    const c = await captureLogs(() => requireCronAuth(reqWith(h), 'job', envOk));
    allLogs += c.logs + '\n';
  }
  const secretSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`Bearer ${SECRET}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert(!allLogs.includes(SECRET) && !allLogs.includes(SECRET.slice(0, 8)) && !allLogs.includes(SECRET.slice(-4)),
    'A15. log nao contem o segredo nem fragmentos');
  assert(!allLogs.includes(secretSha), 'A16. log nao contem o SHA-256 do segredo');
  assert(!/length|len=|\b\d{2,}\b|mismatchChar|expected|index/i.test(allLogs.replace(/fn=job/g, '')),
    'A17. log nao contem tamanho, indice nem caractere divergente');
  assert(/authorized=false reason=(mismatch|missing_header)/.test(allLogs), 'A18. log e somente booleano + motivo');

  // F1-06: guarda do send-push-notification (chave service_role)
  const envPush = (n: string) => (n === 'SUPABASE_SERVICE_ROLE_KEY' ? SERVICE_KEY : undefined);
  g = await captureLogs(() => requireBearerSecret(reqWith(), 'send-push-notification', 'SUPABASE_SERVICE_ROLE_KEY', envPush));
  assert(g.value?.status === 401, 'A19. push sem autenticacao: 401');
  g = await captureLogs(() => requireBearerSecret(reqWith(`Bearer ${ANON_KEY}`), 'send-push-notification', 'SUPABASE_SERVICE_ROLE_KEY', envPush));
  assert(g.value?.status === 401, 'A20. push com chave anon: 401');
  g = await captureLogs(() => requireBearerSecret(reqWith(`Bearer ${SERVICE_KEY}`), 'send-push-notification', 'SUPABASE_SERVICE_ROLE_KEY', envPush));
  assert(g.value === null, 'A21. push com chave service_role (como o worker envia): autorizado');
  g = await captureLogs(() => requireBearerSecret(reqWith(`Bearer ${SERVICE_KEY}`), 'send-push-notification', 'SUPABASE_SERVICE_ROLE_KEY', () => undefined));
  assert(g.value?.status === 500, 'A22. push sem chave no ambiente: 500 fail-closed');

  // ---------------------------------------------------------------------------
  // B) Aplicacao nas Edge Functions — estatico
  // ---------------------------------------------------------------------------
  console.log('\nB) Edge Functions (estatico)');

  const helper = read('supabase/functions/_shared/cronAuth.ts');
  assert(!/^\s*import\s/m.test(helper), 'B1. helper sem imports (portavel Deno/Node)');

  for (const fn of ['notification-worker', 'auto-complete-lessons', 'check-expired-bookings']) {
    const src = stripComments(read(`supabase/functions/${fn}/index.ts`));
    const serve = src.indexOf('Deno.serve(');
    const guard = src.indexOf(`requireCronAuth(req, '${fn}')`);
    // Fase 0: no notification-worker o trabalho passou para runNotificationCycle
    // (_shared/notificationQueue.ts); o handler nao chama mais rpc/from direto.
    const firstWork = src.search(/supabaseAdmin\s*\.(rpc|from)\(|runNotificationCycle\(/);
    assert(/import \{ requireCronAuth \} from '\.\.\/_shared\/cronAuth\.ts'/.test(src), `B2. ${fn}: importa requireCronAuth`);
    assert(guard > serve && guard < firstWork && /if \(denied\) return denied/.test(src),
      `B3. ${fn}: guarda e a primeira acao do handler`);
    assert(!/cronSecret\s*&&/.test(src) && !/authHeader\s*!==\s*`Bearer/.test(src),
      `B4. ${fn}: sem o padrao fail-open nem comparacao !== do segredo`);
  }

  // F1-07: telemetria removida de todo o diretorio de funcoes
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  const fnSources = walk(resolve(ROOT, 'supabase/functions')).map((p) => readFileSync(p, 'utf8')).join('\n');
  assert(!/logSecretTelemetry|expectedMismatchCharacter|expectedHashSha256|actualHashSha256|expectedHeaderLength/.test(fnSources),
    'B5. nenhuma funcao contem telemetria do segredo (F1-07)');

  // F1-06: send-push-notification
  const push = stripComments(read('supabase/functions/send-push-notification/index.ts'));
  const pGuard = push.indexOf("requireBearerSecret(req, 'send-push-notification', 'SUPABASE_SERVICE_ROLE_KEY')");
  assert(pGuard > push.indexOf('Deno.serve(') && pGuard < push.indexOf('await req.json()'),
    'B6. push: guarda service_role antes de ler o corpo');
  assert(!/Access-Control-Allow-Origin/.test(push), 'B7. push: CORS * removido');
  const worker = stripComments(read('supabase/functions/notification-worker/index.ts'));
  // Fase 0: `functions.invoke` nao entregava o cabecalho Authorization e o push
  // respondia 401 (reason=missing_header) desde o F1-06 — os jobs ficavam presos
  // em `processing`. O worker passou a enviar o Bearer service_role explicitamente.
  assert(/SUPABASE_SERVICE_ROLE_KEY/.test(worker) && /\/functions\/v1\/send-push-notification/.test(worker)
    && /'Authorization': `Bearer \$\{serviceRoleKey\}`/.test(worker) && !/functions\.invoke\(/.test(worker),
    'B8. worker chama o push enviando Authorization: Bearer <service_role> de forma explicita');

  // N-06: create-asaas-account
  const acc = stripComments(read('supabase/functions/create-asaas-account/index.ts'));
  const i403 = acc.indexOf('if (!instructor) {');
  assert(i403 > 0 && /status: 403/.test(acc.slice(i403, i403 + 600)), 'B9. create-asaas-account: 403 sem registro em instructors');
  assert(i403 < acc.indexOf('asaasFetch(') && i403 < acc.indexOf('await req.text()'),
    'B10. create-asaas-account: 403 antes de ler o payload e de chamar o Asaas');
  assert(i403 > acc.indexOf(".from('instructors')"), 'B11. create-asaas-account: 403 decidido pela consulta a instructors');
  assert(/getAsaasEnvironment\(/.test(acc), 'B12. create-asaas-account: AP-04 preservado');

  // N-03: config.toml
  const cfg = read('supabase/config.toml');
  assert(/\[functions\.create-tip\]\s*\r?\nverify_jwt = false/.test(cfg), 'B13. config.toml declara create-tip explicitamente');
  for (const fn of ['notification-worker', 'auto-complete-lessons', 'check-expired-bookings', 'send-push-notification']) {
    assert(new RegExp(`\\[functions\\.${fn}\\]\\s*\\r?\\nverify_jwt = false`).test(cfg),
      `B14. ${fn}: verify_jwt=false mantido (autentica por segredo proprio)`);
  }
  const tip = stripComments(read('supabase/functions/create-tip/index.ts'));
  assert(/auth\.getUser\(token\)/.test(tip) && /apt\.student_id !== user\.id/.test(tip),
    'B15. create-tip autentica internamente (justifica verify_jwt=false)');

  console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
  if (failed > 0) process.exit(1);
}

await run();
