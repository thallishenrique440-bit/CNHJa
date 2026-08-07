/**
 * InstructorHistoryAdapter.ts
 * 
 * Adapter layer translating Instructor History / Statement Entries into HistoryCardViewModel.
 * Encapsulates ALL instructor-perspective business rules:
 * - Highlights instructor net sales ("Você recebeu")
 * - Breakdown order: Valor da aula/pacote -> Comissão CNHJá -> Taxa Asaas -> Você recebeu -> ID
 * - Never displays student gross amount as the primary highlight
 * - Integrates with HistoryCardFormatter for string and currency formatting
 * - Returns pure semantic intents ('success', 'warning', 'danger', 'info', 'neutral')
 */

import { HistoryCardViewModel, HistoryCardBreakdownItem, HistoryCardLessonItem, FinancialIntent } from '../HistoryCardViewModel';
import { HistoryCardFormatter } from '../formatters/HistoryCardFormatter';
import { formatFinanceItemPresentation } from '../../../lib/formatters/financePresentationFormatter';

export interface InstructorHistoryItemInput {
  id: string;
  timestamp?: string;
  sortDate?: string;
  type?: 'lesson' | 'tip' | 'refund' | 'combo' | 'chargeback' | string;
  isFinancial?: boolean;
  amount?: number;
  grossAmount?: number;
  platformFee?: number;
  feeAmount?: number;
  commissionCnhJaCents?: number;
  netAmount?: number;
  status: string;
  studentName: string;
  providerPayoutId?: string;
  appointmentStatus?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  isPast?: boolean;
  isCombo?: boolean;
  lessonCount?: number;
  lessons?: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    netAmount?: number;
  }[];
  groupId?: string;
  receivedInstallments?: number;
  totalInstallments?: number;
  lastSettlementDate?: string;
  dueDate?: string;
  createdAt?: string;
}

