/**
 * InstructorFinanceReadService.ts
 * CNHJá Financial Architecture v1.0 - Stage 10 (Onda 1)
 *
 * Concrete implementation of IInstructorFinanceReadService.
 * Reads exclusively from ProjectionService (instructor_financial_projections, cash_flow_projections)
 * and payment_installments table for statements.
 *
 * READ MODEL ONLY - NO MONETARY RECALCULATIONS OR STATE INFERENCES.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { IInstructorFinanceReadService } from '../interfaces/IInstructorFinanceReadService.js';
import {
  InstructorFinanceSummaryDTO,
  InstructorStatementEntryDTO,
  InstructorCashFlowDTO,
  InstructorMonthlyMetricsDTO
} from '../dtos/InstructorFinanceDTO.js';
import { ProjectionService } from '../projections/ProjectionService.js';

export class InstructorFinanceReadService implements IInstructorFinanceReadService {
  /**
   * Reads instructor projection summary directly from ProjectionService.
   */
  public async getSummary(
    supabaseClient: SupabaseClient,
    instructorId: string
  ): Promise<InstructorFinanceSummaryDTO | null> {
    const proj = await ProjectionService.getInstructorProjection(supabaseClient, instructorId);
    
    // Fetch payouts totals if present
    let pendingPayoutCents = 0;
    let totalPaidOutCents = 0;

    try {
      const { data: payouts } = await supabaseClient
        .from('payouts')
        .select('amount, status')
        .eq('instructor_id', instructorId);

      if (payouts && payouts.length > 0) {
        for (const p of payouts) {
          if (p.status === 'PROCESSING' || p.status === 'SCHEDULED' || p.status === 'PENDING') {
            pendingPayoutCents += p.amount || 0;
          } else if (p.status === 'PAID' || p.status === 'COMPLETED') {
            totalPaidOutCents += p.amount || 0;
          }
        }
      }
    } catch {
      // Payouts table query non-fatal fallback
    }

    if (!proj) {
      return {
        instructorId,
        availableBalanceCents: 0,
        futureReceivablesCents: 0,
        totalNetSettledCents: 0,
        totalGrossCents: 0,
        totalFeesCents: 0,
        pendingReleaseCents: 0,
        pendingPayoutCents,
        totalPaidOutCents,
        totalRefundsCents: 0,
        totalChargebacksCents: 0,
        totalOverdueCents: 0,
        projectionVersion: 0,
        updatedAt: new Date().toISOString()
      };
    }

    return {
      instructorId: proj.instructorId,
      availableBalanceCents: proj.settledAvailableCents,
      futureReceivablesCents: proj.futureReceivablesCents,
      totalNetSettledCents: proj.totalNetCents,
      totalGrossCents: proj.totalGrossCents,
      totalFeesCents: proj.totalPlatformFeeCents,
      pendingReleaseCents: proj.pendingReleaseCents,
      pendingPayoutCents,
      totalPaidOutCents,
      totalRefundsCents: proj.totalRefundsCents,
      totalChargebacksCents: proj.totalChargebacksCents,
      totalOverdueCents: proj.totalOverdueCents,
      projectionVersion: proj.projectionVersion,
      updatedAt: proj.updatedAt
    };
  }
  /**
   * Reads monthly financial metrics directly from payment_settlements (SSOT).
   */
  public async getMonthlyMetrics(
    supabaseClient: SupabaseClient,
    instructorId: string,
    year?: number,
    month?: number
  ): Promise<InstructorMonthlyMetricsDTO> {
    const now = new Date();
    const currentYear = year && year > 2000 ? year : now.getUTCFullYear();
    const currentMonth = month && month >= 1 && month <= 12 ? month : (now.getUTCMonth() + 1);

    const periodStart = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 0, 0, 0, 0)).toISOString();
    const periodEnd = new Date(Date.UTC(currentYear, currentMonth, 1, 0, 0, 0, 0)).toISOString();

    // Fetch all settlements (lessons, tips, refunds, chargebacks) directly from payment_settlements SSOT
    const { data } = await supabaseClient
      .from('payment_settlements')
      .select(`
        id,
        installment_id,
        appointment_id,
        settlement_type,
        gross_amount,
        net_amount,
        platform_fee,
        instructor_amount,
        settled_at,
        payment_installments (
          instructor_id,
          appointment_id
        )
      `)
      .eq('instructor_id', instructorId)
      .gte('settled_at', periodStart)
      .lt('settled_at', periodEnd);

    if (!data || data.length === 0) {
      return {
        instructorId,
        year: currentYear,
        month: currentMonth,
        periodStart,
        periodEnd,
        monthlyGrossCents: 0,
        monthlyNetCents: 0,
        monthlyPlatformFeeCents: 0,
        monthlyLessonNetCents: 0,
        monthlyTipNetCents: 0,
        settlementsCount: 0,
        updatedAt: new Date().toISOString()
      };
    }

    let monthlyGrossCents = 0;
    let monthlyNetCents = 0;
    let monthlyPlatformFeeCents = 0;
    let monthlyLessonNetCents = 0;
    let monthlyTipNetCents = 0;
    let settlementsCount = 0;

    for (const item of data) {
      const isRefundOrChargeback = item.settlement_type === 'REFUND' || item.settlement_type === 'CHARGEBACK';
      const multiplier = isRefundOrChargeback ? -1 : 1;

      const gross = (item.gross_amount || 0) * multiplier;
      const net = (item.net_amount !== undefined ? item.net_amount : (item.instructor_amount || 0)) * multiplier;
      const fee = (item.platform_fee || 0) * multiplier;

      monthlyGrossCents += gross;
      monthlyNetCents += net;
      monthlyPlatformFeeCents += fee;

      const isLesson = Boolean(item.installment_id);
      if (isLesson) {
        monthlyLessonNetCents += net;
      } else {
        monthlyTipNetCents += net;
      }
      settlementsCount += 1;
    }

    return {
      instructorId,
      year: currentYear,
      month: currentMonth,
      periodStart,
      periodEnd,
      monthlyGrossCents,
      monthlyNetCents,
      monthlyPlatformFeeCents,
      monthlyLessonNetCents,
      monthlyTipNetCents,
      settlementsCount,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Reads instructor financial statement directly from payment_settlements (SSOT for Cash Flow Movements).
   */
  public async getStatement(
    supabaseClient: SupabaseClient,
    instructorId: string,
    options?: { limit?: number; offset?: number; status?: string }
  ): Promise<InstructorStatementEntryDTO[]> {
    const settlementsTable = supabaseClient.from('payment_settlements');
    let settlementsData: any[] = [];
    
    if (settlementsTable && typeof settlementsTable.select === 'function') {
      try {
        let query = settlementsTable
          .select(`
            id,
            installment_id,
            instructor_id,
            student_id,
            appointment_id,
            provider_payment_id,
            settlement_type,
            gross_amount,
            net_amount,
            platform_fee,
            fee_amount,
            instructor_amount,
            settled_at,
            created_at,
            payment_installments (
              id,
              instructor_id,
              student_id,
              group_id,
              installment_number,
              total_installments,
              due_date,
              payment_date,
              status,
              profiles ( full_name )
            )
          `)
          .eq('instructor_id', instructorId)
          .order('settled_at', { ascending: false });

        if (options?.limit) {
          query = query.limit(options.limit);
        }
        if (options?.offset) {
          query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
        }

        const { data, error } = await query;
        if (!error && data && data.length > 0) {
          settlementsData = data;
        }
      } catch {
        // Fallback below if query throws
      }
    }

    // P-1.19: as entradas vindas de payment_settlements representam o que ja' foi
    // RECEBIDO. Elas deixam de ser o retorno direto do metodo: abaixo sao
    // combinadas com as compras existentes em payment_installments, para que uma
    // venda apareca no historico desde que existe, mesmo com 0 parcelas recebidas.
    let settlementEntries: InstructorStatementEntryDTO[] = [];

    if (settlementsData.length > 0) {
      // Enrich missing student names for direct settlements (e.g. tips)
      const missingStudentIds = Array.from(
        new Set(
          settlementsData
            .filter((s: any) => !s.payment_installments?.profiles && s.student_id)
            .map((s: any) => s.student_id)
        )
      );

      const studentNamesMap = new Map<string, string>();
      if (missingStudentIds.length > 0) {
        try {
          const { data: profs } = await supabaseClient
            .from('profiles')
            .select('id, full_name')
            .in('id', missingStudentIds);
          if (profs) {
            for (const p of profs) {
              if (p.id && p.full_name) {
                studentNamesMap.set(p.id, p.full_name);
              }
            }
          }
        } catch {
          // Non-fatal
        }
      }

      const groupsMap = new Map<string, {
        id: string;
        providerPaymentId: string;
        installmentId: string;
        studentId: string;
        studentName?: string;
        grossAmountCents: number;
        netAmountCents: number;
        platformFeeCents: number;
        feeAmountCents: number;
        commissionCnhJaCents: number;
        status: string;
        dueDate: string;
        settledAt: string;
        groupId?: string;
        totalInstallments?: number;
        settlementsCount: number;
        isTip?: boolean;
        /** P-1.21A: chave de fallback para localizar a aula. Nao e' financeiro. */
        appointmentId?: string;
      }>();

      for (const item of settlementsData) {
        const inst = item.payment_installments as any;
        const instProfile = Array.isArray(inst?.profiles) ? inst?.profiles[0] : inst?.profiles;
        const studentName = instProfile?.full_name || (item.student_id ? studentNamesMap.get(item.student_id) : undefined);

        const isTip = !item.installment_id;

        const isRefundOrChargeback = item.settlement_type === 'REFUND' || item.settlement_type === 'CHARGEBACK';
        const multiplier = isRefundOrChargeback ? -1 : 1;
        const netCents = (item.net_amount !== undefined ? item.net_amount : (item.instructor_amount || 0)) * multiplier;
        const grossCents = (item.gross_amount || 0) * multiplier;
        const feeCents = (item.platform_fee || 0) * multiplier;
        const gatewayFeeCents = (item.fee_amount || 0) * multiplier;
        const commissionCnhJaCents = this.calculateCommissionCnhJa(
          feeCents, gatewayFeeCents, grossCents, netCents);

        let status = inst?.status || 'RECEIVED';
        if (item.settlement_type === 'REFUND') status = 'REFUNDED';
        if (item.settlement_type === 'CHARGEBACK') status = 'CHARGEBACK';
        if (isTip) status = 'TIP';

        // TIPs have unique groupKey so they are NEVER merged. Lessons group by group_id or provider_payment_id.
        const groupKey = isTip ? `tip_${item.id}` : (inst?.group_id || item.provider_payment_id || item.installment_id || item.id);
        const itemSettledAt = item.settled_at || item.created_at;

        if (!groupsMap.has(groupKey)) {
          groupsMap.set(groupKey, {
            id: item.id,
            providerPaymentId: item.provider_payment_id || inst?.provider_payment_id || item.id,
            installmentId: item.installment_id || inst?.id || item.id,
            studentId: item.student_id || inst?.student_id,
            studentName,
            grossAmountCents: grossCents,
            netAmountCents: netCents,
            platformFeeCents: feeCents,
            feeAmountCents: gatewayFeeCents,
            commissionCnhJaCents,
            status,
            dueDate: inst?.due_date || itemSettledAt,
            settledAt: itemSettledAt,
            groupId: inst?.group_id || undefined,
            totalInstallments: inst?.total_installments || 1,
            settlementsCount: isRefundOrChargeback ? 0 : 1,
            isTip,
            appointmentId: item.appointment_id || undefined
          });
        } else {
          const existing = groupsMap.get(groupKey)!;
          existing.grossAmountCents += grossCents;
          existing.netAmountCents += netCents;
          existing.platformFeeCents += feeCents;
          existing.feeAmountCents += gatewayFeeCents;
          existing.commissionCnhJaCents += commissionCnhJaCents;
          if (!existing.appointmentId && item.appointment_id) {
            existing.appointmentId = item.appointment_id;
          }
          if (!isRefundOrChargeback) {
            existing.settlementsCount += 1;
          }

          if (status === 'CHARGEBACK') {
            existing.status = 'CHARGEBACK';
          } else if (status === 'REFUNDED' && existing.status !== 'CHARGEBACK') {
            existing.status = 'REFUNDED';
          }

          if (new Date(itemSettledAt).getTime() > new Date(existing.settledAt).getTime()) {
            existing.settledAt = itemSettledAt;
          }
        }
      }

      let aggregated: InstructorStatementEntryDTO[] = Array.from(groupsMap.values()).map(g => ({
        id: g.id,
        providerPaymentId: g.providerPaymentId,
        installmentId: g.installmentId,
        studentId: g.studentId,
        studentName: g.studentName,
        grossAmountCents: g.grossAmountCents,
        netAmountCents: g.netAmountCents,
        platformFeeCents: g.platformFeeCents,
        feeAmountCents: g.feeAmountCents,
        commissionCnhJaCents: g.commissionCnhJaCents,
        status: g.isTip ? 'TIP' : g.status,
        dueDate: g.dueDate,
        settledAt: g.settledAt,
        groupId: g.groupId,
        installmentNumber: g.settlementsCount,
        totalInstallments: g.totalInstallments,
        settlementsCount: g.settlementsCount,
        receivedInstallments: g.settlementsCount,
        lastSettlementDate: g.settledAt,
        isTip: g.isTip,
        appointmentId: g.appointmentId
      }));

      if (options?.status) {
        aggregated = aggregated.filter(e => e.status === options.status);
      }

      settlementEntries = aggregated;
    }

    // P-1.19 — a VENDA vem de payment_installments, nao de payment_settlements.
    //
    // Causa raiz do bug: payment_settlements so' existe depois que o dinheiro e'
    // efetivamente recebido. Usar essa tabela como fonte da venda escondia do
    // instrutor qualquer compra parcelada ainda nao liquidada — e, pior, o
    // caminho de reserva so' era acionado quando o instrutor nao tinha NENHUM
    // settlement, de modo que uma venda nova ficava invisivel para quem ja'
    // tinha historico.
    //
    // "Venda existente" e "recebimento efetivo" sao conceitos diferentes:
    //   - a venda existe assim que ha' parcelas em payment_installments;
    //   - o recebimento existe quando a parcela esta' RECEIVED.
    // Nenhum valor financeiro e' recalculado aqui, e nenhum registro e' criado.
    const installmentsTable = supabaseClient.from('payment_installments');
    if (!installmentsTable || typeof installmentsTable.select !== 'function') {
      // P-1.21A: o enriquecimento vale tambem neste caminho de saida.
      const onlySettlements = await this.attachLessons(
        supabaseClient, instructorId, settlementEntries);
      return onlySettlements.sort(
        (a, b) => new Date(b.settledAt || 0).getTime() - new Date(a.settledAt || 0).getTime()
      );
    }

    let installmentsQuery = installmentsTable
      .select('id, provider_payment_id, group_id, installment_number, total_installments, student_id, gross_amount, net_amount, platform_fee, fee_amount, status, due_date, payment_date, profiles ( full_name )')
      .eq('instructor_id', instructorId)
      .order('due_date', { ascending: false });

    if (options?.limit) {
      installmentsQuery = installmentsQuery.limit(options.limit);
    }

    const { data: installmentRows } = await installmentsQuery;

    if (!installmentRows || installmentRows.length === 0) {
      // P-1.21A: idem — sem este passo, um extrato composto apenas por
      // settlements sairia sem data nem horario da aula.
      settlementEntries = await this.attachLessons(
        supabaseClient, instructorId, settlementEntries);
      return settlementEntries.sort(
        (a, b) => new Date(b.settledAt || 0).getTime() - new Date(a.settledAt || 0).getTime()
      );
    }

    interface PurchaseAccumulator {
      firstId: string;
      providerPaymentId: string;
      groupId?: string;
      studentId: string;
      studentName?: string;
      totalInstallments: number;
      rowCount: number;
      receivedCount: number;
      receivedGrossCents: number;
      receivedNetCents: number;
      receivedPlatformFeeCents: number;
      receivedFeeAmountCents: number;
      futureNetCents: number;
      dueDate: string;
      lastPaymentDate?: string;
      statuses: string[];
    }

    const purchases = new Map<string, PurchaseAccumulator>();

    for (const row of installmentRows as any[]) {
      const key = row.group_id || row.provider_payment_id || row.id;
      const rawStatus = String(row.status || '').toUpperCase();
      const isReceived = rawStatus === 'RECEIVED';

      if (!purchases.has(key)) {
        const profileObj = Array.isArray(row?.profiles) ? row?.profiles[0] : row?.profiles;
        purchases.set(key, {
          firstId: row.id,
          providerPaymentId: row.provider_payment_id,
          groupId: row.group_id || undefined,
          studentId: row.student_id,
          studentName: profileObj?.full_name || undefined,
          totalInstallments: Number(row.total_installments) > 0 ? Number(row.total_installments) : 0,
          rowCount: 0,
          receivedCount: 0,
          receivedGrossCents: 0,
          receivedNetCents: 0,
          receivedPlatformFeeCents: 0,
          receivedFeeAmountCents: 0,
          futureNetCents: 0,
          dueDate: row.due_date,
          lastPaymentDate: undefined,
          statuses: []
        });
      }

      const acc = purchases.get(key)!;
      acc.rowCount += 1;
      acc.statuses.push(rawStatus);

      // A parcela de numero 1 define a data de referencia da compra.
      if (Number(row.installment_number) === 1 && row.due_date) {
        acc.dueDate = row.due_date;
      }

      if (isReceived) {
        acc.receivedCount += 1;
        acc.receivedGrossCents += row.gross_amount || 0;
        acc.receivedNetCents += row.net_amount || 0;
        acc.receivedPlatformFeeCents += row.platform_fee || 0;
        acc.receivedFeeAmountCents += row.fee_amount || 0;
        if (row.payment_date) {
          const current = acc.lastPaymentDate ? new Date(acc.lastPaymentDate).getTime() : 0;
          if (new Date(row.payment_date).getTime() > current) {
            acc.lastPaymentDate = row.payment_date;
          }
        }
      } else {
        // Ainda nao recebida: compoe os recebimentos futuros do instrutor.
        acc.futureNetCents += row.net_amount || 0;
      }
    }

    /** Status consolidado da compra, sem inventar estado novo. */
    const resolvePurchaseStatus = (acc: PurchaseAccumulator): string => {
      const total = acc.totalInstallments > 0 ? acc.totalInstallments : acc.rowCount;
      if (acc.statuses.includes('CHARGEBACK')) return 'CHARGEBACK';
      if (acc.statuses.every(st => st === 'REFUNDED')) return 'REFUNDED';
      if (acc.statuses.every(st => st === 'CANCELLED')) return 'CANCELLED';
      if (acc.receivedCount > 0 && acc.receivedCount >= total) return 'RECEIVED';
      if (acc.statuses.includes('CONFIRMED')) return 'CONFIRMED';
      if (acc.statuses.includes('OVERDUE')) return 'OVERDUE';
      return acc.receivedCount > 0 ? 'CONFIRMED' : 'PENDING';
    };

    const byKey = new Map<string, InstructorStatementEntryDTO>();
    for (const entry of settlementEntries) {
      byKey.set(entry.groupId || entry.providerPaymentId || entry.id, entry);
    }

    for (const [key, acc] of purchases.entries()) {
      const total = acc.totalInstallments > 0 ? acc.totalInstallments : acc.rowCount;
      const existing = byKey.get(key);

      if (existing) {
        // A venda ja' aparece via settlements (dinheiro recebido). Apenas as
        // CONTAGENS passam a vir de payment_installments, que e' a fonte da
        // compra. Os valores financeiros permanecem exatamente como estavam.
        existing.totalInstallments = total;
        existing.receivedInstallments = acc.receivedCount;
        existing.futureNetAmountCents = acc.futureNetCents;
        continue;
      }

      // Venda existente e ainda sem nenhum settlement: aparece com 0 recebidas.
      byKey.set(key, {
        id: acc.firstId,
        providerPaymentId: acc.providerPaymentId,
        installmentId: acc.firstId,
        studentId: acc.studentId,
        studentName: acc.studentName,
        grossAmountCents: acc.receivedGrossCents,
        netAmountCents: acc.receivedNetCents,
        platformFeeCents: acc.receivedPlatformFeeCents,
        feeAmountCents: acc.receivedFeeAmountCents,
        commissionCnhJaCents: this.calculateCommissionCnhJa(
          acc.receivedPlatformFeeCents,
          acc.receivedFeeAmountCents,
          acc.receivedGrossCents,
          acc.receivedNetCents
        ),
        futureNetAmountCents: acc.futureNetCents,
        status: resolvePurchaseStatus(acc),
        dueDate: acc.dueDate,
        settledAt: acc.lastPaymentDate,
        groupId: acc.groupId,
        installmentNumber: acc.receivedCount,
        totalInstallments: total,
        settlementsCount: acc.receivedCount,
        receivedInstallments: acc.receivedCount,
        lastSettlementDate: acc.lastPaymentDate
      });
    }

    let merged = Array.from(byKey.values());

    merged = await this.attachLessons(supabaseClient, instructorId, merged);

    if (options?.status) {
      merged = merged.filter(e => e.status === options.status);
    }

    return merged.sort((a, b) => {
      const aDate = a.settledAt || a.dueDate || 0;
      const bDate = b.settledAt || b.dueDate || 0;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });
  }

  /**
   * P-1.21A — ENRIQUECIMENTO COM DATA/HORARIO DA AULA.
   *
   * O historico do instrutor mostrava apenas aluno e valores, sem nenhuma
   * referencia a aula que gerou o recebimento. `payment_settlements` ja'
   * carrega `appointment_id` e o adapter (`InstructorHistoryAdapter`) ja' sabe
   * renderizar `lessons[]` — faltava so a leitura.
   *
   * Mesma semantica do historico do aluno (StudentFinanceReadService: mapa por
   * provider_payment_id, group_id e id do appointment).
   *
   * `appointments` e' usada EXCLUSIVAMENTE para apresentacao. Nenhum valor
   * financeiro e' lido, recalculado ou sobrescrito: gross/net/platform_fee/
   * fee_amount/instructor_amount continuam vindo de payment_settlements e
   * payment_installments, intactos. Falha nesta leitura NAO derruba o
   * historico — o extrato apenas segue sem a informacao da aula.
   */
  private async attachLessons(
    supabaseClient: SupabaseClient,
    instructorId: string,
    entries: InstructorStatementEntryDTO[]
  ): Promise<InstructorStatementEntryDTO[]> {
    if (entries.length === 0) return entries;

    try {
      const appointmentsTable = supabaseClient.from('appointments');
      if (!appointmentsTable || typeof appointmentsTable.select !== 'function') {
        return entries;
      }

      const { data: apptsData } = await appointmentsTable
        .select('id, group_id, provider_payment_id, date, start_time, end_time')
        .eq('instructor_id', instructorId);

      if (!apptsData || apptsData.length === 0) return entries;

      const appointmentsMap = new Map<string, any[]>();
      const push = (key: string | null | undefined, appt: any) => {
        if (!key) return;
        if (!appointmentsMap.has(key)) appointmentsMap.set(key, []);
        const bucket = appointmentsMap.get(key)!;
        if (!bucket.some((a: any) => a.id === appt.id)) bucket.push(appt);
      };

      for (const appt of apptsData as any[]) {
        push(appt.provider_payment_id, appt);
        push(appt.group_id, appt);
        push(appt.id, appt);
      }

      return entries.map(entry => {
        if (entry.isTip) return entry;

        const related =
          (entry.groupId && appointmentsMap.get(entry.groupId)) ||
          (entry.providerPaymentId && appointmentsMap.get(entry.providerPaymentId)) ||
          (entry.appointmentId && appointmentsMap.get(entry.appointmentId)) ||
          undefined;

        if (!related || related.length === 0) return entry;

        const lessons = [...related]
          .sort((a, b) =>
            `${a.date}T${a.start_time}`.localeCompare(`${b.date}T${b.start_time}`))
          .map(a => ({
            id: a.id,
            date: a.date,
            startTime: a.start_time,
            endTime: a.end_time
          }));

        return { ...entry, lessons, lessonCount: lessons.length };
      });
    } catch (err) {
      console.error('[InstructorFinanceReadService] lesson enrichment failed:', err);
      return entries;
    }
  }

  /**
   * P-1.21B — COMISSAO DA CNHJA EXIBIDA AO INSTRUTOR.
   *
   * O banco carrega DUAS semanticas diferentes de `platform_fee`, e a formula
   * anterior (`platform_fee - fee_amount`) so valia para a primeira:
   *
   *   LEGADO (ate a P-1.18E): platform_fee = comissao + taxa do gateway.
   *                           Identidade da linha:  platform_fee + net = gross
   *                           Comissao pura:        platform_fee - fee_amount
   *
   *   ATUAL  (P-1.18E em diante): platform_fee = COMISSAO PURA; a taxa do
   *                           gateway vive separada em fee_amount.
   *                           Identidade da linha:  platform_fee + fee + net = gross
   *                           Comissao pura:        platform_fee
   *
   * Aplicar a formula legada aos registros atuais subtraia a taxa do gateway de
   * uma comissao que ja' era pura — era o que exibia "R$ 8,01" numa aula de
   * R$ 100,00 cuja comissao real e' R$ 10,00.
   *
   * A ERA E' DERIVADA DA PROPRIA LINHA, nunca da data: as duas identidades sao
   * mutuamente exclusivas sempre que fee_amount > 0, e coincidem (com o mesmo
   * resultado) quando fee_amount = 0. Validado contra os 33 settlements PAYMENT
   * existentes: 23 classificados como legado, 10 como atual, 0 indeterminados.
   *
   * A identidade sobrevive a soma (o segundo chamador agrega parcelas) e ao
   * sinal negativo de REFUND/CHARGEBACK, porque e' linear nos quatro termos.
   *
   * FUNCAO PURA DE LEITURA. Nao escreve nada, nao altera nenhum valor
   * armazenado: platform_fee, fee_amount, gross_amount, net_amount e
   * instructor_amount continuam exatamente como estao no banco.
   */
  private calculateCommissionCnhJa(
    platformFeeCents: number,
    gatewayFeeCents: number,
    grossAmountCents: number,
    netAmountCents: number
  ): number {
    const p = platformFeeCents || 0;
    const f = gatewayFeeCents || 0;
    const g = grossAmountCents || 0;
    const n = netAmountCents || 0;

    // Modelo ATUAL: a taxa do gateway ja' esta fora do platform_fee.
    if (p + f + n === g) return p;

    // Modelo LEGADO: a taxa do gateway estava embutida no platform_fee.
    if (p + n === g) return p - f;

    // Nenhuma das duas identidades fecha (linha agregada entre eras, ou dado
    // incompleto). Devolve platform_fee cru: nunca credita a taxa do gateway ao
    // instrutor nem produz comissao negativa.
    return p;
  }

  /**
   * Reads cash flow projections directly from ProjectionService.
   */
  public async getCashFlow(
    supabaseClient: SupabaseClient,
    instructorId: string,
    startDate: string,
    endDate: string
  ): Promise<InstructorCashFlowDTO[]> {
    const records = await ProjectionService.getCashFlow(
      supabaseClient,
      'INSTRUCTOR',
      instructorId,
      startDate,
      endDate
    );

    return records.map((rec) => ({
      month: rec.projection_date,
      expectedInflowCents: rec.expected_inflow,
      settledInflowCents: rec.settled_inflow,
      netForecastCents: rec.expected_inflow - rec.expected_outflow
    }));
  }
}
