/**
 * SyncPaymentStatusAuthR2.unit.test.ts
 *
 * R2 — `sync-payment-status` protegido por `requireCronAuth` (CRON_SECRET).
 *
 * A) COMPORTAMENTAL: a guarda real de supabase/functions/_shared/cronAuth.ts,
 *    com ambiente simulado (segredos sinteticos, sem rede, sem banco).
 * B) ESTATICO: a guarda roda no inicio do handler, ANTES da reconciliacao de
 *    estornos, de qualquer consulta ao banco e de qualquer chamada ao Asaas.
 *    (A Edge Function importa de https://esm.sh e nao carrega no Node.)
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCronAuth } from '../../../supabase/functions/_shared/cronAuth.js';

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

let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string) => {
  if (cond) { console.log(`  ✅ [PASS] ${name}`); passed++; }
  else { console.error(`  ❌ [FAIL] ${name}`); failed++; }
};

const SECRET = 'synthetic-cron-secret-r2-0123456789';
const ANON = 'synthetic.anon.jwt';
const env = (vars: Record<string, string | undefined>) => (n: string) => vars[n];
const req = (auth?: string) => new Request('https://example.invalid/functions/v1/sync-payment-status', {
  method: 'POST',
  headers: auth ? { Authorization: auth } : {},
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = e; }
};

console.log('\n🧪 R2 — sync-payment-status exige CRON_SECRET\n');

// ---------------- A) comportamento da guarda ----------------
{
  const r = await quiet(() => requireCronAuth(req(), 'sync-payment-status', env({ CRON_SECRET: SECRET })));
  assert(r?.status === 401, 'A1. sem Authorization -> 401');
}
{
  const r = await quiet(() => requireCronAuth(req(`Bearer ${ANON}`), 'sync-payment-status', env({ CRON_SECRET: SECRET })));
  assert(r?.status === 401, 'A2. chave anon (JWT publico) -> 401');
}
{
  const r = await quiet(() => requireCronAuth(req('Bearer errado'), 'sync-payment-status', env({ CRON_SECRET: SECRET })));
  assert(r?.status === 401, 'A3. segredo divergente -> 401');
}
{
  const r = await quiet(() => requireCronAuth(req(`Bearer ${SECRET}`), 'sync-payment-status', env({})));
  assert(r?.status === 500, 'A4. CRON_SECRET ausente no ambiente -> 500 (fail-closed)');
}
{
  const r = await requireCronAuth(req(`Bearer ${SECRET}`), 'sync-payment-status', env({ CRON_SECRET: SECRET }));
  assert(r === null, 'A5. segredo correto -> autorizado (null)');
}
{
  const lines: string[] = [];
  const e = console.error; console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await requireCronAuth(req('Bearer errado'), 'sync-payment-status', env({ CRON_SECRET: SECRET })); } finally { console.error = e; }
  const log = lines.join('\n');
  assert(/fn=sync-payment-status authorized=false reason=mismatch/.test(log), 'A6. log categorico com o nome da funcao');
  assert(!log.includes(SECRET) && !log.includes('errado'), 'A7. log nao contem segredo nem header recebido');
}

// ---------------- B) posicao da guarda no handler ----------------
const src = readFileSync(resolve(ROOT, 'supabase/functions/sync-payment-status/index.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const serve = code.indexOf('Deno.serve(');
const guard = code.indexOf("requireCronAuth(req, 'sync-payment-status')");
const deniedReturn = code.indexOf('if (denied) return denied', guard);
const handler = code.slice(serve);
const firstWorkInHandler = Math.min(
  ...['reconcileRefundOperations()', 'supabaseAdmin', 'asaasFetch(', 'BookingCancellationCore', 'await req.']
    .map((t) => handler.indexOf(t)).filter((i) => i >= 0)
) + serve;

assert(/import \{ requireCronAuth \} from '\.\.\/_shared\/cronAuth\.ts'/.test(code), 'B1. importa requireCronAuth do modulo compartilhado');
assert(serve >= 0 && guard > serve, 'B2. guarda dentro do handler');
assert(deniedReturn > guard && deniedReturn < firstWorkInHandler, 'B3. recusa retorna antes de qualquer trabalho');
assert(guard < firstWorkInHandler, 'B4. guarda antes da reconciliacao, do banco e do Asaas');
assert(code.split("requireCronAuth(req, 'sync-payment-status')").length === 2, 'B5. guarda aplicada uma unica vez');

// Nada de banco/Asaas no topo do modulo alem da criacao do client.
const top = code.slice(0, serve);
assert(!/\.from\(|asaasFetch\(|reconcileRefundOperations\(\)\s*$/m.test(top.replace(/async function[\s\S]*$/, '')),
  'B6. nenhuma leitura/escrita executada no carregamento do modulo');

console.log(`\n  Resultado: ${passed} PASS, ${failed} FAIL\n`);
if (failed > 0) process.exit(1);
