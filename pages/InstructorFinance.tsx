import React, { useState, useEffect } from 'react';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

// --- Types ---
interface Transaction {
  id: string;
  created_at: string;
  type: 'lesson_payment' | 'tip' | 'refund' | 'platform_fee';
  amount: number; // in cents
  status: 'pending' | 'completed' | 'failed';
  profiles: {
    full_name: string;
  };
}

type StripeStatus = 'none' | 'pending' | 'active';

export const InstructorFinance: React.FC = () => {
  const { session } = useAuth();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  
  // Data State
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [internalBalance, setInternalBalance] = useState(0); // Computed from local transactions
  const [tipsBalance, setTipsBalance] = useState(0);
  
  // Stripe State
  const [stripeStatus, setStripeStatus] = useState<StripeStatus>('none');
  
  // UI States
  const [showTipsInfoModal, setShowTipsInfoModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Helper to format currency from cents
  const formatCurrency = (valInCents: number) => {
    return (valInCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper for Date Formatting
  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  useEffect(() => {
    if (!session?.user) return;

    const loadData = async () => {
        setLoading(true);
        try {
            const userId = session.user.id;

            // 1. Fetch Instructor Stripe Status
            const { data: instructorData, error: instructorError } = await supabase
                .from('instructors')
                .select('stripe_account_id, payouts_enabled, stripe_onboarding_completed')
                .eq('id', userId)
                .single();

            if (instructorError) throw instructorError;

            if (!instructorData.stripe_account_id) {
                setStripeStatus('none');
            } else if (!instructorData.payouts_enabled) {
                setStripeStatus('pending');
            } else {
                setStripeStatus('active');
            }

            // 2. Fetch Transactions (Internal Ledger)
            const { data: transData, error: transError } = await supabase
                .from('transactions')
                .select(`
                    id,
                    created_at,
                    type,
                    amount,
                    status,
                    profiles ( full_name )
                `)
                .eq('instructor_id', userId)
                .order('created_at', { ascending: false });

            if (transError) throw transError;

            if (transData) {
                const typedData = transData as any[];
                setTransactions(typedData);

                let total = 0;
                let tips = 0;
                const now = new Date();
                const currentMonth = now.getMonth();

                typedData.forEach(t => {
                    if (t.status === 'completed') {
                        total += t.amount;
                        
                        const tDate = new Date(t.created_at);
                        if (t.type === 'tip' && tDate.getMonth() === currentMonth) {
                            tips += t.amount;
                        }
                    }
                });

                setInternalBalance(total);
                setTipsBalance(tips);
            }

        } catch (err) {
            console.error("Error loading finance data:", err);
            addToast("Erro ao carregar dados financeiros.", 'error');
        } finally {
            setLoading(false);
        }
    };

    loadData();
  }, [session]);

  const handleStripeConnect = async () => {
    setConnecting(true);
    try {
        const { data, error } = await supabase.functions.invoke('create-stripe-account', {
            method: 'POST',
        });

        if (error) throw error;

        if (data?.url) {
            // CRITICAL FIX: Open in new tab because Stripe blocks Iframes (X-Frame-Options)
            // This allows testing in Preview Mode / Embedded environments.
            window.open(data.url, '_blank');
        } else {
            throw new Error("URL de redirecionamento não encontrada.");
        }

    } catch (err: any) {
        console.error("Stripe Connect Error:", err);
        addToast("Erro ao conectar com a Stripe: " + err.message, 'error');
    } finally {
        setConnecting(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 sm:max-w-md sm:mx-auto relative flex flex-col">
      
      {/* Header */}
      <div className="px-6 py-6 bg-white border-b border-gray-100 sticky top-0 z-10">
        <h1 className="text-xl font-bold text-gray-900">Financeiro</h1>
        <div className="flex items-center justify-between mt-1">
            <p className="text-xs text-gray-500">Gestão de repasses</p>
            
            {/* Status Badge */}
            {!loading && (
                <div className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border flex items-center gap-1
                    ${stripeStatus === 'active' 
                        ? 'bg-green-50 text-green-700 border-green-100' 
                        : stripeStatus === 'pending'
                            ? 'bg-yellow-50 text-yellow-700 border-yellow-100'
                            : 'bg-gray-100 text-gray-500 border-gray-200'
                    }`}
                >
                    {stripeStatus === 'active' && <span>✅ Conta Ativa</span>}
                    {stripeStatus === 'pending' && <span>⚠️ Verificação Pendente</span>}
                    {stripeStatus === 'none' && <span>❌ Não Configurado</span>}
                </div>
            )}
        </div>
      </div>

      <div className="flex-1 px-6 py-6 space-y-6">
        
        {/* 1. Main Balances */}
        <div className="grid grid-cols-2 gap-4">
          {/* Total Earned (Internal view) */}
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col justify-center">
            <span className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1 block">Ganhos Totais</span>
            <span className="text-xl font-bold text-gray-900 truncate block">
                {loading ? '...' : formatCurrency(internalBalance)}
            </span>
            <span className="text-[10px] text-gray-400 mt-2">Acumulado no app</span>
          </div>

          {/* Tips Card */}
          <div 
            onClick={() => setShowTipsInfoModal(true)}
            className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col justify-center cursor-pointer active:scale-[0.98] transition-all"
          >
             <span className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1 flex items-center">
                Caixinha (Mês) <span className="ml-1">🎁</span>
             </span>
             <span className="text-xl font-bold text-green-600 truncate">
                {loading ? '...' : formatCurrency(tipsBalance)}
             </span>
             <span className="text-[10px] text-green-600/70 mt-2 font-medium">100% seu</span>
          </div>
        </div>

        {/* 2. Stripe Callout Area */}
        <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-100 relative overflow-hidden">
            <div className="relative z-10">
                <h3 className="text-indigo-900 font-bold text-sm mb-1">
                    {stripeStatus === 'active' ? 'Painel Financeiro Stripe' : 'Recebimento Automático'}
                </h3>
                <p className="text-indigo-700/80 text-xs leading-relaxed mb-4 max-w-[85%]">
                    {stripeStatus === 'active' 
                        ? 'Acesse seu painel para ver saldo disponível, agendar saques e ver extratos bancários.' 
                        : 'Configure sua conta para receber pagamentos via Pix e Cartão com repasse automático.'}
                </p>
                
                <Button 
                    variant={stripeStatus === 'active' ? 'outline' : 'primary'}
                    onClick={handleStripeConnect}
                    disabled={connecting}
                    className={`text-xs py-2.5 px-4 h-auto shadow-none 
                        ${stripeStatus === 'active' 
                            ? 'bg-white border-white text-indigo-600 hover:bg-indigo-50' 
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white border-transparent'}`}
                >
                    {connecting ? 'Processando...' : 
                        stripeStatus === 'active' ? 'Acessar Painel Stripe ↗' : 
                        stripeStatus === 'pending' ? 'Concluir Cadastro ⚠️' : 
                        'Ativar Recebimentos'
                    }
                </Button>
            </div>
            
            {/* Decoration */}
            <div className="absolute -right-6 -bottom-8 w-24 h-24 bg-indigo-200 rounded-full opacity-50 mix-blend-multiply filter blur-xl"></div>
        </div>

        {/* Info Section */}
        <div className="space-y-2 text-xs text-gray-500 px-1">
            <p>• Os pagamentos caem direto na sua conta Stripe Express.</p>
            <p>• A taxa da plataforma (10%) já é descontada automaticamente.</p>
            <p>• Saques são geridos diretamente pelo painel da Stripe.</p>
        </div>

        {/* Transaction History */}
        <div className="space-y-4 pt-2">
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Histórico de Aulas</h2>
          
          {loading ? (
             <div className="text-center py-4 text-gray-400 text-xs">Carregando histórico...</div>
          ) : transactions.length === 0 ? (
             <div className="text-center py-8 bg-white rounded-xl border border-gray-100 text-gray-400 text-sm">
                 Nenhuma transação encontrada.
             </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50 overflow-hidden">
                {transactions.map((t) => {
                    const isTip = t.type === 'tip';
                    const label = isTip ? 'Caixinha' : 'Aula';
                    const studentName = t.profiles?.full_name || 'Aluno';
                    const displayDesc = `${label} - ${studentName}`;

                    return (
                        <div 
                            key={t.id} 
                            onClick={() => toggleExpand(t.id)}
                            className="p-4 flex flex-col hover:bg-gray-50 transition-colors cursor-pointer"
                        >
                            <div className="flex justify-between items-center w-full">
                                <div className="flex flex-col space-y-1">
                                    <span className="text-xs text-gray-400 font-medium">{formatDate(t.created_at)}</span>
                                    <span className="text-sm font-semibold text-gray-800">
                                    {displayDesc} {isTip && ' 🎁'}
                                    </span>
                                </div>
                                <div className="text-right">
                                    <span className="block font-bold text-sm text-green-600">
                                    + {formatCurrency(t.amount)}
                                    </span>
                                    <span className="text-[10px] text-gray-400 capitalize">
                                        {t.status === 'completed' ? 'Processado' : t.status}
                                    </span>
                                </div>
                            </div>

                            {expandedId === t.id && (
                            <div className="mt-3 pt-2 border-t border-gray-100 flex items-center animate-fade-in">
                                <span className="text-xs text-gray-500 font-medium">
                                🕒 {formatTime(t.created_at)} · ID: {t.id.slice(0, 8)}...
                                </span>
                            </div>
                            )}
                        </div>
                    );
                })}
            </div>
          )}
        </div>

      </div>

      {/* MODAL: TIPS INFO */}
      <Modal
        isOpen={showTipsInfoModal}
        onClose={() => setShowTipsInfoModal(false)}
        title="Sobre as caixinhas"
        footer={
           <Button fullWidth onClick={() => setShowTipsInfoModal(false)}>
              Entendi
            </Button>
        }
      >
        <div className="text-center">
            <div className="w-12 h-12 bg-yellow-100 text-yellow-600 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl">
              🎁
            </div>
            <p className="text-sm text-gray-500 mb-2 leading-relaxed">
              As caixinhas (gorjetas) são somadas ao seu saldo total e repassadas integralmente (sem taxa de plataforma) junto com seus pagamentos.
            </p>
          </div>
      </Modal>

      <InstructorBottomNav />
    </div>
  );
};