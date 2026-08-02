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
  StudentAppointmentPaymentStateDTO,
  StudentHistoryItemDTO,
  StudentLessonDTO,
  StudentFinanceDataDTO
} from '../dtos/StudentFinanceDTO.js';

export class StudentFinanceReadService implements IStudentFinanceReadService {
  /**
   * Reads student payment summary from official payment_installments table and appointments table.
   */
  public async getSummary(
    supabaseClient: SupabaseClient,
    studentId: string
  ): Promise<StudentPaymentSummaryDTO> {
    const { data: installments, error: instErr } = await supabaseClient
      .from('payment_installments')
      .select('gross_amount, status')
      .eq('student_id', studentId);

    const { data: apptsData } = await supabaseClient
      .from('appointments')
      .select('id, date, start_time, status')
      .eq('student_id', studentId);

    let totalSpentCents = 0;
    let pendingPaymentsCents = 0;
    let confirmedPaymentsCount = 0;
    let overduePaymentsCount = 0;

    if (!instErr && installments) {
      for (const row of installments) {
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
    }

    let classesDone = 0;
    let classesScheduled = 0;
    if (apptsData) {
      for (const a of apptsData) {
        if (a.status === 'completed') {
          classesDone++;
        } else if (['confirmed', 'scheduled', 'pending', 'pending_approval', 'reserved'].includes(a.status)) {
          classesScheduled++;
        }
      }
    }

    return {
      studentId,
      totalSpentCents,
      classesDone,
      classesScheduled,
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

  /**
   * Reads full financial history for student directly from payment_installments (SSOT) enriched with appointments & instructors.
   */
  public async getHistory(
    supabaseClient: SupabaseClient,
    studentId: string
  ): Promise<StudentHistoryItemDTO[]> {
    // 1. Fetch payment installments as SSOT
    const { data: installments, error: instError } = await supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, group_id, appointment_id, instructor_id, gross_amount, fee_amount, platform_fee, net_amount, status, due_date, payment_date, created_at')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false });

    if (instError || !installments || installments.length === 0) {
      return [];
    }

    // 2. Fetch all appointments for student with instructor details
    const { data: apptsData } = await supabaseClient
      .from('appointments')
      .select(`
        id,
        group_id,
        provider_payment_id,
        date,
        start_time,
        end_time,
        status,
        price,
        instructor_id,
        instructors (
          profiles ( full_name )
        )
      `)
      .eq('student_id', studentId);

    const appointmentsMap = new Map<string, any[]>();
    (apptsData || []).forEach((appt: any) => {
      const instructorObj = Array.isArray(appt.instructors) ? appt.instructors[0] : appt.instructors;
      const fullName = instructorObj?.profiles?.full_name || 'Instrutor';
      const enrichedAppt = { ...appt, instructorName: fullName };

      // Map by provider_payment_id
      if (appt.provider_payment_id) {
        if (!appointmentsMap.has(appt.provider_payment_id)) {
          appointmentsMap.set(appt.provider_payment_id, []);
        }
        appointmentsMap.get(appt.provider_payment_id)!.push(enrichedAppt);
      }
      // Map by group_id
      if (appt.group_id && appt.group_id !== appt.provider_payment_id) {
        if (!appointmentsMap.has(appt.group_id)) {
          appointmentsMap.set(appt.group_id, []);
        }
        appointmentsMap.get(appt.group_id)!.push(enrichedAppt);
      }
      // Map by appointment id
      if (appt.id) {
        if (!appointmentsMap.has(appt.id)) {
          appointmentsMap.set(appt.id, []);
        }
        if (!appointmentsMap.get(appt.id)!.some((a: any) => a.id === appt.id)) {
          appointmentsMap.get(appt.id)!.push(enrichedAppt);
        }
      }
    });

    const historyItems: StudentHistoryItemDTO[] = installments.map((inst: any) => {
      let matchingAppts: any[] = [];
      if (inst.provider_payment_id && appointmentsMap.has(inst.provider_payment_id)) {
        matchingAppts = appointmentsMap.get(inst.provider_payment_id)!;
      } else if (inst.group_id && appointmentsMap.has(inst.group_id)) {
        matchingAppts = appointmentsMap.get(inst.group_id)!;
      } else if (inst.appointment_id && appointmentsMap.has(inst.appointment_id)) {
        matchingAppts = appointmentsMap.get(inst.appointment_id)!;
      }

      const uniqueAppts = Array.from(
        new Map(matchingAppts.map(a => [a.id, a])).values()
      ).sort((a, b) => new Date(`${a.date}T${a.start_time}`).getTime() - new Date(`${b.date}T${b.start_time}`).getTime());

      const lessonCount = uniqueAppts.length > 0 ? uniqueAppts.length : 1;
      const isCombo = lessonCount > 1;

      const firstAppt = uniqueAppts[0];
      const instructorName = firstAppt?.instructorName || 'Instrutor';

      const grossAmountCents = inst.gross_amount || 0;
      const feeAmountCents = inst.fee_amount || 0;
      const lessonPriceCents = grossAmountCents - feeAmountCents;

      let uiStatus = 'completed';
      const rawStatus = (inst.status || '').toUpperCase();
      if (['RECEIVED', 'CONFIRMED'].includes(rawStatus)) {
        uiStatus = 'completed';
      } else if (['PENDING', 'AUTHORIZED', 'OVERDUE'].includes(rawStatus)) {
        uiStatus = 'pending';
      } else if (['REFUNDED'].includes(rawStatus)) {
        uiStatus = 'refunded';
      } else if (['FAILED', 'CANCELLED'].includes(rawStatus)) {
        uiStatus = 'failed';
      }

      const lessons: StudentLessonDTO[] = uniqueAppts.map(a => ({
        id: a.id,
        date: a.date,
        startTime: a.start_time,
        endTime: a.end_time,
        status: a.status
      }));

      return {
        id: inst.id,
        providerPaymentId: inst.provider_payment_id,
        groupId: inst.group_id || firstAppt?.group_id,
        appointmentId: inst.appointment_id || firstAppt?.id,
        instructorName,
        grossAmountCents,
        feeAmountCents,
        lessonPriceCents,
        paymentMethod: inst.payment_method || 'asaas',
        dueDate: inst.due_date,
        paymentDate: inst.payment_date || undefined,
        status: uiStatus,
        combo: isCombo,
        isCombo,
        lessonCount,
        lessons,
        appointmentDate: firstAppt?.date,
        appointmentTime: firstAppt?.start_time,
        createdAt: inst.created_at || inst.payment_date || inst.due_date
      };
    });

    return historyItems;
  }

  /**
   * Returns complete student finance payload (summary + history).
   */
  public async getFinanceData(
    supabaseClient: SupabaseClient,
    studentId: string
  ): Promise<StudentFinanceDataDTO> {
    const [summary, history] = await Promise.all([
      this.getSummary(supabaseClient, studentId),
      this.getHistory(supabaseClient, studentId)
    ]);

    return { summary, history };
  }
}
