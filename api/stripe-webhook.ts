import { buffer } from 'micro';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Configuração para desativar o body parser padrão do Next.js/Vercel
// Necessário para validar a assinatura do Stripe com o corpo bruto
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover' as any,
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

async function upsertTransaction(paymentIntent: Stripe.PaymentIntent, status: 'pending' | 'completed' | 'failed') {
  const metadata = paymentIntent.metadata || {};
  const type = metadata.type || 'lesson_payment';
  const grossAmount = paymentIntent.amount;
  const platformFee = paymentIntent.application_fee_amount || Math.round(grossAmount * 0.1);
  const netAmount = grossAmount - platformFee;

  const transactionData: any = {
    stripe_payment_intent_id: paymentIntent.id,
    type: type,
    student_id: metadata.student_id,
    instructor_id: metadata.instructor_id,
    gross_amount: grossAmount,
    platform_fee: platformFee,
    net_amount: netAmount,
    status: status,
    event_date: new Date().toISOString(),
    amount: grossAmount // legacy
  };

  // Only upsert if we have the necessary IDs
  if (transactionData.student_id && transactionData.instructor_id) {
    const { error } = await supabaseAdmin
      .from('transactions')
      .upsert(transactionData, {
        onConflict: 'stripe_payment_intent_id,type'
      });
    
    if (error) {
      console.error(`❌ Error upserting transaction [PI: ${paymentIntent.id}]:`, error.message);
    } else {
      console.log(`💰 Transaction ${status} recorded for PI: ${paymentIntent.id}`);
    }
  } else {
    console.warn(`⚠️ Missing metadata for transaction [PI: ${paymentIntent.id}]`, metadata);
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  let event: Stripe.Event;

  try {
    // 1. Ler o corpo bruto da requisição
    const buf = await buffer(req);
    const sig = req.headers['stripe-signature']!;

    // 2. Validar a assinatura do Stripe
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err: any) {
    console.error(`❌ Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Event received: ${event.type} [ID: ${event.id}]`);

  try {
    // 3. Processar eventos
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id;

        if (groupId) {
          console.log(`🔒 Amount Capturable Updated (Auth) for Group ID: ${groupId}`);

          // Atualizar status para pending_approval / authorized
          const { error } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'pending_approval',
              payment_status: 'authorized',
              payment_intent_id: paymentIntent.id,
              expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            })
            .eq('group_id', groupId);

          if (error) throw error;

          // 4. Record transaction as pending
          await upsertTransaction(paymentIntent, 'pending');
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;

        if (groupId) {
          console.log(`✅ Payment Captured for Group ID: ${groupId}`);

          const { error } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'confirmed',
              payment_status: 'captured',
            })
            .eq('group_id', groupId)
            .neq('status', 'completed')
            .neq('status', 'confirmed');

          if (error) throw error;

          // 4. Record transaction as completed
          await upsertTransaction(paymentIntent, 'completed');
        }
        break;
      }

      case 'payment_intent.canceled': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;

        if (groupId) {
          console.log(`🚫 Payment Canceled for Group ID: ${groupId}`);

          // Atualizar status para rejected / released se ainda estiver pendente
          const { data: appointment } = await supabaseAdmin
            .from('appointments')
            .select('status')
            .eq('group_id', groupId)
            .maybeSingle();

          if (appointment && appointment.status === 'pending_approval') {
            await supabaseAdmin
              .from('appointments')
              .update({
                status: 'rejected',
                payment_status: 'released',
              })
              .eq('group_id', groupId);
            
            // 4. Record transaction as failed/canceled
            await upsertTransaction(paymentIntent, 'failed');
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;

        if (groupId) {
          console.log(`❌ Payment Failed for Group ID: ${groupId}`);

          await supabaseAdmin
            .from('appointments')
            .update({
              status: 'failed',
              payment_status: 'failed',
              cancelled_reason: 'payment_failed'
            })
            .eq('group_id', groupId);
          
          // 4. Record transaction as failed
          await upsertTransaction(paymentIntent, 'failed');
        }
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`🚨 Webhook Logic Error:`, err);
    res.status(500).json({ error: err.message });
  }
}
