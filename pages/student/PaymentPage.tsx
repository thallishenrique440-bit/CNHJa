import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Button } from '../../components/Button';
import { useToast } from '../../contexts/ToastContext';

// Initialize Stripe outside component to avoid recreation
const stripeKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY;
const stripePromise = stripeKey ? loadStripe(stripeKey) : null;

const CheckoutForm = ({ purchaseId }: { purchaseId: string }) => {
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/#/student/lessons`, // Fallback if redirect happens
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Erro ao processar pagamento.');
        addToast(error.message || 'Erro ao processar pagamento.', 'error');
      } else if (paymentIntent) {
        const { status } = paymentIntent;

        if (status === 'requires_capture') {
          // SUCCESS: Auth & Capture flow
          addToast('Pagamento autorizado com sucesso! Aguardando aceite do instrutor.', 'success');
          navigate('/student/lessons?authorized=true');
        } else if (status === 'succeeded') {
          // SUCCESS: Immediate capture (rare but possible)
          addToast('Pagamento confirmado!', 'success');
          navigate('/student/lessons?success=true');
        } else if (status === 'requires_action') {
            // Should be handled by Stripe.js, but if we get here, maybe manual handling needed?
            // Usually confirmPayment handles the action.
            setErrorMessage('A autenticação do pagamento não foi concluída.');
        } else {
          setErrorMessage(`Estado inesperado do pagamento: ${status}`);
        }
      }
    } catch (err: any) {
        setErrorMessage(err.message || 'Erro interno.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <PaymentElement />
      {errorMessage && (
        <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg">
          {errorMessage}
        </div>
      )}
      <Button 
        type="submit" 
        disabled={!stripe || isProcessing}
        className="w-full"
      >
        {isProcessing ? 'Processando...' : 'Confirmar Pagamento'}
      </Button>
    </form>
  );
};

export const PaymentPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { clientSecret, purchaseId } = location.state || {};

  useEffect(() => {
    if (!clientSecret || !purchaseId) {
      navigate('/student/home');
    }
  }, [clientSecret, purchaseId, navigate]);

  if (!clientSecret || !purchaseId) return null;

  if (!stripePromise) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-6 sm:p-8 text-center">
          <h1 className="text-xl font-bold text-red-600 mb-2">Erro de Configuração</h1>
          <p className="text-gray-600">
            A chave pública do Stripe não foi configurada.
            <br />
            Por favor, defina a variável de ambiente <code>VITE_STRIPE_PUBLIC_KEY</code>.
          </p>
          <button 
            onClick={() => navigate(-1)}
            className="mt-6 w-full py-2 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            Voltar
          </button>
        </div>
      </div>
    );
  }

  const options = {
    clientSecret,
    appearance: {
      theme: 'stripe' as const,
      variables: {
        colorPrimary: '#2563eb',
      },
    },
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-6 sm:p-8">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Finalizar Pagamento</h1>
          <p className="text-gray-500 text-sm mt-2">
            Insira os dados do cartão para reservar seu horário.
            <br />
            <span className="text-xs text-blue-600 font-medium">
              O valor só será cobrado se o instrutor aceitar.
            </span>
          </p>
        </div>

        <Elements stripe={stripePromise} options={options}>
          <CheckoutForm purchaseId={purchaseId} />
        </Elements>
        
        <button 
            onClick={() => navigate(-1)}
            className="mt-6 w-full text-center text-sm text-gray-400 hover:text-gray-600"
        >
            Cancelar e Voltar
        </button>
      </div>
    </div>
  );
};
