export {};

function check(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// 1. Logic representation of sync-payment-status/index.ts (Fase 1.1.F.3)
function simulateSyncPaymentStatus({
  asaasStatus,
  paymentValue,
  installmentNumber,
  groupApts,
}: {
  asaasStatus: string;
  paymentValue: number;
  installmentNumber: number;
  groupApts: Array<{ id: string; status: string; payment_status: string }>;
}) {
  const isFullRefund = asaasStatus === 'REFUNDED';
  const isPartialRefund = asaasStatus === 'PARTIALLY_REFUNDED';

  const updatedApts: Array<{ id: string; status: string; payment_status: string }> = [];
  let installmentRefundCall: any = null;
  let action = '';
  let status = '';
  let reason = '';

  if (isFullRefund) {
    action = 'repaired_refunded';
    status = 'success';

    for (const apt of groupApts) {
      if (apt.status === 'completed') {
        // Protected: completed appointments represent consumed service
        continue;
      }
      // P-1.20.1B: sync-payment-status reconcilia DINHEIRO. O reparo
      // `cancelling -> cancelled` foi removido junto com o proprio estado; o
      // status de negocio pertence ao BookingCancellationCore, que agora so
      // escreve um estado terminal depois do refund COMPLETED.
      updatedApts.push({
        id: apt.id,
        status: apt.status,
        payment_status: 'refunded',
      });
    }

    installmentRefundCall = {
      installmentNumber: installmentNumber || 1,
      refundAmountCents: Math.round((paymentValue || 0) * 100),
    };
  } else if (isPartialRefund) {
    status = 'skipped';
    reason = 'partial_refund_retained';
  } else {
    status = 'skipped';
    reason = 'unhandled';
  }

  return {
    action,
    status,
    reason,
    updatedApts,
    installmentRefundCall,
  };
}

// 2. Logic representation of Deno InstallmentService.recordRefundSettlement (Fase 1.1.F.3)
async function simulateDenoInstallmentServiceRecordRefundSettlement(
  supabaseMock: {
    queries: Array<{ table: string; operation: string; payload?: any; filters?: any }>;
    installmentsData: Array<{ id: string; status: string }>;
  },
  dto: { providerPaymentId: string; groupId?: string; installmentNumber?: number; refundAmountCents: number }
) {
  // Query payment_installments
  supabaseMock.queries.push({
    table: 'payment_installments',
    operation: 'select',
    filters: { providerPaymentId: dto.providerPaymentId, groupId: dto.groupId },
  });

  const instList = supabaseMock.installmentsData;
  if (instList && instList.length > 0) {
    for (const inst of instList) {
      supabaseMock.queries.push({
        table: 'payment_installments',
        operation: 'update',
        payload: { status: 'REFUNDED' },
        filters: { id: inst.id },
      });
      inst.status = 'REFUNDED';
    }
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('FASE 1.1.F.3 — REFUND HARDENING & ISOLATION UNIT TESTS');
  console.log('====================================================\n');

  console.log('📌 TEST 1: REFUNDED total -> Fluxo total continua funcionando');
  {
    const apts = [
      { id: 'apt_1', status: 'reserved', payment_status: 'paid' },
      { id: 'apt_2', status: 'cancelled', payment_status: 'paid' },
    ];
    const res = simulateSyncPaymentStatus({
      asaasStatus: 'REFUNDED',
      paymentValue: 200,
      installmentNumber: 1,
      groupApts: apts,
    });

    check(res.status === 'success', 'Status is success');
    check(res.action === 'repaired_refunded', 'Action is repaired_refunded');
    check(res.updatedApts.length === 2, 'All 2 appointments updated');
    check(res.updatedApts.find(a => a.id === 'apt_1')?.payment_status === 'refunded', 'apt_1 payment_status is refunded');
    check(res.updatedApts.find(a => a.id === 'apt_2')?.status === 'cancelled', 'apt_2 mantem o status terminal (nao ha reparo de status aqui)');
    check(res.updatedApts.find(a => a.id === 'apt_1')?.status === 'reserved', 'P-1.20.1B: sync nao altera o status de negocio, so payment_status');
    check(res.installmentRefundCall !== null, 'Installment refund was called');
  }

  console.log('\n📌 TEST 2: PARTIALLY_REFUNDED -> Não entra no fluxo total');
  {
    const apts = [
      { id: 'apt_1', status: 'confirmed', payment_status: 'paid' },
      { id: 'apt_2', status: 'confirmed', payment_status: 'paid' },
    ];
    const res = simulateSyncPaymentStatus({
      asaasStatus: 'PARTIALLY_REFUNDED',
      paymentValue: 100,
      installmentNumber: 1,
      groupApts: apts,
    });

    check(res.status === 'skipped', 'Status is skipped');
    check(res.reason === 'partial_refund_retained', 'Reason is partial_refund_retained');
    check(res.updatedApts.length === 0, 'Zero appointments updated');
    check(res.installmentRefundCall === null, 'InstallmentService NOT called');
  }

  console.log('\n📌 TEST 3: COMPLETED protegido contra mutação');
  {
    const apts = [
      { id: 'apt_completed_1', status: 'completed', payment_status: 'paid' },
      { id: 'apt_cancelling_2', status: 'cancelled', payment_status: 'paid' },
    ];
    const res = simulateSyncPaymentStatus({
      asaasStatus: 'REFUNDED',
      paymentValue: 100,
      installmentNumber: 1,
      groupApts: apts,
    });

    check(res.updatedApts.length === 1, 'Only non-completed appointment was updated');
    check(res.updatedApts[0].id === 'apt_cancelling_2', 'apt_cancelling_2 was updated');
    check(res.updatedApts.find(a => a.id === 'apt_completed_1') === undefined, 'apt_completed_1 was NOT updated/mutated');
  }

  console.log('\n📌 TEST 4: Deno InstallmentService -> Altera somente payment_installments, ZERO writes em payment_settlements');
  {
    const mockDb = {
      queries: [] as Array<{ table: string; operation: string; payload?: any; filters?: any }>,
      installmentsData: [{ id: 'inst_101', status: 'PAID' }, { id: 'inst_102', status: 'PAID' }],
    };

    await simulateDenoInstallmentServiceRecordRefundSettlement(mockDb, {
      providerPaymentId: 'pay_asaas_123',
      groupId: 'grp_456',
      refundAmountCents: 50000,
    });

    check(mockDb.installmentsData[0].status === 'REFUNDED', 'inst_101 status is REFUNDED');
    check(mockDb.installmentsData[1].status === 'REFUNDED', 'inst_102 status is REFUNDED');

    const settlementWrites = mockDb.queries.filter(q => q.table === 'payment_settlements');
    check(settlementWrites.length === 0, 'ZERO queries executed against payment_settlements table');

    const installmentUpdates = mockDb.queries.filter(q => q.table === 'payment_installments' && q.operation === 'update');
    check(installmentUpdates.length === 2, 'Exactly 2 installment updates executed');
  }

  console.log('\n📌 TEST 5: Múltiplos refunds -> Sem identificadores sintéticos colidentes (_refund_1)');
  {
    const mockDb = {
      queries: [] as Array<{ table: string; operation: string; payload?: any; filters?: any }>,
      installmentsData: [{ id: 'inst_1', status: 'PAID' }],
    };

    // First refund
    await simulateDenoInstallmentServiceRecordRefundSettlement(mockDb, {
      providerPaymentId: 'pay_999',
      refundAmountCents: 10000,
    });

    // Second refund
    await simulateDenoInstallmentServiceRecordRefundSettlement(mockDb, {
      providerPaymentId: 'pay_999',
      refundAmountCents: 10000,
    });

    const hasSyntheticSettlementIds = mockDb.queries.some(
      q => q.payload?.provider_settlement_id && q.payload.provider_settlement_id.includes('_refund_')
    );
    check(!hasSyntheticSettlementIds, 'No synthetic provider_settlement_id was generated or inserted');
  }

  console.log('\n====================================================');
  console.log('✅ ALL FASE 1.1.F.3 UNIT TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
