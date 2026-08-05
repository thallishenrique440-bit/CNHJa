import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  // 1. Security check: Validate Authorization header if CRON_SECRET is defined
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
    console.log("⏰ [NotificationWorker] Starting notification queue processing cycle (EDGE_CRON)...")

    const batchSize = Number(Deno.env.get('SHADOW_WORKER_BATCH_SIZE')) || 10
    const workerId = `edge-cron-${crypto.randomUUID().slice(0, 8)}`

    // 2. Claim pending jobs atomically using DB RPC
    const { data: claimedJobs, error: claimError } = await supabaseAdmin.rpc('claim_notification_jobs', {
      p_worker_id: workerId,
      p_batch_size: batchSize
    })

    if (claimError) {
      console.error("❌ [NotificationWorker] Error claiming notification jobs:", claimError)
      throw claimError
    }

    if (!claimedJobs || claimedJobs.length === 0) {
      console.log("ℹ️ [NotificationWorker] No pending jobs in queue.")
      return new Response(
        JSON.stringify({ 
          message: 'No pending jobs found',
          claimed: 0,
          processed: 0
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    console.log(`🚀 [NotificationWorker] Claimed ${claimedJobs.length} notification jobs. Processing batch...`)

    let processedJobs = 0
    let failedJobs = 0

    // 3. Process claimed jobs sequentially
    for (const job of claimedJobs) {
      const notificationId = job.notification_id
      try {
        // Fetch corresponding notification record
        const { data: notification, error: fetchError } = await supabaseAdmin
          .from('notifications')
          .select('id')
          .eq('id', notificationId)
          .single()

        if (fetchError || !notification) {
          throw new Error(fetchError ? fetchError.message : `Notification ${notificationId} not found.`)
        }

        // Dispatch push notification via send-push-notification edge function
        const { data: invokeData, error: invokeError } = await supabaseAdmin.functions.invoke('send-push-notification', {
          body: { notification_id: notificationId }
        })

        if (invokeError || !invokeData || invokeData.success !== true) {
          throw new Error(invokeData?.error ?? invokeError?.message ?? 'Push notification dispatch failed')
        }

        // Mark notification job sent via DB RPC
        const { data: marked, error: markError } = await supabaseAdmin.rpc('mark_notification_job_sent', {
          p_notification_id: notificationId
        })

        if (markError || marked !== true) {
          throw new Error(markError?.message ?? 'Failed to mark job as sent')
        }

        processedJobs++
        console.log(`✅ [NotificationWorker] Processed job for notification: ${notificationId}`)
      } catch (err: any) {
        failedJobs++
        console.error(`⚠️ [NotificationWorker] Error processing job for notification ${notificationId}:`, err?.message || err)
      }
    }

    console.log(`🏁 [NotificationWorker] Finished cycle. Claimed: ${claimedJobs.length}, Processed: ${processedJobs}, Failed: ${failedJobs}`)

    return new Response(
      JSON.stringify({
        message: 'Job completed',
        source: 'EDGE_CRON',
        claimed: claimedJobs.length,
        processed: processedJobs,
        failed: failedJobs
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 [NotificationWorker] Critical Error in notification worker:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
