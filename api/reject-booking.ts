import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

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
      .select('id, group_id, status, instructor_id, payment_intent_id')
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
    if (appointment.status === 'rejected') {
      return res.status(200).json({ message: 'Booking already rejected' });
    }

    if (appointment.status !== 'pending_approval') {
      console.error(`[RejectBooking] Invalid status transition from ${appointment.status}`);
      return res.status(400).json({ error: `Invalid status: ${appointment.status}` });
    }

    if (!appointment.payment_intent_id) {
      return res.status(500).json({ error: 'Missing payment_intent_id' });
    }

    // 3. Cancel Payment (Stripe)
    try {
      await stripe.paymentIntents.cancel(appointment.payment_intent_id, {
        cancellation_reason: 'abandoned',
      });
    } catch (stripeError: any) {
      console.error('Stripe Cancel Error:', stripeError);

      // Handle already canceled
      if (stripeError.code === 'payment_intent_unexpected_state') {
        const pi = await stripe.paymentIntents.retrieve(appointment.payment_intent_id);
        
        if (pi.status === 'canceled') {
          // Already canceled, proceed to update DB
          console.log('PaymentIntent already canceled. Proceeding to DB update.');
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

    // 4. Update DB (Group)
    const { error: updateError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'rejected',
        payment_status: 'failed',
        cancelled_reason: 'instructor_rejected',
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
