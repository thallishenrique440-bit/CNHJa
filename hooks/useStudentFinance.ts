/**
 * useStudentFinance.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official React Hook for Student Financial Payments and Appointment Payment States.
 * Consumes IStudentFinanceReadService (StudentFinanceReadService) and official DTOs.
 *
 * READ MODEL ONLY - NO LOCAL MONETARY CALCULATIONS OR STATE INFERENCES.
 */

import { useState, useEffect, useCallback } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '../lib/supabase';
import {
  StudentPaymentSummaryDTO,
  StudentInstallmentDTO,
  StudentAppointmentPaymentStateDTO
} from '../lib/payments/dtos/StudentFinanceDTO';
import { StudentFinanceReadService } from '../lib/payments/services/StudentFinanceReadService';

export interface UseStudentFinanceOptions {
  studentId?: string;
  appointmentId?: string;
  supabaseClient?: SupabaseClient;
  autoFetch?: boolean;
}

export function useStudentFinance(options: UseStudentFinanceOptions = {}) {
  const { studentId, appointmentId, supabaseClient, autoFetch = true } = options;
  const client = supabaseClient || defaultSupabase;

  const [summary, setSummary] = useState<StudentPaymentSummaryDTO | null>(null);
  const [installments, setInstallments] = useState<StudentInstallmentDTO[]>([]);
  const [appointmentPaymentState, setAppointmentPaymentState] = useState<StudentAppointmentPaymentStateDTO | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const readService = new StudentFinanceReadService();

  const fetchData = useCallback(async () => {
    if (!studentId && !appointmentId) {
      setSummary(null);
      setInstallments([]);
      setAppointmentPaymentState(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const promises: Promise<any>[] = [];

      if (studentId) {
        promises.push(readService.getSummary(client, studentId));
        promises.push(readService.getInstallments(client, studentId, { limit: 50 }));
      } else {
        promises.push(Promise.resolve(null));
        promises.push(Promise.resolve([]));
      }

      if (appointmentId) {
        promises.push(readService.getAppointmentPaymentState(client, appointmentId));
      } else {
        promises.push(Promise.resolve(null));
      }

      const [sumRes, instRes, appRes] = await Promise.all(promises);

      if (studentId) {
        setSummary(sumRes);
        setInstallments(instRes);
      }
      if (appointmentId) {
        setAppointmentPaymentState(appRes);
      }
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar dados financeiros do aluno.');
    } finally {
      setLoading(false);
    }
  }, [studentId, appointmentId, client]);

  useEffect(() => {
    if (autoFetch && (studentId || appointmentId)) {
      fetchData();
    }
  }, [studentId, appointmentId, autoFetch, fetchData]);

  return {
    summary,
    installments,
    appointmentPaymentState,
    loading,
    error,
    refresh: fetchData
  };
}
