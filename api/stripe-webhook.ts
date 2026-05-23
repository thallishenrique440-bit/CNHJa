
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
        const metadata = paymentIntent.metadata || {};
        const groupId = metadata.group_id;

        console.log(`[Webhook Debug] amount_capturable_updated: PI=${paymentIntent.id}, GroupID=${groupId}`);

        if (groupId) {
          console.log(`🔒 Amount Capturable Updated (Auth) for Group ID: ${groupId}`);

          const updatePayload = {
            status: 'pending_approval' as const,
            payment_status: 'authorized' as const,
            payment_intent_id: paymentIntent.id,
            expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          };

          // [Validation] Ensure payment_status is explicitly 'authorized'
          if (updatePayload.payment_status !== 'authorized') {
            console.error(`[Webhook Critical] amount_capturable_updated: Invalid payment_status state for PI=${paymentIntent.id}. Expected 'authorized', got:`, updatePayload.payment_status);
            // Safe return to avoid Stripe retries on logic errors
            return res.json({ received: true, error: 'invalid_payment_status' });
          }

          console.log(`[Webhook Debug] amount_capturable_updated: Executing update for PI=${paymentIntent.id} (Group=${groupId}) with payload:`, JSON.stringify(updatePayload, null, 2));

          const { data: updatedData, error } = await supabaseAdmin
            .from('appointments')
            .update(updatePayload)
            .eq('group_id', groupId) // Using group_id is safer due to race condition
            .in('status', ['reserved', 'awaiting_payment'])
            .select('id, status, payment_status');

          const updatedRows = updatedData?.length || 0;
          console.log("[WEBHOOK DEBUG]", {
            groupId,
            updatedRows,
            eventType: event.type
          });
          
          if (updatedRows === 0 && !error) {
            console.warn(`[Webhook Warning] amount_capturable_updated: No rows matched for PI=${paymentIntent.id}. Possible reasons: status already updated, PI ID mismatch, or rows deleted.`);
            // Check if rows exist at all with this PI ID to debug mismatch
            const { data: currentRows } = await supabaseAdmin.from('appointments').select('id, status').eq('group_id', groupId);
            console.log(`[Webhook Debug] Current rows for group_id ${groupId}:`, JSON.stringify(currentRows));
          }
          
          if (updatedRows > 0) {
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
          
          if (error) {
            console.error(`[Webhook Debug] Update error:`, error);
            return res.json({ received: true, error: 'db_update_failed' });
          }
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
        const metadata = paymentIntent.metadata || {};
        const groupId = metadata.group_id || metadata.purchase_id;

        console.log(`[Webhook Debug] succeeded: PI=${paymentIntent.id}, GroupID=${groupId}`);

        if (groupId) {
          console.log(`✅ Payment Captured for Group ID: ${groupId}`);

          const updatePayload = {
            status: 'confirmed' as const,
            payment_status: 'paid' as const,
            updated_by: metadata.instructor_id,
            updated_at: new Date().toISOString()
          };

          // [Validation] Ensure payment_status is explicitly 'paid' and not null/undefined
          if (updatePayload.payment_status !== 'paid') {
            console.error(`[Webhook Critical] succeeded: Invalid payment_status state for PI=${paymentIntent.id}. Expected 'paid', got:`, updatePayload.payment_status);
            // Safe return to avoid Stripe retries on logic errors
            return res.json({ received: true, error: 'invalid_payment_status' });
          }

          console.log('[WEBHOOK]', {
            groupId,
            instructorId: metadata.instructor_id,
            studentId: metadata.student_id,
            oldStatus: 'pending_approval',
            newStatus: 'confirmed'
          });

          console.log(`[Webhook Debug] succeeded: Executing update for PI=${paymentIntent.id} (Group=${groupId}) with payload:`, JSON.stringify(updatePayload, null, 2));

          const { data: updatedData, error } = await supabaseAdmin
            .from('appointments')
            .update(updatePayload)
            .eq('group_id', groupId) // Using group_id is safer due to race condition
            .in('status', ['pending_approval', 'reserved', 'cancelled', 'expired', 'failed', 'pending', 'awaiting_payment'])
            .select('id, status, payment_status, student_id, date');

          const rowsCount = updatedData?.length || 0;
          console.log(`[Webhook Success] succeeded: Updated ${rowsCount} rows for PI=${paymentIntent.id}`);
          
          if (rowsCount === 0 && !error) {
            console.warn(`[Webhook Warning] succeeded: No rows matched for PI=${paymentIntent.id}. Possible reasons: status already 'confirmed', PI ID mismatch, or rows deleted.`);
            // Check if rows exist at all with this PI ID to debug mismatch
            const { count } = await supabaseAdmin.from('appointments').select('*', { count: 'exact', head: true }).eq('payment_intent_id', paymentIntent.id);
            console.log(`[Webhook Debug] Total rows with PI=${paymentIntent.id}: ${count || 0}`);
          }
          
          if (rowsCount > 0) {
            console.log(`[State Transition] Group ${groupId}: -> confirmed (paid)`);
            
            // Notify Student about the confirmation (Idempotent)
            const studentId = paymentIntent.metadata?.student_id || (updatedData && updatedData.length > 0 ? (updatedData[0] as any).student_id : null);
            if (studentId) {
              await supabaseAdmin.from('notifications').upsert({
                user_id: studentId,
                title: 'Aula Confirmada!',
                message: 'Seu pagamento foi confirmado e sua aula está agendada.',
                type: 'booking_accepted',
                metadata: { group_id: groupId, payment_intent_id: paymentIntent.id },
                idempotency_key: `booking_accepted:${groupId}`
              }, { onConflict: 'idempotency_key' });
            }
          }
          
          if (error) {
            console.error(`[Webhook Debug] Update error:`, error);
            return res.json({ received: true, error: 'db_update_failed' });
          }
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
        } else {
          console.warn(`⚠️ Payment Succeeded but no group_id or purchase_id found in metadata for PaymentIntentID: ${paymentIntent.id}`);
        }
        break;
      }

      case 'payment_intent.canceled': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const metadata = paymentIntent.metadata || {};
        const groupId = metadata.group_id || metadata.purchase_id;

        if (groupId) {
          console.log(`❌ Payment Canceled for Group ID: ${groupId}`);

          // Check current status to decide next state
          const { data: appointments } = await supabaseAdmin
             .from("appointments")
             .select("status")
             .eq("group_id", groupId);

          const appointment = appointments?.[0];

          if (appointment) {
            const updatePayload: any = {
              payment_status: 'released' as const,
              updated_by: metadata.instructor_id || metadata.student_id,
              updated_at: new Date().toISOString()
            };

            // Only change status to rejected if it's currently pending_approval or awaiting_payment
            if (appointment.status === 'pending_approval' || appointment.status === 'awaiting_payment') {
              updatePayload.status = 'rejected' as const;
            } else {
              updatePayload.status = 'cancelled' as const;
              updatePayload.cancelled_by = 'student' as const;
              updatePayload.cancelled_reason = 'Payment canceled by user';
            }

            // [Validation] Ensure payment_status is explicitly 'released' or 'pending'
            if (updatePayload.payment_status !== 'released') {
              console.error(`[Webhook Critical] canceled: Invalid payment_status state for PI=${paymentIntent.id}. Expected 'released', got:`, updatePayload.payment_status);
              // Safe return to avoid Stripe retries on logic errors
              return res.json({ received: true, error: 'invalid_payment_status' });
            }

            console.log('[WEBHOOK]', {
              groupId,
              instructorId: metadata.instructor_id,
              studentId: metadata.student_id,
              oldStatus: appointment.status,
              newStatus: updatePayload.status,
              payment_status: updatePayload.payment_status
            });

            console.log(`[Webhook Debug] canceled: Executing update for PI=${paymentIntent.id} (Group=${groupId}) with payload:`, JSON.stringify(updatePayload, null, 2));
            
            const { data: updatedData, error } = await supabaseAdmin
              .from('appointments')
              .update(updatePayload)
              .eq('group_id', groupId) // Using group_id is safer
              .not('status', 'in', '("confirmed", "completed", "in_progress", "scheduled")')
              .select();

            const rowsCount = updatedData?.length || 0;
            console.log(`[Webhook Debug] Update result:`, { updatedRows: rowsCount, error });

            if (rowsCount === 0 && !error) {
              console.warn(`[Webhook Warning] canceled: No rows matched for PI=${paymentIntent.id}. Possible reasons: status already 'cancelled', PI ID mismatch, or rows deleted.`);
              // Check if rows exist at all with this PI ID to debug mismatch
              const { count } = await supabaseAdmin.from('appointments').select('*', { count: 'exact', head: true }).eq('payment_intent_id', paymentIntent.id);
              console.log(`[Webhook Debug] Total rows with PI=${paymentIntent.id}: ${count || 0}`);
            }

            if (error) {
              console.error(`[Webhook Debug] Update error:`, JSON.stringify(error, null, 2));
              return res.json({ received: true, error: 'db_update_failed', details: error.message });
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
