declare const Deno: any;

import { NotificationService } from './NotificationService.ts';
import { asaasFetch } from './asaasClient.ts';
import { RefundOperationRepository } from '../../lib/payments/RefundOperationRepository.ts';
import { buildRefundOperationKey, RefundOperationKeyInput } from '../../lib/payments/RefundOperationKey.ts';

export type CancellationReason = 'instructor_rejected' | 'auto_expired' | 'student_cancelled';

export interface CancellationParams {
  appointmentId: string;
  reason: CancellationReason;
  scope?: 'SINGLE_APPOINTMENT' | 'FULL_GROUP';
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
   * SSOT for Booking Cancellations (Student Cancellation, Instructor Rejection, Auto Expiration).
   */
  static async processCancellation(params: CancellationParams): Promise<CancellationResult> {
    const { appointmentId, reason, initiatedBy, adminClient } = params;

    const getEnvVar = (name: string) => {
      try {
        if (typeof Deno !== 'undefined' && (Deno as any).env) return (Deno as any).env.get(name);
      } catch (_) {}
      try {
        if (typeof process !== 'undefined' && process.env) return process.env[name];
      } catch (_) {}
      return '';
    };

    const asaasApiKey = params.asaasApiKey || getEnvVar('ASAAS_API_KEY') || '';
    const asaasApiUrl = params.asaasApiUrl || getEnvVar('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';

    // 1. Fetch target appointment
    const { data: appointment, error: fetchError } = await adminClient
      .from('appointments')
      .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
      .eq('id', appointmentId)
      .single();

    if (fetchError || !appointment) {
      throw new Error(`Appointment not found: ${appointmentId}`);
    }

    // P0-02: Scope contract resolution
    const effectiveScope: 'SINGLE_APPOINTMENT' | 'FULL_GROUP' = params.scope ||
      (reason === 'student_cancelled' ? 'SINGLE_APPOINTMENT' : (appointment.group_id ? 'FULL_GROUP' : 'SINGLE_APPOINTMENT'));

    const lockKey = effectiveScope === 'FULL_GROUP' && appointment.group_id
      ? `group:${appointment.group_id}`
      : `apt:${appointment.id}`;

    // 2. Concurrency Lock Check
    if (activeCancellationLocks.has(lockKey)) {
      console.warn(`[BookingCancellationCore] Concurrent execution detected for ${lockKey}. Skipping.`);
      return {
        success: true,
        alreadyProcessed: true,
        reason,
        status: reason === 'instructor_rejected' ? 'cancelled' : (reason === 'auto_expired' ? 'expired' : 'cancelled'),
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
      } else if (reason === 'student_cancelled') {
        if (appointment.status === 'cancelled' || appointment.status === 'expired') {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: 'cancelled',
            paymentStatus: appointment.payment_status || 'released',
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 1,
            groupId: appointment.group_id || appointment.id,
            message: 'Appointment already cancelled'
          };
        }
      }

      const allowedStatuses = ['pending', 'pending_approval', 'awaiting_payment', 'reserved', 'confirmed', 'scheduled'];
      if (!allowedStatuses.includes(appointment.status)) {
        return {
          success: false,
          alreadyProcessed: true,
          reason,
          status: appointment.status,
          paymentStatus: appointment.payment_status || 'released',
          isPaid: appointment.payment_status === 'refunded',
          processedCount: 0,
          groupId: appointment.group_id || appointment.id,
          message: `Agendamento em estado não cancelável (status atual: ${appointment.status}).`
        };
      }

      // 4. Fetch Appointments To Cancel (P0-02 Scope Strict Enforcement)
      let appointmentsToCancel = [appointment];
      if (effectiveScope === 'FULL_GROUP' && appointment.group_id) {
        const { data: groupAppointments, error: groupError } = await adminClient
          .from('appointments')
          .select('id, status, instructor_id, student_id, payment_intent_id, provider_payment_id, provider_name, payment_status, cancelled_reason, group_id, price')
          .eq('group_id', appointment.group_id);

        if (groupError) throw new Error(`Error fetching group: ${groupError.message}`);
        if (!groupAppointments || groupAppointments.length === 0) throw new Error('Group not found');

        const activeNonCancelable = groupAppointments.filter((a: any) => !allowedStatuses.includes(a.status) && a.status !== 'cancelled' && a.status !== 'expired');
        if (activeNonCancelable.length > 0) {
          throw new Error('Este combo não pode ser cancelado pois um ou mais horários já foram processados.');
        }

        appointmentsToCancel = groupAppointments.filter((a: any) => allowedStatuses.includes(a.status));
        if (appointmentsToCancel.length === 0) {
          return {
            success: true,
            alreadyProcessed: true,
            reason,
            status: reason === 'instructor_rejected' ? 'cancelled' : (reason === 'auto_expired' ? 'expired' : 'cancelled'),
            paymentStatus: appointment.payment_status || 'released',
            isPaid: appointment.payment_status === 'refunded',
            processedCount: 0,
            groupId: appointment.group_id,
            message: 'All appointments in group are already processed'
          };
        }
      }

      const paymentId = appointment.provider_payment_id || appointment.payment_intent_id;

      // 4.5. Atomic State Lock: Transition target appointment(s) to 'cancelling' in DB
      const targetIds = appointmentsToCancel.map((a: any) => a.id);
      const { data: lockedApts, error: lockErr } = await adminClient
        .from('appointments')
        .update({ status: 'cancelling', updated_at: new Date().toISOString() })
        .in('id', targetIds)
        .in('status', allowedStatuses)
        .select('id');

      if (lockErr || !lockedApts || lockedApts.length < targetIds.length) {
        console.warn(`[BookingCancellationCore] Atomic DB lock transition failed or already acquired by another worker for ${lockKey}`);
        return {
          success: true,
          alreadyProcessed: true,
          reason,
          status: reason === 'instructor_rejected' ? 'cancelled' : (reason === 'auto_expired' ? 'expired' : 'cancelled'),
          paymentStatus: appointment.payment_status || 'released',
          isPaid: appointment.payment_status === 'refunded',
          processedCount: 0,
          groupId: appointment.group_id || appointment.id,
          message: 'Cancellation currently in progress or already processed by another worker.'
        };
      }

      // 5. Asaas Gateway Integration with Durable RefundOperation & Integer Cents Math
      let isPaid = false;
      let isRefundRequestedOrConfirmed = false;
      let isRefundConfirmed = false;

      if (paymentId && asaasApiKey) {
        console.log(`[BookingCancellationCore] Consulting Asaas payment details for ${paymentId} (reason: ${reason})`);
        const paymentUrl = `${asaasApiUrl}/payments/${paymentId}`;
        
        try {
          const paymentRes = await asaasFetch(paymentUrl, {
            method: 'GET',
            headers: {
              'access_token': asaasApiKey,
              'Content-Type': 'application/json'
            }
          });

          if (paymentRes.ok) {
            const paymentData = await paymentRes.json();
            const installmentId = paymentData.installment;
            const asaasStatus = (paymentData.status || '').toUpperCase();

            isPaid = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'].includes(asaasStatus);

            if (isPaid) {
              // P1-01: Calculate requested amount strictly in integer cents using appointment.price
              const requestedAmountCents = Math.round(
                appointmentsToCancel.reduce((sum: number, a: any) => sum + Number(a.price || 0), 0)
              );

              // Calculate total group nominal price in cents for ratio calculations
              let totalGroupNominalPriceCents = 0;
              if (appointment.group_id) {
                const { data: gApts } = await adminClient
                  .from('appointments')
                  .select('price')
                  .eq('group_id', appointment.group_id);
                if (gApts && gApts.length > 0) {
                  totalGroupNominalPriceCents = gApts.reduce((sum: number, a: any) => sum + Math.round(Number(a.price || 0)), 0);
                }
              }
              if (!totalGroupNominalPriceCents || totalGroupNominalPriceCents <= 0) {
                totalGroupNominalPriceCents = requestedAmountCents;
              }

              // P1-01: Process splits strictly in integer cents
              const splits = Array.isArray(paymentData.split) ? paymentData.split : [];
              const splitRefundsPayload: Array<{ id: string; value: number }> = [];
              const splitsForOpKey: Array<{ id: string; amountCents: number }> = [];

              if (splits.length > 0) {
                for (const s of splits) {
                  if (!s || s.status === 'CANCELED' || s.status === 'REFUNDED') continue;
                  const splitId = s.id || s.walletId || s.wallet_id;
                  if (!splitId) continue;

                  let splitRefundCents = 0;
                  let fixedValueCents = 0;

                  if (s.fixedValue !== undefined && s.fixedValue !== null) {
                    fixedValueCents = Math.round(Number(s.fixedValue) * 100);
                    const ratio = totalGroupNominalPriceCents > 0
                      ? Math.min(1, requestedAmountCents / totalGroupNominalPriceCents)
                      : 1;
                    splitRefundCents = Math.round(fixedValueCents * ratio);
                    splitRefundCents = Math.min(splitRefundCents, fixedValueCents);
                  } else if (s.percentualValue !== undefined && s.percentualValue !== null) {
                    const pct = Number(s.percentualValue);
                    splitRefundCents = Math.round((requestedAmountCents * pct) / 100);
                  }

                  splitRefundCents = Math.min(splitRefundCents, requestedAmountCents);

                  if (splitRefundCents > 0) {
                    splitsForOpKey.push({ id: String(splitId), amountCents: splitRefundCents });
                    splitRefundsPayload.push({
                      id: String(splitId),
                      value: Number((splitRefundCents / 100).toFixed(2))
                    });
                  }
                }
              }

              // Build canonical operation key
              const operationKeyInput: RefundOperationKeyInput = {
                provider: 'asaas',
                providerPaymentId: paymentId,
                providerInstallmentId: installmentId || null,
                refundScope: effectiveScope,
                items: appointmentsToCancel.map((a: any) => ({ id: a.id, amountCents: Math.round(Number(a.price || 0)) })),
                splits: splitsForOpKey,
                requestedAmountCents,
                allocationVersion: 'v1'
              };
              const operationKey = buildRefundOperationKey(operationKeyInput);

              // Check Cumulative Ceiling (AvailableBalanceCents)
              const eligiblePaymentCents = Math.round(Number(paymentData.value || 0) * 100);
              const retainedCents = await RefundOperationRepository.getRetainedAmountCents(adminClient, paymentId, operationKey);
              const availableBalanceCents = Math.max(0, eligiblePaymentCents - retainedCents);

              if (requestedAmountCents > availableBalanceCents) {
                throw new Error(`Requested refund amount (${requestedAmountCents} cents) exceeds available balance (${availableBalanceCents} cents) for payment ${paymentId}`);
              }

              // Create or Get durable RefundOperation
              let op = await RefundOperationRepository.createOrGet(adminClient, {
                operationKey,
                providerPaymentId: paymentId,
                scope: effectiveScope,
                requestedAmountCents,
                metadata: { appointmentIds: appointmentsToCancel.map((a: any) => a.id), reason }
              });

              // P0-01: Handle PENDING lease expiration & UNKNOWN state
              op = await RefundOperationRepository.handleExpiredPending(adminClient, op);

              if (op.status === 'UNKNOWN') {
                console.warn(`⚠️ [BookingCancellationCore] Operation ${op.id} is in UNKNOWN state. Direct POST /refund is BLOCKED. Pending reconciliation.`);
                isRefundRequestedOrConfirmed = true;
              } else if (op.status === 'COMPLETED' || op.status === 'PARTIALLY_COMPLETED') {
                console.log(`✅ [BookingCancellationCore] Operation ${op.id} already completed.`);
                isRefundRequestedOrConfirmed = true;
                isRefundConfirmed = op.status === 'COMPLETED';
              } else if (op.status === 'DENIED') {
                console.warn(`⚠️ [BookingCancellationCore] Operation ${op.id} was DENIED. Skipping POST retry.`);
                isRefundRequestedOrConfirmed = true;
              } else if (op.status === 'REQUESTED') {
                // Claim operation durably
                const ownerId = `worker-${crypto.randomUUID()}`;
                const leaseUntil = new Date(Date.now() + 60000).toISOString();
                const claimRes = await RefundOperationRepository.claim(adminClient, op.id, ownerId, leaseUntil);

                if (!claimRes.claimed) {
                  console.log(`ℹ️ [BookingCancellationCore] Operation ${op.id} claim lost. Handled by concurrent worker.`);
                  isRefundRequestedOrConfirmed = true;
                } else {
                  // Transition REQUESTED -> PENDING
                  await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version, 'PENDING', { sent_at: new Date().toISOString() });

                  // Issue POST /refund call to Asaas
                  const refundUrl = `${asaasApiUrl}/payments/${paymentId}/refund`;
                  const refundPayload: Record<string, any> = {
                    value: Number((requestedAmountCents / 100).toFixed(2)),
                    description: reason === 'instructor_rejected' ? 'Cancelamento por recusa do instrutor' : (reason === 'student_cancelled' ? 'Cancelamento de aula pelo aluno' : 'Cancelamento por expiração de solicitação')
                  };
                  if (splitRefundsPayload.length > 0) {
                    refundPayload.splitRefunds = splitRefundsPayload;
                  }

                  try {
                    const refundRes = await asaasFetch(refundUrl, {
                      method: 'POST',
                      headers: {
                        'access_token': asaasApiKey,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify(refundPayload)
                    });

                    if (refundRes.ok) {
                      const refundResData = await refundRes.json().catch(() => ({}));
                      await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version + 1, 'COMPLETED', {
                        completed_amount_cents: requestedAmountCents,
                        provider_refund_id: refundResData.id || null,
                        completed_at: new Date().toISOString()
                      });
                      isRefundConfirmed = true;
                      isRefundRequestedOrConfirmed = true;
                    } else {
                      const errText = await refundRes.text();
                      const is4xx = refundRes.status >= 400 && refundRes.status < 500;
                      if (is4xx) {
                        await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version + 1, 'DENIED', {
                          denial_reason: errText
                        });
                        throw new Error(`Asaas refund failed (HTTP ${refundRes.status}): ${errText}`);
                      } else {
                        await RefundOperationRepository.transition(adminClient, op.id, ownerId, op.version + 1, 'UNKNOWN', {
                          unknown_since: new Date().toISOString()
                        });
                        throw new Error(`Asaas gateway server error (HTTP ${refundRes.status}): ${errText}`);
                      }
                    }
                  } catch (netErr: any) {
                    const currentOp = await RefundOperationRepository.get(adminClient, op.id);
                    if (currentOp.status === 'PENDING') {
                      await RefundOperationRepository.transition(adminClient, op.id, ownerId, currentOp.version, 'UNKNOWN', {
                        unknown_since: new Date().toISOString()
                      });
                    }
                    throw netErr;
                  }
                }
              }
            } else {
              // UNPAID payment cancellation
              console.log(`[BookingCancellationCore] Deleting pending Asaas payment ${paymentId}`);
              const cancelUrl = `${asaasApiUrl}/payments/${paymentId}`;
              const cancelRes = await asaasFetch(cancelUrl, {
                method: 'DELETE',
                headers: {
                  'access_token': asaasApiKey,
                  'Content-Type': 'application/json'
                }
              });
              if (!cancelRes.ok) {
                const errText = await cancelRes.text();
                console.warn(`⚠️ Asaas pending payment cancel returned non-OK: ${errText}`);
              }
            }
          }
        } catch (gatewayErr: any) {
          console.error(`⚠️ Gateway operation warning for payment ${paymentId}:`, gatewayErr?.message || gatewayErr);
          if (isPaid && !isRefundRequestedOrConfirmed) throw gatewayErr;
        }
      }

