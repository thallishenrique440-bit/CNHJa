
import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16' as any,
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

async function upsertTransaction(paymentIntent: Stripe.PaymentIntent, status: string) {
  const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;
  if (!groupId) return;

  const { error } = await supabaseAdmin
    .from('transactions')
    .upsert({
      payment_intent_id: paymentIntent.id,
      group_id: groupId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: status,
      metadata: paymentIntent.metadata,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'payment_intent_id' });

  if (error) console.error('Error upserting transaction:', error);
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const testBypass = req.headers['x-test-bypass'];

  let event: Stripe.Event;

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const buf = Buffer.concat(chunks);

    if (testBypass && testBypass === STRIPE_WEBHOOK_SECRET) {
      console.log('🧪 TEST BYPASS ENABLED: Skipping signature verification.');
      event = JSON.parse(buf.toString());
    } else {
      if (!sig) throw new Error('Missing stripe-signature header');
      event = stripe.webhooks.constructEvent(buf, sig, STRIPE_WEBHOOK_SECRET);
    }

    console.log(`🔔 Webhook received: ${event.type}`);

    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id;

        console.log(`[Webhook Debug] amount_capturable_updated: PI=${paymentIntent.id}, GroupID=${groupId}`);

        if (groupId) {
          console.log(`🔒 Amount Capturable Updated (Auth) for Group ID: ${groupId}`);

          const { data: updatedData, error } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'pending_approval',
              payment_status: 'authorized',
              payment_intent_id: paymentIntent.id,
              expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            })
            .eq('group_id', groupId)
            .in('status', ['reserved'])
            .select('id, status, payment_status');

          const rowsCount = updatedData?.length || 0;
          console.log(`[Webhook Success] amount_capturable_updated: Updated ${rowsCount} rows for Group ${groupId}`);
          
          if (rowsCount > 0) {
            console.log(`[State Transition] Group ${groupId}: reserved -> pending_approval (authorized)`);
            
            // Notify Instructor about the new booking request (Idempotent)
            if (paymentIntent.metadata?.instructor_id) {
              await supabaseAdmin.from('notifications').upsert({
                user_id: paymentIntent.metadata.instructor_id,
                title: 'Nova Solicitação de Aula',
                message: 'Você tem uma nova solicitação de aula aguardando aprovação.',
                type: 'booking_request',
                metadata: { group_id: groupId, payment_intent_id: paymentIntent.id },
                idempotency_key: `booking_request:${groupId}`
              }, { onConflict: 'idempotency_key' });
            }
          }
          
          if (error) console.error(`[Webhook Debug] Update error:`, error);
          if (error) throw error;

          // Record transaction as pending
          await upsertTransaction(paymentIntent, 'pending');

          if (testBypass) {
            return res.status(200).json({ 
              received: true, 
              debug: { 
                event: 'amount_capturable_updated', 
                groupId, 
                updatedRows: updatedData?.length || 0 
              } 
            });
          }
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;

        console.log(`[Webhook Debug] succeeded: PI=${paymentIntent.id}, GroupID=${groupId}`);

        if (groupId) {
          console.log(`✅ Payment Captured for Group ID: ${groupId}`);

          const { data: updatedData, error } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'confirmed',
              payment_status: 'paid',
            })
            .eq('group_id', groupId)
            .in('status', ['pending_approval', 'reserved', 'cancelled', 'expired', 'failed', 'pending'])
            .select('id, status, payment_status');

          const rowsCount = updatedData?.length || 0;
          console.log(`[Webhook Success] succeeded: Updated ${rowsCount} rows for Group ${groupId}`);
          
          if (rowsCount > 0) {
            console.log(`[State Transition] Group ${groupId}: -> confirmed (paid)`);
            
            // Notify Student about the confirmation (Idempotent)
            if (paymentIntent.metadata?.student_id) {
              await supabaseAdmin.from('notifications').upsert({
                user_id: paymentIntent.metadata.student_id,
                title: 'Aula Confirmada!',
                message: 'Seu pagamento foi confirmado e sua aula está agendada.',
                type: 'booking_accepted',
                metadata: { group_id: groupId, payment_intent_id: paymentIntent.id },
                idempotency_key: `booking_accepted:${groupId}`
              }, { onConflict: 'idempotency_key' });
            }
          }
          
          if (error) console.error(`[Webhook Debug] Update error:`, error);
          if (error) throw error;

          // Record transaction as completed
          await upsertTransaction(paymentIntent, 'completed');

          if (testBypass) {
            return res.status(200).json({ 
              received: true, 
              debug: { 
                event: 'succeeded', 
                groupId, 
                updatedRows: updatedData?.length || 0 
              } 
            });
          }
        }
        break;
      }

      case 'payment_intent.canceled': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;

        if (groupId) {
          console.log(`❌ Payment Canceled for Group ID: ${groupId}`);

          console.log(`[Webhook Debug] Attempting update for PaymentIntentID: ${paymentIntent.id} with status: cancelled and cancelled_by: student`);
          const { data: updatedData, error } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'cancelled',
              payment_status: 'pending',
              cancelled_by: 'student',
              cancelled_reason: 'Payment canceled by user',
            })
            .eq('payment_intent_id', paymentIntent.id)
            .not('status', 'in', '("confirmed", "completed", "in_progress", "scheduled")')
            .select();

          const rowsCount = updatedData?.length || 0;
          console.log(`[Webhook Debug] Update result:`, { updatedRows: rowsCount, error });

          if (error) {
            console.error(`[Webhook Debug] Update error:`, JSON.stringify(error, null, 2));
            return res.status(400).json({ error: error.message, supabaseError: error });
          }

          if (rowsCount > 0) {
            // Notify Student about the cancellation based on reason
            if (paymentIntent.metadata?.student_id) {
              const reason = paymentIntent.metadata?.cancellation_reason || 'payment_canceled';
              let title = 'Pagamento Cancelado';
              let message = 'Sua tentativa de pagamento foi cancelada e os horários foram liberados.';
              let type = 'booking_cancelled';

              if (reason === 'instructor_rejected') {
                title = 'Aula Recusada';
                message = 'O instrutor não pôde aceitar sua solicitação. O valor reservado no seu cartão foi liberado.';
                type = 'booking_rejected';
              } else if (reason === 'auto_expired_start_time' || reason === 'auth_expired') {
                title = 'Aula Expirada';
                message = 'O tempo para aprovação da aula expirou e o valor foi liberado.';
                type = 'booking_expired';
              }

              await supabaseAdmin.from('notifications').upsert({
                user_id: paymentIntent.metadata.student_id,
                title,
                message,
                type,
                metadata: { group_id: groupId, payment_intent_id: paymentIntent.id, reason },
                idempotency_key: `${type}:${groupId}`
              }, { onConflict: 'idempotency_key' });
            }
          }
          
          await upsertTransaction(paymentIntent, 'failed');
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error(`❌ Webhook Error: ${err.message}`);
    res.status(400).json({ error: err.message, stack: err.stack });
  }
}
