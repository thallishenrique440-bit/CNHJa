import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "stripe";

// Declare Deno to resolve TypeScript errors
declare const Deno: any;

// Initialize Stripe
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16" as any,
  httpClient: Stripe.createFetchHttpClient(),
});

// Initialize Supabase Admin Client (Bypass RLS)
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

// Crypto provider config for Stripe SDK in Deno
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req: Request) => {
  const signature = req.headers.get("Stripe-Signature");

  if (!signature) {
    return new Response("No signature header", { status: 400 });
  }

  try {
    // 1. Read raw body for signature verification
    const body = await req.text();
    
    // 2. Verify Event Signature
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
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
      console.error(`⚠️  Webhook signature verification failed.`, err.message);
      return new Response(`Webhook Error: ${err.message}`, { status: 400 });
    }

    console.log(`🔔 Event received: ${event.type} [ID: ${event.id}]`);

    // 3. Handle specific events
    switch (event.type) {
      // --------------------------------------------------------
      // EVENTO A: Atualização da Conta do Instrutor (Onboarding)
      // --------------------------------------------------------
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        
        const updates = {
          payouts_enabled: account.payouts_enabled,
          stripe_onboarding_completed: account.details_submitted,
        };

        console.log(`Updating instructor account ${account.id}:`, updates);

        const { error } = await supabaseAdmin
          .from("instructors")
          .update(updates)
          .eq("stripe_account_id", account.id);

        if (error) {
          console.error("Error updating instructor:", error);
          throw error;
        }
        break;
      }

      // --------------------------------------------------------
      // EVENTO B: Checkout Concluído com Sucesso (Pagamento Realizado)
      // Este é o evento PRINCIPAL para Stripe Checkout
      // --------------------------------------------------------
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        
        // Agora usamos purchase_id para agrupar as aulas
        const purchaseId = session.metadata?.purchase_id;
        const paymentIntentId = session.payment_intent as string;

        if (purchaseId) {
          console.log(`✅ Checkout completed for purchase_id: ${purchaseId}`);

          // Atualiza TODAS as aulas vinculadas a esta compra
          const { error, count } = await supabaseAdmin
            .from("appointments")
            .update({
              payment_status: "paid",
              status: "confirmed", // Agenda bloqueada definitivamente
              payment_intent_id: paymentIntentId
            })
            .eq("purchase_id", purchaseId);

          if (error) {
            console.error("CRITICAL: Error confirming appointments:", error);
            throw error;
          }
          console.log(`Updated ${count} appointments to confirmed.`);
        } else {
          console.warn("Checkout completed but missing purchase_id in metadata");
        }
        break;
      }

      // --------------------------------------------------------
      // EVENTO C: Sessão de Checkout Expirada (Usuário desistiu)
      // Importante para liberar a agenda imediatamente
      // --------------------------------------------------------
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const purchaseId = session.metadata?.purchase_id;

        if (purchaseId) {
          console.log(`⚠️ Checkout expired for purchase_id: ${purchaseId}. Releasing slots.`);

          // Se estava 'reserved', deletamos ou marcamos como falha.
          // Como é "expired", o usuário nem chegou a pagar. Melhor deletar para limpar a agenda limpo.
          // Ou mudar status para 'cancelled' se quiser manter histórico. Vamos deletar para liberar visualmente.
          const { error } = await supabaseAdmin
            .from("appointments")
            .delete()
            .eq("purchase_id", purchaseId)
            .eq("status", "reserved"); // Só deleta se ainda estiver reservado (segurança)

          if (error) {
            console.error("Error releasing expired slots:", error);
          }
        }
        break;
      }

      // --------------------------------------------------------
      // EVENTO D: Falha no Pagamento (Cartão recusado, etc)
      // Normalmente capturado via payment_intent
      // --------------------------------------------------------
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const purchaseId = paymentIntent.metadata?.purchase_id;

        if (purchaseId) {
          console.log(`❌ Payment failed for purchase_id: ${purchaseId}`);

          const { error } = await supabaseAdmin
            .from("appointments")
            .update({
              payment_status: "failed",
              // Mantemos como 'reserved' até expirar pelo garbage collector? 
              // Ou falhamos imediatamente? Falhar imediatamente é melhor UX para liberar pro aluno tentar outro cartão.
              status: "failed" 
            })
            .eq("purchase_id", purchaseId);

          if (error) {
            console.error("Error updating appointment failed status:", error);
          }
        }
        break;
      }

      // Fallback para payment_intent.succeeded caso usemos fora do Checkout no futuro
      // Mas para Checkout, o evento 'checkout.session.completed' já resolve.
      case "payment_intent.succeeded": {
         console.log("Payment intent succeeded (Handled via checkout.session.completed usually)");
         break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("Webhook processing error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      }
    );
  }
});