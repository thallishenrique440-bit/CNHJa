/**
 * HistoryCardViewModel.ts
 * 
 * Reorganized Semantic View Model for HistoryCardBase.
 * Structured into semantic block interfaces:
 * - header
 * - amount
 * - status
 * - details
 * - lessons
 * - metadata
 * Completely agnostic of framework CSS classes and domain entities.
 */

export type FinancialIntent = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface HistoryCardHeaderModel {
  title: string;
  subtitle?: string;
  iconEmoji: string;
  intent: FinancialIntent;
}

export interface HistoryCardAmountModel {
  label?: string; // e.g., "Recebido:", "Valor pago:"
  valueFormatted: string;
  intent: FinancialIntent;
  isRefund?: boolean;
}

export interface HistoryCardStatusModel {
  badge?: {
    label: string;
    variant: 'pending' | 'completed' | 'in_progress' | 'failed' | 'transferred' | 'refunded' | 'neutral';
  };
  installmentStatusText?: string;
  appointmentStatus?: {
    text: string;
    intent: FinancialIntent;
  };
}

export interface HistoryCardBreakdownItem {
  label: string;
  valueFormatted: string;
  isDeduction?: boolean;
  isHighlight?: boolean;
  isBold?: boolean;
  isMono?: boolean;
  intent?: FinancialIntent;
}

export interface HistoryCardDetailsModel {
  isExpandable: boolean;
  expandToggleTextOpen?: string;
  expandToggleTextClosed?: string;
  breakdownTitle?: string;
  breakdownItems?: HistoryCardBreakdownItem[];
}

export interface HistoryCardLessonItem {
  id: string;
  dateFormatted: string;
  timeRangeFormatted?: string;
  netAmountFormatted?: string;
}

export interface HistoryCardLessonsModel {
  isCombo?: boolean;
  lessonCount?: number;
  items?: HistoryCardLessonItem[];
}

export interface HistoryCardMetadataModel {
  id: string;
  groupId?: string;
  sortDate: string;
  primaryDateLabel?: string;
  secondaryDateText?: string;
  rawItem?: any;
}

export interface HistoryCardViewModel {
  header: HistoryCardHeaderModel;
  amount: HistoryCardAmountModel;
  status: HistoryCardStatusModel;
  details: HistoryCardDetailsModel;
  lessons: HistoryCardLessonsModel;
  metadata: HistoryCardMetadataModel;
}
