// F1-06 / F1-07 / F1-08 — autenticacao de chamadores internos (cron e worker).
//
// Regras:
//   - FAIL-CLOSED: sem o segredo configurado, a requisicao e' recusada com 500.
//     (Antes: `if (cronSecret && ...)` pulava a checagem inteira.)
//   - Comparacao em tempo constante: os dois lados viram SHA-256 (32 bytes) e
//     sao comparados por XOR acumulado. O tempo nao depende da posicao da
//     primeira divergencia nem do tamanho do segredo.
//   - Log somente booleano + motivo categorico. NUNCA hash, tamanho, mascara ou
//     caractere do segredo ou do header recebido (F1-07).
//
// Sem imports de Deno nem de URL: o modulo roda tambem no Node, para teste.

export type BearerAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; reason: 'not_configured' | 'missing_header' | 'mismatch' };

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Igualdade de strings em tempo constante (via digests de tamanho fixo). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

/**
 * Valida `Authorization: Bearer <secret>`.
 * secret ausente/vazio -> 500 (fail-closed); header ausente -> 401; divergente -> 401.
 */
export async function verifyBearerSecret(
  authHeader: string | null | undefined,
  secret: string | null | undefined,
): Promise<BearerAuthResult> {
  if (!secret) return { ok: false, status: 500, reason: 'not_configured' };
  if (!authHeader) return { ok: false, status: 401, reason: 'missing_header' };
  const ok = await timingSafeEqual(authHeader, `Bearer ${secret}`);
  return ok ? { ok: true } : { ok: false, status: 401, reason: 'mismatch' };
}

type EnvGetter = (name: string) => string | undefined;

const denoEnv: EnvGetter = (name) =>
  (globalThis as { Deno?: { env: { get(n: string): string | undefined } } }).Deno?.env.get(name);

/**
 * Guarda de entrada para uma Edge Function interna.
 * Devolve `null` quando autorizado, ou a Response de recusa (401/500).
 */
export async function requireBearerSecret(
  req: Request,
  fnName: string,
  secretEnvName: string,
  getEnv: EnvGetter = denoEnv,
): Promise<Response | null> {
  const result = await verifyBearerSecret(req.headers.get('Authorization'), getEnv(secretEnvName));
  if (result.ok) return null;

  // Log booleano + motivo categorico. Nada derivado do segredo ou do header.
  console.error(`[auth] fn=${fnName} authorized=false reason=${result.reason}`);

  const body = result.status === 500
    ? { error: 'Server misconfigured' }
    : { error: 'Unauthorized' };
  return new Response(JSON.stringify(body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Guarda dos jobs agendados pelo pg_cron (`Authorization: Bearer <CRON_SECRET>`). */
export function requireCronAuth(req: Request, fnName: string, getEnv?: EnvGetter): Promise<Response | null> {
  return requireBearerSecret(req, fnName, 'CRON_SECRET', getEnv);
}
