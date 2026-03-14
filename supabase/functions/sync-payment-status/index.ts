import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

serve(async (req) => {
  try {
    console.log("🔄 Starting sync-payment-status job...")

    // 1. Find 'reserved' or 'pending_approval' appointments that have a PaymentIntent ID
    // These are the ones that might be stuck if the webhook failed or if status is desynced.
    const { data: stuckAppointments, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, purchase_id, status')
      .in('status', ['reserved', 'pending_approval'])
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

    const results = await Promise.allSettled(stuckAppointments.map(async (apt) => {
        const { id, payment_intent_id, purchase_id, status } = apt;

        // Check Stripe Status
        const pi = await stripe.paymentIntents.retrieve(payment_intent_id);

        let updates = {};
        let action = 'none';

        if (pi.status === 'requires_capture') {
            if (status === 'pending_approval') {
                // Already correct. Skip.
                return { id, status: 'skipped_valid_state', stripe_status: pi.status };
            }

            // SUCCESS: Auth happened, but webhook missed it (status is reserved).
            console.log(`✅ Repairing ${id}: Stripe is authorized (was reserved).`)
            updates = {
                status: 'pending_approval',
                payment_status: 'authorized',
                expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString() // Reset 20 min timer
            };
            action = 'repaired_authorized';

            // Also ensure transaction exists
            const { data: existingTx } = await supabaseAdmin
                .from("transactions")
                .select("id")
                .eq("stripe_payment_intent_id", payment_intent_id)
                .maybeSingle();

            if (!existingTx) {
                 await supabaseAdmin.from("transactions").insert({
                     student_id: pi.metadata.student_id,
                     instructor_id: pi.metadata.instructor_id,
                     type: "lesson_payment",
                     amount: pi.amount,
                     status: "pending",
                     stripe_payment_intent_id: payment_intent_id,
                     description: `Reserva ${purchase_id} (Recuperada)`,
                     metadata: pi.metadata
                 });
            }

            // Notify Instructor (Idempotent Check)
            if (pi.metadata.instructor_id) {
                const { data: existingNotif } = await supabaseAdmin
                    .from("notifications")
                    .select("id")
                    .eq("user_id", pi.metadata.instructor_id)
                    .eq("type", "booking_request")
                    .contains("metadata", { purchase_id: purchase_id })
                    .maybeSingle();

                if (!existingNotif) {
                    await supabaseAdmin.from("notifications").insert({
                        user_id: pi.metadata.instructor_id,
                        title: "Nova Solicitação de Aula (Sincronizada)",
                        message: "Uma solicitação pendente foi sincronizada. Aceite em até 20 minutos.",
                        type: "booking_request",
                        metadata: { purchase_id: purchase_id }
                    });
                }
            }

        } else if (pi.status === 'succeeded') {
            // Already captured?
            console.log(`✅ Repairing ${id}: Stripe is succeeded.`)
            updates = {
                status: 'confirmed', // or scheduled
                payment_status: 'captured'
            };
            action = 'repaired_succeeded';
        } else if (pi.status === 'canceled') {
            // Expired/Cancelled
            console.log(`🚫 Repairing ${id}: Stripe is canceled.`)
            updates = {
                status: 'expired',
                payment_status: 'released',
                cancelled_reason: 'stripe_sync_canceled'
            };
            action = 'repaired_canceled';
        } else {
            // requires_payment_method, requires_confirmation, etc.
            // Still in progress or abandoned. Do nothing, let it expire naturally via create-booking cleanup.
            return { id, status: 'skipped', stripe_status: pi.status };
        }

        if (Object.keys(updates).length > 0) {
            const { error: updateError } = await supabaseAdmin
                .from('appointments')
                .update(updates)
                .eq('id', id);
            
            if (updateError) throw updateError;
        }

        return { id, status: 'success', action };
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
