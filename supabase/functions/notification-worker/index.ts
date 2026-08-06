import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

async function logSecretTelemetry(authHeader: string | null, cronSecret: string) {
  const encoder = new TextEncoder();
  const expectedHeader = `Bearer ${cronSecret}`;
  const actualHeader = authHeader ?? '';

  const hashBufferActual = await crypto.subtle.digest('SHA-256', encoder.encode(actualHeader));
  const hashBufferExpected = await crypto.subtle.digest('SHA-256', encoder.encode(expectedHeader));

  const hashActual = Array.from(new Uint8Array(hashBufferActual)).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashExpected = Array.from(new Uint8Array(hashBufferExpected)).map(b => b.toString(16).padStart(2, '0')).join('');

  let firstMismatchIdx = -1;
  let actualMismatchChar = null;
  let expectedMismatchChar = null;
  const maxLen = Math.max(actualHeader.length, expectedHeader.length);

  for (let i = 0; i < maxLen; i++) {
    const a = actualHeader[i];
    const e = expectedHeader[i];
    if (a !== e) {
      firstMismatchIdx = i;
      actualMismatchChar = a ? { char: a === ' ' ? 'SPACE' : a === '\r' ? 'CR' : a === '\n' ? 'LF' : a === '\t' ? 'TAB' : a, code: a.charCodeAt(0) } : 'END_OF_STRING';
      expectedMismatchChar = e ? { char: e === ' ' ? 'SPACE' : e === '\r' ? 'CR' : e === '\n' ? 'LF' : e === '\t' ? 'TAB' : e, code: e.charCodeAt(0) } : 'END_OF_STRING';
      break;
    }
  }

  const mask = (str: string) => {
    if (str.length <= 8) return '***';
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
  };

  const telemetry = {
    actualHeaderLength: actualHeader.length,
    expectedHeaderLength: expectedHeader.length,
    actualHeaderMasked: mask(actualHeader),
    expectedHeaderMasked: mask(expectedHeader),
    actualHashSha256: hashActual,
    expectedHashSha256: hashExpected,
    hasBearerPrefix: actualHeader.startsWith('Bearer '),
    hasLowerBearerPrefix: actualHeader.toLowerCase().startsWith('bearer '),
    actualHasCR: actualHeader.includes('\r'),
    actualHasLF: actualHeader.includes('\n'),
    actualHasQuotes: actualHeader.includes('"') || actualHeader.includes("'"),
    secretHasCR: cronSecret.includes('\r'),
    secretHasLF: cronSecret.includes('\n'),
    secretHasQuotes: cronSecret.includes('"') || cronSecret.includes("'"),
    firstMismatchIdx,
    actualMismatchChar,
    expectedMismatchChar,
  };

  console.error("🔍 [TELEMETRY_DIAGNOSTIC]", JSON.stringify(telemetry, null, 2));
}

Deno.serve(async (req) => {
  // 1. Security check: Validate Authorization header if CRON_SECRET is defined
  const authHeader = req.headers.get('Authorization')
  const cronSecret = Deno.env.get('CRON_SECRET')

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    await logSecretTelemetry(authHeader, cronSecret);
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
