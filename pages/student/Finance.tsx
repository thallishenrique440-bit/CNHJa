import React, { useState, useEffect } from 'react';
import { StudentBottomNav } from '../../components/StudentBottomNav';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';

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
  status: string;
  instructorName: string;
  appointment_id?: string;
}

interface Appointment {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: 'pending' | 'pending_approval' | 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'rejected' | 'expired' | 'reserved';
  price: number;
  instructors: {
    profiles: {
      full_name: string;
    };
  };
}

interface HistoryItem {
  id: string;
  timestamp: string; // display timestamp
  sortDate: string;  // ISO string for sorting
  type: 'lesson' | 'tip' | 'refund';
  isFinancial: boolean;
  amount: number;
  grossAmount?: number;
  platformFee?: number;
  netAmount?: number;
  status: string;
  instructorName: string;
  appointmentDate?: string;
  appointmentTime?: string;
  isPast?: boolean;
}

interface FinanceSummary {
  totalSpent: number;
  classesDone: number;
  classesScheduled: number;
}

export const StudentFinance: React.FC = () => {
  const { session, serverTimeOffset } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
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

  const formatAppointmentDate = (dateStr: string, timeStr: string) => {
    const d = new Date(`${dateStr}T00:00:00`);
    const formattedDate = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
    return `${formattedDate} às ${timeStr}`;
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
      setError(null);
      try {
        const userId = session.user.id;
        const now = new Date(Date.now() + serverTimeOffset);

        // 1. Fetch Transactions
        const { data: transData, error: transError } = await supabase
          .from('transactions')
          .select(`
            id,
            created_at,
            event_date,
            type,
            amount,
            gross_amount,
            platform_fee,
            net_amount,
            status,
            appointment_id,
            instructors (
              profiles ( full_name )
            )
          `)
          .eq('student_id', userId)
          .order('event_date', { ascending: false });

        if (transError) throw transError;

        // 2. Fetch Appointments (Active and Completed)
        const { data: apptData, error: apptError } = await supabase
          .from('appointments')
          .select(`
            id,
            date,
            start_time,
            end_time,
            status,
            price,
            instructors (
              profiles ( full_name )
            )
          `)
          .eq('student_id', userId)
          .in('status', ['confirmed', 'completed', 'pending', 'pending_approval', 'scheduled', 'reserved'])
          .order('date', { ascending: false });

        if (apptError) throw apptError;

        const typedTrans = (transData || []).map((t: any) => ({
          ...t,
          instructorName: t.instructors?.profiles?.full_name || 'Sistema'
        })) as Transaction[];

        const typedAppts = (apptData || []).map((a: any) => ({
          ...a,
          instructorName: a.instructors?.profiles?.full_name || 'Instrutor'
        })) as any[];

        // --- Process Financial Summary ---
        let totalSpent = 0;
        typedTrans.forEach(t => {
          if (t.status === 'completed') {
            // For students, we care about gross_amount
            // Now refunds are already negative in the database, so we just add them
            const val = t.gross_amount;
            totalSpent += val;
          }
        });

        // --- Process Appointment Stats ---
        let done = 0;
        let scheduled = 0;
        typedAppts.forEach(a => {
          if (a.status === 'completed') {
            done++;
          } else {
            // Check if it's future using date and start_time
            const [hours, minutes] = a.start_time.split(':').map(Number);
            const [y, m, d] = a.date.split('-').map(Number);
            const apptStartDate = new Date(y, m - 1, d, hours, minutes);
            const isFuture = apptStartDate > now;
            
            if (isFuture) {
              scheduled++;
            }
          }
        });

        // --- Build Hybrid History ---
        const items: HistoryItem[] = [];

        // Add Transactions
        typedTrans.forEach(t => {
          const logicalDate = t.event_date || t.created_at;
          items.push({
            id: t.id,
            timestamp: logicalDate,
            sortDate: logicalDate,
            type: t.type === 'lesson_payment' ? 'lesson' : (t.type === 'tip' ? 'tip' : 'refund'),
            isFinancial: true,
            amount: t.amount,
            grossAmount: t.gross_amount,
            platformFee: t.platform_fee,
            netAmount: t.net_amount,
            status: t.status,
            instructorName: t.instructorName
          });
        });

        // Add Active Appointments (not yet paid or confirmed)
        const paidApptIds = new Set(typedTrans.filter(t => t.type === 'lesson_payment').map(t => t.appointment_id));
        
        typedAppts.forEach(a => {
          if (a.status !== 'completed' && !paidApptIds.has(a.id)) {
            const [hours, minutes] = (a.end_time || a.start_time).split(':').map(Number);
            const [y, m, d] = a.date.split('-').map(Number);
            const apptEndDate = new Date(y, m - 1, d, hours, minutes);
            const isPast = apptEndDate < now;

            const logicalDate = `${a.date}T${a.start_time}`;

            items.push({
              id: a.id,
              timestamp: logicalDate,
              sortDate: logicalDate,
              type: 'lesson',
              isFinancial: false,
              amount: a.price,
              status: a.status,
              instructorName: a.instructorName,
              appointmentDate: a.date,
              appointmentTime: a.start_time,
              isPast
            });
          }
        });

        // Sort by sortDate descending
        items.sort((a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime());
        
        setHistoryItems(items);
        setSummary({
          totalSpent,
          classesDone: done,
          classesScheduled: scheduled
        });

      } catch (err: any) {
        console.error('Error loading finance:', err);
        setError(err.message || 'Erro ao carregar dados financeiros.');
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
        
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 bg-blue-600 rounded-2xl p-5 text-white shadow-lg shadow-blue-200">
            <span className="text-blue-100 text-xs font-medium uppercase tracking-wider block mb-1">Total pago</span>
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
          ) : historyItems.length === 0 ? (
             <div className="text-center py-10 bg-white rounded-2xl border border-gray-100 border-dashed">
                <p className="text-gray-400 text-sm">Nenhuma atividade encontrada.</p>
             </div>
          ) : (
            <div className="space-y-3">
              {historyItems.map((item) => {
                const isRefund = item.type === 'refund';
                const isTip = item.type === 'tip';
                const isLesson = item.type === 'lesson';
                const isPending = ['pending', 'processing'].includes(item.status);
                
                // Visual indicators
                const getIndicatorColor = () => {
                  if (isRefund) return 'border-red-500';
                  if (isTip) return 'border-amber-400';
                  if (!item.isFinancial) return 'border-blue-400 border-dashed';
                  return 'border-green-500';
                };
                
                return (
                  <div key={item.id} className={`bg-white p-4 rounded-2xl shadow-sm border border-gray-100 border-l-4 ${getIndicatorColor()} flex items-center justify-between transition-all hover:bg-gray-50`}>
                    <div className="flex items-center space-x-4">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${
                        isRefund ? 'bg-red-50 text-red-600' : 
                        isTip ? 'bg-yellow-50 text-yellow-600' : 
                        'bg-blue-50 text-blue-600'
                      }`}>
                        {getIcon(item.type)}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900 text-sm leading-tight">{getLabel(item.type)}</h3>
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {item.instructorName}
                          {item.appointmentDate && item.appointmentTime && (
                            <span className="text-gray-400"> • {formatAppointmentDate(item.appointmentDate, item.appointmentTime)}</span>
                          )}
                        </p>
                        {!item.isFinancial && isLesson && (
                            <p className={`text-[9px] font-bold uppercase mt-1 ${item.isPast ? 'text-blue-500' : 'text-orange-500'}`}>
                                {item.isPast ? 'Realizada (Processando)' : 'Agendada'}
                            </p>
                        )}
                        <p className="text-[10px] text-gray-400 mt-0.5">{formatDate(item.sortDate)}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`block font-bold text-sm ${isRefund ? 'text-red-600' : 'text-gray-900'}`}>
                        {isRefund ? '-' : ''}{formatCurrency(Math.abs(item.amount))}
                      </span>
                      {isPending && (
                          <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-bold">
                              Pendente
                          </span>
                      )}
                      {item.status === 'failed' && (
                          <span className="text-[9px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">
                              Falhou
                          </span>
                      )}
                      {item.isFinancial && item.status === 'completed' && (
                          <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold">
                              Pago
                          </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

      <StudentBottomNav />
    </div>
  );
};