/**
 * EligibilityScanner.ts
 * CNHJá Financial Architecture v1.0 - Stage 8.1C
 *
 * Operational Scanner for locating candidate settlements for Payout Engine.
 * READ-ONLY SERVICE:
 * - Queries payment_settlements table.
 * - Never writes to the database.
 * - Never alters states or calculates values.
 * - Filters strictly according to official rules.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { EligibleSettlementDTO, SettlementType } from './PayoutTypes.js';
import { ScannerOptions } from './PayoutWorkerTypes.js';

export class EligibilityScanner {
  private client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  /**
   * Scans payment_settlements for candidates matching eligibility criteria.
   *
   * Filters:
   * - settlement_type = 'PAYMENT'
   * - settled_at IS NOT NULL
   * - net_amount > 0
   *
   * Ordering:
   * - ORDER BY settled_at ASC, id ASC
   *
   * Pagination:
   * - Cursor-based via limit and afterSettlementId / afterSettledAt
   */
  public async scanEligibleSettlements(
    options: ScannerOptions = {}
  ): Promise<EligibleSettlementDTO[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : 100;

    let query = this.client
      .from('payment_settlements')
      .select(`
        id,
        provider_payment_id,
        installment_id,
        settlement_type,
        gross_amount,
        net_amount,
        platform_fee,
        fee_amount,
        instructor_amount,
        settled_at,
        payment_installments (
          id,
          appointment_id,
          instructor_id,
          status
        )
      `)
      .eq('settlement_type', 'PAYMENT')
      .not('settled_at', 'is', null)
      .gt('net_amount', 0)
      .order('settled_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);

    if (options.afterSettlementId) {
      query = query.gt('id', options.afterSettlementId);
    }

    if (options.afterSettledAt) {
      query = query.gt('settled_at', options.afterSettledAt);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`EligibilityScanner query failed: ${error.message || JSON.stringify(error)}`);
    }

    if (!data || !Array.isArray(data)) {
      return [];
    }

    // Map DB rows to EligibleSettlementDTO
    return data.map((row: any) => {
      const installment = row.payment_installments || {};
      const settlementType: SettlementType = row.settlement_type || 'PAYMENT';

      return {
        id: row.id,
        providerPaymentId: row.provider_payment_id || '',
        installmentId: row.installment_id || null,
        appointmentId: installment.appointment_id || row.appointment_id || null,
        instructorId: installment.instructor_id || row.instructor_id || 'unknown_instructor',
        settlementType: settlementType,
        grossAmount: Number(row.gross_amount || 0),
        netAmount: Number(row.net_amount || 0),
        platformFee: Number(row.platform_fee || 0),
        feeAmount: Number(row.fee_amount || 0),
        instructorAmount: Number(row.instructor_amount || row.net_amount || 0),
        settledAt: row.settled_at,
        installmentStatus: installment.status || row.installment_status || null
      };
    });
  }
}