      // 6. Update payment_installments table (SSOT)
      if (paymentId || appointment.group_id) {
        try {
          if (!isPaid) {
            let piQuery = adminClient.from('payment_installments').update({
              status: 'CANCELLED',
              updated_at: new Date().toISOString()
            });

            if (effectiveScope === 'SINGLE_APPOINTMENT') {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            } else if (appointment.group_id && paymentId) {
              piQuery = piQuery.or(`group_id.eq.${appointment.group_id},provider_payment_id.eq.${paymentId}`);
            } else if (appointment.group_id) {
              piQuery = piQuery.eq('group_id', appointment.group_id);
            } else {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            }

            await piQuery;
          } else if (isRefundConfirmed) {
            let piQuery = adminClient.from('payment_installments').update({
              status: 'REFUNDED',
              updated_at: new Date().toISOString()
            });

            if (effectiveScope === 'SINGLE_APPOINTMENT') {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            } else if (appointment.group_id && paymentId) {
              piQuery = piQuery.or(`group_id.eq.${appointment.group_id},provider_payment_id.eq.${paymentId}`);
            } else if (appointment.group_id) {
              piQuery = piQuery.eq('group_id', appointment.group_id);
            } else {
              piQuery = piQuery.eq('provider_payment_id', paymentId);
            }

            await piQuery;
          }
        } catch (piEx) {
          console.warn(`⚠️ Exception updating payment_installments:`, piEx);
        }
      }

