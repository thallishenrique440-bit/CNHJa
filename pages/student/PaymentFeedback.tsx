import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, XCircle, AlertCircle, Calendar, ArrowLeft, Home } from 'lucide-react';
import { Button } from '../../components/Button';

interface PaymentFeedbackProps {
  type: 'success' | 'cancelled' | 'expired';
}

export const PaymentFeedback: React.FC<PaymentFeedbackProps> = ({ type }) => {
  const navigate = useNavigate();

  const renderContent = () => {
    switch (type) {
      case 'success':
        return {
          id: 'payment-success',
          icon: <CheckCircle2 className="w-16 h-16 text-emerald-600 animate-bounce" />,
          title: 'Reserva Realizada!',
          description: 'Seu pagamento foi recebido com sucesso no ambiente Asaas e pré-autorizado para reserva.',
          message: 'O instrutor já foi notificado e revisará as suas aulas em breve para aprovação final. Fique de olho na aba de "Aulas"!',
          actions: (
            <div className="space-y-3 w-full">
              <Button 
                onClick={() => navigate('/student/lessons')} 
                className="w-full flex items-center justify-center gap-2"
              >
                <Calendar className="w-4 h-4" />
                Ver Minhas Aulas
              </Button>
              <button 
                onClick={() => navigate('/student/home')}
                className="w-full py-2 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors inline-flex items-center justify-center gap-2 text-sm font-semibold"
              >
                <Home className="w-4 h-4" />
                Ir para Início
              </button>
            </div>
          ),
        };
      case 'cancelled':
        return {
          id: 'payment-cancelled',
          icon: <XCircle className="w-16 h-16 text-rose-600 animate-pulse" />,
          title: 'Pagamento Cancelado',
          description: 'O processo de pagamento foi cancelado ou não foi autorizado pela operadora de cartão.',
          message: 'Nenhum valor foi cobrado e seus horários selecionados não foram garantidos. Se desejar, tente refazer o agendamento.',
          actions: (
            <div className="space-y-3 w-full">
              <Button 
                onClick={() => navigate(-1)} 
                className="w-full flex items-center justify-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                Voltar e Tentar Novamente
              </Button>
              <button 
                onClick={() => navigate('/student/home')}
                className="w-full py-2 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors inline-flex items-center justify-center gap-2 text-sm font-semibold"
              >
                <Home className="w-4 h-4" />
                Ir para Início
              </button>
            </div>
          ),
        };
      case 'expired':
        return {
          id: 'payment-expired',
          icon: <AlertCircle className="w-16 h-16 text-amber-600 animate-pulse" />,
          title: 'Tempo Expirado',
          description: 'O limite de tempo (15 minutos) para realizar esse pagamento expirou.',
          message: 'Por questões de segurança, os slots de aula foram liberados de volta na agenda do instrutor. Por favor, reinicie seu agendamento.',
          actions: (
            <div className="space-y-3 w-full">
              <Button 
                onClick={() => navigate('/student/home')} 
                className="w-full flex items-center justify-center gap-2"
              >
                <Home className="w-4 h-4" />
                Voltar para o Início
              </Button>
            </div>
          ),
        };
    }
  };

  const content = renderContent();

  return (
    <div id={content.id} className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center flex flex-col items-center space-y-6">
        <div className="p-3 bg-gray-50 rounded-full">
          {content.icon}
        </div>
        
        <div className="space-y-2">
          <h1 className="text-2xl font-black text-gray-900 leading-tight">
            {content.title}
          </h1>
          <p className="text-sm font-medium text-gray-700">
            {content.description}
          </p>
          <p className="text-xs text-gray-400 leading-relaxed pt-2">
            {content.message}
          </p>
        </div>

        <div className="pt-4 w-full">
          {content.actions}
        </div>
      </div>
    </div>
  );
};
