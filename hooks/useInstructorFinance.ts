/**
 * useInstructorFinance.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official React Hook for Instructor Financial Projections and Statements.
 * Consumes IInstructorFinanceReadService (InstructorFinanceReadService) and official DTOs.
 *
 * READ MODEL ONLY - NO LOCAL MONETARY CALCULATIONS OR STATE INFERENCES.
 */

import { useState, useEffect, useCallback } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '../lib/supabase';
import {
  InstructorFinanceSummaryDTO,
  InstructorStatementEntryDTO,
  InstructorCashFlowDTO
} from '../lib/payments/dtos/InstructorFinanceDTO';
import { InstructorFinanceReadService } from '../lib/payments/services/InstructorFinanceReadService';

export interface UseInstructorFinanceOptions {
  instructorId?: string;
  supabaseClient?: SupabaseClient;
  autoFetch?: boolean;
}

export function useInstructorFinance(options: UseInstructorFinanceOptions = {}) {
  const { instructorId, supabaseClient, autoFetch = true } = options;
  const client = supabaseClient || defaultSupabase;

  const [summary, setSummary] = useState<InstructorFinanceSummaryDTO | null>(null);
  const [statement, setStatement] = useState<InstructorStatementEntryDTO[]>([]);
  const [cashFlow, setCashFlow] = useState<InstructorCashFlowDTO[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const readService = new InstructorFinanceReadService();

  const fetchData = useCallback(async () => {
    if (!instructorId) {
      setSummary(null);
      setStatement([]);
      setCashFlow([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [sumRes, statRes] = await Promise.all([
        readService.getSummary(client, instructorId),
        readService.getStatement(client, instructorId, { limit: 50 })
      ]);

      setSummary(sumRes);
      setStatement(statRes);
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar dados financeiros do instrutor.');
    } finally {
      setLoading(false);
    }
  }, [instructorId, client]);

  const fetchCashFlow = useCallback(async (startDate: string, endDate: string) => {
    if (!instructorId) return [];
    try {
      const res = await readService.getCashFlow(client, instructorId, startDate, endDate);
      setCashFlow(res);
      return res;
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar fluxo de caixa.');
      return [];
    }
  }, [instructorId, client]);

  useEffect(() => {
    if (autoFetch && instructorId) {
      fetchData();
    }
  }, [instructorId, autoFetch, fetchData]);

  return {
    summary,
    statement,
    cashFlow,
    loading,
    error,
    refresh: fetchData,
    fetchCashFlow
  };
}
