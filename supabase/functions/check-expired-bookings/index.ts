import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { asaasFetch } from '../_shared/asaasClient.ts'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  try {
    console.log("⏰ Starting check-expired-bookings cron job...")

    const now = new Date().toISOString()
    
    // Clean up abandoned checkouts
    console.log("🧹 Cleaning up abandoned checkouts...")
    
    // Clean up awaiting_payment (soft delete/cancel)
    const { data: abandonedBookings, error: deleteError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        cancelled_reason: 'system_cleanup_expired',
        updated_at: new Date().toISOString()
      })
      .eq('status', 'awaiting_payment')
      .lt('expires_at', now)
      .select('id')

    if (deleteError) {
      console.error("❌ Error cleaning up abandoned bookings:", deleteError)
    } else if (abandonedBookings && abandonedBookings.length > 0) {
      console.log(`✅ Cleaned up ${abandonedBookings.length} abandoned checkouts (awaiting_payment).`)
    }

    // Clean up reserved (soft delete to cancelled/failed)
    const { data: reservedBookings, error: reservedError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        cancelled_reason: 'system_cleanup_expired',
        updated_at: new Date().toISOString()
      })
      .eq('status', 'reserved')
      .lt('expires_at', now)
      .select('id')

    if (reservedError) {
      console.error("❌ Error cleaning up reserved bookings:", reservedError)
    } else if (reservedBookings && reservedBookings.length > 0) {
      console.log(`✅ Cleaned up ${reservedBookings.length} abandoned checkouts (reserved).`)
    }

    const { data: expiredBookings, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, provider_payment_id, status, group_id, provider_name, student_id, instructor_id')
      .in('status', ['pending', 'pending_approval', 'awaiting_payment'])
      .lt('expires_at', now)

    if (fetchError) {
      console.error("❌ Error fetching expired bookings:", fetchError)
      throw fetchError
    }

    console.log(`Found ${expiredBookings?.length || 0} expired bookings to process.`)

    if (!expiredBookings || expiredBookings.length === 0) {
      return new Response(JSON.stringify({ 
        message: 'No expired bookings found.',
        abandoned_cleaned: abandonedBookings?.length || 0
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Process each booking
    const results = await Promise.allSettled(expiredBookings.map(async (booking) => {
      const { id, payment_intent_id, provider_payment_id, group_id, status: currentStatus, student_id, instructor_id } = booking
      const paymentId = provider_payment_id || payment_intent_id;

      if (!paymentId) {
        console.error(`⚠️ Booking ${id} has no payment ID.`)
        if (currentStatus === 'awaiting_payment') {
          await supabaseAdmin
            .from('appointments')
            .update({
              status: 'expired',
              payment_status: 'released',
              cancelled_reason: 'auto_expired',
              updated_at: new Date().toISOString()
            })
            .eq('id', id)
          return { id, status: 'expired_success' }
        } else {
          await supabaseAdmin
            .from('appointments')
            .update({ status: 'expired', cancelled_reason: 'missing_pi_id' })
            .eq('id', id)
          return { id, status: 'skipped_missing_pi' }
        }
      }

      try {
        const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
        const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

        if (!asaasApiKey) {
          console.error(`❌ ASAAS_API_KEY is not defined. Skipping Asaas check for ${id}.`);
          throw new Error('Missing ASAAS_API_KEY');
        }

        const url = `${asaasApiUrl}/payments/${paymentId}`;
        const response = await asaasFetch(url, { method: 'GET' });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`❌ Asaas API error for booking ${id}:`, errText);
          throw new Error(`Asaas fetch failed: ${errText}`);
        }

        const paymentData = await response.json();
        const asaasStatus = paymentData?.status?.toUpperCase();

        console.log(`ℹ️ Booking ${id} payment in Asaas status is ${asaasStatus}. Proceeding with expiration/deletion.`);
        
        if (currentStatus === 'awaiting_payment') {
          const { error: updateAptError } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'expired',
              payment_status: 'released',
              cancelled_reason: 'auto_expired',
              updated_at: new Date().toISOString()
            })
            .eq('id', id);

          if (updateAptError) throw updateAptError;
          return { id, status: 'expired_success' };
        } else {
          const { error: updateAptError } = await supabaseAdmin
            .from('appointments')
            .update({
              status: 'expired',
              payment_status: 'released',
              cancelled_reason: 'auto_expired',
              updated_at: new Date().toISOString()
            })
            .eq('id', id);

          if (updateAptError) throw updateAptError;

          // Notify both student and instructor
          try {
            let comboCount = 1;
            if (group_id) {
              const { count } = await supabaseAdmin
                .from('appointments')
                .select('id', { count: 'exact', head: true })
                .eq('group_id', group_id);
              if (count) comboCount = count;
            }

            if (student_id) {
              await NotificationService.sendBookingExpired({
                userId: student_id,
                isInstructor: false,
                comboCount,
                groupId: group_id || id
              });
            }
            if (instructor_id) {
              await NotificationService.sendBookingExpired({
                userId: instructor_id,
                isInstructor: true,
                comboCount,
                groupId: group_id || id
              });
            }
          } catch (notifErr) {
            console.error(`⚠️ Error sending expiry notifications for booking ${id}:`, notifErr);
          }

          return { id, status: 'expired_success' };
        }
      } catch (err: any) {
        console.error(`❌ Error checking Asaas payment for booking ${id}:`, err);
        throw err;
      }
    }))

    // Summary
    const successCount = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'expired_success').length
    const skippedCount = results.filter(r => r.status === 'fulfilled' && (r.value as any).status !== 'expired_success').length
    const failCount = results.filter(r => r.status === 'rejected').length
    const abandonedCount = abandonedBookings?.length || 0

    console.log(`🏁 Job finished. Success: ${successCount}, Skipped: ${skippedCount}, Failed: ${failCount}, Abandoned Cleaned: ${abandonedCount}`)

    return new Response(
      JSON.stringify({ 
        message: 'Job completed', 
        processed: expiredBookings.length,
        success: successCount,
        skipped: skippedCount,
        failed: failCount,
        abandoned_cleaned: abandonedCount,
        results 
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Critical Job Error:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
