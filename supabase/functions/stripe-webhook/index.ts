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
    console.error("❌ Missing Stripe Signature or Webhook Secret.");
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

    console.log(`🔔 Event received: ${event.type} [ID: ${event.id}]`);

    switch (event.type) {
      // ======================================================================
      // Sincronização de Status da Conta (Redundância Segura)
      // ======================================================================
      case "account.updated":
      case "capability.updated": {
        // Em capability.updated, o objeto vem dentro de event.data.object.account ou direto, 
        // mas para simplificar, buscamos sempre o ID da conta e consultamos a fonte da verdade.
        
        let accountId = "";
        if (event.type === "account.updated") {
            accountId = event.data.object.id;
        } else if (event.type === "capability.updated") {
            accountId = event.data.object.account;
        }

        if (accountId) {
            // Buscamos a conta fresca do Stripe para garantir o status real
            const account = await stripe.accounts.retrieve(accountId);
            
            const updates = {
              payouts_enabled: account.payouts_enabled,
              stripe_onboarding_completed: account.details_submitted,
            };

            console.log(`🔄 Syncing Instructor ${accountId}: Payouts=${account.payouts_enabled}`);

            const { error } = await supabaseAdmin
              .from("instructors")
              .update(updates)
              .eq("stripe_account_id", accountId);

            if (error) {
              console.error(`❌ Failed to update instructor ${accountId}:`, error);
              throw error;
            }
            console.log(`✅ Instructor ${accountId} updated successfully.`);
        }
        break;
      }

      // ======================================================================
      // Redundancy: Amount Capturable Updated (True Auth Confirmation)
      // ======================================================================
      case "payment_intent.amount_capturable_updated": {
        const paymentIntent = event.data.object;
        const purchaseId = paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;
        const instructorId = paymentIntent.metadata?.instructor_id;
        const studentId = paymentIntent.metadata?.student_id;
        const amountTotal = paymentIntent.amount;

        console.log(`🔍 Processing amount_capturable_updated for PI: ${paymentIntentId}`);
        console.log(`   Metadata:`, JSON.stringify(paymentIntent.metadata));

        if (purchaseId) {
           console.log(`🔒 Amount Capturable Updated (Auth) for Purchase ID: ${purchaseId}`);
           
           // 1. Update Appointments -> pending_approval / authorized
           const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
           
           const { data: updatedData, error: aptError } = await supabaseAdmin
             .from("appointments")
             .update({
               status: "pending_approval",
               payment_status: "authorized",
               payment_intent_id: paymentIntentId,
               expires_at: expiresAt
             })
             .eq("purchase_id", purchaseId)
             .select(); // Select to verify update

           if (aptError) {
             console.error("❌ Error updating appointments:", aptError);
             throw aptError;
           }

           if (!updatedData || updatedData.length === 0) {
              console.warn(`⚠️ No appointments found/updated for purchase_id: ${purchaseId}`);
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
                 status: "pending", // Pending capture
                 stripe_payment_intent_id: paymentIntentId,
                 description: `Reserva ${purchaseId} (Aguardando Aceite)`,
                 metadata: paymentIntent.metadata
               });

             if (txError) console.error("❌ Error creating transaction:", txError);
             else console.log(`✅ Transaction created for PI ${paymentIntentId}`);
           } else {
             console.log(`ℹ️ Transaction already exists for PI ${paymentIntentId}`);
           }

           // 3. Notify Instructor
           if (instructorId) {
             await supabaseAdmin.from("notifications").insert({
               user_id: instructorId,
               title: "Nova Solicitação de Aula",
               message: "Você tem uma nova solicitação de agendamento. Aceite em até 20 minutos.",
               type: "booking_request",
               metadata: { purchase_id: purchaseId }
             });
             console.log(`🔔 Notification sent to instructor ${instructorId}`);
           }
        } else {
            console.warn(`⚠️ Missing purchase_id in metadata. Trying to find by payment_intent_id: ${paymentIntentId}`);
            
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
        const purchaseId = paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;

        if (purchaseId) {
          console.log(`✅ Payment Captured for Purchase ID: ${purchaseId}`);

          // 1. Update Appointments -> confirmed / captured
          // Prevent overwriting 'completed' status (late webhook) or redundant updates
          await supabaseAdmin
            .from("appointments")
            .update({
              status: "confirmed",
              payment_status: "captured"
            })
            .eq("purchase_id", purchaseId)
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

          // 3. Notify Student
          const studentId = paymentIntent.metadata?.student_id;
          if (studentId) {
             await supabaseAdmin.from("notifications").insert({
              user_id: studentId,
              title: "Aula Confirmada!",
              message: "O instrutor aceitou sua solicitação. Bom treino!",
              type: "booking_accepted",
              metadata: { purchase_id: purchaseId }
            });
          }
        }
        break;
      }

      // ======================================================================
      // Auth Released (Rejected or Expired)
      // ======================================================================
      case "payment_intent.canceled": {
        const paymentIntent = event.data.object;
        const purchaseId = paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;

        if (purchaseId) {
          console.log(`🚫 Payment Canceled (Released) for Purchase ID: ${purchaseId}`);

          // 1. Check current status to decide next state
          const { data: appointment } = await supabaseAdmin
             .from("appointments")
             .select("status")
             .eq("purchase_id", purchaseId)
             .maybeSingle();

          if (appointment) {
             const updatePayload: any = { payment_status: "released" };
             
             // Only change status to rejected if it's currently pending_approval
             // If it's 'expired', we leave it as 'expired'.
             if (appointment.status === 'pending_approval') {
                updatePayload.status = 'rejected';
             }
             
             await supabaseAdmin
                .from("appointments")
                .update(updatePayload)
                .eq("purchase_id", purchaseId);
          }

          // 2. Update Transaction -> failed (Voided)
          await supabaseAdmin
            .from("transactions")
            .update({
              status: "failed",
              description: `Autorização Cancelada (Liberada)`
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
            
          // 3. Notify Student
          const studentId = paymentIntent.metadata?.student_id;
          if (studentId) {
             await supabaseAdmin.from("notifications").insert({
              user_id: studentId,
              title: "Solicitação Cancelada",
              message: "O valor reservado foi liberado no seu cartão.",
              type: "payment_released",
              metadata: { purchase_id: purchaseId }
            });
          }
        }
        break;
      }

      // ======================================================================
      // Fallback / Redundancy
      // ======================================================================
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        const purchaseId = paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;

        if (purchaseId) {
          console.log(`❌ Payment Failed for Purchase ID: ${purchaseId}`);
          
          await supabaseAdmin
            .from("appointments")
            .update({ 
                status: "failed", 
                payment_status: "failed" 
            })
            .eq("purchase_id", purchaseId);

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