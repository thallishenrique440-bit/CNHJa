/**
 * usePaymentState.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Official React Hook for Payment Installment States and Event Logs.
 * Consumes IPaymentStateReadService (PaymentStateReadService) and official DTOs.
 *
 * READ MODEL ONLY - NO LOCAL MONETARY CALCULATIONS OR STATE INFERENCES.
 */

import { useState, useEffect, useCallback } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '../lib/supabase';
import {
  PaymentInstallmentStateDTO,
  PaymentEventLogDTO
} from '../lib/payments/dtos/PaymentStateDTO';
import { PaymentStateReadService } from '../lib/payments/services/PaymentStateReadService';

export interface UsePaymentStateOptions {
  providerPaymentId?: string;
  appointmentId?: string;
  supabaseClient?: SupabaseClient;
  autoFetch?: boolean;
}

export function usePaymentState(options: UsePaymentStateOptions = {}) {
  const { providerPaymentId, appointmentId, supabaseClient, autoFetch = true } = options;
  const client = supabaseClient || defaultSupabase;

  const [installmentState, setInstallmentState] = useState<PaymentInstallmentStateDTO | null>(null);
  const [installmentStates, setInstallmentStates] = useState<PaymentInstallmentStateDTO[]>([]);
  const [eventLogs, setEventLogs] = useState<PaymentEventLogDTO[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const readService = new PaymentStateReadService();

  const fetchData = useCallback(async () => {
    if (!providerPaymentId && !appointmentId) {
      setInstallmentState(null);
      setInstallmentStates([]);
      setEventLogs([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (providerPaymentId) {
        const [stateRes, logsRes] = await Promise.all([
          readService.getInstallmentState(client, providerPaymentId),
          readService.getEventLogs(client, providerPaymentId)
        ]);
        setInstallmentState(stateRes);
        setEventLogs(logsRes);
      }

      if (appointmentId) {
        const statesRes = await readService.getInstallmentStatesByAppointment(client, appointmentId);
        setInstallmentStates(statesRes);
      }
    } catch (err: any) {
      setError(err?.message || 'Erro ao consultar estado do pagamento.');
    } finally {
      setLoading(false);
    }
  }, [providerPaymentId, appointmentId, client]);

  useEffect(() => {
    if (autoFetch && (providerPaymentId || appointmentId)) {
      fetchData();
    }
  }, [providerPaymentId, appointmentId, autoFetch, fetchData]);

  return {
    installmentState,
    installmentStates,
    eventLogs,
    loading,
    error,
    refresh: fetchData
  };
}
