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
        if (pi.latest_charge) {
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
          if (!item.id) continue;

          // Proteção contra Eventos Fora de Ordem (Anti-Downgrade)
          const { data: existing } = await supabaseAdmin
            .from('transactions')
            .select('status, stripe_transfer_id')
            .eq('stripe_payment_intent_id', pi.id)
            .eq('type', txType)
            .eq('appointment_id', item.id)
            .maybeSingle();

          if (existing?.status === 'completed') {
            console.log(`ℹ️ PI ${pi.id} / Apt ${item.id} already completed. Skipping update.`);
            continue;
          }

          // E. Cálculo Financeiro (Centavos)
          const itemAmount = item.price;
          const totalFee = pi.application_fee_amount || 0;
          let platform_fee = 0;

          if (appointmentsToProcess.length === 1) {
            platform_fee = totalFee;
          } else {
            const index = appointmentsToProcess.indexOf(item);
            const isLast = index === appointmentsToProcess.length - 1;
            
            if (isLast) {
              const previousFees = appointmentsToProcess
                .slice(0, -1)
                .reduce((sum, a) => sum + Math.floor(totalFee * (a.price / pi.amount)), 0);
              platform_fee = totalFee - previousFees;
            } else {
              platform_fee = Math.floor(totalFee * (itemAmount / pi.amount));
            }
          }

          const net_amount = itemAmount - platform_fee;

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
              status: 'completed',
              stripe_transfer_id: transferId || existing?.stripe_transfer_id,
              description: txType === 'tip' ? 'Caixinha' : 'Pagamento de Aula',
              metadata: metadata,
              event_date: new Date().toISOString()
            }, { onConflict: 'stripe_payment_intent_id,type,appointment_id' });

          if (txError) {
            console.error(`❌ Error upserting transaction for PI ${pi.id} / apt ${item.id}:`, txError);
            throw txError;
          }

          // G. Sincronização de Status da Aula (Apenas para lesson_payment)
          if (txType !== 'tip') {
            await supabaseAdmin
              .from('appointments')
              .update({ 
                status: 'confirmed', 
                payment_status: 'paid', 
                payment_intent_id: pi.id,
                updated_at: new Date().toISOString()
              })
              .eq('id', item.id)
              .neq('status', 'completed')
              .neq('status', 'confirmed');
          }
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
            .eq("stripe_payment_intent_id", paymentIntentId)
            .not("status", "in", '("completed")');
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
