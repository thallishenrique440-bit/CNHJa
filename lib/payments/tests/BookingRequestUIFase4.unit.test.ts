/**
 * FASE 4 — interface do novo fluxo: verificacoes sobre o CODIGO-FONTE das telas.
 *
 * O projeto nao tem infraestrutura de teste de componentes React; as telas nao
 * sao renderizadas aqui. Estas verificacoes garantem o contrato entre tela e
 * backend (o que e' enviado, o que e' aceito como resposta) e que o modal de
 * pagamento e' o mesmo de antes. A validacao funcional e' feita no aplicativo.
 *
 * Uso: npx tsx lib/payments/tests/BookingRequestUIFase4.unit.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failures.push(label); console.error(`  ❌ ${label}`); }
};
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8').replace(/\r\n/g, '\n');

const profile = src('pages/student/InstructorProfile.tsx');
const lessons = src('pages/student/Lessons.tsx');
const agenda = src('pages/InstructorAgenda.tsx');
const modal = src('components/PaymentMethodModal.tsx');
const cbi = src('api/create-booking-intent.ts');

console.log('=== FASE 4 — interface do novo fluxo ===\n');

// Perfil do instrutor: solicitacao sem pagamento
const book = profile.slice(profile.indexOf('const executeActualBooking'), profile.indexOf('const handleRetryPayment'));
check(profile.includes("? 'Solicitar horário(s)'") && !profile.includes("'Pagar agora'"), 'P1. botao "Solicitar horário(s)" no lugar de "Pagar agora"');
check(!/paymentMethod|installmentCount/.test(book.slice(book.indexOf('const payload'), book.indexOf('// 4. Call API Route'))), 'P2. a solicitacao nao envia forma de pagamento nem parcelamento');
check(!book.includes('CheckoutLauncher.launch') && /data\.mode === 'request'/.test(book), 'P3. resposta aceita somente como pedido (mode=request); nenhum checkout e\' aberto');
check(book.includes("addToast('Solicitação enviada. Aguardando o instrutor.', 'success')") && book.includes("navigate('/student/lessons')"), 'P4. confirmacao simples e ida para "Minhas Aulas"');
check(!profile.includes('isOpen={isPaymentMethodModalOpen}') && /await executeActualBooking\(ignoreTooClose\)/.test(profile), 'P5. o modal de pagamento nao abre mais na solicitacao (CPF/telefone e aviso de horario proximo preservados)');

// Modal de pagamento: o mesmo de antes
check(modal.includes('title="Forma de Pagamento"') && modal.includes('id="payment-method-pix"') && modal.includes('id="payment-method-cc"')
  && modal.includes('id="payment-installments-select"') && modal.includes('Confirmar e Pagar') && /MAX_INSTALLMENTS = 4/.test(modal),
  'M1. modal movido com os mesmos elementos (Pix, cartao, parcelas 1-4, total, "Confirmar e Pagar")');
check(/quoteCheckout\(\{\n\s+servicePriceCents: totalPrice,\n\s+method: selectedPaymentMethod === 'CREDIT_CARD' \? 'CREDIT_CARD' : 'PIX',/.test(modal) && modal.includes('.from(GATEWAY_FEE_TABLE)'),
  'M2. taxas pela mesma funcao (quoteCheckout) e mesma tabela de tarifas lida pelo backend');

// Minhas Aulas
const pay = lessons.slice(lessons.indexOf('const handleRequestPayment'), lessons.indexOf('const confirmCancellation'));
check(/action: 'pay_request'/.test(pay) && /groupId: payingRequest\.groupId/.test(pay), 'L1. "Pagar" chama o endpoint existente com action=pay_request para o PEDIDO (groupId)');
check(/if \(response\.ok && data\?\.mode === 'checkout' && data\?\.invoiceUrl\) \{[\s\S]*CheckoutLauncher\.launch\(data\.invoiceUrl\)/.test(pay), 'L2. checkout so\' abre com resposta mode=checkout do servidor');
check(/RESERVATION_EXPIRED/.test(pay) && /refresh-lessons/.test(pay) && /if \(!payingRequest \|\| isPayingRequest\) return;/.test(pay), 'L3. prazo expirado tratado; tela atualizada pelo servidor; clique duplo ignorado');
check(!/status: 'confirmed'|payment_status/.test(pay), 'L4. a tela nunca marca a aula como paga');
check(/rawLessons\.filter\(r => r\.group_id === group\.groupId && r\.booking_flow === 'request'\)/.test(lessons), 'L5. combo: valor e quantidade do pedido inteiro (todas as aulas do grupo)');
check(/group_id,\n\s+booking_flow,\n\s+expires_at,/.test(lessons), 'L6. a consulta traz group_id, booking_flow e expires_at');
check(lessons.includes('Aguardando instrutor') && lessons.includes('Aguardando pagamento') && lessons.includes('Cancelar solicitação'), 'L7. estados: aguardando instrutor (com cancelamento) e aguardando pagamento');
const cd = lessons.slice(lessons.indexOf('const RequestPaymentAction'), lessons.indexOf('export const StudentLessons'));
check(/new Date\(expiresAt\)\.getTime\(\)/.test(cd) && /Date\.now\(\) \+ serverTimeOffset/.test(cd) && /onExpired\(\)/.test(cd) && /Prazo encerrado/.test(cd),
  'L8. contador a partir do expires_at do servidor (com o desvio de relogio do app); ao zerar pede atualizacao ao servidor');
check(/!\(cancelledGroupId && l\.group_id === cancelledGroupId\)/.test(lessons), 'L9. cancelamento do pedido remove todas as aulas do grupo da lista');

// Agenda do instrutor
check(/lesson\.bookingFlow === 'request' \? "Aguardando pagamento" : "Processando\.\.\."/.test(agenda), 'A1. aceito: "Aguardando pagamento" (fluxo antigo segue "Processando...")');
check(/apt\.booking_flow === 'request' \|\|\n\s+apt\.cancelled_reason === 'user_retry_new_attempt'/.test(agenda), 'A2. pedido recusado/cancelado libera o horario na agenda');
check(/if \(data\?\.mode === 'request'\) \{[\s\S]{0,200}fetchAppointments\(\);/.test(agenda), 'A3. aceite do pedido: mensagem correta e recarga da agenda (sem "pagamento capturado")');
check(/selectedLesson\.bookingFlow === 'request'\n\s+\? "Tem certeza que deseja recusar esta solicitação\?"/.test(agenda), 'A4. recusa de pedido nao fala em estorno');
check(/booking_flow,\n\s+reschedule_requested_at/.test(agenda) && agenda.includes(".channel('instructor-agenda-changes')"), 'A5. agenda le booking_flow e mantem o tempo real existente');

// Contrato com o backend
check(/mode: 'request',\n\s+groupId,\n\s+status: 'pending'/.test(cbi) && /mode: 'checkout',\n\s+groupId,\n\s+invoiceUrl/.test(cbi), 'C1. contrato: pedido devolve mode=request; pagamento devolve mode=checkout com invoiceUrl');

console.log(`\n=== ${passed} asserts PASS, ${failures.length} FAIL ===`);
if (failures.length > 0) {
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
