// =============================================================================
// ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR
//
// Fonte: lib/payments/AsaasEnvironment.ts
// Gerador: scripts/sync-shared.ts  (P-1.20.1B)
//
// Edite a fonte e rode `npx tsx scripts/sync-shared.ts`.
// `npx tsx scripts/sync-shared.ts --check` falha se este arquivo divergir.
// =============================================================================

/**
 * AsaasEnvironment.ts — AP-04 / F1-09
 *
 * FONTE UNICA DE VERDADE do ambiente Asaas (sandbox | production).
 *
 * `supabase/functions/_shared/AsaasEnvironment.ts` e' GERADO a partir deste
 * arquivo por `scripts/sync-shared.ts`. Edite somente aqui.
 *
 * Regras (fail-closed, sem default):
 *   1. ASAAS_ENV e' obrigatoria e so' aceita `sandbox` ou `production`.
 *   2. ASAAS_API_URL e' obrigatoria e precisa ser uma URL oficial DO MESMO
 *      ambiente declarado. Qualquer outra URL e' rejeitada.
 *      -> production + URL sandbox = erro; sandbox + URL production = erro.
 *   3. ASAAS_API_KEY:
 *      - production: obrigatoria e com prefixo de chave de producao
 *        (`$aact_prod_`);
 *      - sandbox: uma chave com prefixo de producao e' rejeitada. Outras
 *        chaves (inclusive o formato antigo, sem marcador) sao aceitas, para
 *        que a chave Sandbox existente continue funcionando.
 *      - ausencia da chave so' e' erro quando o chamador pede
 *        `requireApiKey: true` (fluxos que ja' exigiam a chave continuam
 *        exigindo; fluxos que ja' tratavam a ausencia continuam tratando).
 *   4. Nenhuma URL e' inferida. Nao existe fallback. Configuracao ausente ou
 *      incoerente LANCA AsaasEnvironmentError.
 *
 * O modulo nao le variaveis sozinho no import: quem chama decide quando
 * resolver. Sem dependencias: roda igual em Node (Vercel/tsx) e Deno.
 */

declare const Deno: any;

export type AsaasEnvName = 'sandbox' | 'production';

export interface AsaasEnvironment {
  env: AsaasEnvName;
  /** Base URL sem barra final, ex.: https://sandbox.asaas.com/api/v3 */
  apiUrl: string;
  /** Chave da API, ou null quando ausente e nao exigida. */
  apiKey: string | null;
}

export interface ResolveAsaasEnvironmentOptions {
  /** Lanca se ASAAS_API_KEY estiver ausente/vazia. Default: false. */
  requireApiKey?: boolean;
}

export type EnvReader = (name: string) => string | undefined | null;

export class AsaasEnvironmentError extends Error {
  constructor(message: string) {
    super(`[AsaasEnvironment] ${message}`);
    this.name = 'AsaasEnvironmentError';
  }
}

/** URLs base oficiais aceitas por ambiente (sem barra final). */
export const ASAAS_ALLOWED_URLS: Readonly<Record<AsaasEnvName, readonly string[]>> = Object.freeze({
  sandbox: Object.freeze([
    'https://sandbox.asaas.com/api/v3',
    'https://api-sandbox.asaas.com/v3',
  ]),
  production: Object.freeze([
    'https://api.asaas.com/v3',
    'https://www.asaas.com/api/v3',
  ]),
});

export const ASAAS_PRODUCTION_KEY_PREFIX = '$aact_prod_';

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function envOf(url: string): AsaasEnvName | null {
  const u = normalizeUrl(url).toLowerCase();
  if (ASAAS_ALLOWED_URLS.sandbox.includes(u)) return 'sandbox';
  if (ASAAS_ALLOWED_URLS.production.includes(u)) return 'production';
  return null;
}

/**
 * Resolve e valida o ambiente Asaas a partir de um leitor de variaveis.
 * Funcao pura: nao acessa process/Deno. Lanca AsaasEnvironmentError.
 */
export function resolveAsaasEnvironment(
  read: EnvReader,
  options: ResolveAsaasEnvironmentOptions = {}
): AsaasEnvironment {
  const rawEnv = (read('ASAAS_ENV') ?? '').trim();
  if (!rawEnv) {
    throw new AsaasEnvironmentError('ASAAS_ENV nao definida. Defina explicitamente "sandbox" ou "production".');
  }
  const env = rawEnv.toLowerCase();
  if (env !== 'sandbox' && env !== 'production') {
    throw new AsaasEnvironmentError(`ASAAS_ENV invalida: "${rawEnv}". Valores aceitos: "sandbox" | "production".`);
  }

  const rawUrl = (read('ASAAS_API_URL') ?? '').trim();
  if (!rawUrl) {
    throw new AsaasEnvironmentError(`ASAAS_API_URL nao definida para ASAAS_ENV=${env}. Nenhuma URL e' inferida.`);
  }
  const urlEnv = envOf(rawUrl);
  if (urlEnv === null) {
    throw new AsaasEnvironmentError(
      `ASAAS_API_URL nao e' uma URL oficial do Asaas para ${env}: "${rawUrl}". ` +
      `Aceitas: ${ASAAS_ALLOWED_URLS[env as AsaasEnvName].join(', ')}.`
    );
  }
  if (urlEnv !== env) {
    throw new AsaasEnvironmentError(
      `Combinacao rejeitada: ASAAS_ENV=${env} com ASAAS_API_URL de ${urlEnv} ("${rawUrl}").`
    );
  }

  const rawKey = (read('ASAAS_API_KEY') ?? '').trim();
  const apiKey = rawKey === '' ? null : rawKey;

  if (env === 'production') {
    if (!apiKey) {
      throw new AsaasEnvironmentError('ASAAS_ENV=production exige ASAAS_API_KEY de producao.');
    }
    if (!apiKey.startsWith(ASAAS_PRODUCTION_KEY_PREFIX)) {
      throw new AsaasEnvironmentError(
        `ASAAS_ENV=production exige chave de producao (prefixo ${ASAAS_PRODUCTION_KEY_PREFIX}).`
      );
    }
  } else {
    if (apiKey && apiKey.startsWith(ASAAS_PRODUCTION_KEY_PREFIX)) {
      throw new AsaasEnvironmentError('Combinacao rejeitada: ASAAS_ENV=sandbox com chave de producao.');
    }
    if (!apiKey && options.requireApiKey) {
      throw new AsaasEnvironmentError('ASAAS_API_KEY nao definida.');
    }
  }

  return { env: env as AsaasEnvName, apiUrl: normalizeUrl(rawUrl), apiKey };
}

/** Leitor do runtime atual (Deno.env ou process.env). */
export function readRuntimeEnv(name: string): string | undefined {
  try {
    if (typeof Deno !== 'undefined' && Deno?.env?.get) return Deno.env.get(name) ?? undefined;
  } catch (_) { /* not Deno */ }
  try {
    if (typeof process !== 'undefined' && process.env) return process.env[name];
  } catch (_) { /* not Node */ }
  return undefined;
}

/** Atalho: resolve a partir das variaveis do runtime atual. */
export function getAsaasEnvironment(options: ResolveAsaasEnvironmentOptions = {}): AsaasEnvironment {
  return resolveAsaasEnvironment(readRuntimeEnv, options);
}
