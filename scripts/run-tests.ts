/**
 * run-tests.ts — Runner seguro da suíte financeira do CNHJá
 * Fase P-1.6. Criado apenas para MEDIR. Não corrige nada.
 *
 * SEGURANÇA POR CONSTRUÇÃO:
 *  - allow-list literal: nada é descoberto por sufixo ou glob
 *  - deny-list literal: os 10 arquivos que podem atingir produção
 *  - qualquer arquivo em disco fora das duas listas ABORTA a execução
 *  - variáveis de ambiente perigosas são removidas do processo filho
 *    (o .env.local do projeto NÃO é lido, alterado nem apagado)
 *
 * Uso:  npx tsx scripts/run-tests.ts
 * Exit: 0 = todos passaram · 1 = houve falha/erro · 2 = suíte não classificada
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TESTS_DIR = resolve(process.cwd(), 'lib/payments/tests');
const TIMEOUT_MS = 60_000;

/** 36 arquivos verificados estaticamente: sem createClient, sem env Supabase,
 *  sem rede externa, sem import de api/. */
const ALLOW = [
  'CancelBookingFase3110.unit.test.ts',
  'ConstraintAndCancellationCore.unit.test.ts',
  'EligibilityScanner.unit.test.ts',
  'EligibilityService.unit.test.ts',
  'InstallmentFullRefundFase3114.unit.test.ts',
  'InstallmentSequenceValidation.unit.test.ts',
  'InstructorMonthlyMetrics.unit.test.ts',
  'InstructorStatement.unit.test.ts',
  'IntegrityChecker.unit.test.ts',
  'Onda1Read.unit.test.ts',
  'PaymentStateService.unit.test.ts',
  'PayoutEngine.concurrency.test.ts',
  'PayoutEngine.integration.test.ts',
  'PayoutEngine.unit.test.ts',
  'PayoutKeyFactory.unit.test.ts',
  'PayoutRepository.unit.test.ts',
  'PayoutStateMachine.unit.test.ts',
  'PayoutWorker.concurrency.test.ts',
  'PayoutWorker.integration.test.ts',
  'PayoutWorker.unit.test.ts',
  'ProjectionService.unit.test.ts',
  'Reconciliation.edgecases.test.ts',
  'Reconciliation.integration.test.ts',
  'ReconciliationService.unit.test.ts',
  'RefundAdapterAndStateMachine.unit.test.ts',
  'RefundBlockersFase31177.unit.test.ts',
  'RefundCorrectionsFase31175.unit.test.ts',
  'RefundHardeningFase11F3.unit.test.ts',
  'RefundHardeningP1201B.unit.test.ts',
  'RescheduleDirectP1204.unit.test.ts',
  'RescheduleProposalP1205.unit.test.ts',
  'RefundOperationContract.unit.test.ts',
  'RefundOperationRepository.unit.test.ts',
  'RefundOperationRpcSecurity.unit.test.ts',
  'RefundOperationTransition.unit.test.ts',
  'RefundReconciliationFase31.unit.test.ts',
  'SettlementService.unit.test.ts',
  'SyncPaymentStatusRefundFix.unit.test.ts',
  'Wave2Hardening.concurrency.test.ts',
];

/** 10 arquivos bloqueados. NUNCA executar sem um Supabase de teste dedicado. */
const DENY: Record<string, string> = {
  'PaymentStateService.integration.test.ts':
    'createClient real + SERVICE_ROLE; faz insert/delete de fixtures',
  'ProjectionService.integration.test.ts':
    'createClient real + SERVICE_ROLE',
  'SettlementService.integration.test.ts':
    'createClient real + SERVICE_ROLE',
  'RealIdempotencyIntegration.test.ts':
    'createClient real + SERVICE_ROLE',
  'PayoutDatabase.integration.test.ts':
    'createClient real; insert de fixtures em transactions',
  'AsaasWebhookHardening.unit.test.ts':
    "importa api/asaas-webhook (createClient no topo do modulo); usa `process.env.X || placeholder`, logo a env real vence",
  'RefundDeniedAndSplitCalculationFase3111.unit.test.ts':
    'idem: importa o handler real do webhook',
  'RefundHardeningFase3112.unit.test.ts':
    'idem: importa o handler real do webhook',
  'RefundHardeningFase313.unit.test.ts':
    'idem: importa o handler real do webhook + asaasClient',
  'RefundForensicFinalFase314.unit.test.ts':
    'importa api/asaas-webhook e NAO define SUPABASE_URL/SERVICE_ROLE_KEY: se a env real estiver carregada, opera contra producao',
};

/** Variáveis removidas do processo filho. O arquivo .env.local não é tocado. */
const STRIP = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
  'ASAAS_API_KEY', 'ASAAS_API_URL', 'ASAAS_WEBHOOK_SECRET',
  'DATABASE_URL', 'POSTGRES_URL',
];

type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'ENVIRONMENT ERROR';
interface Result { file: string; status: Status; ms: number; note: string }

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIP) delete env[k];
  env.NODE_ENV = 'test';
  env.CNHJA_TEST_RUNNER = '1';
  return env;
}

function classify(stderr: string, code: number | null): { status: Status; note: string } {
  const envMarkers = [
    'You installed esbuild for another platform',
    'ERR_MODULE_NOT_FOUND',
    'Cannot find package',
    'ERR_DLOPEN_FAILED',
  ];
  for (const m of envMarkers) {
    if (stderr.includes(m)) return { status: 'ENVIRONMENT ERROR', note: m };
  }
  if (code === 0) return { status: 'PASS', note: '' };
  const line = stderr.split('\n').map(s => s.trim())
    .find(s => /Assertion|AssertionError|Error:|FAIL/i.test(s)) ?? `exit code ${code}`;
  return { status: 'FAIL', note: line.slice(0, 160) };
}

