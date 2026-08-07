/**
 * StudentHistoryAdapter.ts
 * 
 * Adapter layer translating Student History Items / DTOs into HistoryCardViewModel.
 * Encapsulates ALL student-perspective business rules:
 * - Focus on "quanto eu paguei" (grossAmount) as primary highlight
 * - Shows Asaas processing fee details
 * - Never exposes platform commission or instructor net repasse
 * - Uses HistoryCardFormatter for string and currency formatting
 * - Returns pure semantic intents ('success', 'warning', 'danger', 'info', 'neutral')
 */

import { HistoryCardViewModel, HistoryCardBreakdownItem, HistoryCardLessonItem, FinancialIntent } from '../HistoryCardViewModel';
import { HistoryCardFormatter } from '../formatters/HistoryCardFormatter';

export interface StudentHistoryItemInput {
  id: string;
  timestamp?: string;
  sortDate?: string;
  type?: 'lesson' | 'tip' | 'refund' | 'combo' | string;
  isFinancial?: boolean;
  amount?: number;
  grossAmount?: number;
  grossAmountCents?: number;
  feeAmountCents?: number;
  platformFee?: number;
  lessonPriceCents?: number;
  netAmount?: number;
  status: string;
  instructorName: string;
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
  latestPaymentDate?: string;
  createdAt?: string;
  dueDate?: string;
}

export class StudentHistoryAdapter {
  public static toViewModel(item: StudentHistoryItemInput): HistoryCardViewModel {
    const isCombo = Boolean(item.isCombo);
    const isTip = item.type === 'tip' || Boolean(item.groupId?.startsWith('tip_')) || item.lessonCount === 0;
    const isRefund = item.type === 'refund' || item.status === 'refunded' || item.status === 'partially_refunded';
    const isLesson = !isCombo && !isTip && !isRefund;

    const totalInst = item.totalInstallments && item.totalInstallments > 0 ? item.totalInstallments : 1;
    const recInst = typeof item.receivedInstallments === 'number' ? item.receivedInstallments : 0;

    // Installment status label
    const installmentStatusText = HistoryCardFormatter.formatInstallmentText(totalInst, recInst, isRefund, isTip);

    // Gross amount paid by student
    const grossVal = Math.abs(item.grossAmountCents ?? item.grossAmount ?? item.amount ?? 0);
    const primaryAmountFormatted = `${isRefund ? '-' : ''}${HistoryCardFormatter.formatCurrency(grossVal)}`;

    // Status Badge & Appointment Status
    let statusBadge: HistoryCardViewModel['status']['badge'] = undefined;
    const isPending = ['pending', 'processing'].includes(item.status);
    if (isPending) {
      statusBadge = { label: 'Pendente', variant: 'pending' };
    } else if (item.status === 'failed') {
      statusBadge = { label: 'Falhou', variant: 'failed' };
    } else if (item.status === 'completed' || item.isFinancial) {
      if (totalInst > 1 && recInst < totalInst) {
        statusBadge = { label: 'Em andamento', variant: 'in_progress' };
      } else {
        statusBadge = { label: 'Concluído', variant: 'completed' };
      }
    }

    let appointmentStatus: HistoryCardViewModel['status']['appointmentStatus'] = undefined;
    if (item.isFinancial === false && isLesson) {
      appointmentStatus = item.isPast
        ? { text: 'Realizada', intent: 'info' }
        : { text: 'Agendada', intent: 'warning' };
    }

    // Header semantic configuration
    let title = '🚗 Aula';
    let subtitle = item.instructorName;
    let iconEmoji = '🚗';
    let headerIntent: FinancialIntent = 'success';

    if (isRefund) {
      title = 'Reembolso recebido';
      iconEmoji = '↩️';
      headerIntent = 'danger';
    } else if (isTip) {
      title = '🎁 Caixinha';
      iconEmoji = '🎁';
      headerIntent = 'warning';
    } else if (isCombo) {
      title = `Combo • ${item.lessonCount ?? 0} aulas`;
      iconEmoji = '📦';
      headerIntent = 'success';
    } else if (item.isFinancial === false) {
      headerIntent = 'info';
    }

    if (!isCombo && item.appointmentDate && item.appointmentTime) {
      subtitle = `${item.instructorName} • ${HistoryCardFormatter.formatAppointmentDate(item.appointmentDate, item.appointmentTime)}`;
    }

    // Dates
    let primaryDateLabel: string | undefined = undefined;
    if (isCombo && item.latestPaymentDate) {
      primaryDateLabel = `Último pagamento: ${HistoryCardFormatter.formatDateShort(item.latestPaymentDate)}`;
    }

    // Lessons format for Combos
    let lessonItems: HistoryCardLessonItem[] | undefined = undefined;
    if (isCombo && item.lessons && item.lessons.length > 0) {
      lessonItems = item.lessons.map((l) => ({
        id: l.id,
        dateFormatted: HistoryCardFormatter.formatDateShort(l.date),
        timeRangeFormatted: HistoryCardFormatter.formatLessonTimeRange(l.startTime, l.endTime),
      }));
    }

    // Financial Breakdown Items for student perspective
    const breakdownItems: HistoryCardBreakdownItem[] = [];

    if (isCombo) {
      breakdownItems.push({
        label: 'Valor Total da Compra:',
        valueFormatted: HistoryCardFormatter.formatCurrency(grossVal),
        isBold: true,
      });

      const asaasFee = item.feeAmountCents ?? item.platformFee ?? 0;
      if (asaasFee > 0) {
        breakdownItems.push({
          label: 'Taxa de processamento Asaas:',
          valueFormatted: HistoryCardFormatter.formatCurrency(asaasFee),
        });
      }

      breakdownItems.push({
        label: 'Parcelamento:',
        valueFormatted: installmentStatusText,
      });

      breakdownItems.push({
        label: 'ID da Compra:',
        valueFormatted: HistoryCardFormatter.formatGroupId(item.groupId, item.id),
        isMono: true,
      });
    }

    return {
      header: {
        title,
        subtitle,
        iconEmoji,
        intent: headerIntent,
      },
      amount: {
        valueFormatted: primaryAmountFormatted,
        intent: isRefund ? 'danger' : 'neutral',
        isRefund,
      },
      status: {
        badge: statusBadge,
        installmentStatusText,
        appointmentStatus,
      },
      details: {
        isExpandable: isCombo,
        expandToggleTextOpen: '▲ Ocultar aulas',
        expandToggleTextClosed: '▼ Ver aulas',
        breakdownTitle: isCombo ? `Aulas do Combo (${item.lessonCount ?? 0}):` : undefined,
        breakdownItems: breakdownItems.length > 0 ? breakdownItems : undefined,
      },
      lessons: {
        isCombo,
        lessonCount: item.lessonCount,
        items: lessonItems,
      },
      metadata: {
        id: item.id,
        groupId: item.groupId,
        sortDate: item.sortDate || item.latestPaymentDate || item.createdAt || item.dueDate || new Date().toISOString(),
        primaryDateLabel,
        rawItem: item,
      },
    };
  }
}
