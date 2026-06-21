import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { PaymentProviderResolver } from '../lib/payments/PaymentProviderResolver.js';
import { PaymentProviderFactory } from '../lib/payments/PaymentProviderFactory.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia' as any,
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const supabaseAnon = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Auth
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
    console.log('[DEBUG] SUPABASE_ANON_KEY present:', !!process.env.SUPABASE_ANON_KEY);

    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);

    if (authError || !user) {
      console.error('[DEBUG] Auth Error:', authError?.message || 'No user found');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Robust Body Parsing
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.error('Failed to parse request body:', e);
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }

    const { appointment_id } = body || {};
    
    console.log(`[RejectBooking] Received request for appointment_id: ${appointment_id}`);

    if (!appointment_id) {
      console.error('[RejectBooking] Missing appointment_id in body:', body);
      return res.status(400).json({ error: 'Missing appointment_id' });
    }

    // 2. Fetch Appointment details
    const { data: appointment, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, group_id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, student_id')
      .eq('id', appointment_id)
      .single();

    if (fetchError || !appointment) {
      console.error(`[RejectBooking] Appointment not found: ${appointment_id}`, fetchError);
      return res.status(404).json({ error: 'Appointment not found' });
    }

    console.log(`[RejectBooking] Found appointment: ${appointment.id}, Status: ${appointment.status}, Group: ${appointment.group_id}`);

    if (!appointment.group_id) {
      console.error(`Critical: Appointment ${appointment_id} has no group_id`);
      return res.status(500).json({ error: 'Data integrity error: Missing booking group' });
    }

    if (appointment.instructor_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Not your appointment' });
    }

    // Idempotency check
    if (appointment.status === 'cancelled') {
      return res.status(200).json({ message: 'Booking already rejected/cancelled' });
    }

    if (appointment.status !== 'pending_approval') {
      console.error(`[RejectBooking] Invalid status transition from ${appointment.status}`);
      return res.status(400).json({ error: `Invalid status: ${appointment.status}` });
    }

    const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

    if (!paymentId) {
      return res.status(500).json({ error: 'Missing payment transaction reference' });
    }

    // Resolve the payment provider via the orchestration layer
    const providerName = PaymentProviderResolver.resolveProviderForAppointment(appointment.id);
    const paymentProvider = PaymentProviderFactory.getProvider(providerName);

    // 3. Cancel Payment (via resolved provider)
    try {
      if (providerName === 'stripe') {
        await (paymentProvider as any).stripe.paymentIntents.cancel(paymentId, {
          cancellation_reason: 'abandoned',
        });
      } else if (providerName === 'asaas') {
        const asaasApiKey = process.env.ASAAS_API_KEY || '';
        const asaasApiUrl = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';

        if (!asaasApiKey) {
          console.error('❌ ASAAS_API_KEY is not defined. Cannot reject/refund Asaas payment.');
          throw new Error('CONFIG_ERROR: Missing ASAAS_API_KEY');
        }

        const isPaid = appointment.payment_status === 'paid';

        if (isPaid) {
          console.log(`[Asaas Refund] NodeJS: Refunding payment ${paymentId} for group ${appointment.group_id}`);
          const refundUrl = `${asaasApiUrl}/payments/${paymentId}/refund`;
          const refundRes = await fetch(refundUrl, {
            method: 'POST',
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              description: 'instructor_rejected'
            })
          });

          if (!refundRes.ok) {
            const errText = await refundRes.text();
            console.error(`❌ Asaas refund failed for payment ${paymentId}: ${errText}`);
            throw new Error(`Asaas refund failed: ${errText}`);
          }

          console.log(`✅ Asaas payment ${paymentId} refunded successfully.`);
        } else {
          console.log(`[Asaas Cancel] NodeJS: Cancelling pending payment ${paymentId} for group ${appointment.group_id}`);
          const cancelUrl = `${asaasApiUrl}/payments/${paymentId}`;
          const cancelRes = await fetch(cancelUrl, {
            method: 'DELETE',
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (!cancelRes.ok) {
            const errText = await cancelRes.text();
            console.warn(`⚠️ Asaas pending payment cancel failed: ${errText}`);
          } else {
            console.log(`✅ Asaas pending payment ${paymentId} cancelled successfully.`);
          }
        }

        // Direct DB update for Asaas
        const { error: updateError } = await supabaseAdmin
          .from('appointments')
          .update({
            status: 'cancelled',
            payment_status: isPaid ? 'refunded' : 'released',
            cancelled_reason: 'instructor_rejected',
            provider_name: providerName,
            updated_by: user.id,
            updated_at: new Date().toISOString()
          })
          .eq('group_id', appointment.group_id);

        if (updateError) {
          throw updateError;
        }

        // Create student notification
        if (appointment.student_id) {
          try {
            await supabaseAdmin.from('notifications').upsert({
              user_id: appointment.student_id,
              title: 'Aula cancelada',
              message: 'Seu agendamento foi cancelado pelo instrutor e o valor correspondente foi reembolsado automaticamente.',
              type: 'booking_rejected',
              metadata: { group_id: appointment.group_id, payment_intent_id: paymentId },
              idempotency_key: `booking_rejected:asaas:${appointment.group_id}`
            }, { onConflict: 'idempotency_key' });
          } catch (notifErr) {
            console.error(`⚠️ Error creating notification:`, notifErr);
          }
        }

        return res.status(200).json({ message: 'Booking rejected and Asaas payment refunded/cancelled successfully.' });
      } else {
        // Safe placeholder for alternative providers
        await paymentProvider.refundPayment({
          providerPaymentId: paymentId,
          reason: 'instructor_rejected',
        });
      }
    } catch (stripeError: any) {
      console.error('Payment Cancel Error:', stripeError);

      // Handle already canceled for Stripe
      if (stripeError.code === 'payment_intent_unexpected_state') {
        const pi = providerName === 'stripe'
          ? await (paymentProvider as any).stripe.paymentIntents.retrieve(paymentId)
          : await paymentProvider.getPayment(paymentId).then((r: any) => ({ status: r.status }));
        
        if (pi.status === 'canceled') {
          // Already canceled, proceed to update DB
          console.log('Payment already canceled. Proceeding to DB update.');
        } else if (pi.status === 'succeeded') {
          // Cannot cancel captured payment
          return res.status(409).json({ 
            error: 'Payment already captured. Cannot reject.',
            code: 'ALREADY_CAPTURED'
          });
        } else {
          throw stripeError;
        }
      } else {
        throw stripeError;
      }
    }

    // 4. Update DB (Group) with Dual Writing (for other/stripe providers)
    const { error: updateError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        cancelled_reason: 'instructor_rejected',
        provider_name: providerName,
        updated_by: user.id,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', appointment.group_id);

    if (updateError) {
      throw updateError;
    }

    return res.status(200).json({ message: 'Booking rejected successfully' });

  } catch (error: any) {
    console.error('Error rejecting booking:', error);
    return res.status(500).json({ error: error.message });
  }
}
