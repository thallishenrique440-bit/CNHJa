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
        const groupId = paymentIntent.metadata?.group_id || paymentIntent.metadata?.purchase_id;
        const paymentIntentId = paymentIntent.id;
        const instructorId = paymentIntent.metadata?.instructor_id;
        const studentId = paymentIntent.metadata?.student_id;
        const amountTotal = paymentIntent.amount;

        console.log(`🔍 Processing amount_capturable_updated for PI: ${paymentIntentId}`);
        console.log(`   Metadata:`, JSON.stringify(paymentIntent.metadata));

        if (groupId) {
           console.log(`🔒 Amount Capturable Updated (Auth) for Group ID: ${groupId}`);
           
           // Fetch appointments to determine the start time
           const { data: apts } = await supabaseAdmin
             .from("appointments")
             .select("date, start_time")
             .eq("group_id", groupId);

           let expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString(); // Fallback
           if (apts && apts.length > 0) {
              // Combine date and start_time to get a Date object with explicit Brazil offset (UTC-3)
              const lessonStart = new Date(`${apts[0].date}T${apts[0].start_time}:00-03:00`);
              expiresAt = lessonStart.toISOString();
           }
           
           // 1. Update Appointments -> pending_approval / authorized
           const { data: updatedData, error: aptError } = await supabaseAdmin
             .from("appointments")
             .update({
               status: "pending_approval",
               payment_status: "authorized",
               payment_intent_id: paymentIntentId,
               expires_at: expiresAt
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
                 status: "pending", // Pending capture
                 stripe_payment_intent_id: paymentIntentId,
                 description: `Reserva ${groupId} (Aguardando Aceite)`,
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
               metadata: { group_id: groupId }
             });
             console.log(`🔔 Notification sent to instructor ${instructorId}`);
           }
        } else {
            console.warn(`⚠️ Missing group_id in metadata. Trying to find by payment_intent_id: ${paymentIntentId}`);
            
            // Fetch appointments to determine the start time
            const { data: apts } = await supabaseAdmin
              .from("appointments")
              .select("date, start_time")
              .eq("payment_intent_id", paymentIntentId);

            let expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString(); // Fallback
            if (apts && apts.length > 0) {
               // Combine date and start_time to get a Date object with explicit Brazil offset (UTC-3)
               const lessonStart = new Date(`${apts[0].date}T${apts[0].start_time}:00-03:00`);
               expiresAt = lessonStart.toISOString();
            }
            
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
        const metadata = paymentIntent.metadata || {};
        const type = metadata.type;
        const paymentIntentId = paymentIntent.id;

        let transferId = null;
        if (paymentIntent.latest_charge) {
          try {
            const chargeId = typeof paymentIntent.latest_charge === 'string' 
              ? paymentIntent.latest_charge 
              : paymentIntent.latest_charge.id;
            
            const charge = await stripe.charges.retrieve(chargeId);
            if (charge.transfer) {
              transferId = typeof charge.transfer === 'string' ? charge.transfer : charge.transfer.id;
              console.log(`💸 Extracted Transfer ID: ${transferId} for PI: ${paymentIntentId}`);
            }
          } catch (err) {
            console.error(`⚠️ Failed to retrieve charge/transfer for PI ${paymentIntentId}:`, err);
          }
        }

        if (type === 'tip') {
          // ======================================================================
          // FLUXO DE CAIXINHA (TIP)
          // ======================================================================
          const studentId = metadata.student_id;
          const instructorId = metadata.instructor_id;
          const appointmentId = metadata.appointment_id;
          const amount = paymentIntent.amount;
          const formattedAmount = (amount / 100).toFixed(2).replace('.', ',');

          console.log(`🎁 TIP START | PI: ${paymentIntentId} | Apt: ${appointmentId} | Amount: R$ ${formattedAmount}`);

          // 1. Validação de Segurança Básica
          if (!studentId || !instructorId || !appointmentId) {
            console.error(`❌ TIP BLOCKED: Missing required metadata. PI: ${paymentIntentId}`);
            break;
          }

          // 2. Validação de Valor Mínimo (R$ 1,00)
          if (!amount || amount < 100) {
            console.error(`❌ TIP BLOCKED: Invalid amount ${amount}. PI: ${paymentIntentId}`);
            break;
          }

          // 3. Idempotência Técnica: Verificar se já existe transação para este PI
          const { data: existingTxByPI } = await supabaseAdmin
            .from("transactions")
            .select("id")
            .eq("stripe_payment_intent_id", paymentIntentId)
            .maybeSingle();

          if (existingTxByPI) {
            console.log(`ℹ️ TIP BLOCKED (duplicate PI): PI ${paymentIntentId}`);
            break;
          }

          // 4. Validação do Appointment e Regras de Negócio
          const { data: apt, error: aptError } = await supabaseAdmin
            .from("appointments")
            .select("id, student_id, instructor_id, status")
            .eq("id", appointmentId)
            .single();

          if (aptError || !apt) {
            console.error(`❌ TIP BLOCKED: Appointment ${appointmentId} not found.`);
            break;
          }

          // A. Validar se a aula está CONCLUÍDA (CRÍTICO)
          if (apt.status !== 'completed') {
            console.error(`❌ TIP BLOCKED: Appointment ${appointmentId} status is ${apt.status} (expected completed).`);
            break;
          }

          // B. Validar se os IDs batem com a aula (Segurança contra spoofing)
          if (apt.student_id !== studentId || apt.instructor_id !== instructorId) {
            console.error(`❌ TIP BLOCKED: Ownership mismatch for Apt ${appointmentId}.`);
            break;
          }

          // C. Verificar se já existe caixinha para esta aula (Regra: 1 por aula)
          const { data: existingTipForApt } = await supabaseAdmin
            .from("transactions")
            .select("id")
            .eq("appointment_id", appointmentId)
            .eq("type", "tip")
            .eq("status", "completed")
            .maybeSingle();

          if (existingTipForApt) {
            console.warn(`⚠️ TIP BLOCKED: Tip already exists for Apt ${appointmentId}`);
            break;
          }

          // 5. Inserir Transação de Caixinha
          const { error: txError } = await supabaseAdmin
            .from("transactions")
            .insert({
              student_id: studentId,
              instructor_id: instructorId,
              appointment_id: appointmentId,
              type: "tip",
              amount: amount,
              status: "completed",
              stripe_payment_intent_id: paymentIntentId,
              stripe_transfer_id: transferId,
              description: `Caixinha • Aula ${appointmentId.split('-')[0]}...`,
              metadata: metadata
            });

          if (txError) {
            console.error(`❌ TIP ERROR: Failed to create transaction for PI ${paymentIntentId}:`, txError);
          } else {
            // 6. Notificar Instrutor
            await supabaseAdmin.from("notifications").insert({
              user_id: instructorId,
              title: "Você recebeu uma caixinha! 🎁",
              message: `Você recebeu R$ ${formattedAmount} de caixinha 🎁`,
              type: "system",
              metadata: { appointment_id: appointmentId }
            });
            console.log(`✅ TIP SUCCESS: PI ${paymentIntentId} | Apt ${appointmentId}`);
          }
        } else {
          // ======================================================================
          // FLUXO DE AULA (LESSON PAYMENT) - MANTIDO INTACTO
          // ======================================================================
          const groupId = metadata.group_id || metadata.purchase_id;

          if (groupId) {
            console.log(`✅ Payment Captured for Group ID: ${groupId}`);

            // 1. Update Appointments -> confirmed / captured
            await supabaseAdmin
              .from("appointments")
              .update({
                status: "confirmed",
                payment_status: "captured"
              })
              .eq("group_id", groupId)
              .neq("status", "completed")
              .neq("status", "confirmed");

            // 2. Update Transaction -> completed + transfer_id
            const txUpdatePayload: any = {
              status: "completed",
              description: `Pagamento Confirmado (Capturado)`
            };
            if (transferId) {
              txUpdatePayload.stripe_transfer_id = transferId;
            }

            await supabaseAdmin
              .from("transactions")
              .update(txUpdatePayload)
              .eq("stripe_payment_intent_id", paymentIntentId);

            // 3. Notify Student
            const studentId = metadata.student_id;
            if (studentId) {
               await supabaseAdmin.from("notifications").insert({
                user_id: studentId,
                title: "Aula Confirmada!",
                message: "O instructor aceitou sua solicitação. Bom treino!",
                type: "booking_accepted",
                metadata: { group_id: groupId }
              });
            }
          }
        }
        break;
      }

      // ======================================================================
      // Payout Paid (Funds transferred to Instructor's bank account)
      // ======================================================================
      case "payout.paid": {
        const payout = event.data.object;
        const connectedAccountId = event.account; // Present if event is from a connected account

        if (connectedAccountId) {
          console.log(`💰 Payout ${payout.id} paid for connected account ${connectedAccountId}`);
          try {
            // Fetch balance transactions for this payout on the connected account
            const balanceTxns = await stripe.balanceTransactions.list(
              { payout: payout.id, limit: 100 },
              { stripeAccount: connectedAccountId }
            );

            const transferIds: string[] = [];

            for (const bt of balanceTxns.data) {
              if (bt.type === 'payment' && bt.source) {
                // Retrieve the charge on the connected account to get the source_transfer
                const charge = await stripe.charges.retrieve(
                  bt.source as string,
                  { stripeAccount: connectedAccountId }
                );
                if (charge.source_transfer) {
                  transferIds.push(typeof charge.source_transfer === 'string' ? charge.source_transfer : charge.source_transfer.id);
                }
              }
            }

            if (transferIds.length > 0) {
              console.log(`🔗 Linking Payout ${payout.id} to Transfers:`, transferIds);
              // Update transactions in Supabase
              const { error } = await supabaseAdmin
                .from('transactions')
                .update({ stripe_payout_id: payout.id })
                .in('stripe_transfer_id', transferIds);

              if (error) {
                console.error('❌ Error updating payout IDs in transactions:', error);
              } else {
                console.log(`✅ Successfully updated payout IDs for ${transferIds.length} transactions.`);
              }
            }
          } catch (err) {
            console.error(`❌ Error processing payout ${payout.id}:`, err);
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

          // 1. Check current status to decide next state
          const { data: appointment } = await supabaseAdmin
             .from("appointments")
             .select("status")
             .eq("group_id", groupId)
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
            
          // 3. Notify Student
          const studentId = paymentIntent.metadata?.student_id;
          if (studentId) {
             await supabaseAdmin.from("notifications").insert({
              user_id: studentId,
              title: "Solicitação Cancelada",
              message: "O valor reservado foi liberado no seu cartão.",
              type: "payment_released",
              metadata: { group_id: groupId }
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
      // Refund Handling (Standard: Negative Values)
      // ======================================================================
      case "charge.refunded": {
        const charge = event.data.object;
        const refund = charge.refunds.data[0]; // Get the latest refund
        
        if (refund && refund.status === 'succeeded') {
          console.log(`↩️ Processing refund for charge ${charge.id}`);
          // Note: When implementing refund creation, ensure amounts are NEGATIVE
          // gross_amount = -refund.amount
          // platform_fee = -Math.floor(refund.amount * 0.1)
          // net_amount = gross_amount - platform_fee
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