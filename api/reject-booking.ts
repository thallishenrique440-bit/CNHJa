import { createClient } from '@supabase/supabase-js';
import { PaymentProviderResolver } from '../lib/payments/PaymentProviderResolver.js';
import { PaymentProviderFactory } from '../lib/payments/PaymentProviderFactory.js';
import { NotificationService } from '../lib/NotificationService.js';

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

    // 3. Cancel or Refund Payment (via Asaas)
    try {
      const asaasApiKey = process.env.ASAAS_API_KEY || '';
      const asaasApiUrl = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';

      if (!asaasApiKey) {
        console.error('❌ ASAAS_API_KEY is not defined. Cannot reject/refund Asaas payment.');
        throw new Error('CONFIG_ERROR: Missing ASAAS_API_KEY');
      }

      // Fetch payment status and check for installments directly from Asaas
      console.log(`[Asaas] NodeJS: Fetching payment details for ${paymentId}`);
      const paymentUrl = `${asaasApiUrl}/payments/${paymentId}`;
      const paymentRes = await fetch(paymentUrl, {
        method: 'GET',
        headers: {
          'access_token': asaasApiKey,
          'Content-Type': 'application/json'
        }
      });

      if (!paymentRes.ok) {
        const errText = await paymentRes.text();
        console.error(`❌ Failed to retrieve Asaas payment ${paymentId}: ${errText}`);
        throw new Error(`Asaas verification failed: ${errText}`);
      }

      const paymentData = await paymentRes.json();
      const installmentId = paymentData.installment;
      const isPaid = paymentData.status === 'RECEIVED' || paymentData.status === 'CONFIRMED';

      console.log(`[Asaas] NodeJS: Retrieved payment details. Status: ${paymentData.status}, Installment: ${installmentId || 'none'}, isPaid: ${isPaid}`);

      if (!installmentId) {
        // Flow for simple/no-installment payments
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
      } else {
        // Flow for installment payments
        if (isPaid) {
          console.log(`[Asaas Installment Refund] NodeJS: Refunding installment ${installmentId} (linked to payment ${paymentId}) for group ${appointment.group_id}`);
          const refundUrl = `${asaasApiUrl}/installments/${installmentId}/refund`;
          const refundRes = await fetch(refundUrl, {
            method: 'POST',
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (!refundRes.ok) {
            const errText = await refundRes.text();
            console.error(`❌ Asaas installment refund failed for installment ${installmentId}: ${errText}`);
            throw new Error(`Asaas installment refund failed: ${errText}`);
          }

          console.log(`✅ Asaas installment ${installmentId} refunded successfully.`);
        } else {
          console.log(`[Asaas Installment Cancel] NodeJS: Cancelling pending installment ${installmentId} (linked to payment ${paymentId}) for group ${appointment.group_id}`);
          const cancelUrl = `${asaasApiUrl}/installments/${installmentId}`;
          const cancelRes = await fetch(cancelUrl, {
            method: 'DELETE',
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (!cancelRes.ok) {
            const errText = await cancelRes.text();
            console.error(`❌ Asaas installment cancellation failed for installment ${installmentId}: ${errText}`);
            throw new Error(`Asaas installment cancel failed: ${errText}`);
          }

          console.log(`✅ Asaas installment ${installmentId} cancelled successfully.`);
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
          let comboCount = 1;
          if (appointment.group_id) {
            const { count } = await supabaseAdmin
              .from('appointments')
              .select('id', { count: 'exact', head: true })
              .eq('group_id', appointment.group_id);
            if (count) comboCount = count;
          }

          await NotificationService.sendBookingRejected({
            studentId: appointment.student_id,
            comboCount,
            groupId: appointment.group_id || appointment.id
          });
        } catch (notifErr) {
          console.error(`⚠️ Error creating notification:`, notifErr);
        }
      }

      return res.status(200).json({ message: 'Booking rejected and Asaas payment processed successfully.' });

    } catch (error: any) {
      console.error('Payment Reject/Cancel Error:', error);
      throw error;
    }

  } catch (error: any) {
    console.error('Error rejecting booking:', error);
    return res.status(500).json({ error: error.message });
  }
}
