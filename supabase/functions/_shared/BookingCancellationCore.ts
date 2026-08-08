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
  paymentStatus: 'refunded' | 'released' | 'failed';
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

      const allowedStatuses = ['pending', 'pending_approval', 'awaiting_payment', 'reserved'];
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

      // 5. Asaas Gateway Integration
      let isPaid = false;

      if (paymentId && asaasApiKey) {
        console.log(`[BookingCancellationCore] Consulting Asaas payment details for ${paymentId} (reason: ${reason})`);
        const paymentUrl = `${asaasApiUrl}/payments/${paymentId}`;
        
        try {
          const paymentRes = await asaasFetch(paymentUrl, { method: 'GET' });

          if (paymentRes.ok) {
            const paymentData = await paymentRes.json();
            const installmentId = paymentData.installment;
            isPaid = paymentData.status === 'RECEIVED' || paymentData.status === 'CONFIRMED';

            console.log(`[BookingCancellationCore] Asaas status: ${paymentData.status}, installment: ${installmentId || 'none'}, isPaid: ${isPaid}`);

            if (!installmentId) {
              // Single payment flow
              if (isPaid) {
                console.log(`[BookingCancellationCore] Refunding Asaas single payment ${paymentId}`);
                const refundUrl = `${asaasApiUrl}/payments/${paymentId}/refund`;
                const refundPayload: Record<string, any> = { description: reason };

                const splits = Array.isArray(paymentData.split) ? paymentData.split : [];
                if (splits.length > 0) {
                  const splitRefunds = splits
                    .map((s: any) => {
                      const item: Record<string, any> = {};
                      if (s.walletId) item.walletId = s.walletId;
                      if (s.id) item.id = s.id;
                      if (s.fixedValue !== undefined && s.fixedValue !== null) item.fixedValue = s.fixedValue;
                      if (s.percentualValue !== undefined && s.percentualValue !== null) item.percentualValue = s.percentualValue;
                      return item;
                    })
                    .filter((item: any) => item.walletId || item.id);

                  if (splitRefunds.length > 0) {
                    refundPayload.splitRefunds = splitRefunds;
                  }
                }

                const refundRes = await asaasFetch(refundUrl, {
                  method: 'POST',
                  body: JSON.stringify(refundPayload)
                });

                if (!refundRes.ok) {
                  const errText = await refundRes.text();
                  console.error(`❌ Asaas refund failed for payment ${paymentId}: ${errText}`);
                  throw new Error(`Asaas refund failed: ${errText}`);
                }
                console.log(`✅ Asaas payment ${paymentId} refunded successfully.`);
              } else {
                console.log(`[BookingCancellationCore] Deleting pending Asaas payment ${paymentId}`);
                const cancelUrl = `${asaasApiUrl}/payments/${paymentId}`;
                const cancelRes = await asaasFetch(cancelUrl, { method: 'DELETE' });

                if (!cancelRes.ok) {
                  const errText = await cancelRes.text();
                  console.warn(`⚠️ Asaas pending payment cancel returned non-OK (may already be deleted): ${errText}`);
                } else {
                  console.log(`✅ Asaas pending payment ${paymentId} cancelled successfully.`);
                }
              }
            } else {
              // Installment payment flow
              if (isPaid) {
                console.log(`[BookingCancellationCore] Refunding Asaas installment ${installmentId}`);
                const refundUrl = `${asaasApiUrl}/installments/${installmentId}/refund`;
                const refundRes = await asaasFetch(refundUrl, { method: 'POST' });

                if (!refundRes.ok) {
                  const errText = await refundRes.text();
                  console.error(`❌ Asaas installment refund failed for ${installmentId}: ${errText}`);
                  throw new Error(`Asaas installment refund failed: ${errText}`);
                }
                console.log(`✅ Asaas installment ${installmentId} refunded successfully.`);
              } else {
                console.log(`[BookingCancellationCore] Deleting pending Asaas installment ${installmentId}`);
                const cancelUrl = `${asaasApiUrl}/installments/${installmentId}`;
                const cancelRes = await asaasFetch(cancelUrl, { method: 'DELETE' });

                if (!cancelRes.ok) {
                  const errText = await cancelRes.text();
                  console.error(`❌ Asaas installment cancellation failed for ${installmentId}: ${errText}`);
                  throw new Error(`Asaas installment cancel failed: ${errText}`);
                }
                console.log(`✅ Asaas installment ${installmentId} cancelled successfully.`);
              }
            }
          } else {
            const errText = await paymentRes.text();
            console.error(`❌ Asaas verification failed for ${paymentId}: ${errText}`);
          }
        } catch (gatewayErr: any) {
          console.error(`⚠️ Gateway operation warning for payment ${paymentId}:`, gatewayErr?.message || gatewayErr);
          if (isPaid) throw gatewayErr; // Re-throw if refund failed for paid transaction
        }
      } else if (paymentId) {
        console.warn(`[BookingCancellationCore] Missing Asaas API key. Skipping gateway call for ${paymentId}.`);
      }

      // 6. Update payment_installments table (SSOT)
      if (paymentId) {
        try {
          const installmentStatus = isPaid ? 'REFUNDED' : 'CANCELLED';
          const { error: piErr } = await adminClient
            .from('payment_installments')
            .update({
              status: installmentStatus,
              updated_at: new Date().toISOString()
            })
            .eq('provider_payment_id', paymentId);

          if (piErr) {
            console.warn(`⚠️ Error updating payment_installments for ${paymentId}:`, piErr.message);
          } else {
            console.log(`✅ payment_installments updated to ${installmentStatus} for ${paymentId}`);
          }
        } catch (piEx) {
          console.warn(`⚠️ Exception updating payment_installments:`, piEx);
        }
      }

      // 7. Update Financial Transactions / Ledger (if paid)
      if (isPaid && paymentId) {
        try {
          // Mark original lesson_payment as failed/cancelled
          await adminClient
            .from('transactions')
            .update({ status: 'failed' })
            .eq('provider_payment_id', paymentId)
            .eq('type', 'lesson_payment');

          // Upsert negative refund transactions
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
                status: 'completed',
                provider_name: 'asaas',
                provider_payment_id: paymentId,
                event_date: new Date().toISOString(),
                description: reason === 'instructor_rejected' ? 'Estorno de Aula via Asaas' : 'Estorno por Expiração de Solicitação',
                metadata: { provider: 'asaas', note: reason }
              }, { onConflict: 'appointment_id,type' });
          }
          console.log(`✅ Logged refund transactions for ${appointmentsToCancel.length} appointment(s).`);
        } catch (txErr) {
          console.error(`⚠️ Error updating financial transactions:`, txErr);
        }
      }

      // 8. Update Appointments Table
      const targetStatus: 'cancelled' | 'expired' = reason === 'instructor_rejected' ? 'cancelled' : 'expired';
      const paymentStatus: 'refunded' | 'released' = isPaid ? 'refunded' : 'released';

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
        ? adminClient.from('appointments').update(updateData).eq('group_id', appointment.group_id)
        : adminClient.from('appointments').update(updateData).eq('id', appointment.id);

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
