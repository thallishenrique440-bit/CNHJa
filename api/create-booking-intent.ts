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
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { lessons, studentId, instructorId, category } = req.body;

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
      .select('stripe_account_id')
      .eq('id', instructorId)
      .single();

    if (instructorError || !instructor?.stripe_account_id) {
      return res.status(400).json({ error: 'Instructor not ready for payments' });
    }

    // 2. Validate dates (max 7 days in advance)
    const MAX_DAYS_IN_ADVANCE = 7;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + MAX_DAYS_IN_ADVANCE);

    for (const lesson of lessons) {
      const lessonDate = new Date(lesson.date + 'T00:00:00');
      
      // NEW: Past date check
      if (lessonDate < today) {
         return res.status(400).json({ error: 'Não é possível agendar aulas no passado.' });
      }

      if (lessonDate > maxDate) {
        return res.status(400).json({ 
          error: `Agendamentos permitidos apenas para os próximos ${MAX_DAYS_IN_ADVANCE} dias due a regras de pagamento.` 
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

    // 4. Create appointments in DB (awaiting_payment)
    const appointmentsToInsert = lessons.map((lesson: any) => ({
      instructor_id: instructorId,
      student_id: studentId,
      date: lesson.date,
      start_time: lesson.startTime,
      end_time: lesson.endTime,
      category: category, // Store the category
      status: 'awaiting_payment',
      price: Math.round(finalPrice / lessons.length), // Distribute discounted price
      group_id: groupId,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    }));

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
