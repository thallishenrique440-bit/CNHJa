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
      // Checkout Logic
      // ======================================================================
      case "checkout.session.completed": {
        const session = event.data.object;
        const purchaseId = session.metadata?.purchase_id;
        const paymentIntentId = session.payment_intent as string;

        if (purchaseId) {
          console.log(`💰 Checkout completed for Purchase ID: ${purchaseId}`);

          const { error, count } = await supabaseAdmin
            .from("appointments")
            .update({
              payment_status: "paid",
              status: "confirmed",
              payment_intent_id: paymentIntentId
            })
            .eq("purchase_id", purchaseId);

          if (error) {
            console.error("❌ Error confirming appointments:", error);
            throw error;
          }
          console.log(`✅ Confirmed ${count} appointments.`);
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object;
        const purchaseId = session.metadata?.purchase_id;

        if (purchaseId) {
          console.log(`⚠️ Checkout expired for Purchase ID: ${purchaseId}`);
          const { error } = await supabaseAdmin
            .from("appointments")
            .delete()
            .eq("purchase_id", purchaseId)
            .eq("status", "reserved");

          if (error) console.error("❌ Error deleting expired slots:", error);
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        const purchaseId = paymentIntent.metadata?.purchase_id;

        if (purchaseId) {
          console.log(`❌ Payment failed for Purchase ID: ${purchaseId}`);
          const { error } = await supabaseAdmin
            .from("appointments")
            .update({ payment_status: "failed", status: "failed" })
            .eq("purchase_id", purchaseId);

          if (error) console.error("❌ Error updating failed status:", error);
        }
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
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