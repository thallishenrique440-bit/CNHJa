import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { requireCronAuth } from '../_shared/cronAuth.ts'
import {
  DEFAULT_QUEUE_CONFIG,
  interpretDispatchResponse,
  runNotificationCycle,
  type DispatchOutcome,
} from '../_shared/notificationQueue.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

/**
 * Envia UMA notificacao pelo `send-push-notification`.
 *
 * FASE 0: a chamada passou a enviar `Authorization: Bearer <service_role>` de
 * forma EXPLICITA. Desde o endurecimento F1-06 o `send-push-notification`
 * exige esse cabecalho; `functions.invoke` nao o estava entregando e toda
 * chamada era recusada com 401 (`reason=missing_header`), deixando os jobs
 * presos em `processing`. O corpo e' lido tambem em respostas nao-2xx, para
 * classificar a falha.
 */
async function dispatchPush(notificationId: string): Promise<DispatchOutcome> {
  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: 'POST',
      // Somente Authorization, no mesmo formato das chamadas do cron (que
      // chegam as funcoes sem alteracao). O cabecalho `apikey` nao e' enviado.
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ notification_id: notificationId }),
    })
  } catch (netErr: any) {
    return { kind: 'transient_failure', error: `network: ${netErr?.message ?? netErr}` }
  }
  const body = await response.json().catch(() => null)
  return interpretDispatchResponse(response.ok, body, `HTTP ${response.status}`)
}

Deno.serve(async (req) => {
  // 1. F1-07/F1-08: CRON_SECRET obrigatorio (fail-closed), comparacao em tempo
  // constante e log somente booleano. A telemetria que expunha hash, tamanho e
  // caractere divergente do segredo foi removida.
  const denied = await requireCronAuth(req, 'notification-worker')
  if (denied) return denied

  try {
    console.log("⏰ [NotificationWorker] Starting notification queue processing cycle (EDGE_CRON)...")

    const batchSize = Number(Deno.env.get('SHADOW_WORKER_BATCH_SIZE')) || DEFAULT_QUEUE_CONFIG.batchSize
    // Validade do push: tipos temporalmente criticos / demais tipos (minutos).
    const maxAgeMinutes = Number(Deno.env.get('NOTIFICATION_MAX_AGE_MINUTES')) || 0
    const maxStandardAgeMinutes = Number(Deno.env.get('NOTIFICATION_STANDARD_MAX_AGE_MINUTES')) || 0
    const workerId = `edge-cron-${crypto.randomUUID().slice(0, 8)}`

    // 2. Recupera jobs abandonados, reivindica pendentes, envia e grava o
    //    desfecho de cada um (ver _shared/notificationQueue.ts).
    const report = await runNotificationCycle({
      db: supabaseAdmin,
      dispatch: dispatchPush,
      workerId,
      config: {
        batchSize,
        ...(maxAgeMinutes > 0 ? { maxNotificationAgeMs: maxAgeMinutes * 60 * 1000 } : {}),
        ...(maxStandardAgeMinutes > 0 ? { maxStandardNotificationAgeMs: maxStandardAgeMinutes * 60 * 1000 } : {}),
      },
    })

    const recoveredTotal = report.recovered.requeued + report.recovered.expired + report.recovered.dead
      + report.recovered.failedUnknown + report.recovered.confirmedSent
    const needsAttention = report.dead + report.failed + report.unresolved + report.recovered.dead + report.recovered.failedUnknown

    // Linha unica e estruturada: e' o que um alerta de log deve observar.
    const summary = `[NotificationWorker] cycle worker=${workerId} claimed=${report.claimed} sent=${report.sent} retried=${report.retried} `
      + `dead=${report.dead} failed=${report.failed} expired=${report.expired} no_devices=${report.noDevices} unresolved=${report.unresolved} `
      + `recovered=${recoveredTotal} needs_attention=${needsAttention} critical_undelivered=${report.criticalUndelivered.length}`
    if (needsAttention > 0 || report.criticalUndelivered.length > 0) console.error(`🚨 ${summary}`)
    else console.log(`🏁 ${summary}`)
    // Uma linha por job morto e por notificacao critica nao entregue: e' o que
    // um alerta de log deve observar. Somente identificador e tipo, sem conteudo.
    for (const id of report.deadIds) console.error(`🚨 [NotificationWorker] DEAD_JOB notification_id=${id}`)
    for (const c of report.criticalUndelivered) {
      console.error(`🚨 [NotificationWorker] CRITICAL_UNDELIVERED notification_id=${c.id} type=${c.type} outcome=${c.outcome}`)
    }

    if (report.claimed === 0 && recoveredTotal === 0) {
      return new Response(
        JSON.stringify({ message: 'No pending jobs found', claimed: 0, processed: 0 }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        message: 'Job completed',
        source: 'EDGE_CRON',
        claimed: report.claimed,
        processed: report.sent,
        failed: report.retried + report.dead + report.failed + report.unresolved,
        report,
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
