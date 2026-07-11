import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ShieldCheck, ExternalLink } from 'lucide-react';
import { CheckoutLauncher } from '../../lib/payments/CheckoutLauncher';

export const PaymentPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { invoiceUrl } = location.state || {};
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    if (!invoiceUrl) {
      navigate('/student/home');
    }
  }, [invoiceUrl, navigate]);

  // Check standalone context on mount
  useEffect(() => {
    setIsStandalone(CheckoutLauncher.isStandalone());
  }, []);

  // Redirect to hosted checkout if invoiceUrl is provided and NOT in standalone/PWA context
  useEffect(() => {
    if (invoiceUrl && !isStandalone) {
      localStorage.removeItem('booking_selected_slots');
      const timer = setTimeout(() => {
        CheckoutLauncher.launch(invoiceUrl);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [invoiceUrl, isStandalone]);

  if (!invoiceUrl) return null;

  return (
    <div id="asaas-redirection-screen" className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center animate-bounce">
          <ShieldCheck className="w-8 h-8 text-emerald-600" />
        </div>

        {isStandalone ? (
          // PWA / Standalone Mobile Mode - Requiring explicit user action (User Gesture)
          <div className="space-y-4" id="standalone-payment-flow">
            <div>
              <h1 className="text-xl font-black text-gray-900" id="payment-ready-title">Pagamento Seguro Pronto</h1>
              <p className="text-sm text-gray-500 mt-2 font-medium" id="payment-ready-desc">
                Para garantir que a transação ocorra com máxima segurança e sem interrupções, clique no botão abaixo para concluir o agendamento no seu navegador de internet padrão.
              </p>
            </div>
            <button
              id="btn-open-checkout"
              onClick={() => {
                localStorage.removeItem('booking_selected_slots');
                CheckoutLauncher.launch(invoiceUrl, { forceNewTab: true });
              }}
              className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-all shadow-md shadow-blue-100 cursor-pointer text-sm"
            >
              <span>Abrir Checkout Seguro</span>
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
        ) : (
          // Desktop / Default Browser Redirecting Mode
          <div className="space-y-6" id="standard-payment-flow">
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
        )}
      </div>
    </div>
  );
};
