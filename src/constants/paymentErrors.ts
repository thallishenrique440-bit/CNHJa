export interface PaymentErrorDetail {
  title: string;
  message: string;
}

export const PAYMENT_ERRORS: Record<string, PaymentErrorDetail> = {
  INSTRUCTOR_ASAAS_NOT_READY: {
    title: 'Agendamento temporariamente indisponível',
    message: 'Este instrutor ainda está concluindo a ativação da Conta de Recebimentos Asaas necessária para receber pagamentos pela plataforma. Assim que essa etapa for concluída, você poderá agendar suas aulas normalmente.'
  }
};