      // 7. Update Financial Transactions
      if (isPaid && paymentId) {
        try {
          if (isRefundConfirmed) {
            await adminClient
              .from('transactions')
              .update({ status: 'failed' })
              .eq('provider_payment_id', paymentId)
              .eq('type', 'lesson_payment');
          }

          const refundTxStatus = isRefundConfirmed ? 'completed' : 'pending';
          for (const apt of appointmentsToCancel) {
            const gross = Math.round(Number(apt.price || 0));
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
                description: reason === 'instructor_rejected' ? 'Estorno de Aula via Asaas' : (reason === 'student_cancelled' ? 'Estorno de Aula pelo Aluno' : 'Estorno por Expiração de Solicitação'),
                metadata: {
                  provider: 'asaas',
                  note: reason,
                  refund_requested_at: new Date().toISOString(),
                  asaas_refund_status: isRefundConfirmed ? 'REFUNDED' : 'REFUND_REQUESTED'
                }
              }, { onConflict: 'appointment_id,type' });
          }
        } catch (txErr) {
          console.error(`⚠️ Error updating financial transactions:`, txErr);
        }
      }

      // 8. Update Appointments Table
      const targetStatus: 'cancelled' | 'expired' = (reason === 'instructor_rejected' || reason === 'student_cancelled') ? 'cancelled' : 'expired';
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

      const cancelIds = appointmentsToCancel.map((a: any) => a.id);
      const { error: updateError } = await adminClient
        .from('appointments')
        .update(updateData)
        .in('id', cancelIds);

      if (updateError) {
        console.error(`❌ Error updating appointments table:`, updateError.message);
        throw updateError;
      }

      // 9. Send Notifications
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
        message: 'Cancelamento e estorno processados com sucesso.'
      };

    } finally {
      activeCancellationLocks.delete(lockKey);
    }
  }
}
