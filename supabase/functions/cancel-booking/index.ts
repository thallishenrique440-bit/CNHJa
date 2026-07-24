import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { NotificationService } from '../_shared/NotificationService.ts'
import { asaasFetch } from '../_shared/asaasClient.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Setup Clients
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing Authorization header');
    }

    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. Authentication
    const { data: { user }, error: authError } = await authClient.auth.getUser()
    if (authError || !user) {
      throw new Error('Unauthorized: Invalid user session')
    }

    const body = await req.json().catch(() => ({}))
    const { appointment_id, actor = 'student', cancel_reason, initiated_from } = body
    if (!appointment_id) {
      throw new Error('Missing appointment_id')
    }

    // 3. Fetch Appointment
    const { data: appointment, error: fetchError } = await authClient
      .from('appointments')
      .select('id, status, instructor_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, student_id, price, date, start_time')
      .eq('id', appointment_id)
      .single()

    if (fetchError || !appointment) {
      throw new Error('Appointment not found')
    }

    // Validate permission: must be student or instructor depending on actor
    if (actor === 'student') {
      if (appointment.student_id !== user.id) {
        return new Response(
          JSON.stringify({ error: 'Forbidden: You are not the student who booked this appointment' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    } else if (actor === 'instructor') {
      if (appointment.instructor_id !== user.id) {
        return new Response(
          JSON.stringify({ error: 'Forbidden: You are not the instructor for this appointment' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    } else {
      throw new Error('Invalid actor')
    }

    // Validation 1: Already cancelled or cancelling?
    if (appointment.status === 'cancelled' || appointment.status === 'cancelling') {
      return new Response(
        JSON.stringify({ message: 'Appointment already cancelled or cancellation in progress', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validation 2: Existing refund transaction?
    const { data: existingRefund, error: refundQueryError } = await adminClient
      .from('transactions')
      .select('id')
      .eq('appointment_id', appointment_id)
      .eq('type', 'refund')
      .maybeSingle()

    if (existingRefund) {
      return new Response(
        JSON.stringify({ message: 'Refund transaction already exists for this appointment', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validation 4: 24h rule validation (only for student)
    if (actor === 'student') {
      const timeStr = appointment.start_time.includes(':') 
        ? appointment.start_time.split(':').slice(0, 2).join(':') 
        : appointment.start_time;
      const lessonStart = new Date(`${appointment.date}T${timeStr}:00-03:00`);
      const now = new Date();
      const diffMs = lessonStart.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours < 24) {
        throw new Error('Faltam menos de 24h para o início da aula. Cancelamento não permitido.');
      }
    }

    // 3.5 Compare-And-Set (CAS): Atomically transition status to 'cancelling'
    const originalStatus = appointment.status;
    const { data: casAppointment, error: casError } = await adminClient
      .from('appointments')
      .update({
        status: 'cancelling',
        updated_at: new Date().toISOString()
      })
      .eq('id', appointment_id)
      .eq('status', originalStatus)
      .select('id, status')
      .maybeSingle();

    if (casError || !casAppointment) {
      return new Response(
        JSON.stringify({ message: 'Appointment cancellation is already in progress or completed', appointment }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

    console.log(JSON.stringify({
      event: "cancel_booking_start",
      provider_name: 'asaas',
      appointment_id: appointment.id,
      payment_id: paymentId,
      price: appointment.price
    }));

    let isPaid = appointment.payment_status === 'paid' || appointment.payment_status === 'received' || appointment.payment_status === 'confirmed';

    // Custom Error class to identify deterministic vs indeterminate Asaas errors
    class AsaasError extends Error {
      isDeterministic: boolean;
      statusCode: number;
      constructor(message: string, isDeterministic: boolean, statusCode: number) {
        super(message);
        this.isDeterministic = isDeterministic;
        this.statusCode = statusCode;
      }
    }

    // 4. Act on Asaas
    try {
      if (paymentId) {
        const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
        const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

        if (!asaasApiKey) {
          console.error('❌ ASAAS_API_KEY is not defined. Cannot cancel/refund Asaas payment.');
          throw new AsaasError('CONFIG_ERROR: Missing ASAAS_API_KEY', true, 500);
        }

        console.log(`[Asaas] Fetching payment details for ${paymentId}`);
        let paymentRes: Response;
        try {
          paymentRes = await asaasFetch(`${asaasApiUrl}/payments/${paymentId}`, {
            method: 'GET'
          });
        } catch (netErr: any) {
          throw new AsaasError(`Network error fetching payment: ${netErr.message}`, false, 0);
        }

        if (!paymentRes.ok) {
          const errText = await paymentRes.text();
          console.error(`❌ Failed to retrieve Asaas payment ${paymentId}: ${errText}`);
          const is4xx = paymentRes.status >= 400 && paymentRes.status < 500;
          throw new AsaasError(`Asaas verification failed: ${errText}`, is4xx, paymentRes.status);
        }

        const paymentData = await paymentRes.json();
        console.log("========== ASAAS PAYMENT ==========");
        console.log(JSON.stringify(paymentData, null, 2));

        const installmentId = paymentData.installment;
        isPaid = paymentData.status === 'RECEIVED' || paymentData.status === 'CONFIRMED';

        if (isPaid) {
          const refundValue = appointment.price / 100;
          let totalPurchaseValue = paymentData.value || 0;
          let splits = Array.isArray(paymentData.split) ? paymentData.split : [];
          let instData: any = null;

          // If this is an installment payment, retrieve total purchase value and splits from the installment resource
          if (installmentId) {
            console.log(`[Asaas] Fetching installment details for ${installmentId}`);
            let instRes: Response;
            try {
              instRes = await asaasFetch(`${asaasApiUrl}/installments/${installmentId}`, {
                method: 'GET'
              });
            } catch (netErr: any) {
              throw new AsaasError(`Network error fetching installment: ${netErr.message}`, false, 0);
            }

            if (instRes.ok) {
              instData = await instRes.json();
              console.log("========== ASAAS INSTALLMENT ==========");
              console.log(JSON.stringify(instData, null, 2));

              if (instData.value && instData.value > 0) {
                totalPurchaseValue = instData.value;
              }
              if (Array.isArray(instData.splits) && instData.splits.length > 0) {
                splits = instData.splits;
              } else if (Array.isArray(instData.split) && instData.split.length > 0) {
                splits = instData.split;
              }
            } else {
              console.warn(`⚠️ Failed to fetch installment ${installmentId}, falling back to payment value estimate.`);
              if (paymentData.value && paymentData.installmentCount) {
                totalPurchaseValue = paymentData.value * paymentData.installmentCount;
              }
            }
          }

          console.log("========== SPLIT SOURCE ==========");
          if (Array.isArray(instData?.splits) && instData.splits.length > 0) {
              console.log("SOURCE: installment.splits");
          } else if (Array.isArray(instData?.split) && instData.split.length > 0) {
              console.log("SOURCE: installment.split");
          } else {
              console.log("SOURCE: payment.split (fallback)");
          }
          console.log(JSON.stringify(splits, null, 2));

          const hasSplits = Array.isArray(splits) && splits.length > 0;
          const splitRefunds: Array<{ id: string; value: number }> = [];

          console.log("========== SPLITS USED ==========");
          if (hasSplits) {
            for (const s of splits) {
              if (!s) continue;

              console.log({
                  id: s.id,
                  walletId: s.walletId ?? s.wallet_id,
                  fixedValue: s.fixedValue,
                  percentualValue: s.percentualValue,
                  totalValue: s.totalValue,
                  status: s.status
              });

              const hasIdAndWallet = !!(s.id && (s.walletId || s.wallet_id));
              const isActive = s.status !== 'CANCELED' && s.status !== 'REFUNDED';

              if (!hasIdAndWallet || !isActive) continue;

              let splitRefundValue = 0;
              if (s.fixedValue !== undefined && s.fixedValue !== null) {
                const ratio = (totalPurchaseValue && totalPurchaseValue > 0) ? (refundValue / totalPurchaseValue) : 1;
                splitRefundValue = Number((s.fixedValue * ratio).toFixed(2));
              } else if (s.percentualValue !== undefined && s.percentualValue !== null) {
                splitRefundValue = Number((refundValue * (s.percentualValue / 100)).toFixed(2));
              }

              if (s.fixedValue !== undefined && s.fixedValue !== null) {
                splitRefundValue = Math.min(splitRefundValue, s.fixedValue);
              }

              if (splitRefundValue > 0) {
                splitRefunds.push({
                  id: s.id,
                  value: splitRefundValue
                });
              }
            }
          }

          const refundPayload: Record<string, any> = {
            value: refundValue,
            description: actor === 'instructor' ? 'Cancelamento parcial de aula pelo instrutor' : 'Cancelamento parcial de aula pelo aluno'
          };

          if (splitRefunds.length > 0) {
            refundPayload.splitRefunds = splitRefunds;
          }

          console.log("========== REFUND PAYLOAD ==========");
          console.log(JSON.stringify(refundPayload, null, 2));

          if (!installmentId) {
            console.log(`[Asaas Refund] Issuing partial refund of ${refundValue} for payment ${paymentId}. Payload:`, JSON.stringify(refundPayload));
            let refundRes: Response;
            try {
              refundRes = await asaasFetch(`${asaasApiUrl}/payments/${paymentId}/refund`, {
                method: 'POST',
                body: JSON.stringify(refundPayload)
              });
            } catch (netErr: any) {
              throw new AsaasError(`Network error issuing refund: ${netErr.message}`, false, 0);
            }

            console.log("========== REFUND RESPONSE ==========");
            console.log(refundRes.status);
            const responseBody = await refundRes.text();
            console.log(responseBody);

            if (!refundRes.ok) {
              console.error(`❌ Asaas refund failed for payment ${paymentId}. HTTP Status: ${refundRes.status}. Error: ${responseBody}`);
              const is4xx = refundRes.status >= 400 && refundRes.status < 500;
              throw new AsaasError(`Asaas refund failed: ${responseBody}`, is4xx, refundRes.status);
            }
            console.log(`✅ Asaas payment ${paymentId} partially refunded successfully.`);
          } else {
            // Installment Flow
            console.log(`[Asaas Installment Refund] Issuing partial refund of ${refundValue} for installment ${installmentId}. Payload:`, JSON.stringify(refundPayload));
            let refundRes: Response;
            try {
              refundRes = await asaasFetch(`${asaasApiUrl}/installments/${installmentId}/refund`, {
                method: 'POST',
                body: JSON.stringify(refundPayload)
              });
            } catch (netErr: any) {
              throw new AsaasError(`Network error issuing installment refund: ${netErr.message}`, false, 0);
            }

            console.log("========== REFUND RESPONSE ==========");
            console.log(refundRes.status);
            const responseBody = await refundRes.text();
            console.log(responseBody);

            if (!refundRes.ok) {
              console.error(`❌ Asaas installment refund failed for installment ${installmentId}: ${responseBody}`);
              const is4xx = refundRes.status >= 400 && refundRes.status < 500;
              throw new AsaasError(`Asaas installment refund failed: ${responseBody}`, is4xx, refundRes.status);
            }
            console.log(`✅ Asaas installment ${installmentId} partially refunded successfully.`);
          }
        } else {
          // Pending / Unpaid Flow
          if (!installmentId) {
            console.log(`[Asaas Cancel] Cancelling pending payment ${paymentId}`);
            let cancelRes: Response;
            try {
              cancelRes = await asaasFetch(`${asaasApiUrl}/payments/${paymentId}`, {
                method: 'DELETE'
              });
            } catch (netErr: any) {
              throw new AsaasError(`Network error cancelling payment: ${netErr.message}`, false, 0);
            }

            if (!cancelRes.ok) {
              const errText = await cancelRes.text();
              console.warn(`⚠️ Asaas pending payment cancel failed (may have been deleted already): ${errText}`);
            } else {
              console.log(`✅ Asaas pending payment ${paymentId} cancelled successfully.`);
            }
          } else {
            console.log(`[Asaas Installment Cancel] Cancelling pending installment ${installmentId}`);
            let cancelRes: Response;
            try {
              cancelRes = await asaasFetch(`${asaasApiUrl}/installments/${installmentId}`, {
                method: 'DELETE'
              });
            } catch (netErr: any) {
              throw new AsaasError(`Network error cancelling installment: ${netErr.message}`, false, 0);
            }

            if (!cancelRes.ok) {
              const errText = await cancelRes.text();
              console.error(`❌ Asaas installment cancellation failed for installment ${installmentId}: ${errText}`);
              const is4xx = cancelRes.status >= 400 && cancelRes.status < 500;
              throw new AsaasError(`Asaas installment cancel failed: ${errText}`, is4xx, cancelRes.status);
            }
            console.log(`✅ Asaas installment ${installmentId} cancelled successfully.`);
          }
        }
      }
    } catch (asaasError: any) {
      const isDeterministic = asaasError instanceof AsaasError ? asaasError.isDeterministic : false;
      if (isDeterministic) {
        console.warn(`⚠️ Deterministic failure from Asaas (${asaasError.message}). Performing rollback to '${originalStatus}'.`);
        await adminClient
          .from('appointments')
          .update({
            status: originalStatus,
            updated_at: new Date().toISOString()
          })
          .eq('id', appointment_id)
          .eq('status', 'cancelling');
      } else {
        console.error(`❌ Indeterminate failure from Asaas (${asaasError.message}). Keeping status as 'cancelling' for reconciliation.`);
      }
      throw asaasError;
    }

    // 5. Update appointment in DB
    const { error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: isPaid ? 'refunded' : 'released',
        cancelled_by: actor,
        cancelled_reason: cancel_reason || (actor === 'instructor' ? 'instructor_cancelled' : 'user_cancelled'),
        updated_at: new Date().toISOString()
      })
      .eq('id', appointment_id);

    if (updateError) {
      console.error(`❌ Error updating database for cancelled appointment ${appointment_id}:`, updateError.message);
      throw updateError;
    }

    // 6. Create refund transaction if paid
    if (isPaid) {
      try {
        const gross_amount = appointment.price || 0;
        const platform_fee = Math.floor(gross_amount * 0.1);
        const net_amount = gross_amount - platform_fee;

        const { error: refundTxErr } = await adminClient
          .from('transactions')
          .upsert({
            appointment_id: appointment.id,
            student_id: appointment.student_id,
            instructor_id: appointment.instructor_id,
            type: 'refund',
            amount: -gross_amount,
            gross_amount: -gross_amount,
            platform_fee: -platform_fee,
            net_amount: -net_amount,
            status: 'completed',
            provider_name: 'asaas',
            provider_payment_id: paymentId || null,
            event_date: new Date().toISOString(),
            description: 'Estorno de Aula via Asaas',
            metadata: { provider: 'asaas', note: actor === 'instructor' ? 'instructor_cancelled' : 'student_cancelled' }
          }, { onConflict: 'appointment_id,type' });

        if (refundTxErr) {
          console.error(`❌ [Cancel Booking] Error creating refund transaction:`, refundTxErr.message);
        } else {
          console.log(`✅ [Cancel Booking] Logged refund transaction for appointment ${appointment.id}`);
        }
      } catch (txErr) {
        console.error(`⚠️ [Cancel Booking] Unexpected error processing financial records:`, txErr);
      }
    }

    // 7. Send Notification
    if (actor === 'instructor' && appointment.student_id) {
      try {
        await NotificationService.sendBookingCancelled({
          userId: appointment.student_id,
          isInstructor: false,
          comboCount: 1,
          groupId: appointment.group_id || appointment.id
        });
      } catch (notifErr) {
        console.error(`⚠️ Error creating notification for cancelled booking:`, notifErr);
      }
    } else if (actor === 'student' && appointment.instructor_id) {
      try {
        await NotificationService.sendBookingCancelled({
          userId: appointment.instructor_id,
          isInstructor: true,
          comboCount: 1,
          groupId: appointment.group_id || appointment.id
        });
      } catch (notifErr) {
        console.error(`⚠️ Error creating notification for cancelled booking:`, notifErr);
      }
    }

    return new Response(
      JSON.stringify({ 
        message: 'Cancelamento e estorno processados com sucesso.', 
        status: 'cancelled',
        appointment: { ...appointment, status: 'cancelled', payment_status: isPaid ? 'refunded' : 'released' }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Error in cancel-booking:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
