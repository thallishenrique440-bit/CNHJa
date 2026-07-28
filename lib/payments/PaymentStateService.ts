/**
 * PaymentStateService - CNHJá Financial Architecture v1.0 (Etapa 5)
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. MUST NEVER write to 'payment_settlements'. (Settlement Service domain)
 * 2. MUST NEVER write to 'payouts'. (Payout Engine domain)
 * 3. MUST NEVER modify 'appointments.status'. (Booking Engine domain)
 *    Only authorized to update projection 'appointments.payment_status'.
 * 4. MUST NEVER write 'transactions' ledger or change ledger 'processing_status'.
 *    (Event Ledger / Webhook handler domain)
 * 5. Isolation: Processes individual installment by providerPaymentId.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  ProcessPaymentEventParams,
  PaymentStateProcessingResult,
  PaymentInstallmentStatus,
  TransitionOutcome,
  PaymentWarningCode,
  AppointmentPaymentStatusProjection
} from './PaymentStateTypes.js';
import { PaymentStateMachine } from './PaymentStateMachine.js';
import { PaymentStateMapper } from './PaymentStateMapper.js';

export class PaymentStateService {
  /**
   * Main entrypoint to process a payment event and transition payment_installments state.
   */
  public static async processEvent(
    params: ProcessPaymentEventParams,
    supabaseClient?: SupabaseClient
  ): Promise<PaymentStateProcessingResult> {
    const warnings: Array<{ code: PaymentWarningCode; message: string }> = [];

    const supabase = supabaseClient || createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const providerPaymentId = params.providerPaymentId;
    const eventType = params.eventType;

    // 1. Map event to target state
    const targetState = PaymentStateMapper.mapAsaasEventToInstallmentStatus(eventType);

    if (!targetState) {
      warnings.push({
        code: PaymentWarningCode.UNMAPPED_ASAAS_EVENT,
        message: `Event '${eventType}' does not trigger a state transition for installment.`
      });

      return {
        oldState: null,
        newState: null,
        transitionExecuted: false,
        noop: true,
        noopReason: 'UNMAPPED_EVENT',
        outcome: TransitionOutcome.UNKNOWN_EVENT,
        warnings
      };
    }

    // 2. Fetch target installment from database
    let installmentQuery = supabase
      .from('payment_installments')
      .select('id, status, provider_payment_id, installment_number, appointment_id, group_id, payment_date')
      .eq('provider_payment_id', providerPaymentId);

    if (params.installmentNumber) {
      installmentQuery = installmentQuery.eq('installment_number', params.installmentNumber);
    }

    const { data: installments, error: fetchErr } = await installmentQuery;

    if (fetchErr) {
      return {
        oldState: null,
        newState: targetState,
        transitionExecuted: false,
        noop: false,
        outcome: TransitionOutcome.ERROR,
        warnings,
        processingError: `Database fetch error: ${fetchErr.message}`
      };
    }

    if (!installments || installments.length === 0) {
      warnings.push({
        code: PaymentWarningCode.PAYMENT_ID_MISMATCH,
        message: `No payment_installment found for provider_payment_id '${providerPaymentId}'`
      });

      return {
        oldState: null,
        newState: targetState,
        transitionExecuted: false,
        noop: true,
        noopReason: 'INSTALLMENT_NOT_FOUND',
        outcome: TransitionOutcome.INSTALLMENT_NOT_FOUND,
        warnings
      };
    }

    const installment = installments[0];
    const currentState = (installment.status || 'PENDING').toUpperCase() as PaymentInstallmentStatus;
    const installmentId = installment.id;
    const appointmentId = installment.appointment_id;
    const groupId = installment.group_id;

    // 3. Check for Same State / Duplicate
    if (currentState === targetState) {
      return {
        oldState: currentState,
        newState: targetState,
        transitionExecuted: false,
        noop: true,
        noopReason: 'SAME_STATE',
        outcome: TransitionOutcome.NO_OP_DUPLICATE,
        installmentId,
        appointmentId,
        groupId,
        warnings
      };
    }

    // 4. Check for Out-Of-Order / Regression
    if (PaymentStateMachine.isOutOfOrder(currentState, targetState)) {
      warnings.push({
        code: PaymentWarningCode.OUT_OF_ORDER_EVENT,
        message: `Out-of-order event '${eventType}' attempted regression from '${currentState}' to '${targetState}'. Skipped.`
      });

      return {
        oldState: currentState,
        newState: targetState,
        transitionExecuted: false,
        noop: true,
        noopReason: 'OUT_OF_ORDER_EVENT',
        outcome: TransitionOutcome.NO_OP_OUT_OF_ORDER,
        installmentId,
        appointmentId,
        groupId,
        warnings
      };
    }

    // 5. Check transition validity
    if (!PaymentStateMachine.isValidTransition(currentState, targetState)) {
      return {
        oldState: currentState,
        newState: targetState,
        transitionExecuted: false,
        noop: false,
        outcome: TransitionOutcome.INVALID_TRANSITION,
        installmentId,
        appointmentId,
        groupId,
        warnings,
        processingError: `Invalid transition from '${currentState}' to '${targetState}'`
      };
    }

    // 6. Execute state transition on payment_installments
    const now = new Date().toISOString();
    const updateFields: Record<string, unknown> = {
      status: targetState,
      updated_at: now
    };

    if ((targetState === 'CONFIRMED' || targetState === 'RECEIVED') && !installment.payment_date) {
      updateFields.payment_date = now;
    }

    const { error: updateErr } = await supabase
      .from('payment_installments')
      .update(updateFields)
      .eq('id', installmentId);

    if (updateErr) {
      return {
        oldState: currentState,
        newState: targetState,
        transitionExecuted: false,
        noop: false,
        outcome: TransitionOutcome.ERROR,
        installmentId,
        appointmentId,
        groupId,
        warnings,
        processingError: `Failed to update payment_installments: ${updateErr.message}`
      };
    }

    // 7. Update Authorized Projection on appointments.payment_status
    let projectionUpdated = false;
    let newProjection: AppointmentPaymentStatusProjection | undefined;

    if (appointmentId || groupId) {
      try {
        let relQuery = supabase.from('payment_installments').select('status');
        if (groupId) {
          relQuery = relQuery.eq('group_id', groupId);
        } else if (appointmentId) {
          relQuery = relQuery.eq('appointment_id', appointmentId);
        }

        const { data: groupInstallments } = await relQuery;
        if (groupInstallments && groupInstallments.length > 0) {
          newProjection = PaymentStateMachine.calculateAppointmentProjection(groupInstallments);

          let aptUpdateQuery = supabase
            .from('appointments')
            .update({
              payment_status: newProjection,
              updated_at: now
            });

          if (groupId) {
            aptUpdateQuery = aptUpdateQuery.eq('group_id', groupId);
          } else if (appointmentId) {
            aptUpdateQuery = aptUpdateQuery.eq('id', appointmentId);
          }

          const { error: aptErr } = await aptUpdateQuery;
          if (aptErr) {
            warnings.push({
              code: PaymentWarningCode.SUPABASE_UPDATE_WARNING,
              message: `Failed to update appointment payment_status projection: ${aptErr.message}`
            });
          } else {
            projectionUpdated = true;
          }
        }
      } catch (projErr: any) {
        warnings.push({
          code: PaymentWarningCode.SUPABASE_UPDATE_WARNING,
          message: `Projection update exception: ${projErr?.message || projErr}`
        });
      }
    }

    // 8. Update Event Ledger Metadata (Additive metadata tracking, without touching processing_status)
    if (params.ledgerId) {
      try {
        const { data: ledgerTx } = await supabase
          .from('transactions')
          .select('metadata')
          .eq('id', params.ledgerId)
          .maybeSingle();

        const currentMeta = (ledgerTx?.metadata && typeof ledgerTx.metadata === 'object') ? ledgerTx.metadata : {};
        const updatedMeta = {
          ...currentMeta,
          state_service_result: {
            old_state: currentState,
            new_state: targetState,
            transition_executed: true,
            installment_id: installmentId,
            appointment_id: appointmentId,
            projection: newProjection,
            processed_at: now
          }
        };

        await supabase
          .from('transactions')
          .update({ metadata: updatedMeta })
          .eq('id', params.ledgerId);
      } catch (ledgerMetaErr) {
        console.warn('⚠️ [PaymentStateService] Ledger metadata update non-fatal warning:', ledgerMetaErr);
      }
    }

    return {
      oldState: currentState,
      newState: targetState,
      transitionExecuted: true,
      noop: false,
      outcome: TransitionOutcome.TRANSITION_EXECUTED,
      installmentId,
      appointmentId,
      groupId,
      appointmentPaymentStatusUpdated: projectionUpdated,
      newAppointmentPaymentStatus: newProjection,
      warnings
    };
  }
}
