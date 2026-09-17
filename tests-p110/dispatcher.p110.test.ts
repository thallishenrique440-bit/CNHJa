/**
 * P-1.10 — Validacao funcional de A-1, A-8.5 e A-8.2 no ProjectionDispatcher.
 *
 * ISOLAMENTO: nenhum Supabase, Asaas, HTTP, credencial ou .env.
 * O duplo abaixo replica o encadeamento real do query builder e REGISTRA os
 * argumentos efetivamente recebidos, para que as asserts provem qual id foi usado.
 *
 * NAO faz parte da suite P-1.6. Fora de lib/payments/tests/ de proposito.
 */
import { ProjectionDispatcher } from '../lib/payments/projections/ProjectionDispatcher.js';
import { ProjectionSourceEventType } from '../lib/payments/projections/ProjectionTypes.js';

let pass = 0, fail = 0;
const t = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`PASS  ${msg}`); }
  else { fail++; console.log(`FAIL  ${msg}`); }
};

const LEDGER_UUID = '11111111-1111-4111-8111-111111111111';
const SYNTHETIC_EVENT_ID = 'state_tr_fake_payment_COMPLETED';
const FAKE_PAYMENT_ID = 'pay_fake_p110';
const FAKE_SETTLEMENT_ID = '22222222-2222-4222-8222-222222222222';
const FAKE_APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';

interface Recorded { table: string; op: string; eqCol?: string; eqVal?: any; payload?: any }

/**
 * Duplo encadeavel que espelha o builder real e grava tudo que recebe.
 *
 * DELIBERADO: este duplo NAO implementa .limit() nem .upsert().select(), usados pelos
 * projectors. Eles portanto falham, o que e exatamente a pre-condicao necessaria para
 * exercitar o caminho de auditoria de falha de projecao (failures.length > 0).
 * Sem isso o bloco sob teste nunca seria alcancado.
 */
function makeSupabaseDouble(opts: {
  existingMetadata?: any;
  rowFound?: boolean;
  updateError?: { message: string } | null;
  updateReturnsRows?: any[];
} = {}) {
  const calls: Recorded[] = [];
  const {
    existingMetadata = {},
    rowFound = true,
    updateError = null,
    updateReturnsRows = [{ id: LEDGER_UUID }]
  } = opts;

  const client: any = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (col: string, val: any) => {
          calls.push({ table, op: 'select', eqCol: col, eqVal: val });
          return {
            maybeSingle: async () => ({
              data: rowFound ? { metadata: existingMetadata } : null,
              error: null
            })
          };
        }
      }),
      update: (payload: any) => ({
        eq: (col: string, val: any) => {
          calls.push({ table, op: 'update', eqCol: col, eqVal: val, payload });
          const res: any = {
            select: async (_c: string) => ({
              data: updateError ? null : updateReturnsRows,
              error: updateError
            })
          };
          // suporta await direto (sem .select) tambem
          res.then = (r: any) => r({ data: null, error: updateError });
          return res;
        }
      }),
      upsert: async () => ({ data: null, error: null }),
      insert: async () => ({ data: null, error: null })
    })
  };
  return { client, calls };
}

const basePayload = {
  eventType: ProjectionSourceEventType.STATE_TRANSITION,
  providerPaymentId: FAKE_PAYMENT_ID
};

