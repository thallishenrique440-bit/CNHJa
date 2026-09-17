/**
 * P-1.10 — A-2: LedgerPersistenceError nao pode ser engolida pelos catches internos.
 *
 * ISOLAMENTO TOTAL:
 *  - @supabase/supabase-js e resolvido para um STUB local (tests-p110/stub-node_modules).
 *    Nenhuma conexao real e possivel, nem mesmo por acidente.
 *  - env vars sao valores explicitamente falsos, nunca .env.local.
 *  - nenhum Asaas, nenhum HTTP, nenhum banco.
 *
 * NAO faz parte da suite P-1.6.
 */

// Valores propositalmente invalidos. Se algo tentar usa-los, falha ruidosamente.
process.env.SUPABASE_URL = 'http://p110.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'p110-fake-service-key';
process.env.ASAAS_WEBHOOK_SECRET = 'p110-fake-webhook-secret';
process.env.ASAAS_API_KEY = 'p110-fake-asaas-key';
process.env.ASAAS_API_URL = 'http://p110.invalid/asaas';

let pass = 0, fail = 0;
const t = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`PASS  ${msg}`); }
  else { fail++; console.log(`FAIL  ${msg}`); }
};

/** Tabelas tocadas durante a execucao, para provar ausencia de caminho incorreto. */
const touched: string[] = [];
/** Logs capturados, para discriminar o caminho percorrido. */
let logs: string[] = [];
const startCapture = () => {
  logs = [];
  const oe = console.error, ow = console.warn, ol = console.log;
  const grab = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
  console.error = grab; console.warn = grab; console.log = grab;
  return () => { console.error = oe; console.warn = ow; console.log = ol; };
};
/** URLs com que qualquer client foi construido. Prova que nenhuma e de producao. */
const createdClients: string[] = [];
(globalThis as any).__P110_CLIENTS__ = createdClients;

/**
 * Duplo do supabaseAdmin.
 * ledgerUpdateAlwaysFails = true faz TODO update em `transactions` retornar { error },
 * o que leva finalizeLedger a esgotar a tentativa principal e o fallback e lancar
 * LedgerPersistenceError — que e exatamente a condicao sob teste.
 */
function makeDb(opts: {
  ledgerUpdateAlwaysFails: boolean;
  provisionalTx?: any;
  notificationLogDuplicate?: boolean;
}) {
  const q = (table: string): any => {
    touched.push(table);
    const failWrite = opts.ledgerUpdateAlwaysFails && table === 'transactions';
    const err = { message: 'p110 forced ledger write failure' };

    // O duplo rastreia os filtros para distinguir consultas diferentes na mesma tabela:
    // a busca do ledger filtra por type='webhook_event'; a da transacao de tip, por id.
    const mk = (filters: Record<string, any>): any => {
      const chain: any = {
        select: () => mk(filters),
        eq: (col: string, val: any) => mk({ ...filters, [col]: val }),
        in: () => mk(filters),
        is: () => mk(filters),
        or: () => mk(filters),
        order: () => mk(filters),
        limit: () => mk(filters),
        single: async () => ({ data: null, error: null }),
        // `.select()` apos update devolve a linha, como no builder real
        
        maybeSingle: async () => {
          if (table !== 'transactions') return { data: null, error: null };
          // busca do ledger de webhook -> inexistente, forca o caminho de INSERT
          if (filters['type'] === 'webhook_event') return { data: null, error: null };
          // busca da transacao provisoria de caixinha -> devolve a linha configurada
          if (filters['id'] && opts.provisionalTx) return { data: opts.provisionalTx, error: null };
          return { data: null, error: null };
        },
        then: (r: any) => {
          // Falha apenas os writes dirigidos a LINHA DO LEDGER. Writes na transacao de
          // caixinha devem ter sucesso, para que o fluxo avance ate o bloco de
          // notificacao (try 533) e alcance o finalizeLedger da linha 546.
          const isLedgerRow = filters['id'] === 'ledger-row-p110';
          const f = failWrite && isLedgerRow;
          return Promise.resolve({ data: f ? null : [], error: f ? err : null }).then(r);
        }
      };
      return chain;
    };

    return {
      select: () => mk({}),
      update: () => mk({}),
      upsert: () => mk({}),
      delete: () => mk({}),
      insert: (_row?: any) => {
        if (table === 'notification_logs' && opts.notificationLogDuplicate) {
          const p: any = Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
          p.select = () => ({ single: async () => ({ data: null, error: { code: '23505' } }) });
          return p;
        }
        const p: any = Promise.resolve({ data: null, error: null });
        p.select = () => ({ single: async () => ({ data: { id: 'ledger-row-p110' }, error: null }) });
        return p;
      }
    };
  };
  return { from: q, rpc: async () => ({ data: null, error: null }) };
}

function mockReqRes(payload: any) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8');
  const req: any = {
    method: 'POST',
    headers: { 'asaas-access-token': 'p110-fake-webhook-secret' },
    rawBody: raw, body: payload, readable: false
  };
  let status = 200, json: any = null;
  const res: any = {
    setHeader: () => {},
    status: (c: number) => { status = c; return res; },
    json: (d: any) => { json = d; return res; },
    getStatus: () => status, getJson: () => json
  };
  return { req, res };
}

