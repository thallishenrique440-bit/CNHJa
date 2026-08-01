import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { calculateDiscount, getInstructorDiscounts } from '../lib/discount-utils.js';
import { AGENDA_SLOTS } from '../lib/slots.js';
import { PaymentProviderResolver } from '../lib/payments/PaymentProviderResolver.js';
import { PaymentProviderFactory } from '../lib/payments/PaymentProviderFactory.js';
import { InstallmentService } from '../lib/payments/InstallmentService.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Checks if an error is a recognized Asaas invalid_customer error
 */
function isInvalidCustomerError(err: any): boolean {
  if (!err) return false;
  if (err.code === 'invalid_customer') return true;
  const msg = String(err.message || err.rawError || err || '').toLowerCase();
  return msg.includes('invalid_customer') || msg.includes('cliente removido') || msg.includes('cliente foi removido');
}

interface RecoverCustomerParams {
  paymentProvider: any;
  supabase: any;
  providerName: string;
  secureStudentId: string;
  oldCustomerProviderId: string;
  userEmail: string;
  fullName: string;
  phone: string;
  cpf: string;
  originalError: any;
}

/**
 * Encapsulated private function to recover an invalid Asaas Customer:
 * 1. Re-creates Customer on provider using user details
 * 2. Validates new providerCustomerId
 * 3. Updates profiles.provider_customer_id in Supabase
 * Returns new providerCustomerId on success or throws originalError on failure.
 */