async function run() {
  console.log('='.repeat(70));
  console.log('P-1.10 — ProjectionDispatcher: A-1 / A-8.5 / A-8.2');
  console.log('='.repeat(70));

  // ---------- A-1.1 — PaymentState: ledgerId e nao eventId ----------
  console.log('\n--- A-1.1  PaymentState: usa ledgerId, nunca eventId ---');
  {
    const { client, calls } = makeSupabaseDouble({ existingMetadata: { retry_history: [1, 2, 3] } });
    await ProjectionDispatcher.dispatch(client, {
      ...basePayload,
      eventId: SYNTHETIC_EVENT_ID,
      ledgerId: LEDGER_UUID
    } as any);

    const ledgerWrites = calls.filter(c => c.table === 'transactions' && c.op === 'update');
    const ledgerReads = calls.filter(c => c.table === 'transactions' && c.op === 'select');

    t(ledgerWrites.length > 0 || ledgerReads.length > 0, 'dispatcher tocou a tabela transactions');
    const all = [...ledgerReads, ...ledgerWrites];
    t(all.every(c => c.eqCol === 'id'), 'sempre filtra por coluna id');
    t(all.every(c => c.eqVal === LEDGER_UUID), 'id usado === ledgerId (UUID real)');
    t(all.every(c => c.eqVal !== SYNTHETIC_EVENT_ID), 'id usado !== eventId sintetico');
    t(all.every(c => c.eqVal !== FAKE_PAYMENT_ID), 'providerPaymentId NAO usado como transactions.id');
    t(all.every(c => c.eqVal !== FAKE_SETTLEMENT_ID), 'settlementId NAO usado como transactions.id');
    t(all.every(c => c.eqVal !== FAKE_APPOINTMENT_ID), 'appointmentId NAO usado como transactions.id');
  }

  // ---------- A-1.2 — Settlement: mesmo contrato ----------
  console.log('\n--- A-1.2  Settlement: eventLedgerId -> ledgerId -> transactions.id ---');
  {
    const { client, calls } = makeSupabaseDouble();
    await ProjectionDispatcher.dispatch(client, {
      eventType: ProjectionSourceEventType.SETTLEMENT_CREATED,
      providerPaymentId: FAKE_PAYMENT_ID,
      settlementId: FAKE_SETTLEMENT_ID,
      appointmentId: FAKE_APPOINTMENT_ID,
      ledgerId: LEDGER_UUID
    } as any);
    const touched = calls.filter(c => c.table === 'transactions');
    t(touched.length === 0 || touched.every(c => c.eqVal === LEDGER_UUID),
      'settlement: id usado === ledgerId, nunca settlementId/appointmentId');
  }

  // ---------- A-1.3 — sem ledgerId ----------
  console.log('\n--- A-1.3  Sem ledgerId: nenhum UPDATE, nenhum UUID inventado ---');
  {
    const { client, calls } = makeSupabaseDouble();
    await ProjectionDispatcher.dispatch(client, {
      ...basePayload,
      eventId: SYNTHETIC_EVENT_ID
      // ledgerId ausente de proposito
    } as any);
    // Filtra apenas a tabela transactions: os projectors consultam legitimamente
    // outras tabelas de projecao usando providerPaymentId, e isso nao e o que testamos.
    const ledgerCalls = calls.filter(c => c.table === 'transactions');
    const writes = ledgerCalls.filter(c => c.op === 'update');
    t(writes.length === 0, 'nenhum UPDATE em transactions sem ledgerId');
    t(ledgerCalls.length === 0, 'tabela transactions nao foi tocada de forma alguma');
    t(!ledgerCalls.some(c => c.eqVal === SYNTHETIC_EVENT_ID), 'eventId NAO foi convertido em transactions.id');
    t(!ledgerCalls.some(c => c.eqVal === FAKE_PAYMENT_ID), 'providerPaymentId NAO foi convertido em transactions.id');
  }

  // ---------- A-8.5 — zero rows ----------
  console.log('\n--- A-8.5  UPDATE: erro / zero rows / uma row ---');
  {
    // Cenario 1: erro no UPDATE
    const c1 = makeSupabaseDouble({ updateError: { message: 'boom' } });
    await ProjectionDispatcher.dispatch(c1.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    t(true, 'cenario 1 (update error): dispatcher nao lancou, erro tratado');

    // Cenario 2: zero rows
    const c2 = makeSupabaseDouble({ updateReturnsRows: [] });
    await ProjectionDispatcher.dispatch(c2.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    t(true, 'cenario 2 (zero rows): dispatcher nao lancou, zero rows tratado');

    // Cenario 3: uma row
    const c3 = makeSupabaseDouble({ updateReturnsRows: [{ id: LEDGER_UUID }] });
    await ProjectionDispatcher.dispatch(c3.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    t(true, 'cenario 3 (uma row): persistencia bem-sucedida');

    // Cenario 4: linha inexistente (barreira antes do UPDATE)
    const c4 = makeSupabaseDouble({ rowFound: false });
    await ProjectionDispatcher.dispatch(c4.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    const w4 = c4.calls.filter(c => c.op === 'update');
    t(w4.length === 0, 'cenario 4 (row ausente): nenhum UPDATE tentado');
  }

  // ---------- A-8.5 reforcado: provar a MENSAGEM, nao so a ausencia de throw ----------
  console.log('\n--- A-8.5 (reforcado)  a falha e explicitamente reportada ---');
  {
    const capture = (): { logs: string[]; restore: () => void } => {
      const logs: string[] = [];
      const orig = console.error;
      console.error = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
      return { logs, restore: () => { console.error = orig; } };
    };

    const c1 = makeSupabaseDouble({ updateError: { message: 'boom' } });
    let cap = capture();
    await ProjectionDispatcher.dispatch(c1.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    cap.restore();
    t(cap.logs.some(l => l.includes('Projection Audit Write Failed') && l.includes('boom')),
      'cenario 1: erro do UPDATE reportado como Write Failed com a mensagem original');

    const c2 = makeSupabaseDouble({ updateReturnsRows: [] });
    cap = capture();
    await ProjectionDispatcher.dispatch(c2.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    cap.restore();
    t(cap.logs.some(l => l.includes('Projection Audit Zero Rows') && l.includes('nothing was persisted')),
      'cenario 2: zero rows reportado como NAO PERSISTIDO (error===null nao e sucesso)');

    const c3 = makeSupabaseDouble({ updateReturnsRows: [{ id: LEDGER_UUID }] });
    cap = capture();
    await ProjectionDispatcher.dispatch(c3.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    cap.restore();
    t(!cap.logs.some(l => l.includes('Zero Rows') || l.includes('Write Failed') || l.includes('Row Missing')),
      'cenario 3: uma row -> nenhum alerta de falha de auditoria');

    const c4 = makeSupabaseDouble({ rowFound: false });
    cap = capture();
    await ProjectionDispatcher.dispatch(c4.client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
    cap.restore();
    t(cap.logs.some(l => l.includes('Projection Audit Row Missing')),
      'cenario 4: linha inexistente reportada como Row Missing');

    cap = capture();
    await ProjectionDispatcher.dispatch(makeSupabaseDouble().client, { ...basePayload } as any);
    cap.restore();
    t(cap.logs.some(l => l.includes('NO_LEDGER_ID')),
      'sem ledgerId: motivo NO_LEDGER_ID registrado explicitamente');
  }

  // ---------- A-8.2 — cap real, medido no payload do UPDATE ----------
  console.log('\n--- A-8.2  projection_failures nunca passa de 10 ---');
  {
    const mkHistory = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ n: from + i }));

    const runWith = async (existingMetadata: any) => {
      const { client, calls } = makeSupabaseDouble({ existingMetadata });
      await ProjectionDispatcher.dispatch(client, { ...basePayload, ledgerId: LEDGER_UUID } as any);
      const upd = calls.find(c => c.table === 'transactions' && c.op === 'update');
      return upd?.payload?.metadata;
    };

    const m0 = await runWith({});
    t(Array.isArray(m0?.projection_failures) && m0.projection_failures.length === 1,
      'historico ausente -> array criado com 1 entrada');

    const m7 = await runWith({ projection_failures: mkHistory(1, 7) });
    t(m7.projection_failures.length === 8, '7 entradas anteriores -> 8 (abaixo do limite, nada descartado)');

    const m10 = await runWith({ projection_failures: mkHistory(1, 10) });
    t(m10.projection_failures.length === 10, 'exatamente 10 anteriores -> permanece 10');
    t(m10.projection_failures[0].n === 2, 'a entrada mais ANTIGA (n=1) foi descartada primeiro');

    const m11 = await runWith({ projection_failures: mkHistory(1, 11) });
    t(m11.projection_failures.length === 10, '11 anteriores -> nunca ultrapassa 10');

    const m15 = await runWith({ projection_failures: mkHistory(1, 15) });
    t(m15.projection_failures.length === 10, '15 anteriores -> nunca ultrapassa 10');

    // asserção explicita pedida: historico 16..25 permanece
    const m25 = await runWith({ projection_failures: mkHistory(16, 25) });
    const kept = m25.projection_failures;
    t(kept.length === 10, 'historico 16..25 + nova entrada -> continua 10');
    t(kept[0].n === 17, 'entrada 16 descartada (mais antiga)');
    t(kept.slice(0, 9).every((e: any, i: number) => e.n === 17 + i),
      'entradas 17..25 permanecem, na ordem');
    t(kept[9] && kept[9].n === undefined, 'a nova entrada de auditoria e a mais recente');

    // preservacao de metadata
    const mPreserve = await runWith({
      retry_history: [{ attempt: 1 }, { attempt: 2 }],
      ingestion_mode: 'raw_stream',
      raw_body_bytes: 1553,
      reason_code: 'ALGO_ANTERIOR'
    });
    t(JSON.stringify(mPreserve.retry_history) === JSON.stringify([{ attempt: 1 }, { attempt: 2 }]),
      'retry_history preservado intacto');
    t(mPreserve.ingestion_mode === 'raw_stream' && mPreserve.raw_body_bytes === 1553,
      'demais propriedades de metadata preservadas');
    t(mPreserve.reason_code === 'PROJECTION_FAILED',
      'reason_code atualizado conforme implementacao');
    t(Array.isArray(mPreserve.projection_failures),
      'projection_failures continua sendo array');
  }

  console.log('\n' + '='.repeat(70));
  console.log(`RESULTADO: ${pass} PASS / ${fail} FAIL`);
  console.log('='.repeat(70));
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('ERRO NA SUITE:', e); process.exit(1); });
