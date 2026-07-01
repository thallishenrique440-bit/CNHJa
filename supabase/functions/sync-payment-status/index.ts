import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
  telemetry: false,
})

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  try {
    console.log("🔄 Starting sync-payment-status job...")

    // 1. Find 'reserved' or 'pending_approval' appointments that have a PaymentIntent ID
    // These are the ones that might be stuck if the webhook failed or if status is desynced.
    const { data: stuckAppointments, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, group_id, status, provider_name, student_id, instructor_id')
      .in('status', ['reserved', 'pending_approval', 'awaiting_payment'])
      .not('payment_intent_id', 'is', null)

    if (fetchError) {
      throw fetchError
    }

    console.log(`Found ${stuckAppointments?.length || 0} potentially stuck appointments.`)

    if (!stuckAppointments || stuckAppointments.length === 0) {
      return new Response(JSON.stringify({ message: 'No stuck appointments found.' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Group by group_id
    const groups = stuckAppointments.reduce((acc, apt) => {
      const gid = apt.group_id || `single_${apt.id}`;
      if (!acc[gid]) acc[gid] = [];
      acc[gid].push(apt);
      return acc;
    }, {} as Record<string, typeof stuckAppointments>);

    const results = await Promise.allSettled(Object.entries(groups).map(async ([groupId, groupApts]) => {
        const firstApt = groupApts[0];
        const { payment_intent_id, provider_name, student_id } = firstApt;

        let updates = {};
        let action = 'none';

        if (provider_name === 'asaas') {
          // Check if any appointment in this group is already expired, cancelled, or rejected
          const { data: allGroupApts, error: verifyError } = await supabaseAdmin
            .from('appointments')
            .select('status')
            .eq('group_id', groupId);

          if (verifyError) {
            console.error(`❌ Error verifying status for group ${groupId}:`, verifyError.message);
            return { groupId, status: 'error_verifying_group', details: verifyError.message };
          }

          const hasInvalidStatus = allGroupApts?.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
          if (hasInvalidStatus) {
            console.log(`ℹ️ Group ${groupId} contains expired/cancelled/rejected appointments. Skipping Asaas payment reconciliation to prevent overbooking.`);
            return { groupId, status: 'skipped', reason: 'group_has_invalid_status' };
          }

          // Check Asaas payment status
          const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
          const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

          if (!asaasApiKey) {
            console.error(`❌ ASAAS_API_KEY is not defined in Edge Function. Skipping Asaas sync for group ${groupId}.`);
            return { groupId, status: 'skipped', reason: 'missing_asaas_api_key' };
          }

          const url = `${asaasApiUrl}/payments/${payment_intent_id}`;
          const response = await fetch(url, {
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error(`❌ Asaas API error retrieving payment ${payment_intent_id} for group ${groupId}:`, errText);
            return { groupId, status: 'error_fetching_asaas', details: errText };
          }

          const paymentData = await response.json();
          const asaasStatus = paymentData?.status?.toUpperCase();

          if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
            console.log(`✅ Repairing Group ${groupId}: Asaas is paid (${asaasStatus}).`);
            updates = {
              status: 'pending_approval',
              payment_status: 'paid'
            };
            action = 'repaired_succeeded';

            // Notify Instructor instead of Student (Idempotent)
            const instructor_id = firstApt.instructor_id;
            if (instructor_id) {
                await supabaseAdmin.from("notifications").upsert({
                    user_id: instructor_id,
                    title: "Nova Solicitação de Aula (Sincronizada)",
                    message: "Novo pagamento recebido. Aula aguardando aprovação.",
                    type: "booking_request",
                    metadata: { group_id: groupId, payment_intent_id },
                    idempotency_key: `booking_request:${groupId}`
                }, { onConflict: 'idempotency_key' });
            }
          } else {
            console.log(`ℹ️ Group ${groupId}: Asaas status is ${asaasStatus}. Not paid yet.`);
            return { groupId, status: 'skipped', asaas_status: asaasStatus };
          }
        } else {
            // Check Stripe Status
            const pi = await stripe.paymentIntents.retrieve(payment_intent_id);

            if (pi.status === 'requires_capture') {
                // SUCCESS: Auth happened, but webhook missed it.
                console.log(`✅ Repairing Group ${groupId}: Stripe is authorized.`)
                updates = {
                    status: 'pending_approval',
                    payment_status: 'authorized'
                };
                action = 'repaired_authorized';

                // Notify Instructor (Idempotent)
                if (pi.metadata.instructor_id) {
                    await supabaseAdmin.from("notifications").upsert({
                        user_id: pi.metadata.instructor_id,
                        title: "Nova Solicitação de Aula (Sincronizada)",
                        message: "Uma solicitação pendente foi sincronizada. Aceite em até 20 minutos.",
                        type: "booking_request",
                        metadata: { group_id: groupId },
                        idempotency_key: `booking_request:${groupId}`
                    }, { onConflict: 'idempotency_key' });
                }

            } else if (pi.status === 'succeeded') {
                console.log(`✅ Repairing Group ${groupId}: Stripe is succeeded.`)
                updates = {
                    status: 'confirmed',
                    payment_status: 'paid'
                };
                action = 'repaired_succeeded';

                // Notify Student (Idempotent)
                if (pi.metadata.student_id) {
                    await supabaseAdmin.from("notifications").upsert({
                        user_id: pi.metadata.student_id,
                        title: "Aula Confirmada! (Sincronizada)",
                        message: "Seu pagamento foi confirmado e sua aula está agendada.",
                        type: "booking_accepted",
                        metadata: { group_id: groupId, payment_intent_id: pi.id },
                        idempotency_key: `booking_accepted:${groupId}`
                    }, { onConflict: 'idempotency_key' });
                }
            } else if (pi.status === 'canceled') {
                console.log(`🚫 Repairing Group ${groupId}: Stripe is canceled.`)
                const reason = pi.metadata?.cancellation_reason || 'stripe_sync_canceled';
                updates = {
                    status: 'cancelled',
                    payment_status: 'released',
                    cancelled_reason: reason
                };
                action = 'repaired_canceled';

                // Notify Student (Idempotent)
                if (pi.metadata.student_id) {
                    const type = reason === 'instructor_rejected' ? 'booking_rejected' : 'booking_cancelled';
                    let title = 'Pagamento Cancelado (Sincronizado)';
                    let message = 'Sua tentativa de pagamento foi cancelada e os horários foram liberados.';
                    
                    if (reason === 'instructor_rejected') {
                        title = 'Aula Recusada (Sincronizada)';
                        message = 'O instrutor não pôde aceitar sua solicitação. O valor reservado no seu cartão foi liberado.';
                    }

                    await supabaseAdmin.from("notifications").upsert({
                        user_id: pi.metadata.student_id,
                        title,
                        message,
                        type,
                        metadata: { group_id: groupId, payment_intent_id: pi.id, reason },
                        idempotency_key: `${type}:${groupId}`
                    }, { onConflict: 'idempotency_key' });
                }
            } else {
                return { groupId, status: 'skipped', stripe_status: pi.status };
            }
        }

        if (Object.keys(updates).length > 0) {
            const { error: updateError } = await supabaseAdmin
                .from('appointments')
                .update(updates)
                .eq('group_id', groupId)
                .in('status', ['reserved', 'pending_approval', 'awaiting_payment']);
            
            if (updateError) throw updateError;
        }

        return { groupId, status: 'success', action };
    }));

    const successCount = results.filter(r => r.status === 'fulfilled').length;

    return new Response(
      JSON.stringify({ 
        message: 'Sync job completed', 
        processed: stuckAppointments.length,
        success: successCount,
        results 
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Sync Job Error:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
