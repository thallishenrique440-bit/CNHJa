/**
 * IPaymentStateReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Interface for Payment State Read Operations.
 * Abstraction layer to query installment state and audit event logs.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  PaymentInstallmentStateDTO,
  PaymentEventLogDTO
} from '../dtos/PaymentStateDTO.js';

export interface IPaymentStateReadService {
  getInstallmentState(
    supabaseClient: SupabaseClient,
    providerPaymentId: string
  ): Promise<PaymentInstallmentStateDTO | null>;

  getInstallmentStatesByAppointment(
    supabaseClient: SupabaseClient,
    appointmentId: string
  ): Promise<PaymentInstallmentStateDTO[]>;

  getEventLogs(
    supabaseClient: SupabaseClient,
    providerPaymentId: string
  ): Promise<PaymentEventLogDTO[]>;
}
