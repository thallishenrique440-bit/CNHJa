import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { BookingCancellationCore, classifyCancellationResult } from '../_shared/BookingCancellationCore.ts'
import { asaasFetch } from '../_shared/asaasClient.ts'
import { requireCronAuth } from '../_shared/cronAuth.ts'
import { runRequestExpiryCycle } from '../_shared/BookingRequestService.ts'
import { NotificationService } from '../_shared/NotificationService.ts'
import { getAsaasEnvironment } from '../_shared/AsaasEnvironment.ts'

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  // F1-08: CRON_SECRET obrigatorio (fail-closed) e comparado em tempo constante.
  const denied = await requireCronAuth(req, 'check-expired-bookings')
  if (denied) return denied

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
      .eq('booking_flow', 'legacy') // FASE 3: pedidos do novo fluxo sao do Modulo C
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
          adminClient: supabaseAdmin,
          httpFetch: asaasFetch
        });

        return { id: booking.id, status: 'expired_success', refund: classifyCancellationResult(res), result: res };
      } catch (err: any) {
        console.error(`❌ [Module A] Error expiring booking ${booking.id} via Core:`, err);
        throw err;
      }
    }))

    const moduleASuccess = moduleAResults.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'expired_success').length
    const moduleASkipped = moduleAResults.filter(r => r.status === 'fulfilled' && (r.value as any).status !== 'expired_success').length
    const moduleAFailed = moduleAResults.filter(r => r.status === 'rejected').length

    // =========================================================================
    // MODULE C — NOVO FLUXO (booking_flow = request), FASE 3
    // Pedido sem resposta ate' o inicio da aula, ou aceito e nao pago dentro
    // do prazo. Com cobranca vinculada: consulta o Asaas; paga -> aguarda a
    // confirmacao (nao expira); nao paga -> cancela a cobranca e so' entao
    // expira. Toda transicao pela funcao atomica do banco (idempotente).
    // =========================================================================
    let moduleC: any = { skipped: 'not_run' }
    try {
      const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || ''
      let asaasApiUrl = ''
      try { asaasApiUrl = getAsaasEnvironment().apiUrl } catch (_e) { asaasApiUrl = '' }
      const gatewayReady = !!asaasApiKey && !!asaasApiUrl
      moduleC = await runRequestExpiryCycle({
        db: supabaseAdmin as any,
        nowIso,
        getGatewayStatus: async (paymentId: string) => {
          if (!gatewayReady) return null
          const r = await asaasFetch(`${asaasApiUrl}/payments/${paymentId}`, { method: 'GET' })
          if (r.status === 404) return 'DELETED'
          if (!r.ok) return null
          const body = await r.json().catch(() => null)
          if (body?.deleted === true) return 'DELETED'
          return body?.status ? String(body.status).toUpperCase() : null
        },
        cancelCharge: async (paymentId: string) => {
          if (!gatewayReady) return false
          const r = await asaasFetch(`${asaasApiUrl}/payments/${paymentId}`, { method: 'DELETE' })
          return r.ok || r.status === 404
        }
      })
      for (const g of moduleC.expiredGroups || []) {
        for (const [userId, isInstructor] of [[g.studentId, false], [g.instructorId, true]] as Array<[string | null, boolean]>) {
          if (!userId) continue
          try {
            await NotificationService.sendBookingRequestExpired({ userId, isInstructor, comboCount: g.lessons, groupId: g.groupId, stage: g.stage })
          } catch (notifErr) {
            console.error(`⚠️ [Module C] Falha ao notificar expiracao do grupo ${g.groupId}:`, notifErr)
          }
        }
      }
      console.log(`[Module C] groups=${moduleC.groups} expired=${moduleC.expired} awaiting_confirmation=${moduleC.awaitingConfirmation} retry_later=${moduleC.retryLater} failed=${moduleC.failed}`)
    } catch (moduleCError: any) {
      console.error('❌ [Module C] Falha no ciclo do novo fluxo:', moduleCError)
      moduleC = { error: String(moduleCError?.message ?? moduleCError) }
    }

    // =========================================================================
    // MODULE B — AULA PAGA NÃO ACEITA (Paid pending_approval past start_time)
    // Target status: pending_approval AND payment_status: paid
    // Condition: (date + start_time) in America/Sao_Paulo <= NOW()
    //
    // O Core encerra a aula (`expired`) na PRIMEIRA execucao, qualquer que seja
    // o estado do estorno. A partir dai' ela sai deste seletor (status deixa de
    // ser `pending_approval`; payment_status deixa de ser `paid`), portanto nao
    // e' reprocessada. Operacao DENIED/CONFLICT nunca recebe novo POST: o Core
    // reaproveita a operacao existente (`findByObligation`).
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
          adminClient: supabaseAdmin,
          httpFetch: asaasFetch
        });

        return { id: booking.id, status: 'expired_success', refund: classifyCancellationResult(res), result: res };
      } catch (err: any) {
        console.error(`❌ [Module B] Error expiring paid booking ${booking.id} via Core:`, err);
        throw err;
      }
    }))

    const moduleBSuccess = moduleBResults.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'expired_success').length
    const moduleBSkipped = moduleBResults.filter(r => r.status === 'fulfilled' && (r.value as any).status !== 'expired_success').length
    const moduleBFailed = moduleBResults.filter(r => r.status === 'rejected').length

    // `success` = aula ENCERRADA. O estorno e' contado a parte: so'
    // `refund_confirmed` e' estorno concluido; pendente e recusado nunca entram
    // nessa conta.
    const countRefund = (kind: string) => moduleBResults.filter(r => r.status === 'fulfilled' && (r.value as any).refund === kind).length
    const moduleBRefundConfirmed = countRefund('refund_confirmed')
    const moduleBRefundInReview = countRefund('refund_in_review')
    const moduleBRefundDenied = countRefund('refund_denied')

    console.log(`🏁 check-expired-bookings job finished.
      Module A (Unpaid): Success=${moduleASuccess}, Skipped=${moduleASkipped}, Failed=${moduleAFailed}
      Module B (Paid): Closed=${moduleBSuccess}, Skipped=${moduleBSkipped}, Failed=${moduleBFailed}, RefundConfirmed=${moduleBRefundConfirmed}, RefundInReview=${moduleBRefundInReview}, RefundDenied=${moduleBRefundDenied}`)

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
        booking_requests: moduleC,
        paid_pending_approval: {
          processed: expiredPaidCandidates.length,
          success: moduleBSuccess,
          skipped: moduleBSkipped,
          failed: moduleBFailed,
          refund_confirmed: moduleBRefundConfirmed,
          refund_in_review: moduleBRefundInReview,
          refund_denied: moduleBRefundDenied,
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


