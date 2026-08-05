/**
 * Formatter exclusivo para a camada de apresentação da UI financeira do instrutor.
 * Responsabilidade exclusivamente visual (formatação de rótulos e textos de parcelas/datas).
 * 
 * PROIBIDO: recalcular valores, fazer matemática financeira ou inferir estados do backend.
 */

export interface FinanceItemPresentationInput {
  status?: string;
  type?: string;
  totalInstallments?: number;
  receivedInstallments?: number;
  dateFormatted?: string;
}

export interface FinanceItemPresentationOutput {
  statusBadge: string;
  dateLabel: string;
  formattedDateLine: string;
}

export function formatFinanceItemPresentation(input: FinanceItemPresentationInput): FinanceItemPresentationOutput {
  const totalInst = typeof input.totalInstallments === 'number' && input.totalInstallments > 0 ? input.totalInstallments : 1;
  const recInst = typeof input.receivedInstallments === 'number' ? input.receivedInstallments : 0;
  const isMultiInstallment = totalInst > 1;
  
  const isRefund = input.type === 'refund' || input.status === 'refunded' || input.status === 'partially_refunded';

  let statusBadge = 'À vista';
  if (isRefund) {
    statusBadge = isMultiInstallment
      ? `${recInst} de ${totalInst} parcelas reembolsadas`
      : 'Reembolso integral';
  } else {
    statusBadge = isMultiInstallment
      ? `${recInst} de ${totalInst} parcelas recebidas`
      : 'À vista';
  }

  let dateLabel = 'Recebido em:';
  if (isRefund) {
    dateLabel = 'Data do reembolso:';
  } else if (isMultiInstallment) {
    dateLabel = 'Último recebimento:';
  }

  const formattedDateLine = input.dateFormatted
    ? `${dateLabel} ${input.dateFormatted}`
    : `${dateLabel} —`;

  return {
    statusBadge,
    dateLabel,
    formattedDateLine,
  };
}
