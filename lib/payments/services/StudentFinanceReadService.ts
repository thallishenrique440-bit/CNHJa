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
    // 1. Fetch payment installments as SSOT for lessons
    const { data: installments } = await supabaseClient
      .from('payment_installments')
      .select('id, provider_payment_id, group_id, appointment_id, instructor_id, gross_amount, fee_amount, platform_fee, net_amount, status, due_date, payment_date, created_at, total_installments, installment_number')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false });

    // 2. Fetch tip settlements directly from payment_settlements (where installment_id IS NULL and student_id = studentId)
    let tipHistoryItems: StudentHistoryItemDTO[] = [];
    const { data: tipSettlements } = await supabaseClient
      .from('payment_settlements')
      .select(`
        id,
        provider_payment_id,
        gross_amount,
        fee_amount,
        net_amount,
        settled_at,
        created_at,
        instructor_id,
        instructors:instructor_id (
          profiles ( full_name )
        )
      `)
      .eq('student_id', studentId)
      .is('installment_id', null);

    if (tipSettlements && tipSettlements.length > 0) {
      tipHistoryItems = tipSettlements.map((ts: any) => {
        const instObj = Array.isArray(ts.instructors) ? ts.instructors[0] : ts.instructors;
        const profileObj = Array.isArray(instObj?.profiles) ? instObj?.profiles[0] : instObj?.profiles;
        const instructorName = profileObj?.full_name || 'Instrutor';

        const settledAtStr = ts.settled_at || ts.created_at || new Date().toISOString();
        const gross = ts.gross_amount || 0;
        const fee = ts.fee_amount || 0;
        return {
          id: ts.id,
          providerPaymentId: ts.provider_payment_id,
          groupId: ts.provider_payment_id,
          appointmentId: undefined,
          instructorName,
          grossAmountCents: gross,
          feeAmountCents: fee,
          lessonPriceCents: gross - fee,
          paymentMethod: 'pix',
          dueDate: settledAtStr,
          paymentDate: settledAtStr,
          status: 'completed',
          combo: false,
          isCombo: false,
          lessonCount: 0,
          lessons: [],
          appointmentDate: undefined,
          appointmentTime: undefined,
          createdAt: settledAtStr,
          receivedInstallments: 1,
          totalInstallments: 1,
          latestPaymentDate: settledAtStr
        };
      });
    }

    if ((!installments || installments.length === 0) && tipHistoryItems.length === 0) {
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

    // 3. Group installments into purchases (by group_id, provider_payment_id, or id)
    const installmentGroups = new Map<string, any[]>();
    (installments || []).forEach((inst: any) => {
      const groupKey = inst.group_id || inst.provider_payment_id || inst.id;
      if (!installmentGroups.has(groupKey)) {
        installmentGroups.set(groupKey, []);
      }
      installmentGroups.get(groupKey)!.push(inst);
    });

    const historyItems: StudentHistoryItemDTO[] = Array.from(installmentGroups.entries()).map(([groupKey, groupInsts]) => {
      // Sort group installments by installment_number
      groupInsts.sort((a, b) => (a.installment_number || 1) - (b.installment_number || 1));
      const firstInst = groupInsts[0];

      let grossAmountCents = 0;
      let feeAmountCents = 0;
      let receivedInstallments = 0;
      const totalInstallments = firstInst.total_installments || groupInsts.length;

      let latestDateMs = 0;
      let latestPaymentDateStr: string | undefined = undefined;

      let hasRefunded = false;
      let hasFailed = false;
      let hasReceivedOrConfirmed = false;

      groupInsts.forEach((inst: any) => {
        grossAmountCents += inst.gross_amount || 0;
        feeAmountCents += inst.fee_amount || 0;

        const rawStatus = (inst.status || '').toUpperCase();
        if (['RECEIVED', 'CONFIRMED', 'PAID'].includes(rawStatus)) {
          receivedInstallments++;
          hasReceivedOrConfirmed = true;
        } else if (['REFUNDED'].includes(rawStatus)) {
          hasRefunded = true;
        } else if (['FAILED', 'CANCELLED'].includes(rawStatus)) {
          hasFailed = true;
        }

        const dateCandidate = inst.payment_date || inst.created_at || inst.due_date;
        if (dateCandidate) {
          const t = new Date(dateCandidate).getTime();
          if (t > latestDateMs) {
            latestDateMs = t;
            latestPaymentDateStr = dateCandidate;
          }
        }
      });

      const lessonPriceCents = grossAmountCents - feeAmountCents;

      // Consolidate UI status for the overall purchase
      let uiStatus = 'pending';
      if (receivedInstallments >= totalInstallments && totalInstallments > 0) {
        uiStatus = 'completed';
      } else if (hasReceivedOrConfirmed) {
        uiStatus = 'completed';
      } else if (hasRefunded) {
        uiStatus = 'refunded';
      } else if (hasFailed) {
        uiStatus = 'failed';
      }

      // Collect matching appointments across installments in group
      const matchingAppts: any[] = [];
      groupInsts.forEach((inst: any) => {
        if (inst.provider_payment_id && appointmentsMap.has(inst.provider_payment_id)) {
          matchingAppts.push(...appointmentsMap.get(inst.provider_payment_id)!);
        }
        if (inst.group_id && appointmentsMap.has(inst.group_id)) {
          matchingAppts.push(...appointmentsMap.get(inst.group_id)!);
        }
        if (inst.appointment_id && appointmentsMap.has(inst.appointment_id)) {
          matchingAppts.push(...appointmentsMap.get(inst.appointment_id)!);
        }
      });
      if (appointmentsMap.has(groupKey)) {
        matchingAppts.push(...appointmentsMap.get(groupKey)!);
      }

      const uniqueAppts = Array.from(
        new Map(matchingAppts.map(a => [a.id, a])).values()
      ).sort((a, b) => new Date(`${a.date}T${a.start_time}`).getTime() - new Date(`${b.date}T${b.start_time}`).getTime());

      const lessonCount = uniqueAppts.length > 0 ? uniqueAppts.length : 1;
      const isCombo = lessonCount > 1;

      const firstAppt = uniqueAppts[0];
      const instructorName = firstAppt?.instructorName || 'Instrutor';

      const lessons: StudentLessonDTO[] = uniqueAppts.map(a => ({
        id: a.id,
        date: a.date,
        startTime: a.start_time,
        endTime: a.end_time,
        status: a.status
      }));

      const createdAtStr = firstInst.created_at || latestPaymentDateStr || firstInst.due_date;

      return {
        id: firstInst.id,
        providerPaymentId: firstInst.provider_payment_id,
        groupId: groupKey,
        appointmentId: firstInst.appointment_id || firstAppt?.id,
        instructorName,
        grossAmountCents,
        feeAmountCents,
        lessonPriceCents,
        paymentMethod: 'asaas',
        dueDate: firstInst.due_date,
        paymentDate: latestPaymentDateStr,
        status: uiStatus,
        combo: isCombo,
        isCombo,
        lessonCount,
        lessons,
        appointmentDate: firstAppt?.date,
        appointmentTime: firstAppt?.start_time,
        createdAt: createdAtStr,
        receivedInstallments,
        totalInstallments,
        latestPaymentDate: latestPaymentDateStr
      };
    });

    const allHistoryItems = [...historyItems, ...tipHistoryItems];
    allHistoryItems.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return allHistoryItems;
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
