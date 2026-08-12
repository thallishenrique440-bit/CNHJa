/**
 * RealIdempotencyIntegration.test.ts
 * Tests REAL database idempotency for refund settlements against connected Supabase DB.
 * Uses synthetic test IDs to ensure zero impact on real production data.
 */

import { createClient } from '@supabase/supabase-js';
import { InstallmentService } from '../InstallmentService.js';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function runRealDbIdempotencyTest() {
  console.log('====================================================');
  console.log('RUNNING REAL DATABASE IDEMPOTENCY INTEGRATION TEST');
  console.log('====================================================\n');

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠️ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. Skipping real DB integration test.');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const testPaymentId = `pay_audit_test_${Date.now()}`;
  const testSettlementId = `${testPaymentId}_refund_1`;

  try {
    // CENÁRIO A: Webhook executa primeiro, depois Sync executa
    console.log('📌 CENÁRIO A: Webhook emite refund settlement, depois Sync repete');

    // 1. Webhook call
    await InstallmentService.recordRefundSettlement(supabase, {
      providerPaymentId: testPaymentId,
      installmentNumber: 1,
      refundAmountCents: 5000,
      providerSettlementId: testSettlementId,
      refundDate: new Date().toISOString()
    });

    // Verify COUNT after Webhook call
    const { count: countAfterWebhook, error: err1 } = await supabase
      .from('payment_settlements')
      .select('*', { count: 'exact', head: true })
      .eq('provider_payment_id', testPaymentId)
      .eq('settlement_type', 'REFUND')
      .eq('provider_settlement_id', testSettlementId);

    if (err1) throw err1;
    assert(countAfterWebhook === 1, `Exact 1 record in DB after Webhook execution (count: ${countAfterWebhook})`);

    // 2. Sync call with identical parameters
    await InstallmentService.recordRefundSettlement(supabase, {
      providerPaymentId: testPaymentId,
      installmentNumber: 1,
      refundAmountCents: 5000,
      providerSettlementId: testSettlementId,
      refundDate: new Date().toISOString()
    });

    // Verify COUNT after Sync call
    const { count: countAfterSync, error: err2 } = await supabase
      .from('payment_settlements')
      .select('*', { count: 'exact', head: true })
      .eq('provider_payment_id', testPaymentId)
      .eq('settlement_type', 'REFUND')
      .eq('provider_settlement_id', testSettlementId);

    if (err2) throw err2;
    assert(countAfterSync === 1, `Exact 1 record in DB after Sync execution (COUNT(*) = ${countAfterSync}) - NO DUPLICATION`);

    // CENÁRIO B: Múltiplas execuções repetidas
    console.log('\n📌 CENÁRIO B: Múltiplas execuções simultâneas/repetidas');
    for (let i = 0; i < 3; i++) {
      await InstallmentService.recordRefundSettlement(supabase, {
        providerPaymentId: testPaymentId,
        installmentNumber: 1,
        refundAmountCents: 5000,
        providerSettlementId: testSettlementId,
        refundDate: new Date().toISOString()
      });
    }

    const { count: countAfterMultiple, error: err3 } = await supabase
      .from('payment_settlements')
      .select('*', { count: 'exact', head: true })
      .eq('provider_payment_id', testPaymentId)
      .eq('settlement_type', 'REFUND')
      .eq('provider_settlement_id', testSettlementId);

    if (err3) throw err3;
    assert(countAfterMultiple === 1, `Exact 1 record in DB after 5 total executions (COUNT(*) = ${countAfterMultiple})`);

    console.log('\n====================================================');
    console.log('✅ REAL DATABASE IDEMPOTENCY INTEGRATION TEST PASSED!');
    console.log('====================================================\n');

  } finally {
    // Cleanup synthetic test records
    await supabase
      .from('payment_settlements')
      .delete()
      .eq('provider_payment_id', testPaymentId);
    
    await supabase
      .from('payment_installments')
      .delete()
      .eq('provider_payment_id', testPaymentId);
  }
}

runRealDbIdempotencyTest().catch((err) => {
  console.error('❌ REAL DB INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
