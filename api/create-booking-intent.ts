import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import Stripe from 'stripe';
import { calculateDiscount, getInstructorDiscounts } from '../lib/discount-utils.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover' as any, // Use a stable version or the one from package.json if specified
});

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

  const { lessons, studentId, instructorId, category, ignoreTooClose } = req.body;

  if (!lessons || !lessons.length) {
    return res.status(400).json({ error: 'No lessons provided' });
  }

  if (!category || !['A', 'B', 'AB'].includes(category)) {
    return res.status(400).json({ error: 'Invalid or missing category' });
  }

  // NEW: Validation for limits
  if (lessons.length > 20) {
    return res.status(400).json({ error: 'Limite máximo de 20 aulas por agendamento excedido.' });
  }

  // NEW: Validation for daily limits
  const lessonsByDate: Record<string, number> = {};
  for (const lesson of lessons) {
    const date = lesson.date;
    lessonsByDate[date] = (lessonsByDate[date] || 0) + 1;
    if (lessonsByDate[date] > 3) {
      return res.status(400).json({ error: `Limite diário de 3 aulas excedido para a data ${date}.` });
    }
  }

  try {
    // 1. Fetch instructor details (Stripe Account ID)
    const { data: instructor, error: instructorError } = await supabase
      .from('instructors')
      .select('stripe_account_id, work_saturday_afternoon')
      .eq('id', instructorId)
      .single();

    if (instructorError || !instructor?.stripe_account_id) {
      return res.status(400).json({ error: 'Instructor not ready for payments' });
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

      // NEW: Sunday Check
      if (dayOfWeek === 0) {
         return res.status(400).json({ error: 'Não é possível agendar aulas aos domingos.' });
      }

      // NEW: Saturday Check
      if (dayOfWeek === 6) {
          const [h, m] = lesson.startTime.split(':').map(Number);
          const minutes = h * 60 + m;
          
          // If instructor works saturday afternoon, allow until 17:10 (1030 mins)
          // Else allow until 11:10 (670 mins)
          const limit = instructor.work_saturday_afternoon ? (17 * 60 + 10) : (11 * 60 + 10);
          
          if (minutes > limit) {
             return res.status(400).json({ 
                 error: instructor.work_saturday_afternoon 
                    ? 'Aos sábados, o horário limite é 17:10.' 
                    : 'Aos sábados, o horário limite é 11:10.' 
             });
          }
      }
      
      // NEW: Past date check (Date only)
      const lessonDateString = lesson.date;
      if (lessonDateString < todayString) {
         return res.status(400).json({ error: 'Não é possível agendar aulas no passado.' });
      }

      // NEW: Specific Time Check (Date + Time)
      // Prevent booking if the lesson time has already passed or is within 2 minutes
      // Assume lesson time is in America/Sao_Paulo (UTC-3)
      const lessonDateTime = new Date(`${lesson.date}T${lesson.startTime}:00-03:00`);
      
      const diffMs = lessonDateTime.getTime() - now.getTime();
      const diffMinutes = diffMs / (1000 * 60);

      if (diffMinutes <= 2) {
        return res.status(400).json({ 
          error: 'Um ou mais horários selecionados já passaram.' 
        });
      } else if (diffMinutes <= 10 && !ignoreTooClose) {
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
    
    const { finalPrice, discountAmount, appliedDiscountPercentage } = calculateDiscount(
      lessons.length,
      totalBasePrice,
      discounts
    );

    // 3. Create group_id
    const groupId = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

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
        if (conflict.student_id === studentId && (conflict.status === 'awaiting_payment' || conflict.status === 'reserved')) {
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
              status: 'failed',
              payment_status: 'failed',
              cancelled_reason: 'user_retry_new_attempt'
          })
          .eq('instructor_id', instructorId)
          .eq('student_id', studentId)
          .eq('date', lesson.date)
          .eq('start_time', lesson.startTime)
          .in('status', ['reserved', 'pending', 'awaiting_payment']);
    }

    // 4. Create appointments in DB (awaiting_payment)
    const appointmentsToInsert = lessons.map((lesson: any) => {
      // Check if it's last minute (within 10 mins)
      const lessonDateTime = new Date(`${lesson.date}T${lesson.startTime}:00-03:00`);
      const startTimeUtc = lessonDateTime.toISOString();
      const diffMs = lessonDateTime.getTime() - now.getTime();
      const diffMinutes = diffMs / (1000 * 60);
      const isLastMinute = diffMinutes <= 10;

      console.log(`[DEBUG] Creating appointment: Date=${lesson.date}, Time=${lesson.startTime}, UTC=${startTimeUtc}, isLastMinute=${isLastMinute}`);

      return {
        instructor_id: instructorId,
        student_id: studentId,
        date: lesson.date,
        start_time: lesson.startTime,
        start_time_utc: startTimeUtc,
        end_time: lesson.endTime,
        category: category, // Store the category
        status: 'awaiting_payment',
        price: Math.round(finalPrice / lessons.length), // Distribute discounted price
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

    // 5. Create Stripe PaymentIntent with Rollback
    const applicationFeeAmount = Math.round(finalPrice * 0.10); // 10% commission
    let paymentIntent;

    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: finalPrice,
        currency: 'brl',
        capture_method: 'manual', // Capture only when instructor accepts
        automatic_payment_methods: { enabled: true },
        transfer_data: {
          destination: instructor.stripe_account_id,
        },
        application_fee_amount: applicationFeeAmount,
        metadata: {
          type: 'lesson_payment',
          group_id: groupId,
          student_id: studentId,
          instructor_id: instructorId,
          lesson_count: lessons.length,
        },
      });

      // 6. Update appointments with payment_intent_id
      await supabase
        .from('appointments')
        .update({ payment_intent_id: paymentIntent.id })
        .eq('group_id', groupId);

    } catch (stripeError: any) {
      console.error('Stripe Error, rolling back appointments:', stripeError);
      
      // ROLLBACK: Delete appointments if Stripe fails
      await supabase.from('appointments').delete().eq('group_id', groupId);
      
      return res.status(500).json({ 
        error: 'Erro ao processar pagamento. Tente novamente.',
        details: stripeError.message 
      });
    }

    // 7. Return clientSecret
    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      groupId,
      totalPrice: finalPrice,
      discountAmount,
    });

  } catch (error: any) {
    console.error('Error in create-booking-intent:', error);
    return res.status(500).json({ error: error.message });
  }
}
