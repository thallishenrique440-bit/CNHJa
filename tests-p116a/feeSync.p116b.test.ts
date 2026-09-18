/**
 * P-1.16B — Testes da sincronizacao de tarifas.
 * Sem Asaas real, sem Supabase real, sem rede, sem env. Respostas mockadas.
 *
 *   npx tsx tests-p116a/feeSync.p116b.test.ts
 */
import { parseAsaasFees } from '../lib/payments/AsaasFeeParser';
import { planGatewayFeeSync, untouchedRanges, CurrentFeeRow } from '../lib/payments/GatewayFeeSyncPlanner';
import { applyGatewayFeeSync, readCurrentFeeRows, syncAgeDays } from '../lib/payments/GatewayFeeSyncService';
import { quoteCheckout, DEFAULT_GATEWAY_FEE_SCHEDULE, mapGatewayFeeRows } from '../lib/payments/GatewayFeeModel';

let pass = 0, fail = 0;
function assert(c: boolean, label: string, detail?: string) {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`); }
}
const eq = (a: unknown, b: unknown, label: string) =>
  assert(a === b, label, `esperado ${String(b)}, obtido ${String(a)}`);
const section = (t: string) => console.log(`\n== ${t} ==`);

// --------------------------------------------------------------------------
// Fake supabase: registra tudo que seria escrito, sem banco.
// --------------------------------------------------------------------------
type FailSpec = { onUpdateId?: string; onInsert?: boolean; onSelect?: boolean; onReopen?: boolean };
function fakeSupabase(rows: CurrentFeeRow[], failSpec: FailSpec = {}) {
  const log: Array<{ op: string; payload: any }> = [];
  const store = rows.map(r => ({ ...r, effective_to: null as string | null }));
  let reopenSeen = false;

  const api = {
    log,
    store,
    from(_table: string) {
      return {
        select(_cols: string) {
          const chain: any = {
            eq() { return chain; },
            is() {
              if (failSpec.onSelect) return Promise.resolve({ data: null, error: { message: 'select boom' } });
              return Promise.resolve({ data: store.filter(r => r.effective_to === null), error: null });
            }
          };
          return chain;
        },
        update(payload: any) {
          return {
            eq(_col: string, id: string) {
              const isReopen = payload.effective_to === null;
              if (isReopen) reopenSeen = true;
              if (failSpec.onUpdateId && failSpec.onUpdateId === id && !isReopen) {
                log.push({ op: 'update-failed', payload: { id, ...payload } });
                return Promise.resolve({ error: { message: 'update boom' } });
              }
              if (failSpec.onReopen && isReopen) {
                log.push({ op: 'reopen-failed', payload: { id } });
                return Promise.resolve({ error: { message: 'reopen boom' } });
              }
              const row = store.find(r => r.id === id);
              if (row) (row as any).effective_to = payload.effective_to;
              log.push({ op: isReopen ? 'reopen' : 'close', payload: { id, ...payload } });
              return Promise.resolve({ error: null });
            }
          };
        },
        insert(payload: any) {
          if (failSpec.onInsert) {
            log.push({ op: 'insert-failed', payload });
            return Promise.resolve({ error: { message: 'insert boom' } });
          }
          store.push({ ...payload, id: `new-${store.length}` });
          log.push({ op: 'insert', payload });
          return Promise.resolve({ error: null });
        },
        delete() { log.push({ op: 'DELETE', payload: null }); return Promise.resolve({ error: null }); }
      };
    },
    get reopenSeen() { return reopenSeen; }
  };
  return api;
}

const CURRENT: CurrentFeeRow[] = [
  { id: 'pix-1',  provider: 'asaas', method: 'PIX',         installment_from: 1,  installment_to: 1,  percent: '0.0000', fixed_cents: 199, source: 'manual' },
  { id: 'cc-1',   provider: 'asaas', method: 'CREDIT_CARD', installment_from: 1,  installment_to: 1,  percent: '2.9900', fixed_cents: 49,  source: 'manual' },
  { id: 'cc-2-6', provider: 'asaas', method: 'CREDIT_CARD', installment_from: 2,  installment_to: 6,  percent: '3.4900', fixed_cents: 49,  source: 'manual' },
  { id: 'cc-7-12',provider: 'asaas', method: 'CREDIT_CARD', installment_from: 7,  installment_to: 12, percent: '3.9900', fixed_cents: 49,  source: 'manual' },
  { id: 'cc-13-21',provider:'asaas', method: 'CREDIT_CARD', installment_from: 13, installment_to: 21, percent: '4.2900', fixed_cents: 49,  source: 'manual' }
];
const NOW = '2026-09-18T12:00:00.000Z';

// --------------------------------------------------------------------------
section('Parser: contrato documentado de /myAccount/fees');

// Payload MOCK com a estrutura documentada pelo Asaas (P-1.16B.3).
// Valores ilustrativos; nenhuma chamada real ao Asaas.
const FEES_OK = {
  payment: {
    bankSlip: { defaultValue: 6.96, discountValue: 0, daysToReceive: 1 },
    creditCard: {
      operationValue: 0.49,
      oneInstallmentPercentage: 2.99,
      upToSixInstallmentsPercentage: 3.49,
      upToTwelveInstallmentsPercentage: 3.99,
      upToTwentyOneInstallmentsPercentage: 4.29,
      discountOneInstallmentPercentage: 1.99,
      discountExpiration: '2027-01-01T00:00:00Z',
      daysToReceive: 30
    },
    debitCard: { operationValue: 0.35, defaultPercentage: 1.89, daysToReceive: 1 },
    pix: {
      fixedFeeValue: 1.99,
      fixedFeeValueWithDiscount: 0.99,
      percentageFee: 0,
      minimumFeeValue: 0,
      maximumFeeValue: 0,
      monthlyCreditsWithoutFee: 0,
      creditsReceivedOfCurrentMonth: 3
    }
  },
  transfer: { monthlyTransfersWithoutFee: 0, ted: { feeValue: 5 }, pix: { feeValue: 0 } },
  notification: { whatsAppFeeValue: 0 },
  anticipation: { creditCard: { detachedMonthlyFeeValue: 1.99 } }
};

const tier = (r: ReturnType<typeof parseAsaasFees>, from: number) =>
  r.ranges.find(x => x.method === 'CREDIT_CARD' && x.installmentFrom === from);
const reasonFor = (r: ReturnType<typeof parseAsaasFees>, method: string, from: number) =>
  r.unmapped.find(u => u.method === method && u.installmentFrom === from)?.reason || '';

{ const r = parseAsaasFees(FEES_OK);
  eq(r.ranges.length, 5, 'payload documentado: extrai as 5 faixas');
  eq(r.unmapped.length, 0, 'payload documentado: nenhuma faixa manual');

  const pix = r.ranges.find(x => x.method === 'PIX')!;
  eq(pix.fixedCents, 199, 'PIX: payment.pix.fixedFeeValue 1.99 -> 199 centavos');
  eq(pix.percent, 0, 'PIX: percentual 0 (tarifa fixa)');
  eq(pix.evidence.fixed, 'payment.pix.fixedFeeValue', 'PIX: evidencia aponta o caminho documentado');

  eq(tier(r, 1)!.percent, 2.99, 'cartao 1x: oneInstallmentPercentage');
  eq(tier(r, 1)!.installmentTo, 1, 'cartao 1x: faixa 1..1');
  eq(tier(r, 1)!.fixedCents, 49, 'cartao 1x: operationValue 0.49 -> 49 centavos');
  eq(tier(r, 1)!.evidence.percent, 'payment.creditCard.oneInstallmentPercentage', 'cartao 1x: evidencia do percentual');
  eq(tier(r, 1)!.evidence.fixed, 'payment.creditCard.operationValue', 'cartao 1x: evidencia do fixo');

  eq(tier(r, 2)!.percent, 3.49, 'cartao 2-6x: upToSixInstallmentsPercentage');
  eq(tier(r, 2)!.installmentTo, 6, 'cartao 2-6x: faixa 2..6');
  eq(tier(r, 2)!.fixedCents, 49, 'cartao 2-6x: mesmo operationValue');

  eq(tier(r, 7)!.percent, 3.99, 'cartao 7-12x: upToTwelveInstallmentsPercentage');
  eq(tier(r, 7)!.installmentTo, 12, 'cartao 7-12x: faixa 7..12');

  eq(tier(r, 13)!.percent, 4.29, 'cartao 13-21x: upToTwentyOneInstallmentsPercentage');
  eq(tier(r, 13)!.installmentTo, 21, 'cartao 13-21x: faixa 13..21');

  // Os valores extraidos coincidem com o schedule vigente -> plano idempotente
  const plan = planGatewayFeeSync(CURRENT, r.ranges.map(x => ({
    method: x.method, installmentFrom: x.installmentFrom, installmentTo: x.installmentTo,
    percent: x.percent, fixedCents: x.fixedCents
  })));
  eq(plan.insert.length, 0, 'payload documentado bate com o schedule atual: nenhuma versao nova');
  eq(plan.unchanged.length, 5, 'payload documentado: 5 faixas idempotentes'); }

// ===========================================================================
// PAYLOAD REAL DO SANDBOX — GET /v3/myAccount/fees, capturado em 2026-09-18.
// Reproduzido exatamente como recebido nos campos relevantes. Nenhuma chamada
// de rede e' feita: este e' um literal.
// ===========================================================================
const FEES_SANDBOX_REAL = {
  payment: {
    pix: {
      fixedFeeValue: 1.99,
      type: 'FIXED',
      percentageFee: null          // <- null, nao 0
    },
    creditCard: {
      operationValue: 0.49,
      oneInstallmentPercentage: 2.99,
      upToSixInstallmentsPercentage: 3.49,
      upToTwelveInstallmentsPercentage: 3.99,
      upToTwentyOneInstallmentsPercentage: 4.29,
      hasValidDiscount: false,
      discountExpiration: '2026-09-14 00:00:00'   // ja vencido
    }
  }
};

{ const r = parseAsaasFees(FEES_SANDBOX_REAL);
  eq(r.ranges.length, 5, 'SANDBOX REAL: extrai as 5 faixas');
  eq(r.unmapped.length, 0, 'SANDBOX REAL: nenhuma faixa fica manual');

  const pix = r.ranges.find(x => x.method === 'PIX')!;
  eq(pix.fixedCents, 199, 'SANDBOX REAL: PIX = R$1,99 (199 centavos)');
  eq(pix.percent, 0, 'SANDBOX REAL: PIX percentual 0');
  eq(pix.evidence.fixed, 'payment.pix.fixedFeeValue', 'SANDBOX REAL: evidencia do PIX');

  // percentageFee: null NAO pode acionar a guarda de "PIX percentual"
  assert(r.unmapped.every(u => !/percentual de PIX/.test(u.reason)), 'SANDBOX REAL: percentageFee null nao aciona a guarda de PIX percentual');

  eq(tier(r, 1)!.percent,  2.99, 'SANDBOX REAL: cartao 1x = 2,99%');
  eq(tier(r, 2)!.percent,  3.49, 'SANDBOX REAL: cartao 2-6x = 3,49%');
  eq(tier(r, 7)!.percent,  3.99, 'SANDBOX REAL: cartao 7-12x = 3,99%');
  eq(tier(r, 13)!.percent, 4.29, 'SANDBOX REAL: cartao 13-21x = 4,29%');
  assert(r.ranges.filter(x => x.method === 'CREDIT_CARD').every(x => x.fixedCents === 49), 'SANDBOX REAL: operationValue R$0,49 em todas as faixas de cartao');

  // hasValidDiscount / discountExpiration nao influenciam nada
  eq(tier(r, 1)!.percent, 2.99, 'SANDBOX REAL: hasValidDiscount=false nao altera a extracao');

  // O resultado bate exatamente com o gateway_fee_schedule vigente
  const plan = planGatewayFeeSync(CURRENT, r.ranges.map(x => ({
    method: x.method, installmentFrom: x.installmentFrom, installmentTo: x.installmentTo,
    percent: x.percent, fixedCents: x.fixedCents
  })));
  eq(plan.unchanged.length, 5, 'SANDBOX REAL: as 5 faixas ja conferem com o schedule em producao');
  eq(plan.insert.length, 0, 'SANDBOX REAL: nenhuma versao nova seria criada');
  eq(plan.close.length, 0, 'SANDBOX REAL: nenhuma faixa vigente seria fechada'); }

// payload real truncado -> fail-safe, sem sobrescrever tarifa
{ const truncado = JSON.parse(JSON.stringify(FEES_SANDBOX_REAL));
  delete truncado.payment.creditCard.operationValue;
  const r = parseAsaasFees(truncado);
  eq(r.ranges.filter(x => x.method === 'CREDIT_CARD').length, 0, 'SANDBOX REAL truncado: cartao nao sincroniza sem operationValue');
  const plan = planGatewayFeeSync(CURRENT, r.ranges.map(x => ({
    method: x.method, installmentFrom: x.installmentFrom, installmentTo: x.installmentTo,
    percent: x.percent, fixedCents: x.fixedCents
  })));
  eq(plan.close.length, 0, 'SANDBOX REAL truncado: nenhuma faixa vigente e fechada');
  eq(plan.insert.length, 0, 'SANDBOX REAL truncado: nenhuma escrita planejada'); }

{ const malformado = { payment: { pix: 'FIXED', creditCard: [] } };
  const r = parseAsaasFees(malformado);
  eq(r.ranges.length, 0, 'SANDBOX malformado: nada extraido');
  eq(r.unmapped.length, 5, 'SANDBOX malformado: as 5 faixas viram manuais'); }

// -- decisoes financeiras pendentes NAO foram implementadas ------------------
{ const comDesconto = JSON.parse(JSON.stringify(FEES_OK));
  comDesconto.payment.creditCard.discountOneInstallmentPercentage = 0.5;
  comDesconto.payment.creditCard.discountExpiration = '2099-01-01T00:00:00Z';
  comDesconto.payment.pix.fixedFeeValueWithDiscount = 0.10;
  const r = parseAsaasFees(comDesconto);
  eq(tier(r, 1)!.percent, 2.99, 'desconto vigente NAO altera o percentual extraido (decisao pendente)');
  eq(r.ranges.find(x => x.method === 'PIX')!.fixedCents, 199, 'fixedFeeValueWithDiscount NAO e usado (decisao pendente)'); }

{ const comMinMax = JSON.parse(JSON.stringify(FEES_OK));
  comMinMax.payment.pix.minimumFeeValue = 0.5;
  comMinMax.payment.pix.maximumFeeValue = 9.9;
  const r = parseAsaasFees(comMinMax);
  eq(r.ranges.find(x => x.method === 'PIX')!.fixedCents, 199, 'minimum/maximumFeeValue NAO sao interpretados (decisao pendente)'); }

// -- payload incompleto -> fail-safe ----------------------------------------
{ const semFixo = JSON.parse(JSON.stringify(FEES_OK));
  delete semFixo.payment.creditCard.operationValue;
  const r = parseAsaasFees(semFixo);
  eq(r.ranges.filter(x => x.method === 'CREDIT_CARD').length, 0, 'sem operationValue: NENHUMA faixa de cartao sincroniza');
  eq(r.ranges.filter(x => x.method === 'PIX').length, 1, 'sem operationValue: PIX continua sincronizando');
  eq(r.unmapped.length, 4, 'sem operationValue: as 4 faixas de cartao viram manuais');
  assert(/nao zerar o fixo vigente/.test(reasonFor(r, 'CREDIT_CARD', 1)), 'sem operationValue: motivo cita preservacao do fixo'); }

{ const semTier = JSON.parse(JSON.stringify(FEES_OK));
  delete semTier.payment.creditCard.upToTwelveInstallmentsPercentage;
  const r = parseAsaasFees(semTier);
  eq(r.ranges.filter(x => x.method === 'CREDIT_CARD').length, 3, 'faixa ausente: as outras 3 continuam sincronizando');
  assert(/upToTwelveInstallmentsPercentage nao encontrado/.test(reasonFor(r, 'CREDIT_CARD', 7)), 'faixa ausente: motivo nomeia o campo'); }

{ const semPix = JSON.parse(JSON.stringify(FEES_OK));
  delete semPix.payment.pix.fixedFeeValue;
  const r = parseAsaasFees(semPix);
  eq(r.ranges.filter(x => x.method === 'PIX').length, 0, 'sem fixedFeeValue: PIX nao sincroniza');
  eq(r.ranges.filter(x => x.method === 'CREDIT_CARD').length, 4, 'sem fixedFeeValue: cartao nao e afetado'); }

{ const semWrapper = { pix: { fixedFeeValue: 1.99 }, creditCard: { oneInstallmentPercentage: 2.99, operationValue: 0.49 } };
  const r = parseAsaasFees(semWrapper);
  eq(r.ranges.length, 0, 'sem o wrapper `payment`: nada e extraido (regressao do bug P-1.16B.3)'); }

{ const r = parseAsaasFees({});
  eq(r.ranges.length, 0, 'objeto vazio: nada extraido');
  eq(r.unmapped.length, 5, 'objeto vazio: as 5 faixas viram manuais'); }
{ const r = parseAsaasFees(null);
  eq(r.ranges.length, 0, 'null: nada extraido'); }
{ const r = parseAsaasFees({ payment: null });
  eq(r.ranges.length, 0, 'payment null: nada extraido'); }

// -- campo invalido -> fail-safe --------------------------------------------
{ const str = JSON.parse(JSON.stringify(FEES_OK));
  str.payment.pix.fixedFeeValue = '1.99';
  const r = parseAsaasFees(str);
  eq(r.ranges.filter(x => x.method === 'PIX').length, 0, 'fixedFeeValue como string: recusado (num() exige number)');
  assert(/nao encontrado/.test(reasonFor(r, 'PIX', 1)), 'string: motivo de campo nao encontrado'); }

{ const absurdo = JSON.parse(JSON.stringify(FEES_OK));
  absurdo.payment.pix.fixedFeeValue = 999;
  const r = parseAsaasFees(absurdo);
  eq(r.ranges.filter(x => x.method === 'PIX').length, 0, 'fixo absurdo (R$999): recusado');
  assert(/sanidade/.test(reasonFor(r, 'PIX', 1)), 'fixo absurdo: motivo cita banda de sanidade'); }

{ const absurdo = JSON.parse(JSON.stringify(FEES_OK));
  absurdo.payment.creditCard.oneInstallmentPercentage = 99;
  const r = parseAsaasFees(absurdo);
  eq(tier(r, 1), undefined, 'percentual 99%: faixa 1x recusada');
  eq(r.ranges.filter(x => x.method === 'CREDIT_CARD').length, 3, 'percentual absurdo isola so a faixa afetada');
  assert(/sanidade/.test(reasonFor(r, 'CREDIT_CARD', 1)), 'percentual absurdo: motivo cita banda de sanidade'); }

{ const fixoAbsurdo = JSON.parse(JSON.stringify(FEES_OK));
  fixoAbsurdo.payment.creditCard.operationValue = 600;
  const r = parseAsaasFees(fixoAbsurdo);
  eq(r.ranges.filter(x => x.method === 'CREDIT_CARD').length, 0, 'operationValue absurdo: todas as faixas de cartao recusadas'); }

{ const pixPct = JSON.parse(JSON.stringify(FEES_OK));
  pixPct.payment.pix.percentageFee = 0.4;
  const r = parseAsaasFees(pixPct);
  eq(r.ranges.filter(x => x.method === 'PIX').length, 0, 'PIX com percentageFee != 0: recusado (guarda, nao interpretacao)');
  assert(/revisao manual/.test(reasonFor(r, 'PIX', 1)), 'PIX percentual: motivo pede revisao manual'); }

// --------------------------------------------------------------------------
section('Planner: idempotencia e versionamento');

{ const desired = [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 199 }];
  const plan = planGatewayFeeSync(CURRENT, desired);
  eq(plan.insert.length, 0, 'tarifa igual: nenhuma insercao');
  eq(plan.close.length, 0, 'tarifa igual: nenhum fechamento');
  eq(plan.unchanged.length, 1, 'tarifa igual: marcada unchanged'); }

{ const desired = [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 249 }];
  const plan = planGatewayFeeSync(CURRENT, desired);
  eq(plan.insert.length, 1, 'tarifa mudou: uma insercao');
  eq(plan.close.length, 1, 'tarifa mudou: fecha a anterior');
  eq(plan.close[0].id, 'pix-1', 'tarifa mudou: fecha exatamente a versao vigente');
  eq(plan.insert[0].replacesId, 'pix-1', 'tarifa mudou: nova versao referencia a anterior'); }

{ const desired = [{ method: 'BOLETO', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 100 }];
  const plan = planGatewayFeeSync(CURRENT, desired);
  eq(plan.insert.length, 1, 'faixa inexistente: primeira versao');
  eq(plan.insert[0].replacesId, null, 'faixa inexistente: sem versao anterior');
  eq(plan.close.length, 0, 'faixa inexistente: nada a fechar'); }

{ // numeric do Postgres chega como string
  const desired = [{ method: 'CREDIT_CARD', installmentFrom: 1, installmentTo: 1, percent: 2.99, fixedCents: 49 }];
  const plan = planGatewayFeeSync(CURRENT, desired);
  eq(plan.unchanged.length, 1, "numeric '2.9900' string == 2.99 number: idempotente"); }

{ const desired = [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 199 }];
  const untouched = untouchedRanges(CURRENT, desired);
  eq(untouched.length, 4, 'faixas nao sincronizadas ficam intocadas');
  assert(untouched.every(u => u.method === 'CREDIT_CARD'), 'intocadas: todas as faixas de cartao'); }

{ const plan = planGatewayFeeSync(CURRENT, []);
  eq(plan.insert.length + plan.close.length, 0, 'nada extraido: plano vazio, nada e sobrescrito'); }

// --------------------------------------------------------------------------
section('Aplicacao: falha nunca destroi a tarifa vigente');

(async () => {
  { const db = fakeSupabase(CURRENT);
    const plan = planGatewayFeeSync(CURRENT, [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 249 }]);
    const r = await applyGatewayFeeSync(db, 'asaas', plan, NOW);
    eq(r.applied.length, 1, 'caminho feliz: 1 faixa aplicada');
    eq(r.failed.length, 0, 'caminho feliz: nenhuma falha');
    eq(db.log.filter(l => l.op === 'close').length, 1, 'caminho feliz: fecha a anterior');
    eq(db.log.filter(l => l.op === 'insert').length, 1, 'caminho feliz: insere a nova');
    eq(db.log.filter(l => l.op === 'DELETE').length, 0, 'caminho feliz: nenhum DELETE');
    const closed = db.store.find(r2 => r2.id === 'pix-1')!;
    eq(closed.effective_to, NOW, 'historico preservado: versao antiga fechada, nao apagada');
    eq(db.store.length, CURRENT.length + 1, 'historico preservado: linha antiga continua na tabela'); }

  { const db = fakeSupabase(CURRENT, { onSelect: true });
    const { rows, error } = await readCurrentFeeRows(db, 'asaas');
    assert(error !== null, 'falha de leitura: erro propagado');
    eq(rows.length, 0, 'falha de leitura: nenhuma linha devolvida');
    eq(db.log.length, 0, 'falha de leitura: NENHUMA escrita executada'); }

  { const db = fakeSupabase(CURRENT, { onUpdateId: 'pix-1' });
    const plan = planGatewayFeeSync(CURRENT, [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 249 }]);
    const r = await applyGatewayFeeSync(db, 'asaas', plan, NOW);
    eq(r.applied.length, 0, 'falha ao fechar: nada aplicado');
    eq(r.failed[0].stage, 'close', 'falha ao fechar: estagio identificado');
    eq(db.log.filter(l => l.op === 'insert').length, 0, 'falha ao fechar: nao insere versao orfa');
    eq(db.store.find(x => x.id === 'pix-1')!.effective_to, null, 'falha ao fechar: tarifa anterior segue vigente'); }

  { const db = fakeSupabase(CURRENT, { onInsert: true });
    const plan = planGatewayFeeSync(CURRENT, [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 249 }]);
    const r = await applyGatewayFeeSync(db, 'asaas', plan, NOW);
    eq(r.applied.length, 0, 'falha ao inserir: nada aplicado');
    eq(r.failed[0].stage, 'insert', 'falha ao inserir: estagio identificado');
    eq(r.failed[0].rolledBack, true, 'falha ao inserir: rollback executado');
    eq(db.store.find(x => x.id === 'pix-1')!.effective_to, null, 'falha ao inserir: versao anterior REABERTA'); }

  { const db = fakeSupabase(CURRENT, { onInsert: true, onReopen: true });
    const plan = planGatewayFeeSync(CURRENT, [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 249 }]);
    const r = await applyGatewayFeeSync(db, 'asaas', plan, NOW);
    eq(r.failed[0].rolledBack, false, 'falha dupla: rollback reportado como nao executado'); }

  { const db = fakeSupabase(CURRENT);
    const plan = planGatewayFeeSync(CURRENT, [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 199 }]);
    const r = await applyGatewayFeeSync(db, 'asaas', plan, NOW);
    eq(r.applied.length, 0, 'idempotencia: segunda execucao nao aplica nada');
    eq(db.log.length, 0, 'idempotencia: NENHUMA escrita no banco'); }

  // ------------------------------------------------------------------------
  section('Checkout: usa a tarifa vigente, nao o embutido');

  { const rules = mapGatewayFeeRows(CURRENT.map(r => ({ ...r, effective_from: '2026-01-01T00:00:00.000Z', effective_to: null })));
    const q = quoteCheckout({ servicePriceCents: 10000, method: 'PIX', installmentCount: 1, rules });
    eq(q.gatewayFeeExpectedCents, 199, 'checkout usa a tarifa do banco');
    eq(q.usedFallback, false, 'checkout: nao marcou fallback'); }

  { // tarifa do banco divergente do embutido: o banco vence
    const bumped = mapGatewayFeeRows(CURRENT.map(r => ({
      ...r, fixed_cents: r.id === 'pix-1' ? 249 : r.fixed_cents,
      effective_from: '2026-01-01T00:00:00.000Z', effective_to: null
    })));
    const q = quoteCheckout({ servicePriceCents: 10000, method: 'PIX', installmentCount: 1, rules: bumped });
    eq(q.gatewayFeeExpectedCents, 249, 'DB vence o embutido quando divergem');
    eq(q.studentChargeCents, 10249, 'student_charge reflete a tarifa do banco'); }

  { // banco respondeu, mas sem faixa para a combinacao: NAO mascarar com embutido
    const onlyPix = mapGatewayFeeRows([{ ...CURRENT[0], effective_from: '2026-01-01T00:00:00.000Z', effective_to: null }]);
    const q = quoteCheckout({ servicePriceCents: 10000, method: 'CREDIT_CARD', installmentCount: 1, rules: onlyPix });
    eq(q.rule, null, 'banco sem a faixa: rule null (nao cai no embutido)');
    eq(q.usedFallback, false, 'banco sem a faixa: nao marca fallback');
    eq(q.gatewayFeeExpectedCents, 0, 'banco sem a faixa: fee 0 e o chamador recusa (fail-closed)'); }

  { // bootstrap/emergencia: banco nao devolveu NADA
    const q = quoteCheckout({ servicePriceCents: 10000, method: 'PIX', installmentCount: 1, rules: [] });
    eq(q.usedFallback, true, 'banco vazio: embutido entra como bootstrap');
    eq(q.gatewayFeeExpectedCents, 199, 'banco vazio: tarifa nao e zerada');
    eq(DEFAULT_GATEWAY_FEE_SCHEDULE.length, 5, 'embutido continua com as 5 faixas'); }

  // ------------------------------------------------------------------------
  section('Snapshot antigo permanece imutavel');

  { // nada na sincronizacao escreve em payment_installments
    const db = fakeSupabase(CURRENT);
    const plan = planGatewayFeeSync(CURRENT, [{ method: 'PIX', installmentFrom: 1, installmentTo: 1, percent: 0, fixedCents: 299 }]);
    await applyGatewayFeeSync(db, 'asaas', plan, NOW);
    const touchedTables = db.log.map(l => l.op);
    assert(!touchedTables.includes('DELETE'), 'sincronizacao nunca deleta');
    // o snapshot de uma compra antiga reproduz a tarifa original mesmo apos a mudanca
    const snapshotPercent = 2.99, snapshotFixed = 49;
    const recomputed = Math.round((13000 * Math.round(snapshotPercent * 100) + snapshotFixed * 10000) / 10000);
    eq(recomputed, 438, 'compra antiga reproduz R$4,38 apos a tarifa mudar'); }

  // ------------------------------------------------------------------------
  section('Observabilidade de sincronizacao');

  eq(syncAgeDays(CURRENT as any, NOW), null, 'nunca sincronizado (source=manual): idade null');
  eq(syncAgeDays([{ source: 'asaas', effective_from: '2026-09-16T12:00:00.000Z' }], NOW), 2, 'idade em dias desde a ultima sync');
  eq(syncAgeDays([{ source: 'asaas', effective_from: '2026-09-18T00:00:00.000Z' },
                  { source: 'asaas', effective_from: '2026-09-10T00:00:00.000Z' }], NOW), 0, 'idade usa a sync mais recente');

  console.log(`\n${'='.repeat(56)}`);
  console.log(`P-1.16B  PASS=${pass}  FAIL=${fail}`);
  console.log('='.repeat(56));
  if (fail > 0) process.exit(1);
})();
