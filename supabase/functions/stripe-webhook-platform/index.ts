// FIX: Use esm.sh for robust bundling in Edge Runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// FIX: Uso de URL absoluta compatível com Deno/Edge Runtime
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

// Declaração do Deno para evitar erros de lint
declare const Deno: any;

// Initialize Stripe
// HttpClient is crucial for Deno Edge environment
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16" as any,
  httpClient: Stripe.createFetchHttpClient(),
});

// Initialize Supabase Admin Client (Bypass RLS)
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req: Request) => {
  // 1. Signature Verification Security Check
  const signature = req.headers.get("Stripe-Signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!signature || !webhookSecret) {
    console.error("❌ Missing Stripe Signature or Webhook Secret (Platform).");
    return new Response("Security Error: Missing Config", { status: 400 });
  }

  try {
    const body = await req.text();
    let event;

    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret,
        undefined,
        cryptoProvider
      );
    } catch (err: any) {
      console.error(`⚠️ Webhook signature verification failed: ${err.message}`);
      return new Response(`Webhook Signature Error: ${err.message}`, { status: 400 });
    }

    console.log(`🔔 Platform Event received: ${event.type} [ID: ${event.id}]`);

    switch (event.type) {
      // ======================================================================
      // Redundancy: Amount Capturable Updated (True Auth Confirmation)
      // ======================================================================
      case "payment_intent.amount_capturable_updated": {
        const paymentIntent = event.data.object;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;
        const instructorId = paymentIntent.metadata?.instructor_id;
        const studentId = paymentIntent.metadata?.student_id;
        const amountTotal = paymentIntent.amount;

        console.log(`🔍 Processing amount_capturable_updated for PI: ${paymentIntentId}`);
        console.log(`   Metadata:`, JSON.stringify(paymentIntent.metadata));

        if (groupId) {
           console.log(`🔒 Amount Capturable Updated (Auth) for Group ID: ${groupId}`);
           
           // 1. Update Appointments -> pending_approval / authorized
           const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
           
           const { data: updatedData, error: aptError } = await supabaseAdmin
             .from("appointments")
             .update({
               status: "pending_approval",
               payment_status: "authorized",
               payment_intent_id: paymentIntentId,
               expires_at: expiresAt,
               updated_by: studentId
             })
             .eq("group_id", groupId)
             .select(); // Select to verify update

           if (aptError) {
             console.error("❌ Error updating appointments:", aptError);
             throw aptError;
           }

           if (!updatedData || updatedData.length === 0) {
              console.warn(`⚠️ No appointments found/updated for group_id: ${groupId}`);
           } else {
              console.log(`✅ Updated ${updatedData.length} appointments to pending_approval.`);
           }

           // 2. Create Initial Transaction (Authorized) if not exists
           const { data: existingTx } = await supabaseAdmin
             .from("transactions")
             .select("id")
             .eq("stripe_payment_intent_id", paymentIntentId)
             .maybeSingle();

           if (!existingTx) {
             const { error: txError } = await supabaseAdmin
               .from("transactions")
               .insert({
                 student_id: studentId,
                 instructor_id: instructorId,
                 type: "lesson_payment",
                 amount: amountTotal,
                 gross_amount: amountTotal,
                 platform_fee: paymentIntent.application_fee_amount || 0,
                 net_amount: amountTotal - (paymentIntent.application_fee_amount || 0),
                 status: "pending", // Pending capture
                 stripe_payment_intent_id: paymentIntentId,
                 description: `Reserva ${groupId} (Aguardando Aceite)`,
                 metadata: paymentIntent.metadata,
                 event_date: new Date().toISOString()
               });

             if (txError) console.error("❌ Error creating transaction:", txError);
             else console.log(`✅ Transaction created for PI ${paymentIntentId}`);
           } else {
             console.log(`ℹ️ Transaction already exists for PI ${paymentIntentId}`);
           }

        } else {
            console.warn(`⚠️ Missing group_id in metadata. Trying to find by payment_intent_id: ${paymentIntentId}`);
            
            const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
            
            // Fallback: Update by PaymentIntent ID
            const { data: updatedData, error: aptError } = await supabaseAdmin
                .from("appointments")
                .update({
                    status: "pending_approval",
                    payment_status: "authorized",
                    expires_at: expiresAt
                })
                .eq("payment_intent_id", paymentIntentId)
                .select();

            if (aptError) {
                console.error("❌ Error updating appointments by PI ID:", aptError);
                throw aptError;
            }

            if (!updatedData || updatedData.length === 0) {
                 console.error(`❌ CRITICAL: Could not find appointment for PI ${paymentIntentId}`);
            } else {
                 console.log(`✅ Recovered & Updated ${updatedData.length} appointments using PI ID.`);
                 
                 // Try to recover metadata from the updated row for subsequent logic
                 // We can't easily create the transaction without student/instructor ID if metadata is missing
                 // But at least the booking is not stuck in reserved.
            }
        }
        break;
      }

      // ======================================================================
      // Capture Success (Instructor Accepted)
      // ======================================================================
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;

        if (groupId) {
          console.log(`✅ Payment Captured for Group ID: ${groupId}`);
          const instructorId = paymentIntent.metadata?.instructor_id;

          // 1. Update Appointments -> confirmed / captured
          // Prevent overwriting 'completed' status (late webhook) or redundant updates
          await supabaseAdmin
            .from("appointments")
            .update({
              status: "confirmed",
              payment_status: "captured",
              updated_by: instructorId
            })
            .eq("group_id", groupId)
            .neq("status", "completed")
            .neq("status", "confirmed");

          // 2. Update Transaction -> completed
          await supabaseAdmin
            .from("transactions")
            .update({
              status: "completed",
              description: `Pagamento Confirmado (Capturado)`
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
        }
        break;
      }

      // ======================================================================
      // Auth Released (Rejected or Expired)
      // ======================================================================
      case "payment_intent.canceled": {
        const paymentIntent = event.data.object;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;

        if (groupId) {
          console.log(`🚫 Payment Canceled (Released) for Group ID: ${groupId}`);
          const instructorId = paymentIntent.metadata?.instructor_id;

          // 1. Check current status to decide next state
          const { data: appointment } = await supabaseAdmin
             .from("appointments")
             .select("status")
             .eq("group_id", groupId)
             .maybeSingle();

          if (appointment) {
             const updatePayload: any = { 
               payment_status: "released",
               updated_by: instructorId
             };
             
             // Only change status to rejected if it's currently pending_approval
             // If it's 'expired', we leave it as 'expired'.
             if (appointment.status === 'pending_approval') {
                updatePayload.status = 'rejected';
             }
             
             await supabaseAdmin
                .from("appointments")
                .update(updatePayload)
                .eq("group_id", groupId);
          }

          // 2. Update Transaction -> failed (Voided)
          await supabaseAdmin
            .from("transactions")
            .update({
              status: "failed",
              description: `Autorização Cancelada (Liberada)`
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
        }
        break;
      }

      // ======================================================================
      // Fallback / Redundancy
      // ======================================================================
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;

        if (groupId) {
          console.log(`❌ Payment Failed for Group ID: ${groupId}`);
          
          await supabaseAdmin
            .from("appointments")
            .update({ 
                status: "failed", 
                payment_status: "failed" 
            })
            .eq("group_id", groupId);

          await supabaseAdmin
            .from("transactions")
            .update({
              status: "failed",
              description: `Falha no Pagamento`
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
        }
        break;
      }

      default:
        if (event.type.startsWith('payment_intent.')) {
            console.log(`ℹ️ Unhandled PaymentIntent event: ${event.type} [ID: ${event.id}]`);
            const pi = event.data.object;
            console.log(`   Status: ${pi.status}, Capture Method: ${pi.capture_method}`);
        } else {
            console.log(`ℹ️ Unhandled event type: ${event.type}`);
        }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error(`🚨 Webhook Logic Error:`, err);
    return new Response(JSON.stringify({ error: err.message }), { 
        status: 400, headers: { "Content-Type": "application/json" } 
    });
  }
});
