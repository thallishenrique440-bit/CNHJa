import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: any, res: any) {
  // 1. Validate Method (GET for Cron, POST for manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Validate Authorization (CRON_SECRET)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('⏰ Starting complete-lessons job...');

    // 1. Find confirmed bookings
    // Optimization: Filter by date <= today AND end_time <= now to reduce data volume
    const now = new Date();
    
    // Adjust for Brazil Time (UTC-3) since DB stores local time
    const options = { timeZone: 'America/Sao_Paulo' };
    
    // Get Date: YYYY-MM-DD (en-CA gives YYYY-MM-DD)
    const dateStr = new Intl.DateTimeFormat('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    
    // Get Time: HH:MM:SS (en-GB gives HH:MM:SS)
    const timeStr = new Intl.DateTimeFormat('en-GB', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);

    console.log(`Checking for lessons before ${dateStr} ${timeStr} (BRT)`);

    // Query: status=confirmed AND (date < today OR (date = today AND end_time <= now))
    // This ensures we only fetch lessons that have actually finished
    const { data: confirmedBookings, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, date, start_time, end_time, student_id, instructor_id, price, group_id')
      .eq('status', 'confirmed')
      .or(`date.lt.${dateStr},and(date.eq.${dateStr},end_time.lte.${timeStr})`);

    if (fetchError) {
      console.error("❌ Error fetching confirmed bookings:", fetchError);
      throw fetchError;
    }

    const bookingsToComplete = [];
    const transactionPayloads = [];
    const appointmentIds: string[] = [];

    // Process the filtered list
    for (const booking of confirmedBookings || []) {
        bookingsToComplete.push(booking);
        appointmentIds.push(booking.id);
        
        const gross = booking.price;
        const fee = Math.floor(gross * 0.1); // 10% platform fee
        const net = gross - fee;

        transactionPayloads.push({
            appointment_id: booking.id,
            student_id: booking.student_id,
            instructor_id: booking.instructor_id,
            type: 'lesson_payment',
            amount: gross, // legacy/display
            gross_amount: gross,
            platform_fee: fee,
            net_amount: net,
            status: 'completed',
            created_at: new Date().toISOString(),
            event_date: `${booking.date}T${booking.start_time}:00-03:00`
        });
    }

    console.log(`Found ${bookingsToComplete.length} lessons to complete.`);

    if (bookingsToComplete.length === 0) {
      return res.status(200).json({ message: 'No lessons to complete.' });
    }

    // 2. Update Appointments -> completed
    // ATOMICITY CHECK: Only update if status is still 'confirmed'
    // This prevents race conditions if two jobs run simultaneously
    const { data: updatedAppointments, error: updateError } = await supabaseAdmin
      .from('appointments')
      .update({ status: 'completed' })
      .in('id', appointmentIds)
      .eq('status', 'confirmed') // Critical: Ensure it wasn't already processed
      .select('id');

    if (updateError) {
        console.error("❌ Error updating appointments:", updateError);
        throw updateError;
    }

    const updatedIds = new Set(updatedAppointments?.map(a => a.id));
    const actualProcessedCount = updatedIds.size;

    console.log(`Successfully updated ${actualProcessedCount} lessons.`);

    if (actualProcessedCount === 0) {
        return res.status(200).json({ message: 'No lessons updated (possibly processed by another job).' });
    }

    // Filter transactions to only include those that were actually updated
    const validTransactions = transactionPayloads.filter(t => updatedIds.has(t.appointment_id));

    // 3. Create Transactions
    // Use ignoreDuplicates: true to handle race conditions or re-runs gracefully
    // This relies on the UNIQUE constraint (appointment_id, type)
    const { error: transError } = await supabaseAdmin
      .from('transactions')
      .insert(validTransactions)
      .select() // Needed for ignoreDuplicates to work in some versions, but good practice
      // @ts-ignore - Supabase types might not be fully up to date in this env
      .options({ ignoreDuplicates: true }); 

    if (transError) {
        console.error("❌ Error creating transactions:", transError);
        // Even if transaction creation fails (e.g. duplicate), we already updated status to completed.
        // This is acceptable as the constraint prevents double payment.
        // If it was a real error, we log it.
        return res.status(500).json({ error: 'Failed to create transactions', details: transError });
    }

    return res.status(200).json({ 
        message: 'Job completed', 
        processed: actualProcessedCount 
    });

  } catch (error: any) {
    console.error("🚨 Critical Job Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
