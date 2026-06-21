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
    console.log("⏰ Starting check-expired-bookings cron job...")

    // 1. Find expired bookings
    // status IN ('pending', 'pending_approval') AND expires_at < now()
    const now = new Date().toISOString()
    
    // 1.5 Clean up abandoned checkouts (awaiting_payment and reserved)
    console.log("🧹 Cleaning up abandoned checkouts...")
    
    // Clean up awaiting_payment (legacy or specific flow) - skip Asaas bookings which we check below
    const { data: abandonedBookings, error: deleteError } = await supabaseAdmin
      .from('appointments')
      .delete()
      .eq('status', 'awaiting_payment')
      .not('provider_name', 'eq', 'asaas')
      .lt('expires_at', now)
      .select('id')

    if (deleteError) {
      console.error("❌ Error deleting abandoned bookings:", deleteError)
    } else if (abandonedBookings && abandonedBookings.length > 0) {
      console.log(`✅ Cleaned up ${abandonedBookings.length} abandoned checkouts (awaiting_payment).`)
    }

    // Clean up reserved (soft delete to failed)
    const { data: reservedBookings, error: reservedError } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        cancelled_reason: 'system_cleanup_expired',
        updated_at: new Date().toISOString()
      })
      .eq('status', 'reserved')
      .lt('expires_at', now)
      .select('id')

    if (reservedError) {
      console.error("❌ Error cleaning up reserved bookings:", reservedError)
    } else if (reservedBookings && reservedBookings.length > 0) {
      console.log(`✅ Cleaned up ${reservedBookings.length} abandoned checkouts (reserved).`)
    }

    const { data: expiredBookings, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, status, group_id, provider_name, student_id')
      .in('status', ['pending', 'pending_approval', 'awaiting_payment'])
      .lt('expires_at', now)

    if (fetchError) {
      console.error("❌ Error fetching expired bookings:", fetchError)
      throw fetchError
    }

    console.log(`Found ${expiredBookings?.length || 0} expired bookings to process.`)

    if (!expiredBookings || expiredBookings.length === 0) {
      return new Response(JSON.stringify({ 
        message: 'No expired bookings found.',
        abandoned_cleaned: abandonedBookings?.length || 0
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2. Process each booking
    const results = await Promise.allSettled(expiredBookings.map(async (booking) => {
      const { id, payment_intent_id, group_id, provider_name, status: currentStatus, student_id } = booking

      if (provider_name === 'asaas') {
        if (!payment_intent_id) {
          console.error(`⚠️ Asaas Booking ${id} has no payment_intent_id.`)
          if (currentStatus === 'awaiting_payment') {
            await supabaseAdmin.from('appointments').delete().eq('id', id)
            return { id, status: 'expired_deleted' }
          } else {
            await supabaseAdmin
              .from('appointments')
              .update({ status: 'expired', cancelled_reason: 'missing_pi_id' })
              .eq('id', id)
            return { id, status: 'skipped_missing_pi' }
          }
        }

        try {
          const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
          const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

          if (!asaasApiKey) {
            console.error(`❌ ASAAS_API_KEY is not defined. Skipping Asaas check for ${id}.`);
            throw new Error('Missing ASAAS_API_KEY');
          }

          const url = `${asaasApiUrl}/payments/${payment_intent_id}`;
          const response = await fetch(url, {
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error(`❌ Asaas API error for booking ${id}:`, errText);
            throw new Error(`Asaas fetch failed: ${errText}`);
          }

          const paymentData = await response.json();
          const asaasStatus = paymentData?.status?.toUpperCase();

          if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
            console.log(`🚨 Asaas payment ${payment_intent_id} is already PAID (${asaasStatus}). We will CONFIRM booking ${id} instead of expiring!`);
            
            // Auto repair to confirmed
            const { error: updateAptError } = await supabaseAdmin
              .from('appointments')
              .update({
                status: 'confirmed',
                payment_status: 'paid',
                updated_at: new Date().toISOString()
              })
              .eq('id', id);

            if (updateAptError) throw updateAptError;

            // Log tx
            try {
              await supabaseAdmin
                .from('transactions')
                .upsert({
                  payment_intent_id: payment_intent_id,
                  group_id: group_id,
                  amount: paymentData.value ? Math.round(paymentData.value * 100) : 0,
                  status: 'completed',
                  updated_at: new Date().toISOString(),
                  metadata: { provider: 'asaas', note: 'recovered_from_expired_cron' }
                }, { onConflict: 'payment_intent_id' });
            } catch (txErr) {
              console.error(`⚠️ Error logging transaction for recovered booking ${id}:`, txErr);
            }

            // Student Notification
            if (student_id) {
              await supabaseAdmin.from("notifications").upsert({
                  user_id: student_id,
                  title: "Aula Confirmada!",
                  message: "Seu pagamento foi confirmado e sua aula está agendada.",
                  type: "booking_accepted",
                  metadata: { group_id: group_id, payment_intent_id },
                  idempotency_key: `booking_accepted:asaas:${group_id}`
              }, { onConflict: 'idempotency_key' });
            }

            return { id, status: 'recovered_as_paid' };
          } else {
            console.log(`ℹ️ Booking ${id} payment in Asaas is not paid (${asaasStatus}). Proceeding with expiration/deletion.`);
            
            if (currentStatus === 'awaiting_payment') {
              const { error: deleteAptError } = await supabaseAdmin
                .from('appointments')
                .delete()
                .eq('id', id);

              if (deleteAptError) throw deleteAptError;
              return { id, status: 'expired_deleted' };
            } else {
              const { error: updateAptError } = await supabaseAdmin
                .from('appointments')
                .update({
                  status: 'expired',
                  payment_status: 'released',
                  cancelled_reason: 'auto_expired',
                  updated_at: new Date().toISOString()
                })
                .eq('id', id);

              if (updateAptError) throw updateAptError;
              return { id, status: 'expired_success' };
            }
          }
        } catch (err: any) {
          console.error(`❌ Error checking Asaas payment for booking ${id}:`, err);
          throw err;
        }
      } else {
        // Stripe flow
        if (!payment_intent_id) {
          console.error(`⚠️ Booking ${id} has no payment_intent_id. Skipping Stripe cancel.`)
          // Still mark as expired in DB to prevent loop
          await supabaseAdmin
            .from('appointments')
            .update({ status: 'expired', cancelled_reason: 'missing_pi_id' })
            .eq('id', id)
          return { id, status: 'skipped_missing_pi' }
        }

        try {
          // A. Cancel Stripe PaymentIntent
          // Idempotency key based on booking ID to prevent double cancellation issues
          await stripe.paymentIntents.cancel(payment_intent_id, {
            idempotencyKey: `auto_expire_${id}`
          })
          console.log(`✅ Cancelled PI ${payment_intent_id} for booking ${id}`)

        } catch (stripeError: any) {
          // Handle cases where it's already canceled or captured
          if (stripeError.code === 'payment_intent_unexpected_state') {
             const pi = await stripe.paymentIntents.retrieve(payment_intent_id)
             if (pi.status === 'canceled') {
               console.log(`ℹ️ PI ${payment_intent_id} already canceled. Proceeding to DB update.`)
             } else if (pi.status === 'succeeded') {
               console.error(`🚨 PI ${payment_intent_id} is SUCCEEDED but booking was pending. Manual intervention needed.`)
               // Do NOT expire the booking if money is captured.
               return { id, status: 'error_already_captured' }
             }
          } else {
             console.error(`❌ Stripe error for ${id}:`, stripeError)
             // If network error, we might want to retry later. 
             // For now, we throw to fail this promise
             throw stripeError
          }
        }

        // B. Update Appointment Status
        const { error: updateAptError } = await supabaseAdmin
          .from('appointments')
          .update({
            status: 'expired',
            payment_status: 'released',
            cancelled_reason: 'auto_expired',
            updated_at: new Date().toISOString()
          })
          .eq('id', id)
          .in('status', ['pending', 'pending_approval']) // Optimistic locking

        if (updateAptError) {
          console.error(`❌ Failed to update appointment ${id}:`, updateAptError)
          throw updateAptError
        }

        // C. Update Transaction Status
        if (payment_intent_id) {
          const { error: updateTxError } = await supabaseAdmin
            .from('transactions')
            .update({
              status: 'failed',
              description: 'Autorização expirada automaticamente'
            })
            .eq('stripe_payment_intent_id', payment_intent_id)

          if (updateTxError) {
             console.error(`⚠️ Failed to update transaction for PI ${payment_intent_id}:`, updateTxError)
          }
        }

        return { id, status: 'expired_success' }
      }
    }))

    // 3. Summary
    const successCount = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'expired_success').length
    const skippedCount = results.filter(r => r.status === 'fulfilled' && (r.value as any).status !== 'expired_success').length
    const failCount = results.filter(r => r.status === 'rejected').length
    const abandonedCount = abandonedBookings?.length || 0

    console.log(`🏁 Job finished. Success: ${successCount}, Skipped: ${skippedCount}, Failed: ${failCount}, Abandoned Cleaned: ${abandonedCount}`)

    return new Response(
      JSON.stringify({ 
        message: 'Job completed', 
        processed: expiredBookings.length,
        success: successCount,
        skipped: skippedCount,
        failed: failCount,
        abandoned_cleaned: abandonedCount,
        results 
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Critical Job Error:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
