/**
 * IInstructorFinanceReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official Interface for Instructor Financial Read Operations.
 * Abstraction layer to query projections and statements from official Sources of Truth.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  InstructorFinanceSummaryDTO,
  InstructorStatementEntryDTO,
  InstructorCashFlowDTO
} from '../dtos/InstructorFinanceDTO.js';

export interface IInstructorFinanceReadService {
  getSummary(
    supabaseClient: SupabaseClient,
    instructorId: string
  ): Promise<InstructorFinanceSummaryDTO | null>;

  getStatement(
    supabaseClient: SupabaseClient,
    instructorId: string,
    options?: { limit?: number; offset?: number; status?: string }
  ): Promise<InstructorStatementEntryDTO[]>;

  getCashFlow(
    supabaseClient: SupabaseClient,
    instructorId: string,
    startDate: string,
    endDate: string
  ): Promise<InstructorCashFlowDTO[]>;
}