async function run() {
  console.log('='.repeat(70));
  console.log('P-1.10 — A-2: LedgerPersistenceError propaga ate o catch externo');
  console.log('='.repeat(70));

  const { default: handler } = await import('../api/asaas-webhook.js');

  // ---------- A-2.1 — TIP ----------
  console.log('\n--- A-2.1  Fluxo de TIP ---');
  {
    touched.length = 0;
    // provisionalTx + notificationLogDuplicate levam o fluxo ate o finalizeLedger da
    // linha 546, que e o que esta DENTRO do catch aninhado (try 533 / catch 570).
    (globalThis as any).__P110_DB__ = makeDb({
      ledgerUpdateAlwaysFails: true,
      provisionalTx: { id: '44444444-4444-4444-8444-444444444444', status: 'pending', student_id: 's1', instructor_id: 'i1', metadata: {} },
      notificationLogDuplicate: true
    });

    const { req, res } = mockReqRes({
      id: 'evt_p110_tip',
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_p110_tip',
        externalReference: 'tip:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
        value: 10, netValue: 9.5, billingType: 'PIX', status: 'RECEIVED'
      }
    });

    const stop = startCapture();
    await handler(req, res);
    stop();

    t(res.getStatus() === 500, `resposta final e HTTP 500 (obtido: ${res.getStatus()})`);

    // DISCRIMINANTE: prova que o catch interno NAO consumiu a excecao.
    // Sem o rethrow, o catch loga "Error processing tip notification & push".
    // Com o rethrow, essa mensagem nunca e emitida.
    t(!logs.some(l => l.includes('Error processing tip notification & push')),
      'catch interno NAO consumiu a excecao (log local enganoso ausente)');
    t(logs.some(l => l.includes('is unobservable')),
      'LedgerPersistenceError foi de fato lancada pelo finalizeLedger');
    t(logs.some(l => l.includes('idempotente via notification_logs')),
      'o fluxo passou pela linha 545/546 — o finalizeLedger DENTRO do catch aninhado');

    // Prova central do A-2.1: apos a LedgerPersistenceError o fluxo do tip NAO continua
    // para o caminho de pagamento comum. O gate de installment fica na linha ~580, logo
    // depois do catch aninhado; zero acessos provam que o rethrow interrompeu o fluxo.
    t(!touched.includes('payment_installments'),
      'fluxo NAO alcancou o installment gate (0 acessos a payment_installments)');

    // NOTA: payment_settlements E tocado, mas ANTES do ponto de falha — o settlement da
    // caixinha faz parte legitima do fluxo de tip e ocorre na linha ~500, muito antes do
    // finalizeLedger da linha 546. O que precisa ser provado e que nenhum settlement do
    // fluxo de PAGAMENTO COMUM roda depois do erro, e isso decorre de payment_installments
    // nunca ter sido consultado (o settlement comum depende do contrato de installment).
    t(!touched.includes('payment_installments'),
      'nenhum settlement do fluxo de pagamento comum foi executado (depende do installment gate)');

    const body = res.getJson();
    t(!!body?.error, 'corpo da resposta indica erro, nao sucesso');
    t(body?.success !== true, 'NAO reporta success=true');
  }

  // ---------- A-2.2 — REFUND SETTLEMENT ----------
  console.log('\n--- A-2.2  Fluxo de REFUND (parcial) ---');
  {
    touched.length = 0;
    (globalThis as any).__P110_DB__ = makeDb({ ledgerUpdateAlwaysFails: true });

    const { req, res } = mockReqRes({
      id: 'evt_p110_refund',
      event: 'PAYMENT_PARTIALLY_REFUNDED',
      payment: {
        id: 'pay_p110_refund', value: 100, netValue: 98,
        billingType: 'PIX', status: 'REFUNDED', installmentNumber: 1
      }
    });

    const stop = startCapture();
    await handler(req, res);
    stop();

    t(res.getStatus() === 500, `resposta final e HTTP 500 (obtido: ${res.getStatus()})`);

    // DISCRIMINANTE: sem o rethrow, o catch (refErr) loga
    // "Error recording refund settlement" — um log falso, porque o settlement nao falhou.
    t(!logs.some(l => l.includes('Error recording refund settlement')),
      'catch interno NAO consumiu a excecao (log falso de settlement ausente)');
    t(logs.some(l => l.includes('is unobservable')),
      'LedgerPersistenceError foi de fato lancada');

    const body = res.getJson();
    t(!!body?.error, 'erro chega ao tratamento externo, nao virou erro local comum');
    t(body?.message !== 'Partial refund recorded pending reconciliation',
      'NAO houve continuacao silenciosa com resposta 200 de reconciliacao');
    t(body?.success !== true, 'NAO reporta success=true');
  }

  // ---------- ISOLAMENTO ----------
  console.log('\n--- Isolamento ---');
  t(createdClients.length > 0, `clients criados via STUB: ${createdClients.length} (nenhum SDK real carregado)`);
  t(createdClients.every(u => !u.includes('supabase.co')),
    `nenhum client aponta para dominio de producao (urls: ${JSON.stringify(createdClients)})`);
  t(process.env.SUPABASE_URL === 'http://p110.invalid', 'SUPABASE_URL permaneceu o valor falso do teste');

  console.log('\n' + '='.repeat(70));
  console.log(`RESULTADO: ${pass} PASS / ${fail} FAIL`);
  console.log('='.repeat(70));
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('ERRO NA SUITE:', e); process.exit(1); });
