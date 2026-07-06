import { createClient } from '@supabase/supabase-js';
import { PaymentProviderResolver } from '../lib/payments/PaymentProviderResolver.js';
import { PaymentProviderFactory } from '../lib/payments/PaymentProviderFactory.js';

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

    console.log(`[ConfirmBooking] Received request for appointment_id: ${appointment_id}`);

    if (!appointment_id) {
      console.error('[ConfirmBooking] Missing appointment_id in body:', body);
      return res.status(400).json({ error: 'Missing appointment_id' });
    }

    // 2. Fetch Appointment details
    const { data: appointment, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, group_id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name')
      .eq('id', appointment_id)
      .single();

    if (fetchError || !appointment) {
      console.error(`[ConfirmBooking] Appointment not found: ${appointment_id}`, fetchError);
      return res.status(404).json({ error: 'Appointment not found' });
    }

    console.log(`[ConfirmBooking] Found appointment: ${appointment.id}, Status: ${appointment.status}, Group: ${appointment.group_id}`);

    if (!appointment.group_id) {
      console.error(`Critical: Appointment ${appointment_id} has no group_id`);
      return res.status(500).json({ error: 'Data integrity error: Missing booking group' });
    }

    if (appointment.instructor_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Not your appointment' });
    }

    // Idempotency check
    if (appointment.status === 'confirmed') {
      return res.status(200).json({ message: 'Booking already confirmed' });
    }

    if (appointment.status !== 'pending_approval') {
      console.error(`[ConfirmBooking] Invalid status transition from ${appointment.status}`);
      return res.status(400).json({ error: `Invalid status: ${appointment.status}` });
    }

    const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

    if (!paymentId) {
      return res.status(500).json({ error: 'Missing payment transaction reference' });
    }

    // Resolve the payment provider via the orchestration layer
    const providerName = PaymentProviderResolver.resolveProviderForAppointment(appointment.id);
    const paymentProvider = PaymentProviderFactory.getProvider(providerName);

    // 3. Capture/Verify Payment (via resolved provider)
    try {
      await paymentProvider.getPayment(paymentId);
    } catch (captureError: any) {
      console.error('Payment Verification Error:', captureError);
      throw captureError;
    }

    // 4. Update DB (Group) with Dual Writing
    const { error: updateError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'confirmed',
        payment_status: 'paid',
        provider_name: providerName,
        updated_by: user.id,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', appointment.group_id)
      .in('status', ['pending_approval', 'confirmed']); // Defensive: Only update if still pending or already confirmed by webhook

    if (updateError) {
      throw updateError;
    }

    return res.status(200).json({ message: 'Booking confirmed successfully' });

  } catch (error: any) {
    console.error('Error confirming booking:', error);
    return res.status(500).json({ error: error.message });
  }
}
