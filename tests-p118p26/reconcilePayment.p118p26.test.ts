/**
 * P-1.18P2.6 — Reconciliacao pelo fluxo financeiro oficial.
 * Sem rede, sem Asaas, sem banco: tudo por injecao de dependencia.
 */
process.env.CRON_SECRET = 'test-cron-secret-p118p26';
process.env.ASAAS_API_KEY = process.env.ASAAS_API_KEY || 'test_key';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test_service_role';

import handler, {
  validateReconcileBody,
  deriveAsaasFeeCents,
  isSettleableStatus,
  reconcilePayment
} from '../api/reconcile-payment';
import { SettlementOutcome } from '../lib/payments/SettlementTypes';
import * as fs from 'fs';
import * as path from 'path';

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`); }
}
function eq(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, label, `esperado ${String(expected)}, obtido ${String(actual)}`);
}
function section(t: string) { console.log(`\n== ${t} ==`); }

/** Parcela 1 da compra 4x real 7d1ed64a, sob o contrato P-1.18E. */
const PARCELA = {
  id: 'inst_1',
  gross_amount: 5193,
  net_amount: 4500,
  platform_fee: 500,
  fee_amount: 193,
  group_id: 'grp_real',
  appointment_id: 'apt_1',
  student_id: 'stu_1',
  instructor_id: 'ins_1',
  status: 'PENDING'
};

/** Resposta crua do Asaas para essa parcela: value 51,93 / netValue 50,01. */
function asaasRaw(over: Record<string, unknown> = {}) {
  return {
    id: 'pay_382oqobmuzycog9d',
    status: 'RECEIVED',
    value: 51.93,
    netValue: 50.01,
    installmentNumber: 1,
    installmentCount: 4,
    paymentDate: '2026-09-19T01:19:35.000Z',
    ...over
  };
}

function mockDeps(over: { raw?: any; installment?: any; outcome?: SettlementOutcome } = {}) {
  const calls: any = { settlement: [], installment: [], selects: [] };
  const supabase: any = {
    from(table: string) {
      calls.selects.push(table);
      const row = over.installment === null ? null : (over.installment || PARCELA);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row, error: null })
      };
      return chain;
    }
  };
  return {
    calls,
    deps: {
      supabase,
      getPaymentRaw: async () => (over.raw !== undefined ? over.raw : asaasRaw()),
      processSettlement: async (input: any) => {
        calls.settlement.push(input);
        return {
          outcome: over.outcome || SettlementOutcome.SETTLEMENT_EXECUTED,
          settlementType: 'PAYMENT',
          settlementKey: 'k',
          grossAmount: input.grossAmount,
          netAmount: input.netAmount,
          feeAmount: input.feeAmount,
          platformFee: input.platformFee,
          instructorAmount: input.netAmount,
          settledAt: input.settledAt,
          warnings: []
        } as any;
      },
      recordPaymentSettlement: async (_sb: any, dto: any) => { calls.installment.push(dto); }
    } as any
  };
}

function mockRes() {
  const out: any = { statusCode: 0, body: null, headers: {} };
  const res: any = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status: (c: number) => { out.statusCode = c; return res; },
    json: (b: any) => { out.body = b; return res; }
  };
  return { out, res };
}

async function main() {
  // -------------------------------------------------------------------------
  section('T1-T4 — autenticacao e validacao do corpo');

  {
    const { out, res } = mockRes();
    await handler({ method: 'GET', headers: {}, body: {} }, res);
    eq(out.statusCode, 405, 'T1a) metodo diferente de POST -> 405');
  }
  {
    const { out, res } = mockRes();
    await handler({ method: 'POST', headers: {}, body: { providerPaymentId: 'pay_x' } }, res);
    eq(out.statusCode, 401, 'T1b) sem Authorization -> 401');
  }
  {
    const { out, res } = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer errado' }, body: { providerPaymentId: 'pay_x' } }, res);
    eq(out.statusCode, 401, 'T2) Authorization invalido -> 401');
  }
  {
    const v = validateReconcileBody({});
    eq(v.ok, false, 'T3) corpo sem providerPaymentId -> recusado');
    eq(v.code, 'MISSING_PROVIDER_PAYMENT_ID', 'T3) codigo correto');
  }
  {
    const v = validateReconcileBody({ providerPaymentId: '  ' });
    eq(v.ok, false, 'T3) providerPaymentId vazio -> recusado');
  }
  for (const campo of [
    'value', 'netValue', 'feeAmount', 'platformFee', 'instructorAmount',
    'grossAmount', 'netAmount', 'gross_amount', 'net_amount',
    'platform_fee', 'fee_amount', 'instructor_amount', 'appointmentPrice', 'amount', 'price'
  ]) {
    const v = validateReconcileBody({ providerPaymentId: 'pay_x', [campo]: 999 });
    eq(v.ok, false, `T4) corpo com '${campo}' -> recusado`);
    eq(v.code, 'FORBIDDEN_FIELDS', `T4) '${campo}' classificado como campo proibido`);
  }
  {
    const v = validateReconcileBody({ providerPaymentId: 'pay_x' });
    eq(v.ok, true, 'T4) corpo com apenas providerPaymentId -> aceito');
    eq(v.providerPaymentId, 'pay_x', 'T4) identificador extraido');
  }
  {
    const v = validateReconcileBody('{"providerPaymentId":"pay_y"}');
    eq(v.ok, true, 'corpo como string JSON tambem e aceito');
    eq(validateReconcileBody('nao é json').ok, false, 'JSON malformado -> recusado');
    eq(validateReconcileBody([1, 2]).ok, false, 'array -> recusado');
  }

  // -------------------------------------------------------------------------
  section('T5 — CONFIRMED nao liquida');

  eq(isSettleableStatus('CONFIRMED'), false, 'T5) CONFIRMED nao e liquidavel');
  eq(isSettleableStatus('PENDING'), false, 'T5) PENDING nao e liquidavel');
  eq(isSettleableStatus('OVERDUE'), false, 'T5) OVERDUE nao e liquidavel');
  {
    const { calls, deps } = mockDeps({ raw: asaasRaw({ status: 'CONFIRMED' }) });
    const r = await reconcilePayment(deps, 'pay_x');
    eq(r.body.outcome, 'NOT_SETTLEABLE', 'T5) CONFIRMED -> NOT_SETTLEABLE');
    eq(r.body.settled, false, 'T5) CONFIRMED nao liquida');
    eq(calls.settlement.length, 0, 'T5) SettlementService nao e chamado');
    eq(calls.installment.length, 0, 'T5) parcela nao e marcada');
  }

  // -------------------------------------------------------------------------
  section('T6/T7 — RECEIVED e RECEIVED_IN_CASH liquidam pelo SettlementService');

  for (const st of ['RECEIVED', 'RECEIVED_IN_CASH']) {
    const { calls, deps } = mockDeps({ raw: asaasRaw({ status: st }) });
    const r = await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
    eq(r.body.settled, true, `T6/T7) ${st} liquida`);
    eq(calls.settlement.length, 1, `T6/T7) ${st}: SettlementService chamado uma vez`);
    eq(calls.installment.length, 1, `T6/T7) ${st}: parcela marcada uma vez`);
  }

  // -------------------------------------------------------------------------
  section('T10-T12 — valores entregues ao SettlementService');

  {
    const { calls, deps } = mockDeps();
    await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
    const s = calls.settlement[0];
    // T10 — tarifa REAL derivada do Asaas
    eq(s.feeAmount, 192, 'T10) feeAmount = round(51,93x100) - round(50,01x100) = 192');
    eq(deriveAsaasFeeCents({ value: 51.93, netValue: 50.01 }), 192, 'T10) formula isolada confere');
    eq(deriveAsaasFeeCents({ feeValue: 1.92 }), 192, 'T10) fallback feeValue');
    eq(deriveAsaasFeeCents({}), undefined, 'T10) sem dado -> undefined, nunca zero inventado');
    // T11 — comissao lida do contrato, nao recalculada
    eq(s.platformFee, 500, 'T11) platform_fee vem de payment_installments (comissao pura)');
    assert(s.platformFee !== 192, 'T11) platform_fee NAO e a tarifa do Asaas');
    // T12 — instrutor
    eq(s.netAmount, 4500, 'T12) net_amount vem do contrato (= instrutor)');
    assert(s.netAmount !== 5001, 'T12) instrutor NAO recebe netValue do Asaas');
    eq(s.grossAmount, 5193, 'gross_amount vem do contrato');
    eq(s.providerSettlementId, 'pay_382oqobmuzycog9d', 'providerSettlementId = id do pagamento (mesma chave do webhook)');
    eq(s.installmentNumber, 1, 'installmentNumber vem do Asaas');
    eq(s.settledAt, '2026-09-19T01:19:35.000Z', 'settledAt = paymentDate do Asaas');
    // identidade contabil
    eq(s.netAmount + s.platformFee + (PARCELA.fee_amount), s.grossAmount,
      'gross = instrutor + comissao + taxa esperada');
  }

  // -------------------------------------------------------------------------
  section('T13/T18 — parcela RECEIVED, nunca PAID');

  {
    const { calls, deps } = mockDeps();
    await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
    const dto = calls.installment[0];
    eq(dto.providerPaymentId, 'pay_382oqobmuzycog9d', 'T13) parcela correta');
    eq(dto.installmentNumber, 1, 'T13) numero da parcela correto');
    eq(dto.totalInstallments, 4, 'T13) total de parcelas do Asaas');
    eq(dto.netAmountCents, 4500, 'T13) valores do contrato, nao recalculados');
    eq(dto.platformFeeCents, 500, 'T13) comissao do contrato');
    eq(dto.paymentDate, '2026-09-19T01:19:35.000Z', 'T13) payment_date do Asaas');
    // T18 — o metodo que marca RECEIVED e' o oficial; 'PAID' nao existe no fluxo
    const src = fs.readFileSync(path.join(process.cwd(), 'api/reconcile-payment.ts'), 'utf8');
    assert(!/['"]PAID['"]/.test(src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
      'T18) o endpoint nunca grava PAID');
  }

  // -------------------------------------------------------------------------
  section('T8/T9 — idempotencia e concorrencia');

  {
    // Parcela ainda PENDING: NO_OP no settlement, mas a parcela pode ser
    // corrigida (cenario B).
    const { calls, deps } = mockDeps({ outcome: SettlementOutcome.NO_OP_DUPLICATE });
    const r = await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
    eq(r.body.outcome, SettlementOutcome.NO_OP_DUPLICATE, 'T8) retry -> NO_OP_DUPLICATE');
    eq(r.body.settled, true, 'T8) retry continua reportando liquidado');
    eq(calls.settlement.length, 1, 'T8) uma unica chamada de liquidacao');
  }

  // -------------------------------------------------------------------------
  section('P-1.18P2.7 — NO_OP_DUPLICATE nao pode sobrescrever a tarifa real');

  // A) primeira reconciliacao: parcela PENDING, sem liquidacao previa
  {
    const { calls, deps } = mockDeps({
      outcome: SettlementOutcome.SETTLEMENT_EXECUTED,
      installment: { ...PARCELA, status: 'PENDING' }
    });
    const r = await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
    eq(r.body.outcome, SettlementOutcome.SETTLEMENT_EXECUTED, 'A) primeira reconciliacao liquida');
    eq(calls.settlement.length, 1, 'A) SettlementService chamado 1x');
    eq(calls.installment.length, 1, 'A) parcela marcada RECEIVED 1x');
    eq(r.body.wrote, true, 'A) houve escrita');
  }

  // B) ja liquidado E parcela RECEIVED -> NO-OP TOTAL
  {
    const { calls, deps } = mockDeps({
      outcome: SettlementOutcome.NO_OP_DUPLICATE,
      installment: { ...PARCELA, status: 'RECEIVED' }
    });
    const r = await reconcilePayment(deps, 'pay_y5tvjf2s3yy4c5n8');
    eq(r.body.outcome, 'NO_OP_ALREADY_RECONCILED', 'B) cenario A -> NO_OP_ALREADY_RECONCILED');
    eq(r.body.settled, true, 'B) continua reportando liquidado');
    eq(r.body.wrote, false, 'B) nenhuma escrita');
    eq(calls.installment.length, 0, 'B) recordPaymentSettlement chamado 0x');
    eq(calls.settlement.length, 1, 'B) o settlement foi apenas consultado (NO_OP), nao recriado');
    // fee_amount / platform_fee / instructor_amount permanecem intocados:
    // nenhuma escrita partiu do endpoint em nenhuma das duas tabelas.
    eq(calls.installment.length, 0, 'B) fee_amount da parcela permanece inalterado');
    eq(calls.installment.length, 0, 'B) platform_fee permanece inalterado');
    eq(calls.installment.length, 0, 'B) instructor_amount permanece inalterado');
  }

  // C) liquidacao existente + parcela ainda nao RECEIVED -> so a parcela
  {
    for (const st of ['PENDING', 'OVERDUE', 'AUTHORIZED']) {
      const { calls, deps } = mockDeps({
        outcome: SettlementOutcome.NO_OP_DUPLICATE,
        installment: { ...PARCELA, status: st }
      });
      const r = await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
      eq(r.body.outcome, SettlementOutcome.NO_OP_DUPLICATE, `C/${st}) settlement permanece NO_OP`);
      eq(calls.installment.length, 1, `C/${st}) parcela corrigida para RECEIVED`);
      const dto = calls.installment[0];
      eq(dto.grossAmountCents, PARCELA.gross_amount, `C/${st}) gross preservado`);
      eq(dto.netAmountCents, PARCELA.net_amount, `C/${st}) net preservado`);
      eq(dto.platformFeeCents, PARCELA.platform_fee, `C/${st}) platform_fee preservado`);
      eq(dto.feeAmountCents, PARCELA.fee_amount, `C/${st}) fee_amount preservado (nao recalculado)`);
    }
  }

  // D) protecao estrutural: o endpoint nao escreve payment_settlements
  {
    const src = fs.readFileSync(path.join(process.cwd(), 'api/reconcile-payment.ts'), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/payment_settlements/.test(src),
      'D) nenhuma referencia a payment_settlements no codigo do endpoint');
    assert(!/\.(insert|update|upsert|delete)\(/.test(src.split('from(')[0] || ''),
      'D) nenhuma escrita direta antes da primeira query');
    const inst = fs.readFileSync(path.join(process.cwd(), 'lib/payments/InstallmentService.ts'), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/from\(['"]payment_settlements['"]\)/.test(inst),
      'D) P-1.18P2.2 continua valida: InstallmentService nao escreve payment_settlements');
  }
  {
    // T9 — webhook e reconciliacao simultaneos: a chave e a mesma, entao o
    // segundo vira NO_OP no SettlementService. Aqui provamos que a chave usada
    // pela reconciliacao e identica a do webhook.
    const { calls, deps } = mockDeps();
    await reconcilePayment(deps, 'pay_382oqobmuzycog9d');
    eq(calls.settlement[0].providerSettlementId, asaasRaw().id,
      'T9) mesma providerSettlementId do webhook -> unique_settlement_idempotency resolve');
  }

  // -------------------------------------------------------------------------
  section('Contrato ausente — fail-closed');

  {
    const { calls, deps } = mockDeps({ installment: null });
    const r = await reconcilePayment(deps, 'pay_sem_contrato');
    eq(r.httpStatus, 409, 'sem payment_installments -> 409');
    eq(r.body.outcome, 'INSTALLMENT_NOT_FOUND', 'fail-closed, sem inventar valores');
    eq(calls.settlement.length, 0, 'nada e liquidado sem contrato');
    eq(calls.installment.length, 0, 'nenhuma parcela e marcada');
  }
  {
    const { calls, deps } = mockDeps({ outcome: SettlementOutcome.ERROR });
    const r = await reconcilePayment(deps, 'pay_erro');
    eq(r.httpStatus, 500, 'erro de liquidacao -> 500');
    eq(r.body.settled, false, 'erro nao reporta liquidado');
    eq(calls.installment.length, 0, 'parcela NAO e marcada quando a liquidacao falha');
  }

  // -------------------------------------------------------------------------
  section('T14-T16/T19/T20 — estrutura: autoridade unica e Edge sem regra financeira');

  {
    const root = process.cwd();
    const endpoint = fs.readFileSync(path.join(root, 'api/reconcile-payment.ts'), 'utf8');
    const limpo = endpoint.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // T14/T15/T16 — o endpoint delega; nao escreve settlement/transacao/projecao
    assert(!/from\(['"]payment_settlements['"]\)/.test(limpo),
      'T14) o endpoint nao escreve payment_settlements diretamente');
    assert(/SettlementService\.processSettlement/.test(endpoint),
      'T14-T16) delega ao SettlementService (settlement + transacao + projecao)');
    assert(!/ProjectionDispatcher/.test(limpo), 'T16) projecao nao e duplicada no endpoint');
    assert(!/\* *0\.10|\* *0,10|0\.9\b/.test(limpo), 'nenhuma comissao recalculada no endpoint');

    const edge = fs.readFileSync(path.join(root, 'supabase/functions/sync-payment-status/index.ts'), 'utf8');
    const edgeLimpo = edge.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // T19 — a Edge Function nao calcula mais valores
    assert(!/from\(['"]payment_settlements['"]\)/.test(edgeLimpo),
      'T19) sync-payment-status nao escreve mais payment_settlements');
    assert(!/status:\s*['"]PAID['"]/.test(edgeLimpo),
      'T19) sync-payment-status nao grava mais PAID');
    assert(!/platformFeeVal/.test(edgeLimpo), 'T19) aritmetica de platform_fee removida');
    assert(!/instructorAmount\s*=/.test(edgeLimpo), 'T19) calculo de instructor_amount removido');
    assert(!/fee_amount:\s*0/.test(edgeLimpo), 'T19) fee_amount = 0 removido');
    assert(/\/api\/reconcile-payment/.test(edge), 'T19) a Edge chama o endpoint oficial');
    assert(/JSON\.stringify\(\{ providerPaymentId: paymentId \}\)/.test(edge),
      'T19) o corpo enviado contem SOMENTE providerPaymentId');
    assert(!/Authorization[^\n]*console/.test(edge), 'nenhum log de Authorization');

    // T17 — appointment so' e reparado depois da liquidacao confirmada
    const idxReconcile = edge.indexOf('/api/reconcile-payment');
    const idxGuard = edge.indexOf('if (!reconciled)');
    const idxRepair = edge.indexOf("status: 'pending_approval'");
    assert(idxReconcile > 0 && idxGuard > idxReconcile && idxRepair > idxGuard,
      'T17) reparo do appointment ocorre apos a confirmacao da liquidacao');
    assert(/isEffectivelyReceived/.test(edge), 'T5/T17) CONFIRMED e separado explicitamente');

    // T20 — refund intocado
    assert(/recordRefundSettlement/.test(edge), 'T20) ramo de refund preservado');
    assert(/PARTIALLY_REFUNDED/.test(edge), 'T20) PARTIALLY_REFUNDED preservado');
    assert(/isFullRefund/.test(edge), 'T20) deteccao de estorno integral preservada');
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`P-1.18P2.6  PASS=${pass}  FAIL=${fail}`);
  console.log('='.repeat(56));
  if (fail > 0) process.exit(1);
}

main();
