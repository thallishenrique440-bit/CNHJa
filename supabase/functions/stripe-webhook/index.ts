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
        const { instructor_id, student_id, appointment_id, group_id, type } = metadata;

        // A. Validação de Metadata (Exige instructor_id, student_id e [appointment_id OU group_id])
        if (!instructor_id || !student_id || (!appointment_id && !group_id)) {
          console.error(`❌ CRITICAL: Missing metadata for PI ${pi.id}. Metadata:`, JSON.stringify(metadata));
          return new Response("Missing Metadata", { status: 500 }); // AJUSTE: Status 500 para retry
        }

        // AJUSTE: Tipo fixo para 'lesson_payment' se não for explicitamente 'tip'
        const txType = type === 'tip' ? 'tip' : 'lesson_payment';

        // B. Resolução de Agendamentos (Mapeamento Atômico)
        let appointmentsToProcess = [];
        
        if (txType === 'lesson_payment') {
          if (appointment_id) {
            // Fluxo de aula única: usa o valor total do PI
            appointmentsToProcess = [{ id: appointment_id, price: pi.amount }];
          } else if (group_id) {
            // Fluxo de combo: busca todas as aulas vinculadas ao grupo e instrutor
            const { data: groupApts, error: groupError } = await supabaseAdmin
              .from('appointments')
              .select('id, price')
              .eq('group_id', group_id)
              .eq('instructor_id', instructor_id);

            if (groupError || !groupApts || groupApts.length === 0) {
              console.error(`❌ ERROR: No appointments found for group_id ${group_id}. PI: ${pi.id}`, groupError);
              return new Response("Appointments Not Found", { status: 500 });
            }

            // AJUSTE: Validação de Consistência Financeira (Soma das aulas vs Total do PI)
            const totalAptsPrice = groupApts.reduce((sum, apt) => sum + (apt.price || 0), 0);
            if (totalAptsPrice !== pi.amount) {
              console.error(`❌ CRITICAL: Price mismatch for group ${group_id}. Stripe: ${pi.amount}, DB: ${totalAptsPrice}`);
              return new Response("Price Mismatch", { status: 500 });
            }
            appointmentsToProcess = groupApts;
          }
        } else {
          // Caso de 'tip' (caixinha) - exige appointment_id
          if (!appointment_id) {
             console.error(`❌ ERROR: Missing appointment_id for tip. PI: ${pi.id}`);
             return new Response("Missing Appointment ID for Tip", { status: 500 });
          }
          appointmentsToProcess = [{ id: appointment_id, price: pi.amount }];
        }

        // C. Otimização: Retrieve de Charge apenas se necessário (uma vez para o PI)
        let transferId = null;
        if (event.type === 'payment_intent.succeeded' && pi.latest_charge) {
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

        // D. Loop de Processamento Idempotente
        for (const item of appointmentsToProcess) {
          // AJUSTE: Segurança no loop (valida ID)
          if (!item.id) {
            console.warn(`⚠️ Skipping invalid appointment record in PI ${pi.id}`);
            continue;
          }

          // AJUSTE: Proteção contra Eventos Fora de Ordem (Anti-Downgrade)
          // A constraint UNIQUE(stripe_payment_intent_id, type, appointment_id) garante que maybeSingle() seja seguro
          const { data: existing } = await supabaseAdmin
            .from('transactions')
            .select('status, stripe_transfer_id')
            .eq('stripe_payment_intent_id', pi.id)
            .eq('type', txType)
            .eq('appointment_id', item.id)
            .maybeSingle();

          // AJUSTE: Proteção global contra downgrade de status
          if (existing?.status === 'completed') {
            console.log(`ℹ️ PI ${pi.id} / Apt ${item.id} already completed. Skipping update.`);
            continue;
          }

          // E. Cálculo Financeiro (Centavos)
          const itemAmount = item.price;
          
          // AJUSTE: Usar valor REAL da taxa do Stripe (não recalcular no webhook)
          // Isso garante que o que foi cobrado no Stripe seja o que está no banco.
          const totalFee = pi.application_fee_amount || 0;
          let platform_fee = 0;

          if (appointmentsToProcess.length === 1) {
            platform_fee = totalFee;
          } else {
            // AJUSTE 3: Divisão proporcional para combos
            const index = appointmentsToProcess.indexOf(item);
            const isLast = index === appointmentsToProcess.length - 1;
            
            if (isLast) {
              // Ajusta diferença de centavos na última aula para evitar inconsistência
              const previousFees = appointmentsToProcess
                .slice(0, -1)
                .reduce((sum, a) => sum + Math.floor(totalFee * (a.price / pi.amount)), 0);
              platform_fee = totalFee - previousFees;
            } else {
              platform_fee = Math.floor(totalFee * (itemAmount / pi.amount));
            }
          }

          const net_amount = itemAmount - platform_fee;
          const status = event.type === 'payment_intent.succeeded' ? 'completed' : 'pending';

          // F. UPSERT Idempotente
          const { error: txError } = await supabaseAdmin
            .from('transactions')
            .upsert({
              stripe_payment_intent_id: pi.id,
              type: txType,
              student_id,
              instructor_id,
              appointment_id: item.id,
              amount: itemAmount,
              gross_amount: itemAmount,
              platform_fee,
              net_amount,
              status,
              stripe_transfer_id: transferId || existing?.stripe_transfer_id,
              description: txType === 'tip' ? 'Caixinha' : 'Pagamento de Aula',
              metadata: metadata,
              event_date: new Date().toISOString()
            }, { onConflict: 'stripe_payment_intent_id,type,appointment_id' });

          if (txError) {
            console.error(`❌ Error upserting transaction for PI ${pi.id} / apt ${item.id}:`, txError);
            throw txError; // Força erro 500 para retry
          }

          // G. Sincronização de Status da Aula (Apenas para lesson_payment)
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
              .eq('id', item.id);
          }
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