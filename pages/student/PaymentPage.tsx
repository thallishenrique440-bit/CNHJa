import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { CheckoutLauncher } from '../../lib/payments/CheckoutLauncher';

export const PaymentPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { invoiceUrl } = location.state || {};

  useEffect(() => {
    if (!invoiceUrl) {
      navigate('/student/home');
    }
  }, [invoiceUrl, navigate]);

  // Redirect to hosted checkout if invoiceUrl is provided using CheckoutLauncher
  useEffect(() => {
    if (invoiceUrl) {
      localStorage.removeItem('booking_selected_slots');
      const timer = setTimeout(() => {
        CheckoutLauncher.launch(invoiceUrl);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [invoiceUrl]);

  if (!invoiceUrl) return null;

  return (
    <div id="asaas-redirection-screen" className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center animate-bounce">
          <ShieldCheck className="w-8 h-8 text-emerald-600" />
        </div>
        <div>
          <h1 className="text-xl font-black text-gray-900">Redirecionando para o Pagamento</h1>
          <p className="text-sm text-gray-500 mt-2 font-medium">
            Você está sendo transferido de forma segura para o ambiente de pagamento para concluir seu agendamento.
          </p>
        </div>
        <div className="flex justify-center items-center gap-1.5 py-4">
          <div className="w-2.5 h-2.5 bg-blue-600 rounded-full animate-ping"></div>
          <div className="w-2.5 h-2.5 bg-blue-600 rounded-full animate-ping [animation-delay:0.2s]"></div>
          <div className="w-2.5 h-2.5 bg-blue-600 rounded-full animate-ping [animation-delay:0.4s]"></div>
        </div>
        <div className="pt-2">
          <a 
            href={invoiceUrl}
            onClick={(e) => {
              e.preventDefault();
              CheckoutLauncher.launch(invoiceUrl, { forceNewTab: true });
            }}
            className="text-xs text-blue-600 hover:underline font-semibold cursor-pointer"
          >
            Clique aqui se não for redirecionado automaticamente
          </a>
        </div>
      </div>
    </div>
  );
};
