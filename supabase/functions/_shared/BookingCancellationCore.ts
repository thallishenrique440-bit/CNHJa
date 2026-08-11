import { NotificationService } from './NotificationService.ts'
import { asaasFetch } from './asaasClient.ts'

export type CancellationReason = 'instructor_rejected' | 'auto_expired';

export interface CancellationParams {
  appointmentId: string;
  reason: CancellationReason;
  initiatedBy?: string;
  adminClient: any;
  asaasApiKey?: string;
  asaasApiUrl?: string;
}

export interface CancellationResult {
  success: boolean;
  alreadyProcessed: boolean;
  reason: CancellationReason;
  status: 'cancelled' | 'expired';
  paymentStatus: 'refunded' | 'released' | 'failed' | 'refund_requested';
  isPaid: boolean;
  processedCount: number;
  groupId?: string;
  message: string;
}

// Technical lock in memory to prevent concurrent duplicate execution
const activeCancellationLocks = new Set<string>();

export class BookingCancellationCore {
  /**
   * SSOT for Booking Cancellations (Manual Rejection by Instructor & Auto Expiration by Timeout).
   * 
   * Unified lifecycle:
   * 1. Acquire technical lock (without modifying business status).
   * 2. Inspect appointment & purchase group state (idempotency check).
   * 3. Consult Asaas gateway (refund if paid / cancel if pending).
   * 4. Update payment_installments table.
   * 5. Record financial refund transactions / settlements (if paid).
   * 6. Update appointments table (status & payment_status).
   * 7. Dispatch user notifications.
   */
  static async processCancellation(params: CancellationParams): Promise<CancellationResult> {
    const { appointmentId, reason, initiatedBy, adminClient } = params;

    const asaasApiKey = params.asaasApiKey || Deno.env.get('ASAAS_API_KEY') || '';
    const asaasApiUrl = params.asaasApiUrl || Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

    // 1. Fetch target appointment
    const { data: appointment, error: fetchError } = await adminClient
      .from('appointments')
      .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
      .eq('id', appointmentId)
      .single();

    if (fetchError || !appointment) {
      throw new Error(`Appointment not found: ${appointmentId}`);
    }

    const lockKey = appointment.group_id ? `group:${appointment.group_id}` : `apt:${appointment.id}`;

    // 2. Concurrency Lock Check
    if (activeCancellationLocks.has(lockKey)) {
      console.warn(`[BookingCancellationCore] Concurrent execution detected for ${lockKey}. Skipping.`);
      return {
        success: true,
        alreadyProcessed: true,
        reason,
        status: reason === 'instructor_rejected' ? 'cancelled' : 'expired',
        paymentStatus: appointment.payment_status || 'released',
        isPaid: appointment.payment_status === 'refunded',
        processedCount: 0,
        groupId: appointment.group_id || appointment.id,
        message: 'Cancellation currently in progress by another task.'
      };
    }

    activeCancellationLocks.add(lockKey);

    try {
      // 3. Idempotency & Eligibility Validation
      if (reason === 'instructor_rejected') {
        if (appointment.status === 'cancelled' && appointment.cancelled_reason === 'instructor_rejected') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'cancelled',
            paymentStatus: appointment.payment_status || 'released',
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already rejected'
          };
        }
      } else if (reason === 'auto_expired') {
        if (appointment.status === 'expired') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'expired',
            paymentStatus: appointment.payment_status || 'released',
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already expired'
          };
        }
      }

      const allowedStatuses = ['pending', 'pending_approval', 'awaiting_payment', 'reserved', 'cancelling'];
      if (!allowedStatuses.includes(appointment.status)) {
        throw new Error(`Invalid status change: Cannot cancel appointment with status '${appointment.status}'`);
      }

      // 4. Fetch Group Appointments
      let appointmentsToCancel = [appointment];
      if (appointment.group_id) {
        const { data: groupAppointments, error: groupError } = await adminClient
          .from('appointments')
          .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
          .eq('group_id', appointment.group_id);

        if (groupError) throw new Error(`Error fetching group: ${groupError.message}`);
        if (!groupAppointments || groupAppointments.length === 0) throw new Error('Group not found');

        // Check for non-cancelable active statuses
        const activeNonCancelable = groupAppointments.filter((a: any) => !allowedStatuses.includes(a.status) && a.status !== 'cancelled' && a.status !== 'expired');
        if (activeNonCancelable.length > 0) {
          throw new Error('Este combo não pode ser cancelado pois um ou mais horários já foram processados.');
        }

        // Filter appointments that need cancellation
        appointmentsToCancel = groupAppointments.filter((a: any) => allowedStatuses.includes(a.status));
        if (appointmentsToCancel.length === 0) {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: reason === 'instructor_rejected' ? 'cancelled' : 'expired',
            paymentStatus: appointment.payment_status || 'released',
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 0,
            groupId: appointment.group_id,
            message: 'All appointments in group are already processed'
          };
        }
      }

      const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

      // 4.5 Atomic State Lock: Atomically claim appointment(s) by updating status to 'cancelling'
      // This prevents approve-booking from approving the appointment while we process Asaas gateway refund
      const targetIds = appointmentsToCancel.map((a: any) => a.id);

      const { data: claimedRows, error: claimError } = await adminClient
        .from('appointments')
        .update({
          status: 'cancelling',
          updated_at: new Date().toISOString()
        })
        .in('id', targetIds)
        .in('status', ['pending', 'pending_approval', 'awaiting_payment', 'reserved', 'cancelling'])
        .select('id, status');

      if (claimError) {
        console.error(`❌ [BookingCancellationCore] Error acquiring atomic cancellation lock:`, claimError.message);
        throw claimError;
      }

      if (!claimedRows || claimedRows.length === 0) {
        console.warn(`⚠️ [BookingCancellationCore] Atomic claim failed for appointment ${appointmentId} (group: ${appointment.group_id || 'none'}). Zero rows updated. Race lost to another operation.`);
        
        const { data: currentApt } = await adminClient
          .from('appointments')
          .select('status')
          .eq('id', appointmentId)
          .single();

        return {
          success: false,
          alreadyProcessed: true,
          reason,
          status: currentApt?.status || 'unknown',
          paymentStatus: appointment.payment_status || 'released',
          isPaid: appointment.payment_status === 'refunded',
          processedCount: 0,
          groupId: appointment.group_id || appointment.id,
          message: `Agendamento teve seu estado alterado por outra operação (status atual: ${currentApt?.status}).`
        };
      }

      console.log(`🔒 [BookingCancellationCore] Atomically claimed ${claimedRows.length} appointment(s) with status 'cancelling'. Proceeding to Asaas gateway processing.`);

      // 5. Asaas Gateway Integration
      let isPaid = false;
      let isRefundRequestedOrConfirmed = false;
      let isRefundConfirmed = false;

      if (paymentId && asaasApiKey) {
        console.log(`[BookingCancellationCore] Consulting Asaas payment details for ${paymentId} (reason: ${reason})`);
        const paymentUrl = `${asaasApiUrl}/payments/${paymentId}`;
        
        try {
          const paymentRes = await asaasFetch(paymentUrl, { method: 'GET' });

          if (paymentRes.ok) {
            const paymentData = await paymentRes.json();
            const installmentId = paymentData.installment;
            const asaasStatus = (paymentData.status || '').toUpperCase();

            isPaid = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'].includes(asaasStatus);
            isRefundRequestedOrConfirmed = ['REFUNDED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'].includes(asaasStatus);
            isRefundConfirmed = asaasStatus === 'REFUNDED';

            console.log(`[BookingCancellationCore] Asaas status: ${asaasStatus}, installment: ${installmentId || 'none'}, isPaid: ${isPaid}, isRefundRequestedOrConfirmed: ${isRefundRequestedOrConfirmed}, isRefundConfirmed: ${isRefundConfirmed}`);

            if (isRefundRequestedOrConfirmed) {
              console.log(`✅ [BookingCancellationCore] Payment ${paymentId} refund already requested or confirmed in Asaas (${asaasStatus}). Skipping Asaas API refund call.`);
            } else if (isPaid) {
              // Calculate total refund value in Reais
              const totalPriceCentavos = appointmentsToCancel.reduce((sum: number, a: any) => sum + (a.price || 0), 0);
              let refundValue = totalPriceCentavos > 0 
                ? Number((totalPriceCentavos / 100).toFixed(2)) 
                : (paymentData.value || 0);

              let totalPurchaseValue = paymentData.value || 0;
              let splits = Array.isArray(paymentData.split) ? paymentData.split : [];

              if (installmentId) {
                console.log(`[BookingCancellationCore] Fetching installment details for ${installmentId}`);
                try {
                  const instRes = await asaasFetch(`${asaasApiUrl}/installments/${installmentId}`, { method: 'GET' });
                  if (instRes.ok) {
                    const instData = await instRes.json();
                    if (instData.value && instData.value > 0) totalPurchaseValue = instData.value;
                    if (Array.isArray(instData.splits) && instData.splits.length > 0) splits = instData.splits;
                    else if (Array.isArray(instData.split) && instData.split.length > 0) splits = instData.split;
                  }
                } catch (instErr: any) {
                  console.warn(`⚠️ [BookingCancellationCore] Error fetching installment ${installmentId}:`, instErr?.message || instErr);
                }
              }

              // Calculate splits matching cancel-booking logic
              const splitRefunds: Array<{ id: string; value: number }> = [];
              if (Array.isArray(splits) && splits.length > 0) {
                for (const s of splits) {
                  if (!s) continue;
                  const hasIdAndWallet = !!(s.id && (s.walletId || s.wallet_id));
                  const isActive = s.status !== 'CANCELED' && s.status !== 'REFUNDED';
                  if (!hasIdAndWallet || !isActive) continue;

                  let splitRefundValue = 0;
                  if (s.fixedValue !== undefined && s.fixedValue !== null) {
                    const ratio = (totalPurchaseValue && totalPurchaseValue > 0) ? (refundValue / totalPurchaseValue) : 1;
                    splitRefundValue = Number((s.fixedValue * ratio).toFixed(2));
                    splitRefundValue = Math.min(splitRefundValue, s.fixedValue);
                  } else if (s.percentualValue !== undefined && s.percentualValue !== null) {
                    splitRefundValue = Number((refundValue * (s.percentualValue / 100)).toFixed(2));
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
                description: reason === 'instructor_rejected' ? 'Estorno por recusa do instrutor' : 'Estorno por expiração de solicitação'
              };
              if (splitRefunds.length > 0) {
                refundPayload.splitRefunds = splitRefunds;
              }

              const refundUrl = installmentId
                ? `${asaasApiUrl}/installments/${installmentId}/refund`
                : `${asaasApiUrl}/payments/${paymentId}/refund`;

              console.log(`[BookingCancellationCore] Executing Asaas refund. URL: ${refundUrl}, Payload:`, JSON.stringify(refundPayload));

              const refundRes = await asaasFetch(refundUrl, {
                method: 'POST',
                body: JSON.stringify(refundPayload)
              });

              if (!refundRes.ok) {
                const errText = await refundRes.text();
                const errLower = errText.toLowerCase();
                if (errLower.includes('already_refunded') || errLower.includes('estornada') || errLower.includes('já foi estornado')) {
                  console.warn(`⚠️ [BookingCancellationCore] Asaas returned already refunded for ${paymentId}: ${errText}. Treating as success.`);
                } else {
                  console.error(`❌ Asaas refund failed for payment ${paymentId}: ${errText}`);
                  throw new Error(`Asaas refund failed: ${errText}`);
                }
              } else {
                console.log(`✅ Asaas payment/installment ${paymentId} refunded successfully.`);
              }
            } else {
              // Pending / Unpaid Flow
              if (!installmentId) {
                console.log(`[BookingCancellationCore] Deleting pending Asaas payment ${paymentId}`);
                const cancelUrl = `${asaasApiUrl}/payments/${paymentId}`;
                const cancelRes = await asaasFetch(cancelUrl, { method: 'DELETE' });

                if (!cancelRes.ok) {
                  const errText = await cancelRes.text();
                  console.warn(`⚠️ Asaas pending payment cancel returned non-OK (may already be deleted): ${errText}`);
                } else {
                  console.log(`✅ Asaas pending payment ${paymentId} cancelled successfully.`);
                }
              } else {
                console.log(`[BookingCancellationCore] Deleting pending Asaas installment ${installmentId}`);
                const cancelUrl = `${asaasApiUrl}/installments/${installmentId}`;
                const cancelRes = await asaasFetch(cancelUrl, { method: 'DELETE' });

                if (!cancelRes.ok) {
                  const errText = await cancelRes.text();
                  console.warn(`⚠️ Asaas pending installment cancel returned non-OK: ${errText}`);
                } else {
                  console.log(`✅ Asaas pending installment ${installmentId} cancelled successfully.`);
                }
              }
            }
          } else {
            const errText = await paymentRes.text();
            console.error(`❌ Asaas verification failed for ${paymentId}: ${errText}`);
          }
        } catch (gatewayErr: any) {
          console.error(`⚠️ Gateway operation warning for payment ${paymentId}:`, gatewayErr?.message || gatewayErr);
          if (isPaid && !isRefundRequestedOrConfirmed) throw gatewayErr; // Re-throw if refund failed for paid transaction
        }
      } else if (paymentId) {
        console.warn(`[BookingCancellationCore] Missing Asaas API key. Skipping gateway call for ${paymentId}.`);
      }

      // 6. Update payment_installments table (SSOT)
      if (paymentId || appointment.group_id) {
        try {
          // Only update installment to 'REFUNDED' if Asaas confirmed the refund explicitly (status === 'REFUNDED').
          // Otherwise, if refund is pending asynchronous confirmation, leave installment in its current state.
          if (!isPaid) {
            let piQuery = adminClient
              .from('payment_installments')
              .update({
                status: 'CANCELLED',
                updated_at: new Date().toISOString()
              });

            if (appointment.group_id && paymentId) {
              piQuery = piQuery.or(`group_id.eq.${appointment.group_id},provider_payment_id.eq.${paymentId}`);
            } else if (appointment.group_id) {
              piQuery = piQuery.eq('group_id', appointment.group_id);
            } else {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            }

            const { error: piErr } = await piQuery;
            if (piErr) {
              console.warn(`⚠️ Error updating payment_installments for ${paymentId || appointment.group_id}:`, piErr.message);
            } else {
              console.log(`✅ payment_installments updated to CANCELLED for unpaid ${paymentId || appointment.group_id}`);
            }
          } else if (isRefundConfirmed) {
            let piQuery = adminClient
              .from('payment_installments')
              .update({
                status: 'REFUNDED',
                updated_at: new Date().toISOString()
              });

            if (appointment.group_id && paymentId) {
              piQuery = piQuery.or(`group_id.eq.${appointment.group_id},provider_payment_id.eq.${paymentId}`);
            } else if (appointment.group_id) {
              piQuery = piQuery.eq('group_id', appointment.group_id);
            } else {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            }

            const { error: piErr } = await piQuery;
            if (piErr) {
              console.warn(`⚠️ Error updating payment_installments for ${paymentId || appointment.group_id}:`, piErr.message);
            } else {
              console.log(`✅ payment_installments updated to REFUNDED for confirmed refund ${paymentId || appointment.group_id}`);
            }
          } else {
            console.log(`ℹ️ [BookingCancellationCore] Refund requested at Asaas for ${paymentId}. payment_installments status preserved pending async confirmation.`);
          }
        } catch (piEx) {
          console.warn(`⚠️ Exception updating payment_installments:`, piEx);
        }
      }

      // 7. Update Financial Transactions / Ledger / Projections
      if (isPaid && paymentId) {
        try {
          if (isRefundConfirmed) {
            // Mark original lesson_payment as failed/cancelled only if refund is confirmed
            await adminClient
              .from('transactions')
              .update({ status: 'failed' })
              .eq('provider_payment_id', paymentId)
              .eq('type', 'lesson_payment');
          }

          // Upsert refund transaction (pending if requested, completed if refund is confirmed)
          const refundTxStatus = isRefundConfirmed ? 'completed' : 'pending';
          for (const apt of appointmentsToCancel) {
            const gross = apt.price || 0;
            const fee = Math.floor(gross * 0.1);
            const net = gross - fee;

            await adminClient
              .from('transactions')
              .upsert({
                appointment_id: apt.id,
                student_id: apt.student_id,
                instructor_id: apt.instructor_id,
                type: 'refund',
                amount: -gross,
                gross_amount: -gross,
                platform_fee: -fee,
                net_amount: -net,
                status: refundTxStatus,
                provider_name: 'asaas',
                provider_payment_id: paymentId,
                event_date: new Date().toISOString(),
                description: reason === 'instructor_rejected' ? 'Estorno de Aula via Asaas' : 'Estorno por Expiração de Solicitação',
                metadata: {
                  provider: 'asaas',
                  note: reason,
                  refund_requested_at: new Date().toISOString(),
                  asaas_refund_status: isRefundConfirmed ? 'REFUNDED' : 'REFUND_REQUESTED'
                }
              }, { onConflict: 'appointment_id,type' });
          }
          console.log(`✅ Logged refund transactions (${refundTxStatus}) for ${appointmentsToCancel.length} appointment(s).`);
        } catch (txErr) {
          console.error(`⚠️ Error updating financial transactions:`, txErr);
        }
      } else if (!isPaid) {
        // UNPAID CHECKOUT EXPIRATION: Revert future_receivables in instructor_financial_projections
        try {
          const cancelEventId = `cancel_sched_${paymentId || appointment.group_id || appointment.id}`;
          const targetInstructorId = appointment.instructor_id;

          if (targetInstructorId) {
            const { data: currentProj } = await adminClient
              .from('instructor_financial_projections')
              .select('*')
              .eq('instructor_id', targetInstructorId)
              .maybeSingle();

            if (currentProj && currentProj.last_processed_event_id === cancelEventId) {
              console.log(`ℹ️ [BookingCancellationCore] Cancellation event ${cancelEventId} already projected for instructor ${targetInstructorId}. Skipping.`);
            } else if (currentProj) {
              const totalNetCents = appointmentsToCancel.reduce((sum: number, apt: any) => {
                const gross = apt.price || 0;
                const fee = Math.floor(gross * 0.1);
                return sum + (gross - fee);
              }, 0);

              const updatedFutureReceivables = Math.max(0, (currentProj.future_receivables || 0) - totalNetCents);

              await adminClient
                .from('instructor_financial_projections')
                .update({
                  future_receivables: updatedFutureReceivables,
                  last_processed_event_id: cancelEventId,
                  projection_version: (currentProj.projection_version || 0) + 1,
                  updated_at: new Date().toISOString()
                })
                .eq('instructor_id', targetInstructorId);

              console.log(`✅ [BookingCancellationCore] Reverted future_receivables for instructor ${targetInstructorId} by ${totalNetCents} cents (event: ${cancelEventId}). New value: ${updatedFutureReceivables}`);
            }
          }
        } catch (projErr) {
          console.error(`⚠️ Error reverting future_receivables projection:`, projErr);
        }
      }

      // 8. Update Appointments Table
      const targetStatus: 'cancelled' | 'expired' = reason === 'instructor_rejected' ? 'cancelled' : 'expired';
      const paymentStatus = isPaid ? (isRefundConfirmed ? 'refunded' : 'refund_requested') : 'released';

      const updateData: Record<string, any> = {
        status: targetStatus,
        payment_status: paymentStatus,
        cancelled_reason: reason,
        updated_at: new Date().toISOString()
      };
      if (initiatedBy) {
        updateData.updated_by = initiatedBy;
      }

      const updateFilter = appointment.group_id
        ? adminClient.from('appointments').update(updateData).eq('group_id', appointment.group_id).in('status', ['cancelling', 'pending', 'pending_approval', 'awaiting_payment', 'reserved'])
        : adminClient.from('appointments').update(updateData).eq('id', appointment.id).in('status', ['cancelling', 'pending', 'pending_approval', 'awaiting_payment', 'reserved']);

      const { error: updateError } = await updateFilter;
      if (updateError) {
        console.error(`❌ Error updating appointments table:`, updateError.message);
        throw updateError;
      }

      // 9. Send Notifications (SSOT)
      const comboCount = appointmentsToCancel.length || 1;
      const groupId = appointment.group_id || appointment.id;

      if (reason === 'instructor_rejected') {
        if (appointment.student_id) {
          try {
            await NotificationService.sendBookingRejected({
              studentId: appointment.student_id,
              comboCount,
              groupId
            });
          } catch (notifErr) {
            console.error(`⚠️ Error sending rejection notification:`, notifErr);
          }
        }
      } else if (reason === 'auto_expired') {
        try {
          if (appointment.student_id) {
            await NotificationService.sendBookingExpired({
              userId: appointment.student_id,
              isInstructor: false,
              comboCount,
              groupId
            });
          }
          if (appointment.instructor_id) {
            await NotificationService.sendBookingExpired({
              userId: appointment.instructor_id,
              isInstructor: true,
              comboCount,
              groupId
            });
          }
        } catch (notifErr) {
          console.error(`⚠️ Error sending expiry notifications:`, notifErr);
        }
      }

      return {
        success: true,
        alreadyProcessed: false,
        reason,
        status: targetStatus,
        paymentStatus,
        isPaid,
        processedCount: appointmentsToCancel.length,
        groupId,
        message: reason === 'instructor_rejected'
          ? 'Cancelamento e estorno por recusa processados com sucesso.'
          : 'Expiração de agendamento e estorno processados com sucesso.'
      };

    } finally {
      activeCancellationLocks.delete(lockKey);
    }
  }
}
