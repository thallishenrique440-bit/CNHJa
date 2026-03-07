import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    console.log('⏰ Starting complete-lessons job...');

    // 1. Find confirmed bookings
    // Optimization: Filter by date <= today to reduce data volume
    const today = new Date().toISOString().split('T')[0];
    
    const { data: confirmedBookings, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, date, start_time, student_id, instructor_id, price, group_id')
      .eq('status', 'confirmed')
      .lte('date', today);

    if (fetchError) {
      console.error("❌ Error fetching confirmed bookings:", fetchError);
      throw fetchError;
    }

    const now = new Date();
    const bookingsToComplete = [];
    const transactionPayloads = [];
    const appointmentIds: string[] = [];

    for (const booking of confirmedBookings || []) {
      const [year, month, day] = booking.date.split('-').map(Number);
      const [hour, minute] = booking.start_time.split(':').map(Number);
      
      // Lesson end time = start time + 50 minutes
      const lessonEnd = new Date(year, month - 1, day, hour, minute + 50);

      // Add a small buffer (e.g., 5 minutes) to ensure lesson is definitely over
      // lessonEnd.setMinutes(lessonEnd.getMinutes() + 5);

      if (now > lessonEnd) {
        bookingsToComplete.push(booking);
        appointmentIds.push(booking.id);
        
        transactionPayloads.push({
            appointment_id: booking.id,
            student_id: booking.student_id,
            instructor_id: booking.instructor_id,
            type: 'lesson_payment',
            amount: booking.price,
            status: 'completed',
            created_at: new Date().toISOString()
        });
      }
    }

    console.log(`Found ${bookingsToComplete.length} lessons to complete.`);

    if (bookingsToComplete.length === 0) {
      return res.status(200).json({ message: 'No lessons to complete.' });
    }

    // 2. Update Appointments -> completed
    const { error: updateError } = await supabaseAdmin
      .from('appointments')
      .update({ status: 'completed' })
      .in('id', appointmentIds);

    if (updateError) {
        console.error("❌ Error updating appointments:", updateError);
        throw updateError;
    }

    // 3. Create Transactions
    // Use ignoreDuplicates: true to handle race conditions or re-runs gracefully
    // This relies on the UNIQUE constraint (appointment_id, type)
    const { error: transError } = await supabaseAdmin
      .from('transactions')
      .insert(transactionPayloads)
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
        processed: bookingsToComplete.length 
    });

  } catch (error: any) {
    console.error("🚨 Critical Job Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
