/**
 * HistoryCardFormatter.ts
 * 
 * Shared Financial & Date Formatter utility for History Card Adapters.
 * Centralizes currency formatting, date parsing, time range formatting, and ID truncation.
 * Pure utility functions — no side effects or external state.
 */

export class HistoryCardFormatter {
  /**
   * Formats a numeric value (default in cents, or BRL units if isCents = false) to Brazilian Real currency format.
   */
  public static formatCurrency(val: number, isCents = true): string {
    const valInReal = isCents ? val / 100 : val;
    return valInReal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  /**
   * Formats ISO date string to short date (e.g. "15 de mai." -> "15 mai").
   */
  public static formatDateShort(isoStr: string): string {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).replace('.', '');
  }

  /**
   * Formats ISO date string to full date (e.g. "15/05/2026").
   */
  public static formatFullDate(isoStr?: string): string {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleDateString('pt-BR');
  }

  /**
   * Formats appointment date and time (e.g. "15 mai às 14:00").
   */
  public static formatAppointmentDate(dateStr: string, timeStr: string): string {
    const d = new Date(`${dateStr}T00:00:00`);
    const formattedDate = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
    return `${formattedDate} às ${timeStr}`;
  }

  /**
   * Formats lesson start and end time range (e.g. "14:00 - 15:00").
   */
  public static formatLessonTimeRange(startTime?: string, endTime?: string): string {
    if (!startTime) return '';
    const start = startTime.slice(0, 5);
    const end = endTime ? endTime.slice(0, 5) : '';
    return end ? `${start} - ${end}` : start;
  }

  /**
   * Cleans and truncates a Group/Order ID for UI presentation.
   */
  public static formatGroupId(groupId?: string, fallbackId?: string): string {
    const rawId = groupId || fallbackId || '';
    return `${rawId.replace('combo_', '').replace('tip_', '').slice(0, 12)}...`;
  }

  /**
   * Calculates instructor lesson price excluding buyer-facing gateway fees (Asaas).
   */
  public static calculateInstructorLessonGross(
    grossAmountCents: number,
    feeAmountCents?: number,
    platformFeeCents?: number,
    commissionCnhJaCents?: number
  ): number {
    const totalGross = Math.abs(grossAmountCents || 0);
    const asaasFee = feeAmountCents ?? (
      platformFeeCents !== undefined && commissionCnhJaCents !== undefined
        ? Math.max(0, platformFeeCents - commissionCnhJaCents)
        : 0
    );
    return Math.max(0, totalGross - asaasFee);
  }

  /**
   * Generates standard installment status label.
   */
  public static formatInstallmentText(
    totalInst: number,
    recInst: number,
    isRefund = false,
    isTip = false
  ): string {
    if (isRefund) {
      return totalInst > 1 ? `${recInst} de ${totalInst} parcelas reembolsadas` : 'Reembolso integral';
    }
    if (isTip) {
      return 'Obrigado pelo reconhecimento ❤️';
    }
    return totalInst > 1 ? `${recInst} de ${totalInst} parcelas pagas` : 'À vista';
  }
}