function main(): void {
  console.log('='.repeat(72));
  console.log('CNHJa — RUNNER SEGURO DA SUITE FINANCEIRA (fase P-1.6, somente medicao)');
  console.log('='.repeat(72));

  if (!existsSync(TESTS_DIR)) {
    console.error(`ERRO: diretorio nao encontrado: ${TESTS_DIR}`);
    process.exit(2);
  }

  // Guarda de integridade: nenhum arquivo pode ficar sem classificacao.
  const onDisk = readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.ts')).sort();
  const known = new Set([...ALLOW, ...Object.keys(DENY)]);
  const unclassified = onDisk.filter(f => !known.has(f));
  const missing = ALLOW.filter(f => !onDisk.includes(f));

  console.log(`\nArquivos em disco: ${onDisk.length}`);
  console.log(`Allow-list: ${ALLOW.length}   Deny-list: ${Object.keys(DENY).length}`);

  if (unclassified.length > 0) {
    console.error('\nABORTADO — arquivos de teste nao classificados:');
    unclassified.forEach(f => console.error(`  - ${f}`));
    console.error('\nClassifique cada um (allow ou deny) antes de executar o runner.');
    process.exit(2);
  }

  // P-1.20.1B: guarda de divergencia. supabase/functions/_shared e' GERADO a
  // partir de lib/payments. Se divergir, a producao roda codigo diferente do
  // que foi revisado -- foi exatamente assim que o defeito do claim sobreviveu.
  console.log('\n--- GUARDA: _shared x lib/payments ---');
  const sync = spawnSync(process.execPath,
    [resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), 'scripts/sync-shared.ts', '--check'],
    { encoding: 'utf-8', env: sanitizedEnv(), timeout: TIMEOUT_MS });
  const syncOut = `${sync.stdout || ''}${sync.stderr || ''}`;
  if (sync.status !== 0) {
    console.error(syncOut);
    console.error('\nABORTADO — supabase/functions/_shared divergente de lib/payments.');
    console.error('Rode: npx tsx scripts/sync-shared.ts');
    process.exit(2);
  }
  console.log('  ok — _shared sincronizado com lib/payments');

  console.log('\n--- ALLOW-LIST (sera executada) ---');
  ALLOW.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));
  console.log('\n--- DENY-LIST (NAO sera executada) ---');
  Object.entries(DENY).forEach(([f, why], i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${f}\n      motivo: ${why}`));

  console.log(`\nVariaveis removidas do processo filho: ${STRIP.join(', ')}`);
  console.log('O arquivo .env.local NAO e lido, alterado nem apagado.\n');

  const env = sanitizedEnv();
  const results: Result[] = [];

  for (const f of missing) {
    results.push({ file: f, status: 'BLOCKED', ms: 0, note: 'arquivo ausente em disco' });
  }

  const toRun = ALLOW.filter(f => onDisk.includes(f));
  console.log('='.repeat(72));
  console.log(`EXECUTANDO ${toRun.length} testes, sequencialmente\n`);

  for (const f of toRun) {
    const t0 = Date.now();
    const r = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(TESTS_DIR, f)],
      { env, encoding: 'utf-8', timeout: TIMEOUT_MS, cwd: process.cwd() }
    );
    const ms = Date.now() - t0;
    const stderr = (r.stderr ?? '') + (r.stdout ?? '');

    let status: Status, note: string;
    if (r.error && (r.error as any).code === 'ETIMEDOUT') {
      status = 'FAIL'; note = `timeout apos ${TIMEOUT_MS} ms`;
    } else {
      ({ status, note } = classify(stderr, r.status));
    }

    results.push({ file: f, status, ms, note });
    const icon = { PASS: 'PASS ', FAIL: 'FAIL ', BLOCKED: 'BLOCK', 'ENVIRONMENT ERROR': 'ENV  ' }[status];
    console.log(`[${icon}] ${f.padEnd(52)} ${String(ms).padStart(6)} ms${note ? '  :: ' + note : ''}`);
  }

  const n = (s: Status) => results.filter(r => r.status === s).length;
  console.log('\n' + '='.repeat(72));
  console.log('RESUMO');
  console.log('='.repeat(72));
  console.log(`  Descobertos em disco .......... ${onDisk.length}`);
  console.log(`  Allow-list .................... ${ALLOW.length}`);
  console.log(`  Deny-list (nao executados) .... ${Object.keys(DENY).length}`);
  console.log(`  Executados .................... ${toRun.length}`);
  console.log(`  PASS .......................... ${n('PASS')}`);
  console.log(`  FAIL .......................... ${n('FAIL')}`);
  console.log(`  BLOCKED ....................... ${n('BLOCKED')}`);
  console.log(`  ENVIRONMENT ERROR ............. ${n('ENVIRONMENT ERROR')}`);
  console.log(`  Duracao total ................. ${results.reduce((a, r) => a + r.ms, 0)} ms`);

  if (n('FAIL') > 0) {
    console.log('\n--- FALHAS ---');
    results.filter(r => r.status === 'FAIL')
      .forEach(r => console.log(`  ${r.file}\n    ${r.note}`));
  }
  if (n('ENVIRONMENT ERROR') > 0) {
    console.log('\n--- ERROS DE AMBIENTE (nao sao falhas de teste) ---');
    results.filter(r => r.status === 'ENVIRONMENT ERROR')
      .forEach(r => console.log(`  ${r.file}\n    ${r.note}`));
  }

  console.log('\nNenhum teste da deny-list foi executado.');
  console.log('Nenhuma variavel de ambiente real foi herdada.\n');

  process.exit(n('FAIL') + n('ENVIRONMENT ERROR') + n('BLOCKED') > 0 ? 1 : 0);
}

main();
