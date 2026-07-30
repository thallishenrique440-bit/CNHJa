/**
 * PaymentStateReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Concrete implementation of IPaymentStateReadService.
 * Reads payment installment states and audit event logs from official tables (payment_installments, transactions).
 *
 * READ MODEL ONLY - NO MONETARY RECALCULATIONS OR STATE INFERENCES.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { IPaymentStateReadService } from '../interfaces/IPaymentStateReadService.js';
import {
  PaymentInstallmentStateDTO,
  PaymentEventLogDTO
} from '../dtos/PaymentStateDTO.js';

export class PaymentStateReadService implements IPaymentStateReadService {
  /**
   * Reads state of a specific installment by providerPaymentId.
   */
  public async getInstallmentState(
    supabaseClient: SupabaseClient,
    providerPaymentId: string
  ): Promise<PaymentInstallmentStateDTO | null> {
    const { data, error } = await supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, appointment_id, student_id, instructor_id, status, gross_amount, net_amount, platform_fee, due_date, payment_date, updated_at')
      .eq('provider_payment_id', providerPaymentId)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      providerPaymentId: data.provider_payment_id,
      appointmentId: data.appointment_id,
      studentId: data.student_id,
      instructorId: data.instructor_id,
      status: data.status,
      grossAmountCents: data.gross_amount || 0,
      netAmountCents: data.net_amount || 0,
      platformFeeCents: data.platform_fee || 0,
      dueDate: data.due_date,
      paymentDate: data.payment_date || undefined,
      lastTransitionAt: data.updated_at || new Date().toISOString()
    };
  }

  /**
   * Reads states of all installments associated with an appointment.
   */
  public async getInstallmentStatesByAppointment(
    supabaseClient: SupabaseClient,
    appointmentId: string
  ): Promise<PaymentInstallmentStateDTO[]> {
    const { data, error } = await supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, appointment_id, student_id, instructor_id, status, gross_amount, net_amount, platform_fee, due_date, payment_date, updated_at')
      .eq('appointment_id', appointmentId);

    if (error || !data) {
      return [];
    }

    return data.map((item: any) => ({
      id: item.id,
      providerPaymentId: item.provider_payment_id,
      appointmentId: item.appointment_id,
      studentId: item.student_id,
      instructorId: item.instructor_id,
      status: item.status,
      grossAmountCents: item.gross_amount || 0,
      netAmountCents: item.net_amount || 0,
      platformFeeCents: item.platform_fee || 0,
      dueDate: item.due_date,
      paymentDate: item.payment_date || undefined,
      lastTransitionAt: item.updated_at || new Date().toISOString()
    }));
  }

  /**
   * Reads audit event logs for a providerPaymentId from the transactions event ledger.
   * STRICTLY FOR AUDIT AND HISTORICAL TRAIL VISUALIZATION.
   */
  public async getEventLogs(
    supabaseClient: SupabaseClient,
    providerPaymentId: string
  ): Promise<PaymentEventLogDTO[]> {
    const { data, error } = await supabaseClient
      .from('transactions')
      .select('id, provider_payment_id, event_type, status, created_at, raw_payload')
      .eq('provider_payment_id', providerPaymentId)
      .order('created_at', { ascending: true });

    if (error || !data) {
      return [];
    }

    return data.map((item: any) => ({
      eventId: item.id,
      providerPaymentId: item.provider_payment_id,
      eventType: item.event_type || 'TRANSACTION_LOG',
      status: item.status,
      processedAt: item.created_at,
      metadata: item.raw_payload || {}
    }));
  }
}
