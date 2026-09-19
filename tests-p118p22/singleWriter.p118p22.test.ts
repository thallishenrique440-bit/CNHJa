/**
 * P-1.18P2.2 — um unico escritor de payment_settlements.
 *
 * InstallmentService.recordPaymentSettlement passa a cuidar SO' da parcela.
 * SettlementService continua sendo a autoridade de payment_settlements, com a
 * taxa REAL vinda do payload (value - netValue).
 */
import { InstallmentService } from '../lib/payments/InstallmentService';
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

/** Registra TODA operacao de escrita, por tabela. */
function mockSupabase() {
  const writes: Record<string, any[]> = {};
  const touched: string[] = [];
  const supabase: any = {
    from(table: string) {
      const record = (op: string) => (row: any) => {
        touched.push(`${table}.${op}`);
        (writes[table] = writes[table] || []).push(row);
        const res: any = { data: { id: `${table}_mock` }, error: null };
        return Object.assign(Promise.resolve(res), {
          select: () => ({ single: async () => ({ data: { id: `${table}_mock` }, error: null }) }),
          eq: () => Promise.resolve({ error: null })
        });
      };
      return {
        upsert: record('upsert'),
        insert: record('insert'),
        update: record('update'),
        delete: () => { touched.push(`${table}.delete`); return { eq: async () => ({ error: null }) }; },
        select: () => ({
          eq: () => ({
            eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null })
          })
        })
      };
    }
  };
  return { writes, touched, supabase };
}

async function main() {
  // -------------------------------------------------------------------------
  section('recordPaymentSettlement escreve a PARCELA e nada mais');

  const { writes, touched, supabase } = mockSupabase();
  const paymentDate = '2026-09-19T01:19:35.000Z';

  await InstallmentService.recordPaymentSettlement(supabase, {
    providerPaymentId: 'pay_382oqobmuzycog9d',
    installmentNumber: 1,
    totalInstallments: 4,
    grossAmountCents: 5193,
    netAmountCents: 4500,
    platformFeeCents: 500,
    feeAmountCents: 193,
    paymentDate,
    groupId: 'grp_p118p22',
    appointmentId: 'apt_1',
    studentId: 'stu_1',
    instructorId: 'ins_1',
    providerSettlementId: 'pay_382oqobmuzycog9d'
  });

  // (a) atualiza payment_installments
  eq((writes.payment_installments || []).length, 1, 'a) payment_installments recebeu exatamente 1 escrita');
  const inst = (writes.payment_installments || [])[0];
  eq(inst.status, 'RECEIVED', 'a) status = RECEIVED preservado');
  eq(inst.payment_date, paymentDate, 'a) payment_date preservado');
  eq(inst.provider_payment_id, 'pay_382oqobmuzycog9d', 'a) provider_payment_id preservado');
  eq(inst.installment_number, 1, 'a) installment_number preservado');
  eq(inst.total_installments, 4, 'a) total_installments preservado');
  eq(inst.gross_amount, 5193, 'a) gross_amount preservado');
  eq(inst.net_amount, 4500, 'a) net_amount preservado');
  eq(inst.fee_amount, 193, 'a) fee_amount preservado');
  eq(inst.platform_fee, 500, 'a) platform_fee preservado');
  eq(inst.instructor_amount, 4500, 'a) instructor_amount = net_amount (P-1.18E.1)');
  eq(inst.group_id, 'grp_p118p22', 'a) group_id preservado');
  eq(inst.appointment_id, 'apt_1', 'a) appointment_id preservado');
  eq(inst.student_id, 'stu_1', 'a) student_id preservado');
  eq(inst.instructor_id, 'ins_1', 'a) instructor_id preservado');

  // (b) NAO escreve payment_settlements
  eq((writes.payment_settlements || []).length, 0, 'b) payment_settlements NAO recebeu nenhuma escrita');
  assert(!touched.some(t => t.startsWith('payment_settlements.')),
    'b) nenhuma operacao de escrita em payment_settlements', touched.join(', '));

  // (c) nenhuma outra tabela escrita
  eq(Object.keys(writes).join(','), 'payment_installments',
    'c) a unica tabela escrita e payment_installments');

  // -------------------------------------------------------------------------
  section('Anti-regressao estrutural');

  const root = process.cwd();
  const instSrc = fs.readFileSync(path.join(root, 'lib/payments/InstallmentService.ts'), 'utf8');
  const semComentarios = instSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const settlementWrites = (semComentarios.match(/from\('payment_settlements'\)\s*\.\s*(upsert|insert|update|delete)/g) || []);
  eq(settlementWrites.length, 0,
    'InstallmentService.ts nao contem nenhuma escrita em payment_settlements');

  // recordRefundSettlement continua intacto (so' le e atualiza a parcela)
  assert(/recordRefundSettlement/.test(semComentarios),
    'recordRefundSettlement preservado');
  assert(/status:\s*'REFUNDED'/.test(semComentarios),
    'recordRefundSettlement continua marcando REFUNDED');

  // SettlementService/SettlementRepository intactos como autoridade
  const repoSrc = fs.readFileSync(path.join(root, 'lib/payments/SettlementRepository.ts'), 'utf8');
  assert(/from\('payment_settlements'\)\s*[\s\S]{0,40}\.insert\(insertPayload\)/.test(repoSrc),
    'SettlementRepository continua inserindo em payment_settlements');
  assert(/fee_amount:\s*calcResult\.feeAmount/.test(repoSrc),
    'SettlementRepository grava a taxa vinda do calcResult (taxa REAL do payload)');

  const webhookSrc = fs.readFileSync(path.join(root, 'api/asaas-webhook.ts'), 'utf8');
  assert(/Math\.round\(payment\.value \* 100\)\s*-\s*\n?\s*Math\.round\(payment\.netValue \* 100\)/.test(webhookSrc)
      || /payment\.value \* 100\)[\s\S]{0,80}payment\.netValue \* 100\)/.test(webhookSrc),
    'webhook continua derivando a taxa REAL como value - netValue');
  assert(/SettlementService\.processSettlement/.test(webhookSrc),
    'webhook continua chamando SettlementService.processSettlement');

  console.log(`\n${'='.repeat(56)}`);
  console.log(`P-1.18P2.2  PASS=${pass}  FAIL=${fail}`);
  console.log('='.repeat(56));
  if (fail > 0) process.exit(1);
}

main();
