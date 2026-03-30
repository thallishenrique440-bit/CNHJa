// FIX: Use esm.sh for robust bundling in Edge Runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// FIX: Uso de URL absoluta compatível com Deno/Edge Runtime
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

// Declaração do Deno para evitar erros de lint
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
      // 1. Sincronização de Status da Conta (Redundância Segura)
      // ======================================================================
      case "account.updated":
      case "capability.updated": {
        let accountId = "";
        if (event.type === "account.updated") {
            accountId = event.data.object.id;
        } else if (event.type === "capability.updated") {
            accountId = event.data.object.account;
        }

        if (accountId) {
            const account = await stripe.accounts.retrieve(accountId);
            const updates = {
              payouts_enabled: account.payouts_enabled,
              stripe_onboarding_completed: account.details_submitted,
            };
            await supabaseAdmin.from("instructors").update(updates).eq("stripe_account_id", accountId);
        }
        break;
      }

      // ======================================================================
      // 2. Transações em Tempo Real (Mirror Financeiro)
      // ======================================================================
      case "payment_intent.amount_capturable_updated":
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const metadata = pi.metadata || {};
        const { instructor_id, student_id, appointment_id, type } = metadata;

        // A. Validação Obrigatória de Metadata
        if (!instructor_id || !student_id || !appointment_id) {
          console.error(`❌ CRITICAL: Missing metadata for PI ${pi.id}. Metadata:`, JSON.stringify(metadata));
          return new Response("Missing Metadata", { status: 200 });
        }

        const txType = type || 'lesson_payment';

        // B. Proteção contra Eventos Fora de Ordem (Anti-Downgrade)
        // A constraint UNIQUE(stripe_payment_intent_id, type) garante que maybeSingle() seja seguro
        const { data: existing } = await supabaseAdmin
          .from('transactions')
          .select('status, stripe_transfer_id')
          .eq('stripe_payment_intent_id', pi.id)
          .eq('type', txType)
          .maybeSingle();

        if (existing?.status === 'completed' && event.type === 'payment_intent.amount_capturable_updated') {
          console.log(`ℹ️ PI ${pi.id} already completed. Skipping pending update.`);
          break;
        }

        // C. Otimização: Retrieve de Charge apenas se necessário
        let transferId = existing?.stripe_transfer_id || null;
        if (!transferId && event.type === 'payment_intent.succeeded' && pi.latest_charge) {
          try {
            const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id;
            const charge = await stripe.charges.retrieve(chargeId);
            if (charge.transfer) {
              transferId = typeof charge.transfer === 'string' ? charge.transfer : charge.transfer.id;
            }
          } catch (e) {
            console.warn(`⚠️ Could not retrieve transfer ID for PI ${pi.id}:`, e.message);
          }
        }

        // D. Cálculo Financeiro (Centavos)
        const amount = pi.amount;
        const platform_fee = Math.floor(amount * 0.10);
        const net_amount = amount - platform_fee;
        const status = event.type === 'payment_intent.succeeded' ? 'completed' : 'pending';

        // E. UPSERT Idempotente
        const { error: txError } = await supabaseAdmin
          .from('transactions')
          .upsert({
            stripe_payment_intent_id: pi.id,
            type: txType,
            student_id,
            instructor_id,
            appointment_id,
            amount,
            gross_amount: amount,
            platform_fee,
            net_amount,
            status,
            stripe_transfer_id: transferId,
            description: txType === 'tip' ? 'Caixinha' : 'Pagamento de Aula',
            metadata: metadata,
            event_date: new Date().toISOString()
          }, { onConflict: 'stripe_payment_intent_id,type' });

        if (txError) {
          console.error(`❌ Error upserting transaction for PI ${pi.id}:`, txError);
          throw txError;
        }

        // F. Sincronização de Status da Aula (Apenas para lesson_payment)
        if (txType !== 'tip') {
          const aptStatus = status === 'completed' ? 'confirmed' : 'pending_approval';
          const payStatus = status === 'completed' ? 'paid' : 'authorized';
          
          await supabaseAdmin
            .from('appointments')
            .update({ 
              status: aptStatus, 
              payment_status: payStatus, 
              payment_intent_id: pi.id 
            })
            .eq('id', appointment_id);
        }
        break;
      }

      // ======================================================================
      // 3. Cancelamento / Estorno
      // ======================================================================
      case "payment_intent.canceled": {
        const pi = event.data.object;
        const paymentIntentId = pi.id;

        // Proteção: Não cancelar se já estiver concluído (segurança extra)
        await supabaseAdmin
          .from("transactions")
          .update({ status: "failed", description: "Autorização Cancelada/Expirada" })
          .eq("stripe_payment_intent_id", paymentIntentId)
          .neq("status", "completed");

        await supabaseAdmin
          .from("appointments")
          .update({ status: "cancelled", payment_status: "released" })
          .eq("payment_intent_id", paymentIntentId)
          .neq("status", "completed");
        break;
      }

      // ======================================================================
      // 4. Repasse Bancário (Payout)
      // ======================================================================
      case "payout.paid": {
        const payout = event.data.object;
        const connectedAccountId = event.account;

        if (connectedAccountId) {
          const balanceTxns = await stripe.balanceTransactions.list(
            { payout: payout.id, limit: 100 },
            { stripeAccount: connectedAccountId }
          );

          const transferIds = balanceTxns.data
            .filter(bt => bt.type === 'payment' && bt.source)
            .map(bt => bt.source as string);

          if (transferIds.length > 0) {
            await supabaseAdmin
              .from('transactions')
              .update({ stripe_payout_id: payout.id })
              .in('stripe_transfer_id', transferIds);
          }
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