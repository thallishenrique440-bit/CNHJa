import React, { useState, useEffect } from 'react';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { supabase } from '../lib/supabase';
import { invokeSecureFunction } from '../lib/functions';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

// --- Types ---
interface Transaction {
  id: string;
  created_at: string;
  event_date: string;
  type: 'lesson_payment' | 'tip' | 'refund' | 'platform_fee';
  amount: number; // legacy
  gross_amount: number;
  platform_fee: number;
  net_amount: number;
  status: 'pending' | 'completed' | 'failed';
  appointment_id?: string;
  stripe_payout_id?: string;
  profiles: {
    full_name: string;
  };
}

interface Appointment {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: 'pending' | 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'rejected' | 'expired';
  price: number;
  profiles: {
    full_name: string;
  };
}

interface HistoryItem {
  id: string;
  timestamp: string; // display timestamp
  sortDate: string;  // ISO string for sorting
  type: 'lesson' | 'tip' | 'refund';
  isFinancial: boolean; // true if it's a completed transaction
  amount: number;
  grossAmount?: number;
  platformFee?: number;
  netAmount?: number;
  status: string;
  studentName: string;
  stripePayoutId?: string;
  appointmentStatus?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  isPast?: boolean;
}

// Updated Status Types for better UX
type StripeStatus = 'none' | 'pending' | 'processing' | 'active';

