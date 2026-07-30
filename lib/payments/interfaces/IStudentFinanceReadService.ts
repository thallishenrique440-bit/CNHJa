/**
 * IStudentFinanceReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Interface for Student Financial Read Operations.
 * Abstraction layer to query student payments, installments, and appointment payment states.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  StudentInstallmentDTO,
  StudentPaymentSummaryDTO,
  StudentAppointmentPaymentStateDTO
} from '../dtos/StudentFinanceDTO.js';

export interface IStudentFinanceReadService {
  getSummary(
    supabaseClient: SupabaseClient,
    studentId: string
  ): Promise<StudentPaymentSummaryDTO>;

  getInstallments(
    supabaseClient: SupabaseClient,
    studentId: string,
    options?: { status?: string; limit?: number; offset?: number }
  ): Promise<StudentInstallmentDTO[]>;

  getAppointmentPaymentState(
    supabaseClient: SupabaseClient,
    appointmentId: string
  ): Promise<StudentAppointmentPaymentStateDTO | null>;
}
