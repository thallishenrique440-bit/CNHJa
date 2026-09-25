/**
 * sync-shared.ts — P-1.20.1B
 *
 * `lib/payments/` is the SINGLE SOURCE OF TRUTH for the cancellation/refund
 * engine. `supabase/functions/_shared/` is GENERATED from it.
 *
 * Why this exists: the two trees had drifted. `_shared/BookingCancellationCore.ts`
 * carried a version bug that `lib/payments/BookingCancellationCore.ts` did not,
 * and `_shared` is the copy that runs in production. A fix applied to `lib/`
 * simply never reached users. Divergence must be a build error, not a surprise
 * discovered during an incident.
 *
 * Usage:
 *   npx tsx scripts/sync-shared.ts           # write the generated files
 *   npx tsx scripts/sync-shared.ts --check   # exit 1 if any file is stale
 *
 * The transform is deliberately mechanical and tiny (module specifiers and the
 * supabase-js import). Anything that needs more than that does not belong in a
 * shared module.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'lib/payments');
const OUT_DIR = join(ROOT, 'supabase/functions/_shared');

/**
 * Generated pairs. Each entry MUST be a file whose `lib/payments` version is
 * the complete, authoritative implementation.
 */
export const GENERATED_FILES = [
  'RefundStateMachine.ts',
  'RefundOperationTypes.ts',
  'RefundOperationErrors.ts',
  'RefundOperationKey.ts',
  'RefundOperationRepository.ts',
  'BookingCancellationCore.ts',
  'AsaasEnvironment.ts', // AP-04: fonte unica do ambiente Asaas
];

/**
 * NOT generated, and why. Kept here so the exclusion is a documented decision
 * rather than an omission.
 */
export const NOT_GENERATED: Record<string, string> = {
  'NotificationService.ts':
    'No pair in lib/payments (the Node copy lives at lib/NotificationService.ts and differs).',
  'asaasClient.ts':
    'Deno-only HTTP client. The Core receives it through the `httpFetch` parameter instead of importing it.',
  'InstallmentService.ts':
    'BLOCKED — the _shared copy exposes only recordRefundSettlement (94 lines); ' +
    'lib/payments/InstallmentService.ts is a different, larger module (319 lines) that also ' +
    'imports the projections subsystem. Generating it would silently swap the implementation ' +
    'used by sync-payment-status and pull a new dependency graph into the Deno bundle. ' +
    'Unifying it is a decision of its own (see P-1.18F.1), not a side effect of this phase.',
};

const BANNER = (sourceRel: string) =>
  `// =============================================================================\n` +
  `// ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR\n` +
  `//\n` +
  `// Fonte: ${sourceRel}\n` +
  `// Gerador: scripts/sync-shared.ts  (P-1.20.1B)\n` +
  `//\n` +
  `// Edite a fonte e rode \`npx tsx scripts/sync-shared.ts\`.\n` +
  `// \`npx tsx scripts/sync-shared.ts --check\` falha se este arquivo divergir.\n` +
  `// =============================================================================\n\n`;

const SUPABASE_IMPORT_NODE = `import { SupabaseClient } from '@supabase/supabase-js';`;
const SUPABASE_IMPORT_DENO =
  `import { createClient } from 'npm:@supabase/supabase-js@2';\n` +
  `type SupabaseClient = ReturnType<typeof createClient>;`;

export function transform(source: string, sourceRel: string): string {
  let out = source;

  // 1. supabase-js: bare specifier (Node/Vite) -> npm: specifier (Deno)
  out = out.replace(SUPABASE_IMPORT_NODE, SUPABASE_IMPORT_DENO);

  // 2. sibling modules: `.js` specifiers (tsc/Vite) -> real `.ts` (Deno)
  out = out.replace(/from '\.\/([A-Za-z0-9_.-]+)\.js'/g, "from './$1.ts'");

  // 3. NotificationService lives one level up in lib/, side by side in _shared
  out = out.replace(/from '\.\.\/NotificationService\.js'/g, "from './NotificationService.ts'");

  // 4. Any remaining parent-relative import would escape _shared in Deno.
  const escaped = out.match(/from '\.\.\/[^']+'/g);
  if (escaped) {
    throw new Error(
      `${sourceRel}: unresolved parent-relative import(s) ${escaped.join(', ')}. ` +
      `A shared module may only import its siblings.`
    );
  }

  return BANNER(sourceRel) + out;
}

interface FileResult { file: string; changed: boolean; }

function run(check: boolean): number {
  const results: FileResult[] = [];
  const stale: string[] = [];
  const missingSource: string[] = [];

  for (const file of GENERATED_FILES) {
    const srcPath = join(SRC_DIR, file);
    const outPath = join(OUT_DIR, file);
    const sourceRel = `lib/payments/${file}`;

    if (!existsSync(srcPath)) { missingSource.push(sourceRel); continue; }

    const generated = transform(readFileSync(srcPath, 'utf-8'), sourceRel);
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null;
    const changed = current !== generated;

    if (changed && !check) writeFileSync(outPath, generated, 'utf-8');
    if (changed && check) stale.push(`supabase/functions/_shared/${file}`);
    results.push({ file, changed });
  }

  console.log('='.repeat(72));
  console.log(`sync-shared — ${check ? 'VERIFICACAO (--check)' : 'GERACAO'}`);
  console.log('='.repeat(72));
  for (const r of results) {
    const mark = r.changed ? (check ? 'DIVERGENTE' : 'gerado') : 'ok';
    console.log(`  ${mark.padEnd(12)} supabase/functions/_shared/${r.file}`);
  }
  console.log('\n  Nao gerados (decisao explicita):');
  for (const [f, why] of Object.entries(NOT_GENERATED)) console.log(`    - ${f}: ${why}`);

  if (missingSource.length > 0) {
    console.error('\nERRO — fonte ausente:');
    missingSource.forEach(f => console.error(`  - ${f}`));
    return 2;
  }

  if (check && stale.length > 0) {
    console.error('\nFALHA — _shared divergente de lib/payments:');
    stale.forEach(f => console.error(`  - ${f}`));
    console.error('\nRode: npx tsx scripts/sync-shared.ts');
    return 1;
  }

  console.log(check ? '\n_shared esta sincronizado com lib/payments.' : '\nGeracao concluida.');
  return 0;
}

const entry = typeof process !== 'undefined' && process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = entry.endsWith('sync-shared.ts') || entry.endsWith('sync-shared.js');

if (isMain) {
  process.exit(run(process.argv.includes('--check')));
}

export { run };
