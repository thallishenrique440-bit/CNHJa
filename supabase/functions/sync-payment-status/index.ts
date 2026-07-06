import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check"
import { NotificationService } from '../_shared/NotificationService.ts'

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
    console.log("🔄 Starting sync-payment-status job...")

    // 1. Find 'reserved' or 'pending_approval' appointments that have a PaymentIntent ID
    // These are the ones that might be stuck if the webhook failed or if status is desynced.
    const { data: stuckAppointments, error: fetchError } = await supabaseAdmin
      .from('appointments')
      .select('id, payment_intent_id, group_id, status, provider_name, student_id, instructor_id')
      .in('status', ['reserved', 'pending_approval', 'awaiting_payment'])
      .not('payment_intent_id', 'is', null)

    if (fetchError) {
      throw fetchError
    }

    console.log(`Found ${stuckAppointments?.length || 0} potentially stuck appointments.`)

    if (!stuckAppointments || stuckAppointments.length === 0) {
      return new Response(JSON.stringify({ message: 'No stuck appointments found.' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Group by group_id
    const groups = stuckAppointments.reduce((acc, apt) => {
      const gid = apt.group_id || `single_${apt.id}`;
      if (!acc[gid]) acc[gid] = [];
      acc[gid].push(apt);
      return acc;
    }, {} as Record<string, typeof stuckAppointments>);

    const results = await Promise.allSettled(Object.entries(groups).map(async ([groupId, groupApts]) => {
        const firstApt = groupApts[0];
        const { payment_intent_id, provider_name, student_id } = firstApt;

        let updates = {};
        let action = 'none';

        if (provider_name === 'asaas') {
          // Check if any appointment in this group is already expired, cancelled, or rejected
          const { data: allGroupApts, error: verifyError } = await supabaseAdmin
            .from('appointments')
            .select('status')
            .eq('group_id', groupId);

          if (verifyError) {
            console.error(`❌ Error verifying status for group ${groupId}:`, verifyError.message);
            return { groupId, status: 'error_verifying_group', details: verifyError.message };
          }

          const hasInvalidStatus = allGroupApts?.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
          if (hasInvalidStatus) {
            console.log(`ℹ️ Group ${groupId} contains expired/cancelled/rejected appointments. Skipping Asaas payment reconciliation to prevent overbooking.`);
            return { groupId, status: 'skipped', reason: 'group_has_invalid_status' };
          }

          // Check Asaas payment status
          const asaasApiKey = Deno.env.get('ASAAS_API_KEY') || '';
          const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

          if (!asaasApiKey) {
            console.error(`❌ ASAAS_API_KEY is not defined in Edge Function. Skipping Asaas sync for group ${groupId}.`);
            return { groupId, status: 'skipped', reason: 'missing_asaas_api_key' };
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
            console.error(`❌ Asaas API error retrieving payment ${payment_intent_id} for group ${groupId}:`, errText);
            return { groupId, status: 'error_fetching_asaas', details: errText };
          }

          const paymentData = await response.json();
          const asaasStatus = paymentData?.status?.toUpperCase();

          if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(asaasStatus)) {
            console.log(`✅ Repairing Group ${groupId}: Asaas is paid (${asaasStatus}).`);
            updates = {
              status: 'pending_approval',
              payment_status: 'paid'
            };
            action = 'repaired_succeeded';

            // Notify Instructor instead of Student (Idempotent)
            const instructor_id = firstApt.instructor_id;
            if (instructor_id) {
                try {
                    let studentName = 'Um aluno';
                    if (firstApt.student_id) {
                        const { data: profile } = await supabaseAdmin
                            .from('profiles')
                            .select('full_name')
                            .eq('id', firstApt.student_id)
                            .maybeSingle();
                        if (profile?.full_name) {
                            studentName = profile.full_name;
                        }
                    }

                    let comboCount = 1;
                    const { count } = await supabaseAdmin
                        .from('appointments')
                        .select('id', { count: 'exact', head: true })
                        .eq('group_id', groupId);
                    if (count) comboCount = count;

                    await NotificationService.sendBookingRequest({
                        instructorId: instructor_id,
                        studentName,
                        comboCount,
                        groupId
                    });
                } catch (notifErr) {
                    console.error('⚠️ [Sync job] Error notifying instructor:', notifErr);
                }
            }
          } else {
            console.log(`ℹ️ Group ${groupId}: Asaas status is ${asaasStatus}. Not paid yet.`);
            return { groupId, status: 'skipped', asaas_status: asaasStatus };
          }
        } else {
            // Check Stripe Status
            const pi = await stripe.paymentIntents.retrieve(payment_intent_id);

            if (pi.status === 'requires_capture') {
                // SUCCESS: Auth happened, but webhook missed it.
                console.log(`✅ Repairing Group ${groupId}: Stripe is authorized.`)
                updates = {
                    status: 'pending_approval',
                    payment_status: 'authorized'
                };
                action = 'repaired_authorized';

                // Notify Instructor (Idempotent)
                const instId = pi.metadata.instructor_id || firstApt.instructor_id;
                if (instId) {
                    try {
                        let studentName = 'Um aluno';
                        const studId = pi.metadata.student_id || firstApt.student_id;
                        if (studId) {
                            const { data: profile } = await supabaseAdmin
                                .from('profiles')
                                .select('full_name')
                                .eq('id', studId)
                                .maybeSingle();
                            if (profile?.full_name) {
                                studentName = profile.full_name;
                            }
                        }

                        let comboCount = 1;
                        const { count } = await supabaseAdmin
                            .from('appointments')
                            .select('id', { count: 'exact', head: true })
                            .eq('group_id', groupId);
                        if (count) comboCount = count;

                        await NotificationService.sendBookingRequest({
                            instructorId: instId,
                            studentName,
                            comboCount,
                            groupId
                        });
                    } catch (notifErr) {
                        console.error('⚠️ [Sync job] Error notifying instructor (Stripe):', notifErr);
                    }
                }

            } else if (pi.status === 'succeeded') {
                console.log(`✅ Repairing Group ${groupId}: Stripe is succeeded.`)
                updates = {
                    status: 'confirmed',
                    payment_status: 'paid'
                };
                action = 'repaired_succeeded';

                // Notify Student (Idempotent)
                const studId = pi.metadata.student_id || firstApt.student_id;
                if (studId) {
                    try {
                        let comboCount = 1;
                        const { count } = await supabaseAdmin
                            .from('appointments')
                            .select('id', { count: 'exact', head: true })
                            .eq('group_id', groupId);
                        if (count) comboCount = count;

                        await NotificationService.sendBookingAccepted({
                            studentId: studId,
                            comboCount,
                            groupId
                        });
                    } catch (notifErr) {
                        console.error('⚠️ [Sync job] Error notifying student:', notifErr);
                    }
                }
            } else if (pi.status === 'canceled') {
                console.log(`🚫 Repairing Group ${groupId}: Stripe is canceled.`)
                const reason = pi.metadata?.cancellation_reason || 'stripe_sync_canceled';
                updates = {
                    status: 'cancelled',
                    payment_status: 'released',
                    cancelled_reason: reason
                };
                action = 'repaired_canceled';

                // Notify Student (Idempotent)
                const studId = pi.metadata.student_id || firstApt.student_id;
                if (studId) {
                    try {
                        let comboCount = 1;
                        const { count } = await supabaseAdmin
                            .from('appointments')
                            .select('id', { count: 'exact', head: true })
                            .eq('group_id', groupId);
                        if (count) comboCount = count;

                        if (reason === 'instructor_rejected') {
                            await NotificationService.sendBookingRejected({
                                studentId: studId,
                                comboCount,
                                groupId
                            });
                        } else {
                            await NotificationService.sendBookingCancelled({
                                userId: studId,
                                isInstructor: false,
                                comboCount,
                                groupId
                            });
                        }
                    } catch (notifErr) {
                        console.error('⚠️ [Sync job] Error notifying student on cancellation:', notifErr);
                    }
                }
            } else {
                return { groupId, status: 'skipped', stripe_status: pi.status };
            }
        }

        if (Object.keys(updates).length > 0) {
            const { error: updateError } = await supabaseAdmin
                .from('appointments')
                .update(updates)
                .eq('group_id', groupId)
                .in('status', ['reserved', 'pending_approval', 'awaiting_payment']);
            
            if (updateError) throw updateError;
        }

        return { groupId, status: 'success', action };
    }));

    const successCount = results.filter(r => r.status === 'fulfilled').length;

    return new Response(
      JSON.stringify({ 
        message: 'Sync job completed', 
        processed: stuckAppointments.length,
        success: successCount,
        results 
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Sync Job Error:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
