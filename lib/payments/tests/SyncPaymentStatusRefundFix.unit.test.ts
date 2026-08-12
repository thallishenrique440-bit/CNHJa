// Function under test logic isolated for unit testing
function evaluateSyncDecision(paymentData: any, allGroupApts: Array<{ status: string }>) {
  const asaasStatus = paymentData?.status?.toUpperCase();

  const hasCompletedRefund = Array.isArray(paymentData?.refunds) && paymentData.refunds.some(
    (r: any) => ['DONE', 'REFUNDED'].includes(r?.status?.toUpperCase())
  );
  const isRefunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(asaasStatus) || hasCompletedRefund;

  if (isRefunded) {
    return { decision: 'reconcile_refund', action: 'repaired_refunded' };
  } else if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
    const hasInvalidStatus = allGroupApts?.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
    if (hasInvalidStatus) {
      return { decision: 'skip', reason: 'group_already_cancelled_or_expired' };
    }
    return { decision: 'repair_payment', action: 'repaired_succeeded' };
  } else {
    return { decision: 'skip', reason: 'asaas_status_unhandled', asaasStatus };
  }
}

function check(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function runSyncPaymentStatusRefundFixTests() {
  console.log('====================================================');
  console.log('RUNNING SYNC PAYMENT STATUS REFUND FIX TEST SUITE (FASE 3.1.8)');
  console.log('====================================================\n');

  console.log('📌 CASO A: RECEIVED + expired + refund DONE -> RECONCILIAR REFUND');
  {
    const paymentData = {
      status: 'RECEIVED',
      refunds: [
        { status: 'DONE', value: 101.49 }
      ]
    };
    const apts = [{ status: 'expired' }];

    const res = evaluateSyncDecision(paymentData, apts);
    check(res.decision === 'reconcile_refund', `decision is 'reconcile_refund'`);
    check(res.action === 'repaired_refunded', `action is 'repaired_refunded'`);
  }

  console.log('\n📌 CASO B: RECEIVED + expired + nenhum refund -> SKIP (group_already_cancelled_or_expired)');
  {
    const paymentData = {
      status: 'RECEIVED',
      refunds: []
    };
    const apts = [{ status: 'expired' }];

    const res = evaluateSyncDecision(paymentData, apts);
    check(res.decision === 'skip', `decision is 'skip'`);
    check(res.reason === 'group_already_cancelled_or_expired', `reason is 'group_already_cancelled_or_expired'`);
  }

  console.log('\n📌 CASO C: RECEIVED + pending_approval + nenhum refund -> REPARAR PAGAMENTO (repaired_succeeded)');
  {
    const paymentData = {
      status: 'RECEIVED',
      refunds: []
    };
    const apts = [{ status: 'pending_approval' }];

    const res = evaluateSyncDecision(paymentData, apts);
    check(res.decision === 'repair_payment', `decision is 'repair_payment'`);
    check(res.action === 'repaired_succeeded', `action is 'repaired_succeeded'`);
  }

  console.log('\n📌 CASO D: RECEIVED + expired + refund AWAITING_CRITICAL_ACTION_AUTHORIZATION -> SKIP (NÃO marcar como REFUNDED)');
  {
    const paymentData = {
      status: 'RECEIVED',
      refunds: [
        { status: 'AWAITING_CRITICAL_ACTION_AUTHORIZATION', value: 100.00 }
      ]
    };
    const apts = [{ status: 'expired' }];

    const res = evaluateSyncDecision(paymentData, apts);
    check(res.decision === 'skip', `decision is 'skip'`);
    check(res.reason === 'group_already_cancelled_or_expired', `reason is 'group_already_cancelled_or_expired'`);
  }

  console.log('\n📌 CASO E: RECEIVED + expired + refund DONE -> RECONCILIAR REFUND');
  {
    const paymentData = {
      status: 'RECEIVED',
      refunds: [
        { status: 'DONE', value: 100.00 }
      ]
    };
    const apts = [{ status: 'expired' }];

    const res = evaluateSyncDecision(paymentData, apts);
    check(res.decision === 'reconcile_refund', `decision is 'reconcile_refund'`);
    check(res.action === 'repaired_refunded', `action is 'repaired_refunded'`);
  }

  console.log('\n📌 CASO F: REFUNDED top level + cancelled apt -> RECONCILIAR REFUND');
  {
    const paymentData = {
      status: 'REFUNDED'
    };
    const apts = [{ status: 'cancelled' }];

    const res = evaluateSyncDecision(paymentData, apts);
    check(res.decision === 'reconcile_refund', `decision is 'reconcile_refund'`);
  }

  console.log('\n====================================================');
  console.log('✅ ALL SYNC PAYMENT STATUS REFUND FIX TESTS PASSED!');
  console.log('====================================================');
}

runSyncPaymentStatusRefundFixTests().catch((err) => {
  console.error('❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
