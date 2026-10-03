import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { calculateDiscount, getInstructorDiscounts } from '../lib/discount-utils.js';
import { AGENDA_SLOTS } from '../lib/slots.js';
import { PaymentProviderResolver } from '../lib/payments/PaymentProviderResolver.js';
import { PaymentProviderFactory } from '../lib/payments/PaymentProviderFactory.js';
import { fetchGatewayFeeRules } from '../lib/payments/GatewayFeeRepository.js';
import { deriveLessonPrices } from '../lib/payments/LessonPricing.js';
import {
  computeBookingCharge, buildBookingPaymentDTO, ensureProviderCustomer,
  createPaymentWithCustomerRecovery, recordBookingChargeSchedule,
} from '../lib/payments/BookingCharge.js';
import {
  BookingRequestService, BOOKING_FLOW_REQUEST,
  requestResponseDeadlineIso, httpStatusForOutcome,
} from '../lib/payments/BookingRequestService.js';
import { NotificationService } from '../lib/NotificationService.js';

const MAX_INSTALLMENTS = 4;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// isInvalidCustomerError / recoverInvalidCustomer: movidos sem alteracao para
// lib/payments/BookingCharge.ts (FASE 3), compartilhados com o novo fluxo.

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get token from header
  const authHeader = req.headers.authorization;
  
  // Diagnostic logs (Safe: no secrets logged)
  console.log('[DEBUG] Auth Header present:', !!authHeader);
  if (authHeader) {
    console.log('[DEBUG] Auth Header length:', authHeader.length);
  }

  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  console.log('[DEBUG] Token extracted, length:', token.length);
  
  // Check Supabase config presence
  console.log('[DEBUG] SUPABASE_URL present:', !!process.env.SUPABASE_URL);
  console.log('[DEBUG] SUPABASE_SERVICE_ROLE_KEY present:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log('[DEBUG] SUPABASE_ANON_KEY present:', !!process.env.SUPABASE_ANON_KEY);

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    console.error('[DEBUG] Auth Error:', authError?.message || 'No user found');
    console.error('[DEBUG] Token used (first 10 chars):', token.substring(0, 10));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { lessons, instructorId, category, ignoreTooClose, paymentMethod, installmentCount } = req.body;
  const secureStudentId = user.id;

  // FASE 3 — novo fluxo: pagamento de um pedido JA' ACEITO pelo instrutor.
  // Mesmo endpoint (o projeto esta' no limite de funcoes da Vercel).
  if (req.body?.action === 'pay_request') {
    return handleRequestPayment(req, res, user);
  }

  if (!lessons || !lessons.length) {
    return res.status(400).json({ error: 'No lessons provided' });
  }

  if (!category || !['A', 'B', 'AB'].includes(category)) {
    return res.status(400).json({ error: 'Invalid or missing category' });
  }

  // Validation for limits
  if (lessons.length > 20) {
    return res.status(400).json({ error: 'Limite máximo de 20 aulas por agendamento excedido.' });
  }

  if (installmentCount !== undefined && installmentCount !== null) {
    const parsedCount = Number(installmentCount);
    if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > MAX_INSTALLMENTS) {
      return res.status(400).json({ error: `O número máximo de parcelas permitido é ${MAX_INSTALLMENTS}.` });
    }
  }

  try {
    // 1. Fetch instructor details (including generic provider details)
    const { data: instructor, error: instructorError } = await supabase
      .from('instructors')
      .select('provider_account_id, provider_wallet_id, provider_name, work_saturday_afternoon, lunch_start_slot, lunch_duration, lunch_active, has_night_lessons, base_price, night_price, on_vacation')
      .eq('id', instructorId)
      .single();

    if (instructorError) {
      console.error('[ERROR] Instructor details fetch error:', instructorError);
      return res.status(400).json({ error: 'Instructor details not found.' });
    }

    // AP-05/A — defesa antecipada: NOVA reserva para instrutor em ferias.
    // Fica antes de qualquer escrita (inclusive da limpeza 3.6), para nunca
    // mexer em reserva existente. Checkouts ja criados antes das ferias nao
    // passam por aqui: sao concluidos por webhook/UPDATE, que nao consulta
    // on_vacation. O trigger de INSERT no banco e' a barreira definitiva.
    if (instructor?.on_vacation === true) {
      return res.status(409).json({
        error: 'Este instrutor está em férias no momento e não está aceitando novas aulas.',
        code: 'INSTRUCTOR_ON_VACATION'
      });
    }

    // FASE 3 — decisao de 03/10/2026: o novo fluxo e' o PADRAO (sem chave de
    // ativacao). Toda solicitacao vira um PEDIDO sem cobranca. Os ramos
    // `!requestFlow` abaixo sao o caminho de compra direta do fluxo anterior,
    // mantido sem uso apenas ate' a remocao do legado (Fase 9).
    const requestFlow = true;

    // Resolve the payment provider via the orchestration layer
    const providerName = PaymentProviderResolver.resolveProviderForStudent(secureStudentId);
    console.log(`[PAYMENT_DIAGNOSTIC]
DEFAULT_PAYMENT_PROVIDER=${process.env.DEFAULT_PAYMENT_PROVIDER}
providerName=${providerName}`);

    const paymentProvider = PaymentProviderFactory.getProvider(providerName);
    console.log(`[PAYMENT_DIAGNOSTIC]
providerInstance=${paymentProvider.getProviderName()}`);

    // FASE 2 — LEITURA DAS TAXAS (P-1.16A)
    // Fonte unica: public.gateway_fee_schedule. A leitura nunca lanca; se
    // falhar, quoteCheckout cai no DEFAULT_GATEWAY_FEE_SCHEDULE embutido —
    // a tarifa nunca e' zerada nem volta a percentuais antigos.
    const gatewayFeeRules = await fetchGatewayFeeRules(supabase, providerName);

    // Validate gateway setup for selected provider
    if (providerName === 'asaas' && !instructor?.provider_account_id && !instructor?.provider_wallet_id) {
      return res.status(400).json({ 
        error: 'Instructor not ready for Asaas payments',
        code: 'INSTRUCTOR_ASAAS_NOT_READY'
      });
    }

    // 1.5 Fetch student profile & manage Asaas/Provider Customer ID
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('full_name, provider_customer_id, provider_name, phone, cpf')
      .eq('id', secureStudentId)
      .single();

    if (profileError || !profile) {
      console.error('[ERROR] Student profile not found for user:', secureStudentId, profileError);
      return res.status(400).json({ error: 'Student profile not found.' });
    }

    // Validate CPF and Phone presence for billing (required by payment providers)
    if (!profile.cpf || profile.cpf.trim() === '') {
      return res.status(400).json({ error: 'O CPF é obrigatório para prosseguir com o pagamento.' });
    }
    if (!profile.phone || profile.phone.trim() === '') {
      return res.status(400).json({ error: 'O Telefone é obrigatório para prosseguir com o pagamento.' });
    }

    // Resolve student's customer ID for the active provider.
    // Novo fluxo: o cliente no provedor so' e' necessario no pagamento.
    let customerProviderId: string | null = null;
    if (!requestFlow) {
      try {
        customerProviderId = await ensureProviderCustomer({
          supabase,
          paymentProvider,
          providerName,
          studentId: secureStudentId,
          userEmail: user.email || '',
          profile,
        });
      } catch (custError: any) {
        console.error(`[ERROR] Fail to create Customer for user ${secureStudentId} on provider ${providerName}:`, custError);
        return res.status(500).json({
          error: 'Erro ao registrar cliente de pagamento. Tente novamente.',
          details: custError.message
        });
      }
    }

    // 2. Validate dates (max 7 days in advance)
    const MAX_DAYS_IN_ADVANCE = 7;
    
    // Get current date in Brazil as YYYY-MM-DD string
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const now = new Date();
    const todayString = formatter.format(now);
    
    // Calculate maxDate (7 days in advance)
    const maxDateObj = new Date(now);
    maxDateObj.setDate(maxDateObj.getDate() + MAX_DAYS_IN_ADVANCE);
    const maxDateString = formatter.format(maxDateObj);

    for (const lesson of lessons) {
      // Use noon UTC to reliably get the day of the week regardless of server timezone
      const lessonDateObj = new Date(`${lesson.date}T12:00:00Z`);
      const dayOfWeek = lessonDateObj.getUTCDay(); // 0 = Sunday, 6 = Saturday

      // Sunday Check
      if (dayOfWeek === 0) {
         return res.status(400).json({ error: 'Não é possível agendar aulas aos domingos.' });
      }

      // Saturday Check
      if (dayOfWeek === 6) {
          const [h, m] = lesson.startTime.split(':').map(Number);
          const minutes = h * 60 + m;
          
          // If instructor works saturday afternoon, allow until 17:00 (1020 mins)
          // Else allow until 11:10 (670 mins)
          const limit = instructor.work_saturday_afternoon ? (17 * 60) : (11 * 60 + 10);
          
          if (minutes > limit) {
             return res.status(400).json({ 
                 error: instructor.work_saturday_afternoon 
                    ? 'Aos sábados, o horário limite é 17:00.' 
                    : 'Aos sábados, o horário limite é 11:10.' 
             });
          }
      }

      // Weekday Night Lesson Check
      const [h, m] = lesson.startTime.split(':').map(Number);
      const minutes = h * 60 + m;
      if (!instructor.has_night_lessons && minutes >= 18 * 60) {
          return res.status(400).json({ error: 'Este instrutor não realiza aulas noturnas.' });
      }

      // Lunch Check (Slot-based)
      if (instructor.lunch_active) {
          const startIndex = AGENDA_SLOTS.indexOf(instructor.lunch_start_slot || '12:00');
          if (startIndex !== -1) {
            const lunchSlots = AGENDA_SLOTS.slice(startIndex, startIndex + (instructor.lunch_duration || 2));
            if (lunchSlots.includes(lesson.startTime)) {
              return res.status(400).json({ error: `O horário ${lesson.startTime} está dentro do intervalo de almoço do instrutor.` });
            }
          }
      }
      
      // Past date check (Date only)
      const lessonDateString = lesson.date;
      if (lessonDateString < todayString) {
         return res.status(400).json({ error: 'Não é possível agendar aulas no passado.' });
      }

      // Specific Time Check (Date + Time)
      // Canonical UTC start time for lesson
      const startTimeUtc = lesson.start_time_utc || new Date(`${lesson.date}T${lesson.startTime}:00-03:00`).toISOString();
      const startTimeMs = new Date(startTimeUtc).getTime();
      const nowMs = now.getTime();

      // HARDENING 2: Revalidação final - se a aula já foi iniciada
      if (nowMs >= startTimeMs) {
        return res.status(400).json({ 
          error: 'Esta aula já foi iniciada.' 
        });
      }

      // Single Source of Truth para a janela crítica dos últimos 30 minutos antes do início da aula
      const isInsideWarningWindow = nowMs >= (startTimeMs - 30 * 60 * 1000);

      // CENÁRIO 2: Compra com menos de 30 minutos de antecedência (e ignoreTooClose == false)
      if (isInsideWarningWindow && !ignoreTooClose) {
        return res.status(409).json({ 
          errorCode: 'TOO_CLOSE',
          error: 'Horário muito próximo para agendamento automático.' 
        });
      }

      if (lessonDateString > maxDateString) {
        return res.status(400).json({ 
          error: `Agendamentos permitidos apenas para os próximos ${MAX_DAYS_IN_ADVANCE} dias devido a regras de pagamento.` 
        });
      }
    }

    // 3. Calculate discount
    const discounts = await getInstructorDiscounts(instructorId, supabase);
    
    // P-1.17 (G1) — PRECO AUTORITATIVO.
    // O preco de cada aula e' derivado no servidor a partir de
    // public.instructor_categories, com fallback para public.instructors.
    // `lesson.price` do request e' dado NAO CONFIAVEL e nao entra em nenhum
    // calculo financeiro: serve apenas para registrar divergencia.
    const { data: categoryPriceRows, error: categoryPriceError } = await supabase
      .from('instructor_categories')
      .select('category, day_price, night_price')
      .eq('instructor_id', instructorId);

    if (categoryPriceError) {
      console.error('[PRICE AUTHORITY] Falha ao ler instructor_categories:', categoryPriceError);
      return res.status(500).json({
        error: 'Nao foi possivel determinar o preco da aula.',
        code: 'PRICE_AUTHORITY_UNAVAILABLE'
      });
    }

    const pricing = deriveLessonPrices(
      lessons,
      category,
      categoryPriceRows || [],
      {
        base_price: instructor.base_price ?? null,
        night_price: instructor.night_price ?? null,
        has_night_lessons: instructor.has_night_lessons ?? null
      }
    );

    if (pricing.unresolved.length > 0 || pricing.prices.length !== lessons.length) {
      console.error(`[PRICE AUTHORITY] Preco autoritativo indisponivel: ${pricing.unresolved.map(u => u.reason).join(' | ')}`);
      return res.status(400).json({
        error: 'Preco da aula indisponivel para o instrutor/categoria selecionados.',
        code: 'PRICE_AUTHORITY_UNRESOLVED'
      });
    }

    const authoritativePrices = pricing.prices;

    for (const a of pricing.audit) {
      if (a.diverged) {
        console.warn(`[PRICE AUTHORITY] Divergencia na aula ${a.index} (${a.startTime}): cliente enviou ${a.submittedCents}, autoritativo ${a.authoritativeCents} (${a.source}). Valor do cliente IGNORADO.`);
      }
    }

    const totalBasePrice = authoritativePrices.reduce((sum: number, p: number) => sum + p, 0);
    
    const { finalPrice, discountAmount } = calculateDiscount(
      lessons.length,
      totalBasePrice,
      discounts
    );

    // FASE 3 — CÁLCULO DA TAXA & FASE 4 — TOTAL COBRADO
    // P-1.16A: a tarifa e' resolvida pelo modelo canonico compartilhado
    // (lib/payments/GatewayFeeModel). O frontend usa exatamente as mesmas
    // funcoes e o mesmo schedule, portanto exibe o mesmo total que sera
    // cobrado aqui. `finalPrice` (service_price) nao e' alterado pela tarifa.
    const charge = computeBookingCharge({
      finalPriceCents: finalPrice,
      paymentMethod,
      installmentCount,
      providerName,
      rules: gatewayFeeRules
    });
    const feeQuote = charge.feeQuote;

    // Fail-closed: sem faixa de tarifa nao ha como formar student_charge sem
    // que a plataforma absorva a tarifa inteira em silencio.
    if (charge.ruleMissing && !requestFlow) {
      console.error(`[GATEWAY FEE] Nenhuma faixa de tarifa para ${feeQuote.method} em ${feeQuote.installmentCount}x.`);
      return res.status(400).json({
        error: 'Tarifa de pagamento indisponivel para o metodo/parcelamento selecionado.',
        code: 'GATEWAY_FEE_RULE_NOT_FOUND'
      });
    }

    const processingFee = charge.processingFee;
    const appliedFee = charge.appliedFee;

    if (feeQuote.usedFallback) {
      console.warn(`[GATEWAY FEE] Schedule do banco indisponivel para ${feeQuote.method}/${feeQuote.installmentCount}x. Usando DEFAULT_GATEWAY_FEE_SCHEDULE embutido.`);
    }
    console.log(`[GATEWAY FEE] method=${feeQuote.method} installments=${feeQuote.installmentCount} percent=${appliedFee.feePercentApplied} fixed=${appliedFee.feeFixedCents} servicePrice=${finalPrice} fee=${processingFee} source=${appliedFee.feeSource}`);

    const totalPriceWithFee = charge.totalPriceWithFee;

    // Create group_id
    const groupId = uuidv4();

    // 3.5 Double check availability for ALL lessons in the batch
    for (const lesson of lessons) {
      const { data: conflict } = await supabase
        .from('appointments')
        .select('id, student_id, status, booking_flow')
        .eq('instructor_id', instructorId)
        .eq('date', lesson.date)
        .eq('start_time', lesson.startTime)
        .in('status', ['pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment'])
        .maybeSingle();

      if (conflict) {
        // Allow retry if it's the same student and it's a temporary status
        // So' checkout ABANDONADO do fluxo atual e' "nova tentativa". Pedido do
        // novo fluxo e' um pedido real: nunca e' substituido em silencio.
        if (conflict.student_id === secureStudentId && conflict.booking_flow !== BOOKING_FLOW_REQUEST
            && (conflict.status === 'awaiting_payment' || conflict.status === 'reserved')) {
          // This will be cleaned up in the next step
          continue; 
        }
        return res.status(409).json({ 
          error: `O horário ${lesson.startTime} no dia ${lesson.date} já foi ocupado por outro aluno.`,
          code: 'SLOT_TAKEN'
        });
      }
    }

    // 3.6 Cleanup previous abandoned checkouts by the same user for the same slots
    for (const lesson of lessons) {
      await supabase
          .from('appointments')
          .update({
              status: 'cancelled',
              payment_status: 'failed',
              cancelled_reason: 'user_retry_new_attempt'
          })
          .eq('instructor_id', instructorId)
          .eq('student_id', secureStudentId)
          .eq('date', lesson.date)
          .eq('start_time', lesson.startTime)
          .eq('booking_flow', 'legacy')
          .in('status', ['reserved', 'pending', 'awaiting_payment']);
    }

    // 4. Create appointments in DB (awaiting_payment) with proportional discount allocation
    let allocatedSum = 0;
    const appointmentsToInsert = lessons.map((lesson: any, index: number) => {
      const startTimeUtc = lesson.start_time_utc || new Date(`${lesson.date}T${lesson.startTime}:00-03:00`).toISOString();
      const startTimeMs = new Date(startTimeUtc).getTime();
      const isInsideWarningWindow = now.getTime() >= (startTimeMs - 30 * 60 * 1000);

      // A janela de expiração do checkout é independente do horário da aula: criacao + 5 minutos
      // Novo fluxo: prazo de RESPOSTA do instrutor = inicio da primeira aula do pedido.
      const reservationExpiresAt = requestFlow
        ? requestResponseDeadlineIso(lessons.map((l: any) => ({ date: l.date, startTime: l.startTime })))
        : new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const isLastMinute = isInsideWarningWindow || Boolean(ignoreTooClose);

      // P-1.17: base do rateio e' o preco autoritativo desta aula, nunca lesson.price.
      const origPrice = authoritativePrices[index];
      let discountedLessonPrice = 0;

      if (index === lessons.length - 1) {
        // Last lesson takes exact remainder of finalPrice to guarantee sum(price) === finalPrice
        discountedLessonPrice = finalPrice - allocatedSum;
      } else {
        const itemDiscount = Math.round((discountAmount * origPrice) / (totalBasePrice || 1));
        discountedLessonPrice = origPrice - itemDiscount;
        allocatedSum += discountedLessonPrice;
      }

      console.log(`[DEBUG] Creating appointment: Date=${lesson.date}, Time=${lesson.startTime}, UTC=${startTimeUtc}, origPrice=${origPrice}, discountedPrice=${discountedLessonPrice}, isLastMinute=${isLastMinute}`);

      return {
        instructor_id: instructorId,
        student_id: secureStudentId,
        date: lesson.date,
        start_time: lesson.startTime,
        start_time_utc: startTimeUtc,
        end_time: lesson.endTime,
        category: category,
        status: requestFlow ? 'pending' : 'awaiting_payment',
        ...(requestFlow ? { booking_flow: BOOKING_FLOW_REQUEST } : {}),
        price: discountedLessonPrice, // Proportional net price in cents
        group_id: groupId,
        expires_at: reservationExpiresAt,
        created_at: new Date().toISOString(),
        is_last_minute: isLastMinute
      };
    });

    const { data: appointments, error: dbError } = await supabase
      .from('appointments')
      .insert(appointmentsToInsert)
      .select();

    if (dbError) {
      // AP-05/A: o instrutor entrou em ferias entre a checagem acima e o INSERT.
      if (typeof dbError.message === 'string' && dbError.message.includes('INSTRUCTOR_ON_VACATION')) {
        return res.status(409).json({
          error: 'Este instrutor está em férias no momento e não está aceitando novas aulas.',
          code: 'INSTRUCTOR_ON_VACATION'
        });
      }

      // Check for unique constraint violation (Postgres code 23505)
      if (dbError.code === '23505') {
        return res.status(409).json({ 
          error: 'Este horário acabou de ser reservado por outro aluno.',
          code: 'SLOT_TAKEN'
        });
      }

      console.error('Error creating appointments:', dbError);
      return res.status(500).json({ 
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        hint: dbError.hint
      });
    }

    // FASE 3 — novo fluxo: o pedido foi registrado. NENHUMA cobranca, nenhum
    // split, nenhum checkout. A resposta nao tem invoiceUrl nem clientSecret:
    // o frontend nao tem como abrir pagamento a partir dela.
    if (requestFlow) {
      try {
        await NotificationService.sendBookingRequest({
          instructorId,
          studentName: profile.full_name || 'Um aluno',
          comboCount: appointments?.length || lessons.length,
          groupId
        });
      } catch (notifErr) {
        console.error('⚠️ [CREATE_BOOKING_INTENT] Falha ao notificar o instrutor sobre o pedido:', notifErr);
      }
      return res.status(200).json({
        mode: 'request',
        groupId,
        status: 'pending',
        lessons: appointments?.length || lessons.length,
        responseDeadline: appointmentsToInsert[0]?.expires_at ?? null,
        totalPrice: finalPrice,
        discountAmount
      });
    }

    // 5. Create Payment via resolved provider with Rollback capabilities
    const applicationFeeAmount = charge.applicationFeeAmount; // 10% commission
    let paymentResponse;

    const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : 'https://autoescolabrasil.com');
    const returnUrl = `${requestOrigin}/#/student/lessons`;

    const paymentDTO = buildBookingPaymentDTO({
      charge,
      finalPriceCents: finalPrice,
      groupId,
      customerProviderId: customerProviderId as string,
      returnUrl,
      paymentMethod,
      installmentCount,
      instructorWalletId: instructor.provider_wallet_id
    });

    try {
      paymentResponse = await createPaymentWithCustomerRecovery({
        paymentProvider,
        supabase,
        providerName,
        studentId: secureStudentId,
        customerProviderId: customerProviderId as string,
        userEmail: user.email || '',
        profile,
        paymentDTO
      });

      console.log(`[PAYMENT_DIAGNOSTIC]
paymentResponse.providerName=${paymentResponse.providerName}
paymentResponse.clientSecretPresent=${!!paymentResponse.clientSecret}
paymentResponse.invoiceUrl=${paymentResponse.invoiceUrl}
paymentResponse.providerPaymentId=${paymentResponse.providerPaymentId}`);

      // 6. Update appointments with payment_intent_id & provider_payment_id with Dual Writing
      await supabase
        .from('appointments')
        .update({ 
          payment_intent_id: paymentResponse.providerPaymentId, 
          provider_payment_id: paymentResponse.providerPaymentId,
          provider_name: providerName
        })
        .eq('group_id', groupId);

      // 6b. Record Financial Schedule in payment_installments using individual payment IDs for installments
      try {
        const firstAptId = appointments && appointments.length > 0 ? appointments[0].id : null;
        await recordBookingChargeSchedule({
          supabase,
          paymentProvider,
          paymentResponse,
          installmentCount,
          charge,
          groupId,
          appointmentId: firstAptId,
          studentId: secureStudentId,
          instructorId,
        });
      } catch (instError: any) {
        console.error('⚠️ [InstallmentService] Error recording initial schedule:', instError);
        throw instError;
      }

    } catch (paymentError: any) {
      console.error(`[ERROR] Payment Provider creation error on ${providerName}, rolling back appointments:`, paymentError);
      
      // ROLLBACK: Delete appointments if payment creation fails
      await supabase.from('appointments').delete().eq('group_id', groupId);
      
      return res.status(500).json({ 
        error: 'Erro ao processar pagamento. Tente novamente.',
        details: paymentError.message 
      });
    }

    console.log(`[PAYMENT_DIAGNOSTIC]
RESPONSE_PAYLOAD
clientSecretPresent=${!!paymentResponse?.clientSecret}
invoiceUrl=${providerName === 'asaas' ? (paymentResponse?.invoiceUrl || null) : undefined}
groupId=${groupId}`);

    // 7. Return payload (retains clientSecret legacy compatibility, appends invoiceUrl dynamically)
    return res.status(200).json({
      mode: 'checkout',
      clientSecret: paymentResponse.clientSecret,
      groupId,
      totalPrice: finalPrice,
      totalPriceWithFee,
      processingFee,
      discountAmount,
      invoiceUrl: providerName === 'asaas' ? (paymentResponse.invoiceUrl || null) : undefined
    });

  } catch (error: any) {
    console.error('Error in create-booking-intent:', error);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * FASE 3 — pagamento de um pedido do novo fluxo, depois do aceite.
 *
 * Ordem (cada passo e' idempotente):
 *   1. booking_request_start_payment: reserved -> awaiting_payment, so' dentro
 *      do prazo (o banco e' a autoridade do prazo).
 *   2. Cobranca ja' vinculada? Devolve a mesma (nunca cria a segunda).
 *   3. Cria a cobranca com as MESMAS regras do fluxo atual (BookingCharge).
 *   4. booking_request_attach_payment: uma cobranca por reserva. Se outra
 *      chamada venceu a disputa, ou o prazo venceu, a cobranca criada aqui e'
 *      cancelada no provedor.
 *   5. Cronograma de parcelas (payment_installments), como no fluxo atual.
 * A confirmacao da aula NAO acontece aqui: so' quando o provedor confirmar o
 * pagamento (webhook / conciliacao -> booking_request_confirm_payment).
 */
async function handleRequestPayment(req: any, res: any, user: any) {
  const { groupId, paymentMethod, installmentCount } = req.body || {};
  const studentId = user.id;

  if (!groupId || typeof groupId !== 'string') {
    return res.status(400).json({ mode: 'request', error: 'groupId obrigatorio.', code: 'INVALID_ARGUMENT' });
  }
  if (installmentCount !== undefined && installmentCount !== null) {
    const parsedCount = Number(installmentCount);
    if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > MAX_INSTALLMENTS) {
      return res.status(400).json({ error: `O número máximo de parcelas permitido é ${MAX_INSTALLMENTS}.` });
    }
  }

  try {
    const { data: rows, error: rowsError } = await supabase
      .from('appointments')
      .select('id, student_id, instructor_id, price, status, booking_flow, provider_payment_id, expires_at')
      .eq('group_id', groupId)
      .eq('booking_flow', BOOKING_FLOW_REQUEST);
    if (rowsError) throw rowsError;
    if (!rows || rows.length === 0) {
      return res.status(404).json({ mode: 'request', outcome: 'NOT_FOUND', error: 'Pedido nao encontrado.' });
    }
    if (rows.some((r: any) => r.student_id !== studentId)) {
      return res.status(403).json({ mode: 'request', outcome: 'FORBIDDEN', error: 'Pedido de outro aluno.' });
    }

    // 1. Inicio do pagamento (dentro do prazo).
    const started = await BookingRequestService.startPayment(supabase, groupId, studentId);
    if (!started.ok) {
      return res.status(httpStatusForOutcome(started)).json({ mode: 'request', outcome: started.outcome, error: 'Pagamento indisponivel para este pedido.' });
    }

    const instructorId = rows[0].instructor_id;
    const providerName = PaymentProviderResolver.resolveProviderForStudent(studentId);
    const paymentProvider: any = PaymentProviderFactory.getProvider(providerName);

    // 2. Cobranca ja' vinculada: devolve a mesma.
    const attachedId = rows.find((r: any) => r.provider_payment_id)?.provider_payment_id;
    if (attachedId) {
      const existing = await paymentProvider.getPayment(attachedId);
      return res.status(200).json({
        mode: 'checkout', groupId, reused: true,
        invoiceUrl: existing?.invoiceUrl || null,
        paymentDeadline: started.payment_deadline ?? null
      });
    }

    // 3. Cobranca nova, com as regras do fluxo atual.
    const { data: instructor, error: instructorError } = await supabase
      .from('instructors')
      .select('provider_account_id, provider_wallet_id')
      .eq('id', instructorId)
      .single();
    if (instructorError || !instructor) {
      return res.status(400).json({ error: 'Instructor details not found.' });
    }
    if (providerName === 'asaas' && !instructor.provider_account_id && !instructor.provider_wallet_id) {
      return res.status(400).json({ error: 'Instructor not ready for Asaas payments', code: 'INSTRUCTOR_ASAAS_NOT_READY' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('full_name, provider_customer_id, provider_name, phone, cpf')
      .eq('id', studentId)
      .single();
    if (profileError || !profile) {
      return res.status(400).json({ error: 'Student profile not found.' });
    }
    if (!profile.cpf || profile.cpf.trim() === '') {
      return res.status(400).json({ error: 'O CPF é obrigatório para prosseguir com o pagamento.' });
    }
    if (!profile.phone || profile.phone.trim() === '') {
      return res.status(400).json({ error: 'O Telefone é obrigatório para prosseguir com o pagamento.' });
    }

    // Preco: o valor gravado em cada aula no pedido (com desconto ja' rateado).
    const finalPrice = rows.reduce((sum: number, r: any) => sum + (r.price || 0), 0);
    const gatewayFeeRules = await fetchGatewayFeeRules(supabase, providerName);
    const charge = computeBookingCharge({ finalPriceCents: finalPrice, paymentMethod, installmentCount, providerName, rules: gatewayFeeRules });
    if (charge.ruleMissing) {
      return res.status(400).json({
        error: 'Tarifa de pagamento indisponivel para o metodo/parcelamento selecionado.',
        code: 'GATEWAY_FEE_RULE_NOT_FOUND'
      });
    }

    let customerProviderId: string;
    try {
      customerProviderId = await ensureProviderCustomer({ supabase, paymentProvider, providerName, studentId, userEmail: user.email || '', profile });
    } catch (custError: any) {
      console.error(`[ERROR] Fail to create Customer for user ${studentId} on provider ${providerName}:`, custError);
      return res.status(500).json({ error: 'Erro ao registrar cliente de pagamento. Tente novamente.', details: custError.message });
    }

    const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : 'https://autoescolabrasil.com');
    const paymentDTO = buildBookingPaymentDTO({
      charge, finalPriceCents: finalPrice, groupId, customerProviderId,
      returnUrl: `${requestOrigin}/#/student/lessons`,
      paymentMethod, installmentCount, instructorWalletId: instructor.provider_wallet_id
    });

    let paymentResponse: any;
    try {
      paymentResponse = await createPaymentWithCustomerRecovery({
        paymentProvider, supabase, providerName, studentId, customerProviderId,
        userEmail: user.email || '', profile, paymentDTO
      });
    } catch (paymentError: any) {
      // Nenhuma cobranca criada. O pedido continua aguardando pagamento ate' o
      // prazo; o aluno pode tentar de novo (o passo 1 e' idempotente).
      console.error(`[ERROR] Payment Provider creation error on ${providerName} (pedido ${groupId}):`, paymentError);
      return res.status(502).json({ mode: 'request', outcome: 'PROVIDER_ERROR', error: 'Erro ao processar pagamento. Tente novamente.', details: paymentError.message });
    }

    // 4. Vinculo (uma cobranca por reserva).
    const attached = await BookingRequestService.attachPayment(supabase, groupId, providerName, paymentResponse.providerPaymentId);
    if (!attached.ok) {
      // A cobranca criada aqui nao vale: cancela no provedor.
      await cancelOrphanCharge(paymentProvider, paymentResponse.providerPaymentId, groupId);
      if (attached.outcome === 'PAYMENT_CONFLICT') {
        const { data: winner } = await supabase
          .from('appointments').select('provider_payment_id').eq('group_id', groupId).not('provider_payment_id', 'is', null).limit(1).maybeSingle();
        const existing = winner?.provider_payment_id ? await paymentProvider.getPayment(winner.provider_payment_id) : null;
        return res.status(200).json({ mode: 'checkout', groupId, reused: true, invoiceUrl: existing?.invoiceUrl || null, paymentDeadline: started.payment_deadline ?? null });
      }
      return res.status(httpStatusForOutcome(attached)).json({ mode: 'request', outcome: attached.outcome, error: 'Pagamento indisponivel para este pedido.' });
    }

    // 5. Cronograma de parcelas.
    try {
      await recordBookingChargeSchedule({
        supabase, paymentProvider, paymentResponse, installmentCount, charge, groupId,
        appointmentId: rows[0].id, studentId, instructorId
      });
    } catch (instError: any) {
      // A cobranca existe e esta' vinculada; sem o cronograma o webhook retem o
      // evento para conciliacao (RECONCILIATION_PENDING). Registrado para acao.
      console.error(`❌ [CREATE_BOOKING_INTENT] Cronograma de parcelas NAO gravado para ${paymentResponse.providerPaymentId} (pedido ${groupId}):`, instError);
    }

    return res.status(200).json({
      mode: 'checkout',
      groupId,
      invoiceUrl: providerName === 'asaas' ? (paymentResponse.invoiceUrl || null) : undefined,
      clientSecret: paymentResponse.clientSecret,
      totalPrice: finalPrice,
      totalPriceWithFee: charge.totalPriceWithFee,
      processingFee: charge.processingFee,
      paymentDeadline: started.payment_deadline ?? null
    });
  } catch (error: any) {
    console.error('Error in create-booking-intent (pay_request):', error);
    return res.status(500).json({ mode: 'request', error: error.message });
  }
}

/** Cancela no provedor uma cobranca que nao ficou vinculada ao pedido. */
async function cancelOrphanCharge(paymentProvider: any, providerPaymentId: string, groupId: string) {
  try {
    if (typeof paymentProvider.deletePayment === 'function') {
      await paymentProvider.deletePayment(providerPaymentId);
      console.warn(`[CREATE_BOOKING_INTENT] Cobranca ${providerPaymentId} cancelada: nao vinculada ao pedido ${groupId}.`);
    } else {
      console.error(`❌ [CREATE_BOOKING_INTENT] Provedor sem cancelamento: cobranca ${providerPaymentId} do pedido ${groupId} ficou sem vinculo.`);
    }
  } catch (err: any) {
    console.error(`❌ [CREATE_BOOKING_INTENT] Falha ao cancelar a cobranca ${providerPaymentId} do pedido ${groupId}: ${err?.message ?? err}`);
  }
}
