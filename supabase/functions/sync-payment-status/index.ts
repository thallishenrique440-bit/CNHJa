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
      .select('id, payment_intent_id, group_id, status')
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
        const { payment_intent_id } = firstApt;

        // Check Stripe Status
        const pi = await stripe.paymentIntents.retrieve(payment_intent_id);

        let updates = {};
        let action = 'none';

        if (pi.status === 'requires_capture') {
            // SUCCESS: Auth happened, but webhook missed it.
            console.log(`✅ Repairing Group ${groupId}: Stripe is authorized.`)
            updates = {
                status: 'pending_approval',
                payment_status: 'authorized',
                expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
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
