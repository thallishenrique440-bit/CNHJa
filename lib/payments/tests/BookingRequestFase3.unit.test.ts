/**
 * FASE 3 — regras puras do novo fluxo e verificacoes sobre o codigo de integracao.
 *
 * TIPO
 *   - Secoes A-D: unitarios (funcoes puras, sem banco nem rede).
 *   - Secao E: leitura do CODIGO-FONTE dos handlers (Vercel e Edge). Os
 *     handlers nao sao executados aqui; o comportamento das funcoes do banco
 *     esta' em BookingRequestFase3.pg.test.ts (PostgreSQL real).
 *
 * Uso: npx tsx lib/payments/tests/BookingRequestFase3.unit.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  requestResponseDeadlineIso, decideRequestExpiry,
  isBookingConfirmingStatus, httpStatusForOutcome,
} from '../BookingRequestService.js';
import { computeBookingCharge, buildBookingPaymentDTO } from '../BookingCharge.js';
import { quoteCheckout, buildAppliedFeeSnapshot, DEFAULT_GATEWAY_FEE_SCHEDULE } from '../GatewayFeeModel.js';

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failures.push(label); console.error(`  ❌ ${label}`); }
};
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8').replace(/\r\n/g, '\n');

async function main() {
  console.log('=== FASE 3 — regras do novo fluxo ===\n');

  // A. Sem chave de ativacao (decisao de 03/10/2026): o pedido e' o padrao.
  const svc = src('lib/payments/BookingRequestService.ts');
  const cbiA = src('api/create-booking-intent.ts');
  check(!/BOOKING_REQUEST_FLOW_ENABLED|BOOKING_REQUEST_FLOW_INSTRUCTORS|isBookingRequestFlowEnabled/.test(svc + cbiA), 'A1. nenhuma chave de ativacao no servico nem no endpoint');
  check(/const requestFlow = true;/.test(cbiA) && !/process\.env\[[^\]]*FLOW/.test(cbiA), 'A2. toda solicitacao e\' um pedido; nada depende de variavel de ambiente');

  // B. Prazos
  check(requestResponseDeadlineIso([{ date: '2026-10-10', startTime: '14:00' }, { date: '2026-10-09', start_time: '08:00:00' }]) === '2026-10-09T11:00:00.000Z',
    'B1. prazo de resposta = inicio da PRIMEIRA aula do pedido (horario de Brasilia)');
  check(requestResponseDeadlineIso([{ date: 'x', startTime: '10:00' }]) === null, 'B2. data invalida: sem prazo (nao inventa valor)');

  // C. Provedor e expiracao
  check(['RECEIVED', 'received_in_cash', 'CONFIRMED'].every(isBookingConfirmingStatus) && !['PENDING', 'OVERDUE', 'REFUNDED', 'DELETED', ''].some(isBookingConfirmingStatus),
    'C1. confirmam a reserva: RECEIVED, RECEIVED_IN_CASH, CONFIRMED (mesma regra do fluxo atual)');
  check(decideRequestExpiry(false, null) === 'expire' && decideRequestExpiry(true, 'RECEIVED') === 'await_confirmation'
    && decideRequestExpiry(true, 'PENDING') === 'cancel_charge_then_expire' && decideRequestExpiry(true, 'DELETED') === 'cancel_charge_then_expire'
    && decideRequestExpiry(true, null) === 'retry_later', 'C2. expiracao: sem cobranca expira; paga aguarda; pendente cancela e expira; desconhecida tenta depois');
  check(httpStatusForOutcome({ ok: true, outcome: 'ALREADY_ACCEPTED' }) === 200 && httpStatusForOutcome({ ok: false, outcome: 'FORBIDDEN' }) === 403
    && httpStatusForOutcome({ ok: false, outcome: 'NOT_FOUND' }) === 404 && httpStatusForOutcome({ ok: false, outcome: 'INVALID_STATE' }) === 409,
    'C3. resultado do banco -> HTTP (idempotente = 200; disputa perdida = 409)');

  // D. Cobranca: mesmas regras do fluxo atual (18)
  for (const [method, n, price] of [['PIX', 1, 12000], ['CREDIT_CARD', 1, 10000], ['CREDIT_CARD', 3, 23990]] as Array<[string, number, number]>) {
    const rules = DEFAULT_GATEWAY_FEE_SCHEDULE as any;
    const c = computeBookingCharge({ finalPriceCents: price, paymentMethod: method, installmentCount: n, providerName: 'asaas', rules });
    // Formula ORIGINAL do create-booking-intent (antes da extracao).
    const q = quoteCheckout({ servicePriceCents: price, method: method === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'PIX', installmentCount: n || 1, provider: 'asaas', rules });
    const legacyFee = q.gatewayFeeExpectedCents;
    const legacyCommission = Math.round(price * 0.10);
    const dto = buildBookingPaymentDTO({ charge: c, finalPriceCents: price, groupId: 'g', customerProviderId: 'cus', returnUrl: 'u', paymentMethod: method, installmentCount: n, instructorWalletId: 'w' });
    check(c.processingFee === legacyFee && c.totalPriceWithFee === price + legacyFee && c.applicationFeeAmount === legacyCommission
      && dto.amount === price + legacyFee && dto.splitRules[0].fixedValue === price - legacyCommission && dto.splitRules[0].walletId === 'w'
      && JSON.stringify(c.appliedFee) === JSON.stringify(buildAppliedFeeSnapshot(q)),
      `D. ${method} ${n}x R$${price / 100}: tarifa, total, comissao de 10% e split identicos a formula original`);
  }

  // E. Integracao (codigo-fonte)
  const cbi = src('api/create-booking-intent.ts');
  const reqBranch = cbi.slice(cbi.indexOf('if (requestFlow) {\n      try {\n        await NotificationService.sendBookingRequest'), cbi.indexOf('// 5. Create Payment via resolved provider'));
  check(reqBranch.includes("mode: 'request'") && !/invoiceUrl|clientSecret/.test(reqBranch), 'E1. pedido: resposta mode=request, SEM invoiceUrl/clientSecret (o frontend nao consegue abrir checkout)');
  check(cbi.indexOf('if (requestFlow) {\n      try {\n        await NotificationService.sendBookingRequest') < cbi.indexOf('createPaymentWithCustomerRecovery({\n        paymentProvider,\n        supabase,\n        providerName,\n        studentId: secureStudentId'),
    'E2. pedido retorna ANTES de qualquer criacao de cobranca');
  check(/status: requestFlow \? 'pending' : 'awaiting_payment'/.test(cbi) && /if \(!requestFlow\) \{\n\s+try \{\n\s+customerProviderId = await ensureProviderCustomer/.test(cbi),
    'E3. pedido: aulas em pending, sem criar cliente no provedor (ramo de compra direta mantido sem uso ate\' a remocao do legado)');
  check(/mode: 'checkout',\n\s+clientSecret: paymentResponse\.clientSecret/.test(cbi) && /mode: 'checkout',\n\s+groupId,\n\s+invoiceUrl/.test(cbi),
    'E4. so\' o pagamento (apos o aceite) devolve invoiceUrl, marcado mode=checkout; o modal/checkout existente e\' o mesmo');
  check(/\.eq\('booking_flow', 'legacy'\)\n\s+\.in\('status', \['reserved', 'pending', 'awaiting_payment'\]\)/.test(cbi),
    'E5. "nova tentativa" do fluxo atual nunca cancela um pedido do novo fluxo');
  const pay = cbi.slice(cbi.indexOf('async function handleRequestPayment'));
  check(pay.indexOf('BookingRequestService.startPayment') < pay.indexOf('createPaymentWithCustomerRecovery') && pay.indexOf('createPaymentWithCustomerRecovery') < pay.indexOf('BookingRequestService.attachPayment')
    && /if \(!attached\.ok\) \{\n\s+\/\/[^\n]*\n\s+await cancelOrphanCharge/.test(pay), 'E6. pagamento: prazo validado no banco antes; vinculo unico depois; cobranca nao vinculada e\' cancelada');
  check(!/\.delete\(\)/.test(pay) && /attachedId[\s\S]*getPayment\(attachedId\)/.test(pay), 'E7. pagamento repetido devolve a cobranca existente; nenhuma aula e\' apagada em falha do provedor');

  const ap = src('supabase/functions/approve-booking/index.ts');
  const rj = src('supabase/functions/reject-booking/index.ts');
  const cb = src('supabase/functions/cancel-booking/index.ts');
  check(ap.indexOf('BookingRequestService.accept') < ap.indexOf('// --- GROUPING LOGIC ---') && rj.indexOf('BookingRequestService.reject') < rj.indexOf('BookingCancellationCore.processCancellation')
    && cb.indexOf('BookingRequestService.cancelByStudent') < cb.indexOf('// Validation: 24h rule'), 'E8. aceite, recusa e cancelamento do novo fluxo desviam ANTES do caminho atual');
  check(/booking_flow === BOOKING_FLOW_REQUEST/.test(ap) && /booking_flow === BOOKING_FLOW_REQUEST/.test(rj) && /booking_flow === BOOKING_FLOW_REQUEST/.test(cb),
    'E9. o desvio depende do dado gravado (booking_flow): reservas antigas (legacy) seguem no caminho anterior durante a transicao');

  const ce = src('supabase/functions/check-expired-bookings/index.ts');
  check(/\.in\('status', \['awaiting_payment', 'reserved', 'pending'\]\)\n\s+\.eq\('booking_flow', 'legacy'\)/.test(ce) && ce.includes('runRequestExpiryCycle'),
    'E10. expiracao: Modulo A (atual) so\' le linhas legacy; Modulo C trata o novo fluxo');

  const wh = src('api/asaas-webhook.ts');
  check(/if \(isRequestFlow\) \{[\s\S]*BookingRequestService\.confirmPayment[\s\S]*\} else \{\n\s+\/\/ Update appointments payload \(pending approval/.test(wh)
    && /if \(instructorId && !isRequestFlow\)/.test(wh), 'E11. webhook: novo fluxo confirma pela funcao do banco; fluxo atual inalterado no else; sem aviso duplicado ao instrutor');
  check(wh.indexOf('const isRequestFlow') > wh.indexOf('const hasInvalidStatus'), 'E12. webhook: reserva encerrada continua indo para payment_exceptions antes de qualquer confirmacao');

  const sy = src('supabase/functions/sync-payment-status/index.ts');
  check(/if \(isRequestGroup\) \{\n\s+return await confirmRequestGroup\(\);/.test(sy), 'E13. conciliacao: pedido pago do novo fluxo e\' confirmado pela funcao do banco, nunca levado a pending_approval');

  console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
  if (failures.length > 0) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('❌ TEST SUITE FAILED:', e); process.exit(1); });