export const InstructorFinance: React.FC = () => {
  const { session, signOut } = useAuth();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  
  // Data State
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  
  // Financial Metrics
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [monthlyRevenue, setMonthlyRevenue] = useState(0);
  const [totalTips, setTotalTips] = useState(0);
  const [monthlyTips, setMonthlyTips] = useState(0);
  
  // New Balance Metrics
  const [pendingBalance, setPendingBalance] = useState(0);
  const [availableBalance, setAvailableBalance] = useState(0);
  const [paidOutTotal, setPaidOutTotal] = useState(0);
  
  // Stripe State
  const [stripeStatus, setStripeStatus] = useState<StripeStatus>('none');
  
  // UI States
  const [showTipsInfoModal, setShowTipsInfoModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Helper to format currency from cents
  const formatCurrency = (valInCents: number) => {
    return (valInCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  const loadData = async () => {
    if (!session?.user) return;
    try {
        setLoading(true);
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
        } else if (instructorData.payouts_enabled === true) {
            setStripeStatus('active');
        } else if (instructorData.stripe_onboarding_completed === true) {
            setStripeStatus('processing');
        } else {
            setStripeStatus('pending');
        }

        // 2. Fetch Transactions
        const { data: transData, error: transError } = await supabase
            .from('transactions')
            .select(`
                id,
                created_at,
                event_date,
                type,
                gross_amount,
                platform_fee,
                net_amount,
                status,
                appointment_id,
                stripe_payout_id,
                profiles ( full_name )
            `)
            .eq('instructor_id', userId)
            .order('event_date', { ascending: false });

        if (transError) throw transError;

        const typedTrans = (transData || []).map((t: any) => ({
            ...t,
            profiles: Array.isArray(t.profiles) ? t.profiles[0] : t.profiles
        })) as Transaction[];

        // --- Financial Calculations (Strictly from transactions) ---
        let totalRev = 0;
        let monthRev = 0;
        let totalTip = 0;
        let monthTip = 0;
        
        let pendingBal = 0;
        let availableBal = 0;
        let paidOutSum = 0;

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        typedTrans.forEach(t => {
            const val = t.net_amount || 0;

            // 1. Status-based balances
            if (t.status === 'pending') {
                pendingBal += val;
            } else if (t.status === 'completed') {
                if (t.stripe_payout_id) {
                    paidOutSum += val;
                } else {
                    availableBal += val;
                }
            }

            // 2. Earnings Summary (Total historical earnings)
            if (t.status === 'completed' || t.status === 'pending') {
                const tDate = new Date(t.event_date || t.created_at);
                const isCurrentMonth = tDate.getMonth() === currentMonth && tDate.getFullYear() === currentYear;
                
                if (t.type === 'lesson_payment') {
                    totalRev += val;
                    if (isCurrentMonth) monthRev += val;
                } else if (t.type === 'tip') {
                    totalRev += val;
                    totalTip += val;
                    if (isCurrentMonth) {
                        monthRev += val;
                        monthTip += val;
                    }
                } else if (t.type === 'refund') {
                    totalRev += val;
                    if (isCurrentMonth) monthRev += val;
                }
            }
        });

        setTotalRevenue(totalRev);
        setMonthlyRevenue(monthRev);
        setTotalTips(totalTip);
        setMonthlyTips(monthTip);
        
        setPendingBalance(pendingBal);
        setAvailableBalance(availableBal);
        setPaidOutTotal(paidOutSum);

        // --- Build History (Transactions ONLY) ---
        const items: HistoryItem[] = typedTrans.map(t => {
            const logicalDate = t.event_date || t.created_at;
            return {
                id: t.id,
                timestamp: logicalDate,
                sortDate: logicalDate,
                type: t.type === 'lesson_payment' ? 'lesson' : (t.type === 'tip' ? 'tip' : 'refund'),
                isFinancial: true,
                amount: t.net_amount, // We only use net_amount now
                grossAmount: t.gross_amount,
                platformFee: t.platform_fee,
                netAmount: t.net_amount,
                status: t.status,
                studentName: t.profiles?.full_name || 'Aluno',
                stripePayoutId: t.stripe_payout_id
            };
        });

        setHistoryItems(items);

    } catch (err) {
        console.error("Error loading finance data:", err);
        addToast("Erro ao carregar dados.", 'error');
    } finally {
        setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [session]);

    const handleStripeConnect = async () => {
    setConnecting(true);
    try {
        const { data, error } = await invokeSecureFunction('create-stripe-account', {
            method: 'POST',
            body: { mode: 'create_link' }
        });

        if (error) {
            if (error.message === 'SESSION_EXPIRED') {
                addToast("Sessão expirada. Por favor, entre novamente.", 'error');
                signOut();
                return;
            }
            throw error;
        }

        if (data?.url) {
            window.open(data.url, '_blank');
        } else {
            throw new Error("URL não encontrada.");
        }

    } catch (err: any) {
        addToast("Erro ao conectar: " + err.message, 'error');
    } finally {
        setConnecting(false);
    }
  };

  // --- NEW MANUAL SYNC FUNCTION ---
  const handleManualSync = async () => {
    setSyncing(true);
    try {
        const { data, error } = await invokeSecureFunction('create-stripe-account', {
            method: 'POST',
            body: { mode: 'sync' }
        });

        if (error) {
            if (error.message === 'SESSION_EXPIRED') {
                addToast("Sessão expirada. Por favor, entre novamente.", 'error');
                signOut();
                return;
            }
            throw error;
        }

        if (data?.status === 'synced') {
            // OPTIMISTIC UPDATE: Use response directly instead of waiting for DB read
            // This prevents race conditions where the read happens before the write propagates
            if (data.payouts_enabled === true) {
                setStripeStatus('active');
                addToast("Tudo certo! Sua conta está ativa.", 'success');
            } else if (data.details_submitted === true) {
                setStripeStatus('processing');
                addToast("Dados enviados! Aguardando verificação do banco.", 'info');
            } else {
                setStripeStatus('pending');
                addToast("Cadastro incompleto no Stripe.", 'warning');
            }
            
            // Reload background data just to be sure
            loadData(); 
        }

    } catch (err: any) {
        addToast("Erro ao sincronizar: " + err.message, 'error');
    } finally {
        setSyncing(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 sm:max-w-md sm:mx-auto relative flex flex-col">
      
      <div className="px-6 py-6 bg-white border-b border-gray-100 sticky top-0 z-20">
        <h1 className="text-xl font-bold text-gray-900">Financeiro</h1>
        <div className="flex items-center justify-between mt-1">
            <p className="text-xs text-gray-500">Gestão de repasses</p>
            
            {!loading && (
                <div className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border flex items-center gap-1
                    ${stripeStatus === 'active' 
                        ? 'bg-green-50 text-green-700 border-green-100' 
                        : stripeStatus === 'processing'
                            ? 'bg-blue-50 text-blue-700 border-blue-100'
                            : stripeStatus === 'pending'
                                ? 'bg-yellow-50 text-yellow-700 border-yellow-100'
                                : 'bg-gray-100 text-gray-500 border-gray-200'
                    }`}
                >
                    {stripeStatus === 'active' && <span>✅ Conta Ativa</span>}
                    {stripeStatus === 'processing' && <span>⏳ Em Análise</span>}
                    {stripeStatus === 'pending' && <span>⚠️ Ação Necessária</span>}
                    {stripeStatus === 'none' && <span>❌ Não Configurado</span>}
                </div>
            )}
        </div>
      </div>

      <div className="flex-1 px-6 py-6 space-y-6">
        
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col justify-center">
            <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wide mb-1 block">Saldo Disponível</span>
            <span className="text-xl font-bold text-indigo-600 truncate block">
                {loading ? '...' : formatCurrency(availableBalance)}
            </span>
            <span className="text-[10px] text-gray-400 mt-2">
                A receber: <span className="text-gray-600 font-semibold">{formatCurrency(pendingBalance)}</span>
            </span>
          </div>

          <div 
            onClick={() => setShowTipsInfoModal(true)}
            className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col justify-center cursor-pointer active:scale-[0.98] transition-all"
          >
             <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wide mb-1 flex items-center">
                Total Transferido <span className="ml-1">🏦</span>
             </span>
             <span className="text-xl font-bold text-gray-900 truncate">
                {loading ? '...' : formatCurrency(paidOutTotal)}
             </span>
             <span className="text-[10px] text-gray-400 mt-2 font-medium">
                Ganhos totais: {formatCurrency(totalRevenue)}
             </span>
          </div>
        </div>

        {/* Stripe Callout Area */}
        <div className={`rounded-2xl p-5 border relative overflow-hidden transition-colors
            ${stripeStatus === 'active' ? 'bg-indigo-50 border-indigo-100' : 
              stripeStatus === 'processing' ? 'bg-blue-50 border-blue-100' :
              'bg-yellow-50 border-yellow-100'
            }`}>
            
            <div className="relative z-10">
                <h3 className={`font-bold text-sm mb-1
                    ${stripeStatus === 'active' ? 'text-indigo-900' : 
                      stripeStatus === 'processing' ? 'text-blue-900' :
                      'text-yellow-900'
                    }`}>
                    {stripeStatus === 'active' ? 'Painel Financeiro Stripe' : 
                     stripeStatus === 'processing' ? 'Verificando Dados' :
                     'Recebimento Automático'}
                </h3>
                <p className={`text-xs leading-relaxed mb-4 max-w-[85%]
                    ${stripeStatus === 'active' ? 'text-indigo-700/80' : 
                      stripeStatus === 'processing' ? 'text-blue-700/80' :
                      'text-yellow-800/80'
                    }`}>
                    {stripeStatus === 'active' 
                        ? 'Acesse seu painel Stripe para ver seu saldo disponível, acompanhar os repasses automáticos para sua conta bancária e consultar seus extratos de pagamento.' 
                        : stripeStatus === 'processing'
                            ? 'O Stripe está verificando seus documentos. Isso pode levar alguns minutos ou horas. Clique em atualizar para checar.'
                            : 'Configure sua conta para receber pagamentos via Pix e Cartão com repasse automático.'}
                </p>
                
                <div className="flex flex-col space-y-2">
                    <Button 
                        variant={stripeStatus === 'active' ? 'outline' : 'primary'}
                        onClick={handleStripeConnect}
                        disabled={connecting}
                        className={`text-xs py-2.5 px-4 h-auto shadow-none w-full
                            ${stripeStatus === 'active' 
                                ? 'bg-white border-white text-indigo-600 hover:bg-indigo-50' 
                                : stripeStatus === 'processing'
                                    ? 'bg-blue-600 hover:bg-blue-700 text-white border-transparent'
                                    : 'bg-yellow-600 hover:bg-yellow-700 text-white border-transparent'}`}
                    >
                        {connecting ? 'Processando...' : 
                            stripeStatus === 'active' ? 'Acessar Painel Stripe ↗' : 
                            stripeStatus === 'processing' ? 'Verificar Status no Stripe ↗' : 
                            stripeStatus === 'pending' ? 'Concluir Cadastro ⚠️' : 
                            'Ativar Recebimentos'
                        }
                    </Button>

                    {/* Botão de Sincronização Manual */}
                    {(stripeStatus === 'pending' || stripeStatus === 'processing') && (
                        <button 
                            onClick={handleManualSync}
                            disabled={syncing}
                            className={`text-[10px] font-bold underline text-center
                                ${stripeStatus === 'processing' ? 'text-blue-600 hover:text-blue-800' : 'text-yellow-700 hover:text-yellow-900'}
                            `}
                        >
                            {syncing ? 'Verificando com o banco...' : 'Já completei, atualizar agora ⟳'}
                        </button>
                    )}
                </div>
            </div>
            
            <div className={`absolute -right-6 -bottom-8 w-24 h-24 rounded-full opacity-50 mix-blend-multiply filter blur-xl
                ${stripeStatus === 'active' ? 'bg-indigo-200' : 
                  stripeStatus === 'processing' ? 'bg-blue-200' :
                  'bg-yellow-200'
                }`}></div>
        </div>

        <div className="space-y-2 text-xs text-gray-500 px-1">
            <p>• Os pagamentos das aulas caem diretamente na sua conta Stripe Express.</p>
            <p>• Os repasses para sua conta bancária são realizados automaticamente pelo Stripe, de acordo com as regras da conta Stripe Express.</p>
            <p>• O saldo disponível e os repasses devem ser consultados diretamente no painel do Stripe.</p>
            <p>• A plataforma aplica uma taxa fixa de 10% sobre cada aula. Essa taxa é vitalícia e não está sujeita a alterações.</p>
            <p>• As taxas de processamento da Stripe são pagas pela própria plataforma, garantindo que você receba exatamente 90% do valor de cada aula.</p>
            <p>• Caso deseje manter um valor líquido específico por aula, você pode ajustar o preço da aula em aproximadamente 10%, considerando a taxa da plataforma.</p>
        </div>

        <div className="space-y-4 pt-2">
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Histórico de Aulas</h2>
          
          {loading ? (
             <div className="text-center py-4 text-gray-400 text-xs">Carregando histórico...</div>
          ) : historyItems.length === 0 ? (
             <div className="text-center py-8 bg-white rounded-xl border border-gray-100 text-gray-400 text-sm">
                 Nenhuma atividade encontrada.
             </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50 overflow-hidden">
                {historyItems.map((item) => {
                    const isTip = item.type === 'tip';
                    const isRefund = item.type === 'refund';
                    const isLesson = item.type === 'lesson';
                    
                    let label = 'Aula';
                    if (isTip) label = 'Caixinha';
                    if (isRefund) label = 'Reembolso';

                    const studentName = item.studentName;
                    const displayDesc = `${label} - ${studentName}`;

                    // Visual indicators
                    const getIndicatorColor = () => {
                        if (isRefund) return 'border-red-500';
                        if (isTip) return 'border-amber-400';
                        return 'border-green-500';
                    };

                    const getIcon = () => {
                        if (isRefund) return '↩️';
                        if (isTip) return '🎁';
                        return '✅';
                    };

                    return (
                        <div 
                            key={item.id} 
                            onClick={() => toggleExpand(item.id)}
                            className={`p-4 flex flex-col hover:bg-gray-50 transition-colors cursor-pointer border-l-4 ${getIndicatorColor()}`}
                        >
                            <div className="flex justify-between items-center w-full">
                                <div className="flex flex-col space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-400 font-medium">{formatDate(item.sortDate)}</span>
                                        <span className="text-[10px] text-gray-300">•</span>
                                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">{getIcon()} {label}</span>
                                    </div>
                                    <span className="text-sm font-semibold text-gray-800">
                                        {studentName}
                                    </span>
                                </div>
                                <div className="text-right">
                                    <span className={`block font-bold text-sm ${isRefund ? 'text-red-600' : 'text-green-600'}`}>
                                        {item.netAmount !== undefined ? (
                                            <>
                                                {isRefund ? '-' : '+'} {formatCurrency(Math.abs(item.netAmount))}
                                            </>
                                        ) : (
                                            '—'
                                        )}
                                    </span>
                                    <span className="text-[10px] text-gray-400">
                                        {item.status === 'pending' && 'Processando'}
                                        {item.status === 'completed' && (
                                            item.stripePayoutId 
                                                ? 'Transferido' 
                                                : 'Disponível'
                                        )}
                                        {item.status === 'failed' && 'Falha'}
                                        {!['pending', 'completed', 'failed'].includes(item.status) && item.status}
                                    </span>
                                </div>
                            </div>

                            {expandedId === item.id && (
                                <div className="mt-3 pt-3 border-t border-gray-100 space-y-2 animate-fade-in">
                                    <div className="grid grid-cols-2 gap-y-2 text-[11px]">
                                        <div className="text-gray-400">Horário:</div>
                                        <div className="text-gray-700 font-medium text-right">{formatTime(item.sortDate)}</div>
                                        
                                        {item.isFinancial && item.grossAmount !== undefined && (
                                            <>
                                                <div className="text-gray-400">Valor Bruto:</div>
                                                <div className="text-gray-700 font-medium text-right">{formatCurrency(Math.abs(item.grossAmount))}</div>
                                                
                                                <div className="text-gray-400">Taxa Plataforma (10%):</div>
                                                <div className="text-red-500 font-medium text-right">-{formatCurrency(Math.abs(item.platformFee || 0))}</div>
                                                
                                                <div className="text-gray-400 font-bold">Valor Líquido:</div>
                                                <div className="text-green-600 font-bold text-right">{formatCurrency(Math.abs(item.netAmount || 0))}</div>
                                            </>
                                        )}

                                        <div className="text-gray-400">ID:</div>
                                        <div className="text-gray-500 text-right font-mono">{item.id.slice(0, 12)}...</div>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
          )}
        </div>

      </div>

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
              A plataforma não cobra comissão sobre a caixinha (gorjeta), apenas as taxas do Stripe.
            </p>
          </div>
      </Modal>

      <InstructorBottomNav />
    </div>
  );
};