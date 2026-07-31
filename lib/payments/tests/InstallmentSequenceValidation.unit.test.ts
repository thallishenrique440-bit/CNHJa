import { AsaasProvider } from '../AsaasProvider.js';
import { InstallmentService } from '../InstallmentService.js';

process.env.ASAAS_API_KEY = 'test_asaas_key_123';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`  ✅ PASS: ${message}`);
  }
}

console.log('====================================================');
console.log('🧪 RUNNING INSTALLMENT SEQUENCE VALIDATION TESTS');
console.log('====================================================');

async function testValid4InstallmentSequence() {
  console.log('\n📌 TEST 1: Valid 4-installment sequence (1..4)');
  const provider = new AsaasProvider();

  // Mock request method on provider
  (provider as any).request = async (endpoint: string) => {
    if (endpoint.includes('/installments/inst_12345/payments')) {
      return {
        data: [
          { id: 'pay_xxxxx1', installmentNumber: 1, value: 250, netValue: 220, dueDate: '2026-08-01', status: 'PENDING' },
          { id: 'pay_xxxxx2', installmentNumber: 2, value: 250, netValue: 220, dueDate: '2026-09-01', status: 'PENDING' },
          { id: 'pay_xxxxx3', installmentNumber: 3, value: 250, netValue: 220, dueDate: '2026-10-01', status: 'PENDING' },
          { id: 'pay_xxxxx4', installmentNumber: 4, value: 250, netValue: 220, dueDate: '2026-11-01', status: 'PENDING' },
        ]
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const items = await provider.getInstallmentPayments('inst_12345', 4);
  assert(items.length === 4, 'Returned 4 items');
  assert(items[0].id === 'pay_xxxxx1', 'Parcela 1 = pay_xxxxx1');
  assert(items[1].id === 'pay_xxxxx2', 'Parcela 2 = pay_xxxxx2');
  assert(items[2].id === 'pay_xxxxx3', 'Parcela 3 = pay_xxxxx3');
  assert(items[3].id === 'pay_xxxxx4', 'Parcela 4 = pay_xxxxx4');

  // Verify InstallmentService mapping logic
  const mockInsertedRows: any[] = [];
  const mockSupabase: any = {
    from: (table: string) => {
      assert(table === 'payment_installments', 'Writes to payment_installments table');
      return {
        upsert: async (row: any) => {
          mockInsertedRows.push(row);
          return { error: null };
        }
      };
    }
  };

  const idMap = new Map<number, string>();
  items.forEach(item => idMap.set(item.installmentNumber, item.id));

  await InstallmentService.recordInitialSchedule(mockSupabase, {
    providerPaymentId: 'pay_xxxxx1',
    providerPaymentIdMap: idMap,
    totalInstallments: 4,
    grossAmountCents: 100000,
    netAmountCents: 90000,
    platformFeeCents: 10000,
    groupId: 'grp_test_4inst'
  });

  assert(mockInsertedRows.length === 4, '4 installments recorded in database');
  assert(mockInsertedRows[0].provider_payment_id === 'pay_xxxxx1', 'Row 1 provider_payment_id = pay_xxxxx1');
  assert(mockInsertedRows[1].provider_payment_id === 'pay_xxxxx2', 'Row 2 provider_payment_id = pay_xxxxx2');
  assert(mockInsertedRows[2].provider_payment_id === 'pay_xxxxx3', 'Row 3 provider_payment_id = pay_xxxxx3');
  assert(mockInsertedRows[3].provider_payment_id === 'pay_xxxxx4', 'Row 4 provider_payment_id = pay_xxxxx4');
}

async function testInconsistentCountError() {
  console.log('\n📌 TEST 2: Inconsistent installment count rejection');
  const provider = new AsaasProvider();

  (provider as any).request = async () => {
    return {
      data: [
        { id: 'pay_xxxxx1', installmentNumber: 1, value: 250 },
        { id: 'pay_xxxxx2', installmentNumber: 2, value: 250 },
      ]
    };
  };

  let threwError = false;
  try {
    await provider.getInstallmentPayments('inst_12345', 4);
  } catch (err: any) {
    threwError = true;
    assert(err.message.includes('Esperado 4 parcelas'), 'Error thrown for count mismatch');
  }
  assert(threwError, 'Count mismatch aborted execution');
}

async function testInconsistentSequenceError() {
  console.log('\n📌 TEST 3: Out-of-order / duplicate sequence rejection');
  const provider = new AsaasProvider();

  (provider as any).request = async () => {
    return {
      data: [
        { id: 'pay_xxxxx1', installmentNumber: 1, value: 250 },
        { id: 'pay_xxxxx2', installmentNumber: 1, value: 250 }, // Duplicate 1
        { id: 'pay_xxxxx3', installmentNumber: 3, value: 250 },
        { id: 'pay_xxxxx4', installmentNumber: 4, value: 250 },
      ]
    };
  };

  let threwError = false;
  try {
    await provider.getInstallmentPayments('inst_12345', 4);
  } catch (err: any) {
    threwError = true;
    assert(err.message.includes('Inconsistência na sequência'), 'Error thrown for duplicate sequence');
  }
  assert(threwError, 'Sequence inconsistency aborted execution');
}

async function testUnorderedInstallmentsSorting() {
  console.log('\n📌 TEST 4: Unordered API response (4, 2, 1, 3) sorting and DB recording');
  const provider = new AsaasProvider();

  (provider as any).request = async (endpoint: string) => {
    if (endpoint.includes('/installments/inst_9999/payments')) {
      return {
        data: [
          { id: 'pay_444', installmentNumber: 4, value: 250, netValue: 220, dueDate: '2026-11-01', status: 'PENDING' },
          { id: 'pay_222', installmentNumber: 2, value: 250, netValue: 220, dueDate: '2026-09-01', status: 'PENDING' },
          { id: 'pay_111', installmentNumber: 1, value: 250, netValue: 220, dueDate: '2026-08-01', status: 'PENDING' },
          { id: 'pay_333', installmentNumber: 3, value: 250, netValue: 220, dueDate: '2026-10-01', status: 'PENDING' },
        ]
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const items = await provider.getInstallmentPayments('inst_9999', 4);

  // 1. Validate getInstallmentPayments ordered them 1..4
  assert(items.length === 4, 'Returned 4 items');
  assert(items[0].installmentNumber === 1 && items[0].id === 'pay_111', 'Item 0 = Parcela 1 (pay_111)');
  assert(items[1].installmentNumber === 2 && items[1].id === 'pay_222', 'Item 1 = Parcela 2 (pay_222)');
  assert(items[2].installmentNumber === 3 && items[2].id === 'pay_333', 'Item 2 = Parcela 3 (pay_333)');
  assert(items[3].installmentNumber === 4 && items[3].id === 'pay_444', 'Item 3 = Parcela 4 (pay_444)');

  // 2. Validate DB recording with Map<number, string>
  const mockInsertedRows: any[] = [];
  const mockSupabase: any = {
    from: (table: string) => {
      assert(table === 'payment_installments', 'Writes to payment_installments table');
      return {
        upsert: async (row: any) => {
          mockInsertedRows.push(row);
          return { error: null };
        }
      };
    }
  };

  const idMap = new Map<number, string>();
  items.forEach(item => idMap.set(item.installmentNumber, item.id));

  await InstallmentService.recordInitialSchedule(mockSupabase, {
    providerPaymentId: 'pay_111',
    providerPaymentIdMap: idMap,
    totalInstallments: 4,
    grossAmountCents: 100000,
    netAmountCents: 90000,
    platformFeeCents: 10000,
    groupId: 'grp_test_unordered'
  });

  assert(mockInsertedRows.length === 4, '4 installments recorded in database');
  assert(mockInsertedRows[0].installment_number === 1 && mockInsertedRows[0].provider_payment_id === 'pay_111', 'Parcela 1 -> pay_111');
  assert(mockInsertedRows[1].installment_number === 2 && mockInsertedRows[1].provider_payment_id === 'pay_222', 'Parcela 2 -> pay_222');
  assert(mockInsertedRows[2].installment_number === 3 && mockInsertedRows[2].provider_payment_id === 'pay_333', 'Parcela 3 -> pay_333');
  assert(mockInsertedRows[3].installment_number === 4 && mockInsertedRows[3].provider_payment_id === 'pay_444', 'Parcela 4 -> pay_444');
}

async function runAll() {
  await testValid4InstallmentSequence();
  await testInconsistentCountError();
  await testInconsistentSequenceError();
  await testUnorderedInstallmentsSorting();
  console.log('\n🎉 ALL INSTALLMENT SEQUENCE TESTS PASSED SUCCESSFULLY!\n');
}

runAll().catch(err => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
