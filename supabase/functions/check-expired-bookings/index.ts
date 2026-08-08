import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { BookingCancellationCore } from '../_shared/BookingCancellationCore.ts'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  // Security check: Validate Authorization header
  const authHeader = req.headers.get('Authorization')
  const cronSecret = Deno.env.get('CRON_SECRET')

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.error("❌ Unauthorized: Invalid CRON_SECRET")
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

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
      .select('id, group_id')
      .in('status', ['pending', 'pending_approval', 'awaiting_payment', 'cancelling'])
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

    // Process each booking via BookingCancellationCore SSOT (deduplicating by group_id if already handled)
    const processedGroupIds = new Set<string>();
    const results = await Promise.allSettled(expiredBookings.map(async (booking) => {
      if (booking.group_id) {
        if (processedGroupIds.has(booking.group_id)) {
          return { id: booking.id, status: 'already_processed_in_group' };
        }
        processedGroupIds.add(booking.group_id);
      }

      try {
        const res = await BookingCancellationCore.processCancellation({
          appointmentId: booking.id,
          reason: 'auto_expired',
          adminClient: supabaseAdmin
        });

        return { id: booking.id, status: 'expired_success', result: res };
      } catch (err: any) {
        console.error(`❌ Error expiring booking ${booking.id} via Core:`, err);
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

