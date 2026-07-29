/**
 * PayoutRepository.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1B
 *
 * Data Access Layer for Payouts.
 * Directly interfaces with PostgreSQL via Supabase RPC `record_payout_and_ledger_event`.
 * Performs DTO mapping and handles database exceptions.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RecordPayoutPayloadDTO, RecordPayoutResponseDTO } from './PayoutTypes.js';
import { PayoutRepositoryException } from './PayoutErrors.js';

export class PayoutRepository {
  private client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    if (client) {
      this.client = client;
    } else {
      const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
      this.client = createClient(url, key);
    }
  }

  /**
   * Invokes the transactional PostgreSQL RPC `record_payout_and_ledger_event`.
   * Encapsulates RPC call, maps DTO payload parameters, and wraps network/db driver errors in PayoutRepositoryException.
   */
  public async recordPayoutAndLedgerEvent(
    payload: RecordPayoutPayloadDTO
  ): Promise<RecordPayoutResponseDTO> {
    const netAmount = payload.netAmount || payload.amount;
    const grossAmount = payload.grossAmount || netAmount;
    const platformFee = payload.platformFee || 0;

    const rpcParams = {
      p_payout_key: payload.payoutKey,
      p_instructor_id: payload.instructorId,
      p_appointment_id: payload.appointmentId || null,
      p_installment_id: payload.installmentId || null,
      p_settlement_id: payload.settlementId || null,
      p_gross_amount: grossAmount,
      p_platform_fee: platformFee,
      p_net_amount: netAmount,
      p_amount: netAmount,
      p_status: payload.status,
      p_payout_mode: payload.payoutMode || 'SHADOW',
      p_provider_transfer_id: payload.providerTransferId || null,
      p_provider_status: payload.providerStatus || null,
      p_failure_reason: payload.failureReason || null,
      p_executed_at: payload.executedAt || null,
      p_ledger_event_type: payload.ledgerEventType || null,
      p_idempotency_key: payload.idempotencyKey || null,
      p_provider_event_id: payload.providerEventId || null,
      p_raw_payload: payload.rawPayload || null
    };

    try {
      const { data, error } = await this.client.rpc(
        'record_payout_and_ledger_event',
        rpcParams
      );

      if (error) {
        return {
          success: false,
          payout_key: payload.payoutKey,
          error: error.code || 'RPC_ERROR',
          message: error.message
        };
      }

      return data as RecordPayoutResponseDTO;
    } catch (err: any) {
      if (err instanceof PayoutRepositoryException) {
        throw err;
      }
      throw new PayoutRepositoryException(
        `Database communication failed during payout record execution: ${err.message}`,
        'DB_COMMUNICATION_ERROR'
      );
    }
  }
}
