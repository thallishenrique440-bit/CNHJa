import React, { useState, useEffect } from 'react';
import { StudentBottomNav } from '../../components/StudentBottomNav';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';

// --- Types ---
interface Transaction {
  id: string;
  created_at: string;
  type: 'lesson_payment' | 'tip' | 'refund' | 'platform_fee';
  amount: number;
  status: string;
  instructorName: string;
}

interface FinanceSummary {
  totalSpent: number;
  classesDone: number;
  classesScheduled: number;
}

export const StudentFinance: React.FC = () => {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<FinanceSummary>({
    totalSpent: 0,
    classesDone: 0,
    classesScheduled: 0,
  });

  // Helper for currency
  const formatCurrency = (valInCents: number) => {
    return (valInCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper for date
  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  };

  // Helper for icons
  const getIcon = (type: string) => {
    switch (type) {
      case 'tip': return '🎁';
      case 'platform_fee': return '🧾';
      case 'refund': return '↩️';
      default: return '🚗';
    }
  };

  const getLabel = (type: string) => {
    switch (type) {
      case 'lesson_payment': return 'Pagamento de Aula';
      case 'tip': return 'Caixinha';
      case 'refund': return 'Reembolso';
      case 'platform_fee': return 'Taxa de Serviço';
      default: return 'Transação';
    }
  };

  useEffect(() => {
    if (!session?.user) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        // 1. Fetch Transactions
        const { data: transData, error: transError } = await supabase
          .from('transactions')
          .select(`
            id,
            created_at,
            type,
            amount,
            status,
            instructors (
              profiles ( full_name )
            )
          `)
          .eq('student_id', session.user.id)
          .order('created_at', { ascending: false });

        if (transError) throw transError;

        // 2. Fetch Appointments Stats
        const { data: apptData, error: apptError } = await supabase
          .from('appointments')
          .select('status')
          .eq('student_id', session.user.id);

        if (apptError) throw apptError;

        // --- Process Transactions ---
        let totalSpent = 0;
        const mappedTransactions: Transaction[] = [];

        if (transData) {
          transData.forEach((t: any) => {
            if (t.status === 'completed') {
              totalSpent += t.amount;
            }
            mappedTransactions.push({
              id: t.id,
              created_at: t.created_at,
              type: t.type,
              amount: t.amount,
              status: t.status,
              instructorName: t.instructors?.profiles?.full_name || 'Sistema'
            });
          });
        }

        // --- Process Appointments ---
        let done = 0;
        let scheduled = 0;
        if (apptData) {
          apptData.forEach((a: any) => {
            if (a.status === 'completed') done++;
            if (a.status === 'scheduled' || a.status === 'confirmed') scheduled++;
          });
        }

        setTransactions(mappedTransactions);
        setSummary({
          totalSpent,
          classesDone: done,
          classesScheduled: scheduled
        });

      } catch (err) {
        console.error('Error loading finance:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [session]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      {/* Header */}
      <div className="bg-white px-6 pt-6 pb-4 border-b border-gray-100 sticky top-0 z-10">
        <h1 className="text-xl font-bold text-gray-900">Financeiro</h1>
        <p className="text-xs text-gray-500 mt-1">
          Acompanhe seus gastos no app
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        
        {/* Summary Cards */}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 bg-blue-600 rounded-2xl p-5 text-white shadow-lg shadow-blue-200">
            <span className="text-blue-100 text-xs font-medium uppercase tracking-wider block mb-1">Total investido</span>
            {loading ? (
               <div className="h-8 w-32 bg-blue-500 rounded animate-pulse mt-1"></div>
            ) : (
               <span className="text-3xl font-bold block">{formatCurrency(summary.totalSpent)}</span>
            )}
          </div>
          
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
             <span className="text-gray-400 text-[10px] font-bold uppercase tracking-wider block mb-1">Aulas realizadas</span>
             <span className="text-xl font-bold text-gray-900">
                {loading ? '...' : summary.classesDone}
             </span>
          </div>

          <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
             <span className="text-gray-400 text-[10px] font-bold uppercase tracking-wider block mb-1">Aulas agendadas</span>
             <span className="text-xl font-bold text-blue-600">
                {loading ? '...' : summary.classesScheduled}
             </span>
          </div>
        </div>

        {/* History List */}
        <div>
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-3 pl-1">Histórico</h2>
          
          {loading ? (
             <div className="space-y-3">
               {[1,2,3].map(i => (
                 <div key={i} className="bg-white p-4 rounded-2xl border border-gray-100 h-16 animate-pulse"></div>
               ))}
             </div>
          ) : transactions.length === 0 ? (
             <div className="text-center py-10 bg-white rounded-2xl border border-gray-100 border-dashed">
                <p className="text-gray-400 text-sm">Nenhuma transação encontrada.</p>
             </div>
          ) : (
            <div className="space-y-3">
              {transactions.map((t) => (
                <div key={t.id} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${t.type === 'tip' ? 'bg-yellow-50 text-yellow-600' : 'bg-gray-50 text-gray-600'}`}>
                      {getIcon(t.type)}
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 text-sm leading-tight">{getLabel(t.type)}</h3>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{t.instructorName}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">{formatDate(t.created_at)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="block font-bold text-gray-900 text-sm">{formatCurrency(t.amount)}</span>
                    {t.status === 'pending' && (
                        <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-bold">
                            Pendente
                        </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      <StudentBottomNav />
    </div>
  );
};