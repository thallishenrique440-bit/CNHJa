import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Button } from '../../components/Button';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';
import { Calendar, Clock, ShieldCheck, CreditCard, Info, ArrowLeft } from 'lucide-react';

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
          localStorage.removeItem('booking_selected_slots');
          addToast('Pagamento autorizado com sucesso! Aguardando aceite do instrutor.', 'success');
          navigate('/student/lessons?authorized=true');
        } else if (status === 'succeeded') {
          // SUCCESS: Immediate capture (rare but possible)
          localStorage.removeItem('booking_selected_slots');
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

interface BookingSummary {
  instructorName: string;
  instructorAvatar: string | null;
  category: string;
  lessonCount: number;
  totalAmount: number;
  lessons: { date: string; startTime: string; endTime: string }[];
}

const formatDateBR = (dateStr: string) => {
  try {
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}`;
  } catch (e) {
    return dateStr;
  }
};

const formatTimeBR = (timeStr: string) => {
  try {
    return timeStr.substring(0, 5);
  } catch (e) {
    return timeStr;
  }
};

const getDayOfWeekBR = (dateStr: string) => {
  try {
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return days[date.getDay()];
  } catch (e) {
    return '';
  }
};

const renderCategory = (cat: string) => {
  if (cat === 'A') return 'Categoria A (Moto)';
  if (cat === 'B') return 'Categoria B (Carro)';
  if (cat === 'AB') return 'Categoria AB (Carro & Moto)';
  return `Categoria ${cat}`;
};

export const PaymentPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { clientSecret, purchaseId } = location.state || {};
  const [summary, setSummary] = useState<BookingSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  useEffect(() => {
    if (!clientSecret || !purchaseId) {
      navigate('/student/home');
    }
  }, [clientSecret, purchaseId, navigate]);

  useEffect(() => {
    if (!purchaseId) return;

    const fetchSummaryData = async () => {
      setLoadingSummary(true);
      try {
        const { data, error } = await supabase
          .from('appointments')
          .select(`
            id,
            date,
            start_time,
            end_time,
            price,
            category,
            instructors (
              profiles (
                full_name,
                avatar_url
              )
            )
          `)
          .eq('group_id', purchaseId);

        if (error) throw error;

        if (data && data.length > 0) {
          // Calculate total price accurately based on the queried rows
          const totalAmount = data.reduce((acc, item) => acc + (item.price || 0), 0);
          
          // Map lessons and sort them by date and time
          const sortedLessons = [...data].sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.start_time.localeCompare(b.start_time);
          }).map(item => ({
            date: item.date,
            startTime: item.start_time,
            endTime: item.end_time,
          }));

          const firstItem = data[0];
          let instructorName = 'Instrutor';
          let instructorAvatar: string | null = null;

          if (firstItem && firstItem.instructors) {
            const inst: any = firstItem.instructors;
            const profile = Array.isArray(inst.profiles) ? inst.profiles[0] : inst.profiles;
            if (profile) {
              instructorName = profile.full_name || 'Instrutor';
              instructorAvatar = profile.avatar_url || null;
            }
          }
          
          setSummary({
            instructorName,
            instructorAvatar,
            category: data[0].category || 'Aula',
            lessonCount: data.length,
            totalAmount,
            lessons: sortedLessons,
          });
        }
      } catch (err) {
        console.error('Erro ao buscar resumo do agendamento:', err);
        // Fallback gracefully to hide the summary card, keeping payment element unblocked
        setSummary(null);
      } finally {
        setLoadingSummary(false);
      }
    };

    fetchSummaryData();
  }, [purchaseId]);

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

  // 1. Loading Skeleton Layout (Two Column)
  if (loadingSummary) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4 sm:p-6 md:p-10 animate-pulse">
        <div className="w-full max-w-4xl bg-white rounded-2xl shadow-xl overflow-hidden border border-gray-100 grid grid-cols-1 md:grid-cols-12 min-h-[550px]">
          {/* Left Column Skeleton */}
          <div className="md:col-span-5 bg-gray-50 p-6 md:p-8 border-b md:border-b-0 md:border-r border-gray-100 flex flex-col justify-between">
            <div>
              <div className="h-4 bg-gray-200 rounded w-1/2 mb-6"></div>
              <div className="h-6 bg-gray-300 rounded w-3/4 mb-6"></div>
              <div className="bg-white p-4 rounded-xl border border-gray-100 mb-6 flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-gray-200"></div>
                <div className="space-y-2 flex-1">
                  <div className="h-3 bg-gray-200 rounded w-1/4"></div>
                  <div className="h-4 bg-gray-300 rounded w-1/2"></div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="h-3 bg-gray-200 rounded w-1/3 mb-1"></div>
                <div className="h-10 bg-gray-200 rounded"></div>
                <div className="h-10 bg-gray-200 rounded"></div>
              </div>
            </div>
            <div className="h-24 bg-gray-200 rounded-xl mt-6"></div>
          </div>

          {/* Right Column Skeleton */}
          <div className="md:col-span-7 p-6 md:p-8 flex flex-col justify-between">
            <div>
              <div className="h-6 bg-gray-300 rounded w-1/3 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-2/3 mb-8"></div>
              <div className="h-14 bg-gray-100 rounded-xl mb-6"></div>
              <div className="space-y-4">
                <div className="h-10 bg-gray-200 rounded"></div>
                <div className="h-10 bg-gray-200 rounded"></div>
              </div>
            </div>
            <div className="h-10 bg-gray-200 rounded w-full mt-8"></div>
          </div>
        </div>
      </div>
    );
  }

  // 2. Fallback Layout if summary query fails or has no rows
  if (!summary) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-6 sm:p-8 border border-gray-100">
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
  }

  // 3. Fully Polished Two-Column Purchase Summary Card Layout
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4 sm:p-6 md:p-10">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-xl overflow-hidden border border-gray-100 grid grid-cols-1 md:grid-cols-12 min-h-[550px]">
        
        {/* Left Column: Purchase Summary & Guideline Checklist */}
        <div className="md:col-span-5 bg-gray-50 p-6 md:p-8 border-b md:border-b-0 md:border-r border-gray-100 flex flex-col justify-between">
          <div>
            <div className="mb-6 flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Checkout 100% Seguro</span>
            </div>

            <h2 className="text-xl font-bold text-gray-900 mb-6">Resumo do Agendamento</h2>

            {/* Instructor Summary Component */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 mb-6 flex items-center gap-4">
              {summary.instructorAvatar ? (
                <img
                  src={summary.instructorAvatar}
                  alt={summary.instructorName}
                  className="w-12 h-12 rounded-full object-cover border border-gray-200"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-extrabold text-lg">
                  {summary.instructorName.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <p className="text-xs text-gray-400 font-medium">Instrutor(a)</p>
                <p className="font-bold text-gray-900 leading-tight">{summary.instructorName}</p>
                <div className="mt-1.5 inline-flex items-center text-xs bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full font-medium">
                  {renderCategory(summary.category)}
                </div>
              </div>
            </div>

            {/* Selected Lessons Scrollable Area */}
            <div className="mb-6">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
                Aulas Selecionadas ({summary.lessonCount})
              </p>
              <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                {summary.lessons.map((lesson, idx) => {
                  const dayOfWeek = getDayOfWeekBR(lesson.date);
                  return (
                    <div 
                      key={idx} 
                      className="bg-white p-3 rounded-lg border border-gray-100 flex items-center justify-between text-sm transition-all hover:border-gray-200"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-gray-100 text-gray-600 rounded">
                          <Calendar className="w-4 h-4 text-gray-500" />
                        </div>
                        <div>
                          <span className="font-semibold text-gray-800">
                            {formatDateBR(lesson.date)}
                          </span>
                          {dayOfWeek && (
                            <span className="text-xs text-gray-400 ml-1">
                              ({dayOfWeek})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-gray-600 font-medium">
                        <Clock className="w-3.5 h-3.5 text-gray-400" />
                        <span className="font-mono text-xs">
                          {formatTimeBR(lesson.startTime)} - {formatTimeBR(lesson.endTime)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Explicit Reassurance Alerts / Policies */}
          <div className="mt-6 md:mt-0 pt-6 border-t border-gray-200/60 font-sans">
            <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100/50 space-y-3">
              <div className="flex items-start gap-2.5">
                <Info className="w-4.5 h-4.5 text-blue-600 shrink-0 mt-0.5" />
                <div className="text-xs leading-relaxed text-blue-900 space-y-2">
                  <p className="font-bold text-blue-950">
                    Como funciona a pré-autorização?
                  </p>
                  <p>
                    O preço total será apenas <strong className="text-blue-950 font-semibold">reservado temporariamente</strong> no limite do seu cartão de crédito.
                  </p>
                  <p>
                    A cobrança real e transferência só serão efetivadas quando o instrutor <strong className="text-blue-950 font-semibold">aprovar formalmente</strong> o agendamento.
                  </p>
                  <p>
                    Caso o instrutor recuse ou expire, a reserva é desfeita de forma automática pela operadora do seu cartão sem qualquer custo.
                  </p>
                  <p className="text-blue-800/80 text-[10px]">
                    * Modalidades de pagamento com parcelamento ou cartões de débito não são compatíveis com o mecanismo de pré-autorização manual.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Stripe Payment Form Element */}
        <div className="md:col-span-7 p-6 md:p-8 flex flex-col justify-between">
          <div>
            <div className="mb-6">
              <h1 className="text-2xl font-black text-gray-900 leading-tight">Finalizar Pagamento</h1>
              <p className="text-gray-500 text-sm mt-1">
                Insira os dados do cartão de crédito à vista para concluir sua pré-autorização.
              </p>
            </div>

            {/* Total summary Box */}
            <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 mb-6 flex justify-between items-center">
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  Total a reservar
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  (Sem cobrança imediata)
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-black text-gray-900 font-mono">
                  R$ {summary.totalAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            </div>

            <Elements stripe={stripePromise} options={options}>
              <CheckoutForm purchaseId={purchaseId} />
            </Elements>
          </div>

          <div className="mt-8 pt-6 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-4">
            <button
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-700 transition-colors font-semibold"
            >
              <ArrowLeft className="w-4 h-4" />
              Cancelar e voltar
            </button>
            <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
              <CreditCard className="w-3.5 h-3.5 text-gray-300" />
              <span>Transações protegidas por criptografia SSL</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
