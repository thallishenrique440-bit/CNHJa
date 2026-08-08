import { createClient } from '@supabase/supabase-js';
import { BookingCancellationCore } from '../lib/payments/BookingCancellationCore.js';

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
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Body Parsing
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }

    const { appointment_id } = body || {};

    if (!appointment_id) {
      return res.status(400).json({ error: 'Missing appointment_id' });
    }

    // 2. Ownership Verification
    const { data: appointment, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, instructor_id, group_id')
      .eq('id', appointment_id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (appointment.instructor_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Not your appointment' });
    }

    // 3. Delegate to BookingCancellationCore SSOT
    const result = await BookingCancellationCore.processCancellation({
      appointmentId: appointment_id,
      reason: 'instructor_rejected',
      initiatedBy: user.id,
      adminClient: supabaseAdmin
    });

    return res.status(200).json({
      message: result.message,
      status: result.status,
      payment_status: result.paymentStatus,
      count: result.processedCount
    });

  } catch (error: any) {
    console.error('Error rejecting booking:', error);
    return res.status(500).json({ error: error.message });
  }
}

