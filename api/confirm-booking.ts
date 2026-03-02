import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Configuração do Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover' as any,
});

// Configuração do Supabase (Service Role para operações privilegiadas)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Configuração do Supabase (Anon Key para validação de token)
const supabaseAnon = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export default async function handler(req: any, res: any) {
  // Apenas POST permitido
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Autenticação (Validar Token JWT)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid user session' });
    }

    // 2. Ler dados da requisição
    const { appointment_id } = req.body;
    if (!appointment_id) {
      return res.status(400).json({ error: 'Missing appointment_id' });
    }

    // 3. Validar Propriedade e Status do Agendamento
    const { data: appointment, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, status, instructor_id, payment_intent_id, payment_status')
      .eq('id', appointment_id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Verificar se o usuário é o instrutor dono do agendamento
    if (appointment.instructor_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden: You are not the instructor for this appointment' });
    }

    // Idempotência: Se já aprovado, retornar sucesso
    if (appointment.status === 'confirmed' && appointment.payment_status === 'captured') {
      return res.status(200).json({ message: 'Appointment already approved', appointment });
    }

    // Validar transição de status
    if (appointment.status !== 'pending_approval') {
      return res.status(400).json({ error: `Invalid status change: Cannot approve appointment with status '${appointment.status}'` });
    }

    if (!appointment.payment_intent_id) {
      return res.status(500).json({ error: 'Critical: Appointment has no PaymentIntent ID' });
    }

    // 4. Capturar Pagamento no Stripe
    let capturedIntent;
    try {
      capturedIntent = await stripe.paymentIntents.capture(
        appointment.payment_intent_id,
        {
          idempotencyKey: `capture_${appointment.id}`,
        }
      );
    } catch (stripeError: any) {
      console.error('Stripe Capture Error:', stripeError);

      // Tratamento robusto de erros de estado
      if (stripeError.code === 'payment_intent_unexpected_state') {
        const retrievedIntent = await stripe.paymentIntents.retrieve(appointment.payment_intent_id);
        
        if (retrievedIntent.status === 'succeeded') {
          // Já capturado (race condition ou retry anterior). Prosseguir.
          capturedIntent = retrievedIntent;
          console.log('PaymentIntent was already succeeded. Proceeding.');
        } else if (retrievedIntent.status === 'canceled') {
           // Autorização expirada. Falhar com segurança.
           await supabaseAdmin.from('appointments').update({
             status: 'cancelled',
             payment_status: 'failed',
             cancelled_reason: 'auth_expired'
           }).eq('id', appointment.id);
           
           return res.status(409).json({ 
             error: 'Payment authorization expired. Appointment cancelled.',
             code: 'AUTH_EXPIRED'
           });
        } else {
          // Outros estados (ex: requires_payment_method)
          throw stripeError;
        }
      } else {
        throw stripeError;
      }
    }

    // 5. Persistir no Banco (Atualizar Status com Optimistic Locking)
    const { data: updatedAppointment, error: updateError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'confirmed',
        payment_status: 'captured',
        updated_at: new Date().toISOString()
      })
      .eq('id', appointment.id)
      .eq('status', 'pending_approval') // Optimistic Lock: Só atualiza se ainda estiver pendente
      .select()
      .single();

    if (updateError || !updatedAppointment) {
      // Falha na atualização. Verificar se foi race condition (webhook venceu)
      const { data: check } = await supabaseAdmin
        .from('appointments')
        .select('*')
        .eq('id', appointment.id)
        .single();
      
      if (check?.status === 'confirmed' && check?.payment_status === 'captured') {
        return res.status(200).json({ message: 'Booking approved successfully (synced)', appointment: check });
      }

      console.error('CRITICAL: Payment captured but DB update failed:', updateError);
      throw new Error('Database update failed after payment capture');
    }

    return res.status(200).json({ message: 'Booking approved successfully', appointment: updatedAppointment });

  } catch (error: any) {
    console.error('Error in confirm-booking:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
