import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

serve(async (req) => {
  // 1. Security check: Validate Authorization header
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
    console.log("⏰ Starting auto-complete-lessons job...")

    // Threshold: end_time + 3 hours < now
    // Since we don't have end_time_utc, we use start_time_utc + 50 mins + 3 hours
    // 50 + 180 = 230 minutes
    const thresholdDate = new Date(Date.now() - 230 * 60 * 1000).toISOString()

    console.log(`[DEBUG] Threshold calculation:`)
    console.log(`- Current time (UTC): ${new Date().toISOString()}`)
    console.log(`- Threshold date: ${thresholdDate}`)
    console.log(`Searching for confirmed lessons started before ${thresholdDate}`)

    // 2. Performance: Batch update using count: 'exact' and removing .select('id')
    // Batch update: status = 'confirmed' AND start_time_utc < threshold
    // Idempotency: only update if status is still 'confirmed'
    const { count, error } = await supabaseAdmin
      .from('appointments')
      .update({ 
        status: 'completed',
        updated_at: new Date().toISOString()
      }, { count: 'exact' })
      .eq('status', 'confirmed')
      .lt('start_time_utc', thresholdDate)

    if (error) {
      console.error("❌ Error auto-completing lessons:", error)
      throw error
    }

    const updatedCount = count || 0
    console.log(`✅ Auto-completed ${updatedCount} lessons.`)

    return new Response(
      JSON.stringify({ 
        message: 'Job completed', 
        auto_completed_count: updatedCount,
        threshold_used: thresholdDate
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
