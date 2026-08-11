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

    const now = new Date()
    const nowIso = now.toISOString()
    
    // =========================================================================
    // MODULE A — CHECKOUT NÃO PAGO (Unpaid expired checkouts after 5 min)
    // Target statuses: awaiting_payment, reserved, pending
    // Strictly exclude: pending_approval
    // =========================================================================
    console.log("🔍 [Module A] Fetching unpaid expired checkouts (expires_at < now)...")
    const { data: expiredUnpaidBookings, error: fetchUnpaidError } = await supabaseAdmin
      .from('appointments')
      .select('id, group_id')
      .in('status', ['awaiting_payment', 'reserved', 'pending'])
      .lt('expires_at', nowIso)

    if (fetchUnpaidError) {
      console.error("❌ Error fetching unpaid expired bookings:", fetchUnpaidError)
      throw fetchUnpaidError
    }

    console.log(`[Module A] Found ${expiredUnpaidBookings?.length || 0} unpaid expired bookings.`)

    const processedUnpaidGroupIds = new Set<string>();
    const moduleAResults = await Promise.allSettled((expiredUnpaidBookings || []).map(async (booking) => {
      if (booking.group_id) {
        if (processedUnpaidGroupIds.has(booking.group_id)) {
          return { id: booking.id, status: 'already_processed_in_group' };
        }
        processedUnpaidGroupIds.add(booking.group_id);
      }

      try {
        const res = await BookingCancellationCore.processCancellation({
          appointmentId: booking.id,
          reason: 'auto_expired',
          adminClient: supabaseAdmin
        });

        return { id: booking.id, status: 'expired_success', result: res };
      } catch (err: any) {
        console.error(`❌ [Module A] Error expiring booking ${booking.id} via Core:`, err);
        throw err;
      }
    }))

    const moduleASuccess = moduleAResults.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'expired_success').length
    const moduleASkipped = moduleAResults.filter(r => r.status === 'fulfilled' && (r.value as any).status !== 'expired_success').length
    const moduleAFailed = moduleAResults.filter(r => r.status === 'rejected').length

    // =========================================================================
    // MODULE B — AULA PAGA NÃO ACEITA (Paid pending_approval past start_time)
    // Target status: pending_approval AND payment_status: paid
    // Condition: (date + start_time) in America/Sao_Paulo <= NOW()
    // =========================================================================
    console.log("🔍 [Module B] Fetching paid pending_approval bookings past start time...")
    const { data: pendingPaidBookings, error: fetchPaidError } = await supabaseAdmin
      .from('appointments')
      .select('id, group_id, date, start_time')
      .eq('status', 'pending_approval')
      .eq('payment_status', 'paid')

    if (fetchPaidError) {
      console.error("❌ Error fetching paid pending_approval bookings:", fetchPaidError)
      throw fetchPaidError
    }

    // Filter candidates whose lesson start time in America/Sao_Paulo (UTC-3) has passed
    const expiredPaidCandidates = (pendingPaidBookings || []).filter(apt => {
      if (!apt.date || !apt.start_time) return false;

      // Clean start_time to HH:mm (handling HH:mm, HH:mm:ss, etc)
      const timeClean = String(apt.start_time).trim().split(':').slice(0, 2).join(':');
      const isoStr = `${String(apt.date).trim()}T${timeClean}:00-03:00`;
      const lessonStart = new Date(isoStr);

      if (isNaN(lessonStart.getTime())) {
        console.error(`❌ [Module B] Invalid date parsed for appointment ${apt.id}: date="${apt.date}", start_time="${apt.start_time}", normalized="${isoStr}", reason="Failed to construct valid Date object"`);
        return false;
      }

      return lessonStart <= now;
    });

    console.log(`[Module B] Found ${expiredPaidCandidates.length} paid pending_approval bookings past start time.`)

    const processedPaidGroupIds = new Set<string>();
    const moduleBResults = await Promise.allSettled(expiredPaidCandidates.map(async (booking) => {
      if (booking.group_id) {
        if (processedPaidGroupIds.has(booking.group_id)) {
          return { id: booking.id, status: 'already_processed_in_group' };
        }
        processedPaidGroupIds.add(booking.group_id);
      }

      try {
        console.log(`⏰ [Module B] Expiring paid unaccepted lesson ${booking.id} (group: ${booking.group_id || 'none'})...`)
        const res = await BookingCancellationCore.processCancellation({
          appointmentId: booking.id,
          reason: 'auto_expired',
          adminClient: supabaseAdmin
        });

        return { id: booking.id, status: 'expired_success', result: res };
      } catch (err: any) {
        console.error(`❌ [Module B] Error expiring paid booking ${booking.id} via Core:`, err);
        throw err;
      }
    }))

    const moduleBSuccess = moduleBResults.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'expired_success').length
    const moduleBSkipped = moduleBResults.filter(r => r.status === 'fulfilled' && (r.value as any).status !== 'expired_success').length
    const moduleBFailed = moduleBResults.filter(r => r.status === 'rejected').length

    console.log(`🏁 check-expired-bookings job finished.
      Module A (Unpaid): Success=${moduleASuccess}, Skipped=${moduleASkipped}, Failed=${moduleAFailed}
      Module B (Paid): Success=${moduleBSuccess}, Skipped=${moduleBSkipped}, Failed=${moduleBFailed}`)

    return new Response(
      JSON.stringify({ 
        message: 'Job completed', 
        unpaid_checkout: {
          processed: expiredUnpaidBookings?.length || 0,
          success: moduleASuccess,
          skipped: moduleASkipped,
          failed: moduleAFailed,
          results: moduleAResults
        },
        paid_pending_approval: {
          processed: expiredPaidCandidates.length,
          success: moduleBSuccess,
          skipped: moduleBSkipped,
          failed: moduleBFailed,
          results: moduleBResults
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Critical Job Error in check-expired-bookings:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})


