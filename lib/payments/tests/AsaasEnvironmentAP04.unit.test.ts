/**
 * AP-04 / F1-09 — Ambiente Asaas explicito e fail-closed.
 *
 * Sem rede, sem Supabase, sem chave real. Todas as chaves abaixo sao
 * ficticias e so' exercitam o formato (prefixo).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveAsaasEnvironment,
  AsaasEnvironmentError,
  ASAAS_ALLOWED_URLS,
} from '../AsaasEnvironment';

function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json')) &&
        existsSync(resolve(dir, 'supabase'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('raiz do repositorio nao encontrada');
}
const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string) => {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
};

const SANDBOX_URL = 'https://sandbox.asaas.com/api/v3';
const PROD_URL = 'https://api.asaas.com/v3';
const FAKE_SANDBOX_KEY = '$aact_hmlg_FAKE_AP04_TEST_ONLY';
const FAKE_LEGACY_KEY = '$aact_FAKE_LEGACY_AP04_TEST_ONLY';
const FAKE_PROD_KEY = '$aact_prod_FAKE_AP04_TEST_ONLY';

const reader = (vars: Record<string, string | undefined>) => (n: string) => vars[n];
const ok = (vars: Record<string, string | undefined>, opts = {}) => resolveAsaasEnvironment(reader(vars), opts);
const throws = (vars: Record<string, string | undefined>, pattern: RegExp, opts = {}): boolean => {
  try { ok(vars, opts); return false; }
  catch (e: any) { return e instanceof AsaasEnvironmentError && pattern.test(e.message); }
};

console.log('\n======================================================');
console.log('🧪 AP-04: ambiente Asaas explicito (fail-closed)');
console.log('======================================================');

// ---------------------------------------------------------------- (a)
console.log('\n[a] Sandbox configurado corretamente -> permitido');
{
  const r = ok({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: SANDBOX_URL, ASAAS_API_KEY: FAKE_SANDBOX_KEY }, { requireApiKey: true });
  assert(r.env === 'sandbox' && r.apiUrl === SANDBOX_URL && r.apiKey === FAKE_SANDBOX_KEY, 'A1. sandbox + URL sandbox + chave hmlg');
  const r2 = ok({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: SANDBOX_URL + '/', ASAAS_API_KEY: FAKE_LEGACY_KEY });
  assert(r2.apiUrl === SANDBOX_URL, 'A2. barra final removida');
  assert(r2.apiKey === FAKE_LEGACY_KEY, 'A3. chave sandbox no formato antigo (sem marcador) continua aceita');
  const r3 = ok({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: 'https://api-sandbox.asaas.com/v3' });
  assert(r3.env === 'sandbox' && r3.apiKey === null, 'A4. URL sandbox nova aceita; chave ausente = null quando nao exigida');
  const r4 = ok({ ASAAS_ENV: ' Sandbox ', ASAAS_API_URL: ` ${SANDBOX_URL} ` });
  assert(r4.env === 'sandbox', 'A5. ASAAS_ENV tolera caixa/espacos');
}

// ---------------------------------------------------------------- (b)
console.log('\n[b] Configuracao ausente -> falha explicita');
assert(throws({}, /ASAAS_ENV nao definida/), 'B1. tudo ausente -> ASAAS_ENV nao definida');
assert(throws({ ASAAS_API_URL: SANDBOX_URL, ASAAS_API_KEY: FAKE_SANDBOX_KEY }, /ASAAS_ENV nao definida/),
  'B2. so URL+chave (estado atual da Vercel) -> falha, nao infere sandbox');
assert(throws({ ASAAS_ENV: '', ASAAS_API_URL: SANDBOX_URL }, /ASAAS_ENV nao definida/), 'B3. ASAAS_ENV vazia');
assert(throws({ ASAAS_ENV: 'sandbox' }, /ASAAS_API_URL nao definida/), 'B4. sandbox sem URL -> falha (sem fallback)');
assert(throws({ ASAAS_ENV: 'staging', ASAAS_API_URL: SANDBOX_URL }, /ASAAS_ENV invalida/), 'B5. ASAAS_ENV invalida');
assert(throws({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: SANDBOX_URL }, /ASAAS_API_KEY nao definida/, { requireApiKey: true }),
  'B6. requireApiKey sem chave -> falha');

// ---------------------------------------------------------------- (c)
console.log('\n[c] production sem URL/chave de production -> falha explicita');
assert(throws({ ASAAS_ENV: 'production', ASAAS_API_KEY: FAKE_PROD_KEY }, /ASAAS_API_URL nao definida/), 'C1. production sem URL');
assert(throws({ ASAAS_ENV: 'production', ASAAS_API_URL: PROD_URL }, /exige ASAAS_API_KEY de producao/), 'C2. production sem chave (mesmo sem requireApiKey)');
assert(throws({ ASAAS_ENV: 'production', ASAAS_API_URL: PROD_URL, ASAAS_API_KEY: FAKE_SANDBOX_KEY }, /exige chave de producao/), 'C3. production com chave hmlg');
assert(throws({ ASAAS_ENV: 'production', ASAAS_API_URL: PROD_URL, ASAAS_API_KEY: FAKE_LEGACY_KEY }, /exige chave de producao/), 'C4. production com chave sem marcador');
{
  const r = ok({ ASAAS_ENV: 'production', ASAAS_API_URL: PROD_URL, ASAAS_API_KEY: FAKE_PROD_KEY });
  assert(r.env === 'production' && r.apiUrl === PROD_URL, 'C5. production totalmente coerente -> permitido (caminho futuro)');
}

// ---------------------------------------------------------------- (d)
console.log('\n[d] production apontando para sandbox -> rejeitado');
for (const u of ASAAS_ALLOWED_URLS.sandbox) {
  assert(throws({ ASAAS_ENV: 'production', ASAAS_API_URL: u, ASAAS_API_KEY: FAKE_PROD_KEY }, /Combinacao rejeitada/),
    `D. production + ${u}`);
}

// ---------------------------------------------------------------- (e)
console.log('\n[e] sandbox apontando para production -> rejeitado');
for (const u of ASAAS_ALLOWED_URLS.production) {
  assert(throws({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: u, ASAAS_API_KEY: FAKE_SANDBOX_KEY }, /Combinacao rejeitada/),
    `E. sandbox + ${u}`);
}
assert(throws({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: SANDBOX_URL, ASAAS_API_KEY: FAKE_PROD_KEY }, /sandbox com chave de producao/),
  'E3. sandbox + chave de producao');
assert(throws({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: 'http://sandbox.asaas.com/api/v3' }, /nao e' uma URL oficial/), 'E4. http (sem TLS) rejeitado');
assert(throws({ ASAAS_ENV: 'sandbox', ASAAS_API_URL: 'https://sandbox.asaas.com.evil.io/api/v3' }, /nao e' uma URL oficial/), 'E5. host parecido rejeitado');

// ---------------------------------------------------------------- (f)
console.log('\n[f] Nenhum fallback silencioso no codigo');

const SCAN_DIRS = ['api', 'lib', 'supabase/functions', 'server.ts'];
const files: string[] = [];
const walk = (p: string) => {
  const abs = resolve(ROOT, p);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) { if (/\.(ts|tsx|js)$/.test(abs)) files.push(abs); return; }
  for (const e of readdirSync(abs)) {
    if (e === 'node_modules' || e === 'tests' || e === 'dist') continue;
    walk(join(p, e));
  }
};
SCAN_DIRS.forEach(walk);
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');
const ENV_FILES = new Set(['lib/payments/AsaasEnvironment.ts', 'supabase/functions/_shared/AsaasEnvironment.ts']);

const urlLeaks = files.filter(f => !ENV_FILES.has(rel(f)) && /(sandbox|api|www)\.asaas\.com\/(api\/)?v3|api-sandbox\.asaas\.com/.test(readFileSync(f, 'utf8')));
assert(urlLeaks.length === 0, `F1. URL base do Asaas so existe em AsaasEnvironment.ts (vazamentos: ${urlLeaks.map(rel).join(', ') || 'nenhum'})`);

const envReads = files.filter(f => !ENV_FILES.has(rel(f)) && /ASAAS_API_URL|ASAAS_ENV\b/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
assert(envReads.length === 0, `F2. ASAAS_API_URL/ASAAS_ENV lidas so pelo modulo (fora dele: ${envReads.map(rel).join(', ') || 'nenhum'})`);

const CALL_SITES: Array<[string, RegExp]> = [
  ['lib/payments/AsaasProvider.ts', /getAsaasEnvironment\(\{ requireApiKey: true \}\)/],
  ['lib/payments/BookingCancellationCore.ts', /resolveAsaasEnvironment\(/],
  ['supabase/functions/_shared/BookingCancellationCore.ts', /resolveAsaasEnvironment\(/],
  ['api/sync-fees.ts', /resolveAsaasEnvironment\(/],
  ['supabase/functions/create-tip/index.ts', /getAsaasEnvironment\(/],
  ['supabase/functions/create-asaas-account/index.ts', /getAsaasEnvironment\(/],
  ['supabase/functions/sync-payment-status/index.ts', /getAsaasEnvironment\(/],
];
for (const [f, re] of CALL_SITES) assert(re.test(read(f)), `F3. ${f} usa o modulo central`);

const shared = read('supabase/functions/_shared/AsaasEnvironment.ts');
const src = read('lib/payments/AsaasEnvironment.ts');
assert(shared.includes('ARQUIVO GERADO AUTOMATICAMENTE') && shared.endsWith(src), 'F4. _shared/AsaasEnvironment.ts e copia gerada identica da fonte');
assert(/'AsaasEnvironment\.ts'/.test(read('scripts/sync-shared.ts')), 'F5. sync-shared --check cobre AsaasEnvironment.ts');
assert(/from '\.\/AsaasEnvironment\.ts'/.test(read('supabase/functions/_shared/BookingCancellationCore.ts')), 'F6. Core Deno importa o modulo irmao .ts');

const provider = read('lib/payments/AsaasProvider.ts');
assert(/if \(!secret \|\| receivedToken !== secret\)/.test(provider), 'F7. AsaasProvider.handleWebhook fail-closed sem ASAAS_WEBHOOK_SECRET');

// Comportamento em runtime dos consumidores Node
const saved = { ...process.env };
const clearAsaas = () => { for (const k of ['ASAAS_ENV', 'ASAAS_API_URL', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_SECRET']) delete process.env[k]; };

const { AsaasProvider } = await import('../AsaasProvider');
clearAsaas();
process.env.ASAAS_API_KEY = FAKE_LEGACY_KEY;
let err: any = null;
try { new AsaasProvider(); } catch (e) { err = e; }
assert(err instanceof AsaasEnvironmentError, 'F8. AsaasProvider sem ASAAS_ENV/URL -> lanca (antes caia no sandbox)');

process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = SANDBOX_URL;
let p: any = null;
try { p = new AsaasProvider(); } catch (e) { p = null; }
assert(p !== null && p.apiUrl === SANDBOX_URL, 'F9. AsaasProvider com sandbox explicito -> URL sandbox');

let whErr: any = null;
try { await p.handleWebhook({ headers: { 'asaas-access-token': 'x' }, rawBody: '{}' }); } catch (e) { whErr = e; }
assert(whErr && /Invalid Asaas access token/.test(whErr.message), 'F10. handleWebhook sem secret configurado -> rejeitado');

// NotificationService cria um client no import: valores ficticios, nunca rede real.
process.env.SUPABASE_URL = 'https://ap04.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'ap04-fake-service-key';
const { BookingCancellationCore } = await import('../BookingCancellationCore');
clearAsaas();
let coreErr: any = null;
const neverCalled = { from: () => { throw new Error('adminClient nao deveria ser chamado'); } };
try {
  await BookingCancellationCore.processCancellation({
    appointmentId: '00000000-0000-0000-0000-0000000000a4', reason: 'ap04', initiatedBy: 'system', adminClient: neverCalled,
  } as any);
} catch (e) { coreErr = e; }
assert(coreErr instanceof AsaasEnvironmentError, 'F11. BookingCancellationCore sem ambiente -> lanca antes de tocar o banco');

process.env = saved;

console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) process.exit(1);