async function recoverInvalidCustomer(params: RecoverCustomerParams): Promise<string> {
  const {
    paymentProvider,
    supabase,
    providerName,
    secureStudentId,
    oldCustomerProviderId,
    userEmail,
    fullName,
    phone,
    cpf,
    originalError,
  } = params;

  console.warn(`[ASAAS CUSTOMER RECOVERY] Detected invalid_customer error on payment creation. Initiating controlled recovery.
- providerName: ${providerName}
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- moment: ${new Date().toISOString()}
- originalError: ${originalError?.message || originalError}`);

  // PASSO 1: Re-create Customer on provider using identical student data
  let newCustomerResponse;
  try {
    newCustomerResponse = await paymentProvider.createCustomer({
      email: userEmail || '',
      name: fullName || userEmail || 'Aluno',
      phone: phone.replace(/\D/g, ''),
      cpfCnpj: cpf.replace(/\D/g, ''),
    });
    console.log(`[ASAAS CUSTOMER RECOVERY] Customer re-created successfully on ${providerName}:
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- newProviderCustomerId: ${newCustomerResponse?.providerCustomerId}
- recreationResult: SUCCESS`);
  } catch (recreateError: any) {
    console.error(`[ASAAS CUSTOMER RECOVERY] Re-creation of Customer failed on ${providerName}:
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- recreationResult: FAILED
- error: ${recreateError?.message || recreateError}`);
    throw originalError; // Abort recovery, preserve original error
  }

  const newCustomerProviderId = newCustomerResponse?.providerCustomerId;
  if (!newCustomerProviderId || typeof newCustomerProviderId !== 'string' || newCustomerProviderId.trim() === '') {
    console.error(`[ASAAS CUSTOMER RECOVERY] Re-created Customer ID is invalid or empty:
- userId: ${secureStudentId}
- receivedId: ${newCustomerProviderId}`);
    throw originalError;
  }

  // PASSO 2: Update profiles.provider_customer_id ONLY after success
  const { error: updateProfileError } = await supabase
    .from('profiles')
    .update({ provider_customer_id: newCustomerProviderId })
    .eq('id', secureStudentId);

  if (updateProfileError) {
    console.error(`[ASAAS CUSTOMER RECOVERY] Failed to update profiles.provider_customer_id in database:
- userId: ${secureStudentId}
- newProviderCustomerId: ${newCustomerProviderId}
- dbUpdateResult: FAILED
- error: ${updateProfileError.message}`);
    throw originalError;
  }

  console.log(`[ASAAS CUSTOMER RECOVERY] Updated profiles.provider_customer_id in DB:
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- newProviderCustomerId: ${newCustomerProviderId}
- dbUpdateResult: SUCCESS`);

  return newCustomerProviderId;
}

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

  try {
    // 1. Fetch instructor details (including generic provider details)
    const { data: instructor, error: instructorError } = await supabase
      .from('instructors')
      .select('provider_account_id, provider_wallet_id, provider_name, work_saturday_afternoon, lunch_start_slot, lunch_duration, lunch_active, has_night_lessons')
      .eq('id', instructorId)
      .single();

    if (instructorError) {
      console.error('[ERROR] Instructor details fetch error:', instructorError);
      return res.status(400).json({ error: 'Instructor details not found.' });
    }

    // Resolve the payment provider via the orchestration layer
    const providerName = PaymentProviderResolver.resolveProviderForStudent(secureStudentId);
    console.log(`[PAYMENT_DIAGNOSTIC]
DEFAULT_PAYMENT_PROVIDER=${process.env.DEFAULT_PAYMENT_PROVIDER}
providerName=${providerName}`);

    const paymentProvider = PaymentProviderFactory.getProvider(providerName);
    console.log(`[PAYMENT_DIAGNOSTIC]
providerInstance=${paymentProvider.getProviderName()}`);

    // FASE 2 — LEITURA DAS TAXAS
    let settings = {
      pix_flat_fee: 149,
      credit_1x_fee: 3.99,
      credit_2x_fee: 5.49,
      credit_3x_fee: 6.49,
      credit_4x_fee: 7.49,
      credit_5x_fee: 8.49,
      credit_6x_fee: 9.49,
      credit_7x_fee: 10.49,
      credit_8x_fee: 11.49,
      credit_9x_fee: 12.49,
      credit_10x_fee: 13.49,
      credit_11x_fee: 14.49,
      credit_12x_fee: 15.49
    };

    try {
      const { data: dbSettings, error: dbSettingsError } = await supabase
        .from('platform_financial_settings')
        .select('*')
        .limit(1)
        .maybeSingle();
      
      if (dbSettingsError) {
        console.error('[ERROR] Failed to fetch platform_financial_settings:', dbSettingsError);
      } else if (dbSettings) {
        settings = {
          pix_flat_fee: dbSettings.pix_flat_fee,
          credit_1x_fee: Number(dbSettings.credit_1x_fee),
          credit_2x_fee: Number(dbSettings.credit_2x_fee),
          credit_3x_fee: Number(dbSettings.credit_3x_fee),
          credit_4x_fee: Number(dbSettings.credit_4x_fee),
          credit_5x_fee: Number(dbSettings.credit_5x_fee),
          credit_6x_fee: Number(dbSettings.credit_6x_fee),
          credit_7x_fee: Number(dbSettings.credit_7x_fee),
          credit_8x_fee: Number(dbSettings.credit_8x_fee),
          credit_9x_fee: Number(dbSettings.credit_9x_fee),
          credit_10x_fee: Number(dbSettings.credit_10x_fee),
          credit_11x_fee: Number(dbSettings.credit_11x_fee),
          credit_12x_fee: Number(dbSettings.credit_12x_fee),
        };
      }
    } catch (err) {
      console.error('[ERROR] Exception fetching platform_financial_settings:', err);
    }

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

    // Resolve student's customer ID for the active provider
    let customerProviderId = (profile.provider_name === providerName)
      ? profile.provider_customer_id
      : null;

    if (!customerProviderId) {
      try {
        console.log(`[INFO] Creating new Customer via resolved provider: ${providerName} for user ${secureStudentId}`);
        const customerResponse = await paymentProvider.createCustomer({
          email: user.email || '',
          name: profile.full_name || user.email || 'Aluno',
          phone: profile.phone.replace(/\D/g, ''),
          cpfCnpj: profile.cpf.replace(/\D/g, ''),
        });
        
        customerProviderId = customerResponse.providerCustomerId;
        console.log(`[INFO] Customer created successfully on ${providerName} with ID: ${customerProviderId}`);

        // Persist back to profile
        const updateData: any = {
          provider_customer_id: customerProviderId,
          provider_name: providerName
        };

        const { error: updateProfileError } = await supabase
          .from('profiles')
          .update(updateData)
          .eq('id', secureStudentId);

        if (updateProfileError) {
          console.error(`[ERROR] Failed to save customer_id ${customerProviderId} to user profile ${secureStudentId}:`, updateProfileError);
        } else {
          console.log(`[INFO] Saved customer identifiers to database profile ${secureStudentId}`);
        }
      } catch (custError: any) {
        console.error(`[ERROR] Fail to create Customer for user ${secureStudentId} on provider ${providerName}:`, custError);
        return res.status(500).json({ 
          error: 'Erro ao registrar cliente de pagamento. Tente novamente.',
          details: custError.message 
        });
      }
    } else {
      console.log(`[INFO] Reusing existing Customer ${customerProviderId} for user ${secureStudentId} on provider ${providerName}`);
      
      // Dual write check: keep provider fields synced if empty
      if (!profile.provider_customer_id || profile.provider_name !== providerName) {
        const updateData: any = {
          provider_customer_id: customerProviderId,
          provider_name: providerName
        };
        await supabase
          .from('profiles')
          .update(updateData)
          .eq('id', secureStudentId);
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
      // Prevent booking if the lesson time has already passed or is within 2 minutes
      // Assume lesson time is in America/Sao_Paulo (UTC-3)
      const lessonDateTime = new Date(`${lesson.date}T${lesson.startTime}:00-03:00`);
      
      const diffMs = lessonDateTime.getTime() - now.getTime();
      const diffMinutes = diffMs / (1000 * 60);

      if (diffMinutes <= 2) {
        return res.status(400).json({ 
          error: 'Um ou mais horários selecionados já passaram.' 
        });
      } else if (diffMinutes <= 20 && !ignoreTooClose) {
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
    
    // Calculate total base price by summing individual lesson prices
    const totalBasePrice = lessons.reduce((sum: number, lesson: any) => sum + (lesson.price || 0), 0);
    
    const { finalPrice, discountAmount } = calculateDiscount(
      lessons.length,
      totalBasePrice,
      discounts
    );

    // FASE 3 — CÁLCULO DA TAXA & FASE 4 — TOTAL COBRADO
    let processingFee = 0;
    if (providerName === 'asaas') {
      if (paymentMethod === 'PIX') {
        processingFee = settings.pix_flat_fee;
      } else if (paymentMethod === 'CREDIT_CARD') {
        const instCount = installmentCount || 1;
        const feeKey = `credit_${instCount}x_fee` as keyof typeof settings;
        const percentage = settings[feeKey] !== undefined ? Number(settings[feeKey]) : 3.99;
        processingFee = Math.round(finalPrice * (percentage / 100));
      }
    }

    const totalPriceWithFee = finalPrice + processingFee;

    // Create group_id
    const groupId = uuidv4();
    
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    // 3.5 Double check availability for ALL lessons in the batch
    for (const lesson of lessons) {
      const { data: conflict } = await supabase
        .from('appointments')
        .select('id, student_id, status')
        .eq('instructor_id', instructorId)
        .eq('date', lesson.date)
        .eq('start_time', lesson.startTime)
        .in('status', ['pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment'])
        .maybeSingle();

      if (conflict) {
        // Allow retry if it's the same student and it's a temporary status
        if (conflict.student_id === secureStudentId && (conflict.status === 'awaiting_payment' || conflict.status === 'reserved')) {
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
          .in('status', ['reserved', 'pending', 'awaiting_payment']);
    }

    // 4. Create appointments in DB (awaiting_payment) with proportional discount allocation
    let allocatedSum = 0;
    const appointmentsToInsert = lessons.map((lesson: any, index: number) => {
      // Check if it's last minute (within 20 mins)
      const lessonDateTime = new Date(`${lesson.date}T${lesson.startTime}:00-03:00`);
      const startTimeUtc = lessonDateTime.toISOString();
      const diffMs = lessonDateTime.getTime() - now.getTime();
      const diffMinutes = diffMs / (1000 * 60);
      const isLastMinute = diffMinutes <= 20;

      const origPrice = lesson.price || 0;
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
        status: 'awaiting_payment',
        price: discountedLessonPrice, // Proportional net price in cents
        group_id: groupId,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        is_last_minute: isLastMinute
      };
    });

    const { data: appointments, error: dbError } = await supabase
      .from('appointments')
      .insert(appointmentsToInsert)
      .select();

    if (dbError) {
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

    // 5. Create Payment via resolved provider with Rollback capabilities
    const applicationFeeAmount = Math.round(finalPrice * 0.10); // 10% commission
    let paymentResponse;

    const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : 'https://autoescolabrasil.com');
    const returnUrl = `${requestOrigin}/#/student/lessons`;

    const paymentDTO = {
      amount: totalPriceWithFee,
      description: `Agendamento - Código da reserva ${groupId}`,
      customerProviderId: customerProviderId,
      externalReferenceId: groupId,
      returnUrl: returnUrl,
      billingAddress: {
        postalCode: '01001-000',
        address: 'Praca da Se',
        addressNumber: '1',
        city: 'Sao Paulo',
        state: 'SP',
      },
      billingType: paymentMethod, // e.g., 'PIX' or 'CREDIT_CARD'
      installmentCount: installmentCount, // e.g., 1 to 12
      splitRules: [
        {
          walletId: instructor.provider_wallet_id || undefined,
          fixedValue: finalPrice - applicationFeeAmount,
        }
      ],
      metadata: {
        lesson_price: finalPrice,
        processing_fee: processingFee,
        gateway: 'asaas',
        installments: installmentCount || 1,
        payment_method: paymentMethod === 'CREDIT_CARD' ? 'credit_card' : 'pix'
      }
    };

    try {
      try {
        paymentResponse = await paymentProvider.createPayment(paymentDTO);
      } catch (firstPaymentError: any) {
        if (!isInvalidCustomerError(firstPaymentError)) {
          throw firstPaymentError;
        }

        const newCustomerProviderId = await recoverInvalidCustomer({
          paymentProvider,
          supabase,
          providerName,
          secureStudentId,
          oldCustomerProviderId: customerProviderId,
          userEmail: user.email || '',
          fullName: profile.full_name || user.email || 'Aluno',
          phone: profile.phone,
          cpf: profile.cpf,
          originalError: firstPaymentError,
        });

        const retryPaymentDTO = {
          ...paymentDTO,
          customerProviderId: newCustomerProviderId,
        };

        try {
          paymentResponse = await paymentProvider.createPayment(retryPaymentDTO);
          console.log(`[ASAAS CUSTOMER RECOVERY] Payment retry successful with new Customer ID:
- userId: ${secureStudentId}
- newProviderCustomerId: ${newCustomerProviderId}
- providerPaymentId: ${paymentResponse.providerPaymentId}
- retryResult: SUCCESS`);
        } catch (retryError: any) {
          console.error(`[ASAAS CUSTOMER RECOVERY] Payment retry failed:
- userId: ${secureStudentId}
- newProviderCustomerId: ${newCustomerProviderId}
- retryResult: FAILED
- error: ${retryError.message}`);
          throw retryError;
        }
      }

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
        let providerPaymentIdMap: Map<number, string> | undefined = undefined;
        const installmentId = paymentResponse.providerInstallmentId;

        if (installmentCount && installmentCount > 1 && installmentId && typeof paymentProvider.getInstallmentPayments === 'function') {
          const installmentItems = await paymentProvider.getInstallmentPayments(installmentId, installmentCount);
          providerPaymentIdMap = new Map<number, string>();
          for (const item of installmentItems) {
            providerPaymentIdMap.set(item.installmentNumber, item.id);
          }
          console.log(`✅ [CREATE_BOOKING_INTENT] Obtained ${providerPaymentIdMap.size} individual payment IDs for installment collection '${installmentId}'`);
        }

        const firstAptId = appointments && appointments.length > 0 ? appointments[0].id : null;
        await InstallmentService.recordInitialSchedule(supabase, {
          providerPaymentId: paymentResponse.providerPaymentId,
          providerPaymentIdMap: providerPaymentIdMap,
          totalInstallments: installmentCount || 1,
          grossAmountCents: totalPriceWithFee,
          netAmountCents: finalPrice - applicationFeeAmount,
          platformFeeCents: applicationFeeAmount + processingFee,
          feeAmountCents: processingFee,
          groupId: groupId,
          appointmentId: firstAptId,
          studentId: secureStudentId,
          instructorId: instructorId,
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