export class InstructorHistoryAdapter {
  public static toViewModel(item: InstructorHistoryItemInput): HistoryCardViewModel {
    const isCombo = Boolean(item.isCombo);
    const isTip = item.type === 'tip';
    const isRefund = item.type === 'refund' || item.status === 'refunded' || item.status === 'partially_refunded';
    const isChargeback = item.type === 'chargeback' || item.status === 'CHARGEBACK' || item.status === 'chargeback';

    const totalInst = item.totalInstallments && item.totalInstallments > 0 ? item.totalInstallments : 1;
    const recInst = typeof item.receivedInstallments === 'number' ? item.receivedInstallments : 1;

    // Use shared presentation formatter for settlement date & installment status labels
    const displayDateStr = HistoryCardFormatter.formatFullDate(item.lastSettlementDate || item.sortDate);
    const presentation = formatFinanceItemPresentation({
      status: item.status,
      type: item.type,
      totalInstallments: totalInst,
      receivedInstallments: recInst,
      dateFormatted: displayDateStr,
    });

    // Primary Net Amount Received by Instructor
    const netVal = item.netAmount !== undefined ? Math.abs(item.netAmount) : Math.abs(item.grossAmount || item.amount || 0);
    const primaryAmountFormatted = netVal !== undefined
      ? `${isRefund || isChargeback ? '-' : '+ '} ${HistoryCardFormatter.formatCurrency(netVal)}`
      : '—';

    const normalizedStatus = (item.status || '').toLowerCase();

    // Determine 5 standardized visual states
    let statusBadge: HistoryCardViewModel['status']['badge'] = undefined;
    let iconEmoji = '✅';
    let headerIntent: FinancialIntent = 'success';

    if (isChargeback || isRefund || ['refunded', 'partially_refunded', 'chargeback'].includes(normalizedStatus)) {
      statusBadge = {
        label: isChargeback ? 'Chargeback' : 'Reembolsada',
        variant: 'refunded',
      };
      iconEmoji = '↩️';
      headerIntent = 'danger';
    } else if (['pending', 'pending_approval', 'reserved', 'authorized', 'processing'].includes(normalizedStatus)) {
      statusBadge = {
        label: 'Aguardando aprovação',
        variant: 'pending',
      };
      iconEmoji = '⏳';
      headerIntent = 'warning';
    } else if (['completed', 'confirmed', 'settled', 'received'].includes(normalizedStatus)) {
      if (item.providerPayoutId) {
        statusBadge = { label: 'Transferido', variant: 'transferred' };
      } else {
        statusBadge = { label: 'Confirmada', variant: 'completed' };
      }
      iconEmoji = isTip ? '🎁' : isCombo ? '📦' : '✅';
      headerIntent = isTip ? 'warning' : 'success';
    } else if (['rejected', 'failed', 'cancelled'].includes(normalizedStatus)) {
      statusBadge = { label: 'Recusada', variant: 'failed' };
      iconEmoji = '❌';
      headerIntent = 'danger';
    } else if (['expired', 'overdue'].includes(normalizedStatus)) {
      statusBadge = { label: 'Expirada', variant: 'neutral' };
      iconEmoji = '⌛';
      headerIntent = 'neutral';
    } else {
      statusBadge = { label: item.status || 'Pendente', variant: 'neutral' };
    }

    // Title & Subtitle configuration
    let title = item.studentName;
    let subtitle: string | undefined = undefined;

    if (isRefund || isChargeback) {
      subtitle = isChargeback ? 'Chargeback' : 'Repasse estornado';
    } else if (isTip) {
      subtitle = 'Você recebeu uma gorjeta';
    } else if (isCombo) {
      subtitle = `Pacote • ${item.lessonCount ?? 0} aulas`;
    }

    // Lessons list for Combo
    let lessonItems: HistoryCardLessonItem[] | undefined = undefined;
    if (isCombo && item.lessons && item.lessons.length > 0) {
      lessonItems = item.lessons.map((l) => ({
        id: l.id,
        dateFormatted: HistoryCardFormatter.formatDateShort(l.date),
        timeRangeFormatted: HistoryCardFormatter.formatLessonTimeRange(l.startTime, l.endTime),
      }));
    }

    // Financial Breakdown Items in EXACT specified order:
    // 1. Valor da aula / pacote (preço da aula definido pelo instrutor, descontando taxa de processamento Asaas paga pelo aluno)
    // 2. Comissão CNHJá
    // 3. Você recebeu
    // 4. ID da Compra / ID
    const breakdownItems: HistoryCardBreakdownItem[] = [];

    const lessonGross = HistoryCardFormatter.calculateInstructorLessonGross(
      item.grossAmount || 0,
      item.feeAmount,
      item.platformFee,
      item.commissionCnhJaCents
    );

    if (lessonGross > 0) {
      breakdownItems.push({
        label: isCombo ? 'Valor do pacote:' : 'Valor da aula:',
        valueFormatted: HistoryCardFormatter.formatCurrency(lessonGross),
      });
    }

    const commissionCnhJa = item.commissionCnhJaCents ?? item.platformFee ?? 0;
    if (commissionCnhJa > 0 && !isTip) {
      breakdownItems.push({
        label: 'Comissão CNHJá:',
        valueFormatted: `-${HistoryCardFormatter.formatCurrency(commissionCnhJa)}`,
        isDeduction: true,
        intent: 'danger',
      });
    }

    if (item.netAmount !== undefined) {
      breakdownItems.push({
        label: 'Você recebeu:',
        valueFormatted: HistoryCardFormatter.formatCurrency(Math.abs(item.netAmount)),
        isHighlight: true,
        isBold: true,
        intent: 'success',
      });
    }

    breakdownItems.push({
      label: isCombo ? 'ID da Compra:' : 'ID:',
      valueFormatted: HistoryCardFormatter.formatGroupId(item.groupId, item.id),
      isMono: true,
    });

    return {
      header: {
        title,
        subtitle: isCombo ? subtitle : undefined,
        iconEmoji,
        intent: headerIntent,
      },
      amount: {
        label: 'Recebido:',
        valueFormatted: primaryAmountFormatted,
        intent: isRefund || isChargeback ? 'danger' : 'success',
        isRefund: isRefund || isChargeback,
      },
      status: {
        badge: statusBadge,
        installmentStatusText: presentation.statusBadge,
      },
      details: {
        isExpandable: true,
        expandToggleTextOpen: isCombo ? '▲ Ocultar aulas' : '▲ Ocultar detalhes',
        expandToggleTextClosed: isCombo ? '▼ Ver aulas' : '▼ Ver detalhes',
        breakdownTitle: isCombo ? `Aulas do Pacote (${item.lessonCount ?? 0}):` : undefined,
        breakdownItems,
      },
      lessons: {
        isCombo,
        lessonCount: item.lessonCount,
        items: lessonItems,
      },
      metadata: {
        id: item.id,
        groupId: item.groupId,
        sortDate: item.sortDate || item.lastSettlementDate || item.createdAt || item.dueDate || new Date().toISOString(),
        primaryDateLabel: presentation.formattedDateLine,
        rawItem: item,
      },
    };
  }
}
