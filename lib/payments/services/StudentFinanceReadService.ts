/**
 * StudentFinanceReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Concrete implementation of IStudentFinanceReadService.
 * Reads student installments and payment states directly from official tables (payment_installments, appointments).
 *
 * READ MODEL ONLY - NO MONETARY RECALCULATIONS OR STATE INFERENCES.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { IStudentFinanceReadService } from '../interfaces/IStudentFinanceReadService.js';
import {
  StudentInstallmentDTO,
  StudentPaymentSummaryDTO,
  StudentAppointmentPaymentStateDTO
} from '../dtos/StudentFinanceDTO.js';

export class StudentFinanceReadService implements IStudentFinanceReadService {
  /**
   * Reads student payment summary from official payment_installments table.
   */
  public async getSummary(
    supabaseClient: SupabaseClient,
    studentId: string
  ): Promise<StudentPaymentSummaryDTO> {
    const { data, error } = await supabaseClient
      .from('payment_installments')
      .select('gross_amount, status')
      .eq('student_id', studentId);

    if (error || !data) {
      return {
        studentId,
        totalSpentCents: 0,
        pendingPaymentsCents: 0,
        confirmedPaymentsCount: 0,
        overduePaymentsCount: 0
      };
    }

    let totalSpentCents = 0;
    let pendingPaymentsCents = 0;
    let confirmedPaymentsCount = 0;
    let overduePaymentsCount = 0;

    for (const row of data) {
      const amount = row.gross_amount || 0;
      const status = row.status;

      if (status === 'RECEIVED' || status === 'CONFIRMED') {
        totalSpentCents += amount;
        confirmedPaymentsCount++;
      } else if (status === 'PENDING' || status === 'AUTHORIZED') {
        pendingPaymentsCents += amount;
      } else if (status === 'OVERDUE') {
        pendingPaymentsCents += amount;
        overduePaymentsCount++;
      }
    }

    return {
      studentId,
      totalSpentCents,
      pendingPaymentsCents,
      confirmedPaymentsCount,
      overduePaymentsCount
    };
  }

  /**
   * Reads student payment installments directly from payment_installments.
   */
  public async getInstallments(
    supabaseClient: SupabaseClient,
    studentId: string,
    options?: { status?: string; limit?: number; offset?: number }
  ): Promise<StudentInstallmentDTO[]> {
    let query = supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, appointment_id, instructor_id, installment_number, gross_amount, status, due_date, payment_date')
      .eq('student_id', studentId)
      .order('due_date', { ascending: false });

    if (options?.status) {
      query = query.eq('status', options.status);
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
    }

    const { data, error } = await query;
    if (error || !data) {
      return [];
    }

    return data.map((item: any) => ({
      id: item.id,
      providerPaymentId: item.provider_payment_id,
      appointmentId: item.appointment_id,
      instructorId: item.instructor_id,
      installmentNumber: item.installment_number || 1,
      totalInstallments: 1,
      amountCents: item.gross_amount || 0,
      status: item.status,
      dueDate: item.due_date,
      paymentDate: item.payment_date || undefined
    }));
  }

  /**
   * Reads payment state for a specific appointment from appointments & payment_installments.
   */
  public async getAppointmentPaymentState(
    supabaseClient: SupabaseClient,
    appointmentId: string
  ): Promise<StudentAppointmentPaymentStateDTO | null> {
    const { data: appointment, error: appErr } = await supabaseClient
      .from('appointments')
      .select('id, group_id, payment_status, price')
      .eq('id', appointmentId)
      .maybeSingle();

    if (appErr || !appointment) {
      return null;
    }

    const { data: installments } = await supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, appointment_id, instructor_id, installment_number, gross_amount, status, due_date, payment_date')
      .eq('appointment_id', appointmentId);

    const formattedInstallments: StudentInstallmentDTO[] = (installments || []).map((item: any) => ({
      id: item.id,
      providerPaymentId: item.provider_payment_id,
      appointmentId: item.appointment_id,
      instructorId: item.instructor_id,
      installmentNumber: item.installment_number || 1,
      totalInstallments: 1,
      amountCents: item.gross_amount || 0,
      status: item.status,
      dueDate: item.due_date,
      paymentDate: item.payment_date || undefined
    }));

    return {
      appointmentId: appointment.id,
      groupId: appointment.group_id || appointment.id,
      paymentStatus: appointment.payment_status || 'PENDING',
      totalAmountCents: Math.round((appointment.price || 0) * 100),
      installments: formattedInstallments
    };
  }
}
