import React, { useState, useEffect } from 'react';
import { Shield } from 'lucide-react';
import { StudentBottomNav } from '../../components/StudentBottomNav';
import { AsaasPartnerSeal } from '../../components/AsaasPartnerSeal';
import { useAuth } from '../../contexts/AuthContext';

// --- Types ---
interface HistoryItem {
  id: string;
  timestamp: string; // display timestamp
  sortDate: string;  // ISO string for sorting
  type: 'lesson' | 'tip' | 'refund' | 'combo';
  isFinancial: boolean;
  amount: number;
  grossAmount?: number;
  platformFee?: number;
  netAmount?: number;
  status: 'pending' | 'completed' | 'failed' | string;
  instructorName: string;
  appointmentDate?: string;
  appointmentTime?: string;
  isPast?: boolean;

  // Package/Combo details
  isCombo?: boolean;
  lessonCount?: number;
  lessons?: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    netAmount?: number;
  }[];
  groupId?: string;
  receivedInstallments?: number;
  totalInstallments?: number;
  latestPaymentDate?: string;
}

interface FinanceSummary {
  totalSpent: number;
  classesDone: number;
  classesScheduled: number;
}

export const StudentFinance: React.FC = () => {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [summary, setSummary] = useState<FinanceSummary>({
    totalSpent: 0,
    classesDone: 0,
    classesScheduled: 0,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  // Helper for currency
  const formatCurrency = (valInCents: number) => {
    return (valInCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper for date
  const formatDate = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).replace('.', '');
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
      case 'lesson_payment':
      case 'lesson': return '🚗 Aula';
      case 'tip': return '🎁 Caixinha';
      case 'refund': return 'Reembolso';
      case 'platform_fee': return 'Taxa de Serviço';
      default: return '🚗 Aula';
    }
  };

  useEffect(() => {
    if (!session?.user || !session?.access_token) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/student-finance?action=all&studentId=${session.user.id}`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`
          }
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Erro ao carregar dados financeiros.');
        }

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Erro ao carregar dados financeiros.');
        }

        const { summary: sumDto, history: histDto } = data;

        setSummary({
          totalSpent: sumDto.totalSpentCents || 0,
          classesDone: sumDto.classesDone || 0,
          classesScheduled: sumDto.classesScheduled || 0,
        });

        const items: HistoryItem[] = (histDto || []).map((h: any) => {
          const isTip = Boolean(h.groupId?.startsWith('tip_') || h.lessonCount === 0);
          return {
            id: h.id,
            timestamp: h.createdAt || h.dueDate,
            sortDate: h.latestPaymentDate || h.createdAt || h.dueDate,
            type: isTip ? 'tip' : h.isCombo ? 'combo' : 'lesson',
            isFinancial: true,
            amount: h.grossAmountCents, // GROSS AMOUNT paid by student for the purchase
            grossAmount: h.grossAmountCents,
            platformFee: h.feeAmountCents,
            netAmount: h.lessonPriceCents,
            status: h.status,
            instructorName: h.instructorName,
            appointmentDate: h.appointmentDate,
            appointmentTime: h.appointmentTime,
            isCombo: h.isCombo,
            lessonCount: h.lessonCount,
            lessons: h.lessons,
            groupId: h.groupId,
            receivedInstallments: h.receivedInstallments,
            totalInstallments: h.totalInstallments,
            latestPaymentDate: h.latestPaymentDate
          };
        });

        items.sort((a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime());

        setHistoryItems(items);
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
      <div className="px-6 py-6 bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="flex items-center justify-between">
          {/* Left Column: Title and Subtitle */}
          <div className="flex flex-col">
            <h1 className="text-xl font-bold text-gray-900 leading-tight">Financeiro</h1>
            <p className="text-xs text-gray-500 mt-0.5">Histórico de compras e pagamentos</p>
          </div>
          
          {/* Right Column: Institutional Financial Partner Logo and Label */}
          <AsaasPartnerSeal className="min-w-[160px] shrink-0" />
        </div>
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

        {/* Informative Trust Card */}
        <div className="bg-blue-50/55 border border-blue-100 rounded-2xl p-4 flex items-start gap-3">
          <Shield className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-bold text-gray-900 text-xs flex items-center gap-1">
              🛡️ Sua segurança em primeiro lugar
            </h3>
            <p className="text-[11px] text-gray-600 mt-1 leading-relaxed">
              Sempre que um reembolso for devido, ele será processado automaticamente pelo <span className="font-semibold text-gray-800">Asaas</span>, sem necessidade de solicitação.
            </p>
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
             <div className="text-center py-12 bg-white rounded-2xl border border-gray-100 border-dashed px-6">
                <div className="w-12 h-12 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-3">
                   <span className="text-xl">⏳</span>
                </div>
                <h3 className="text-gray-900 font-bold text-sm mb-1">Aguardando processamento</h3>
                <p className="text-gray-400 text-xs leading-relaxed">
                   Se você realizou um pagamento recentemente, ele aparecerá aqui em alguns instantes assim que for confirmado.
                </p>
             </div>
          ) : (
            <div className="space-y-3">
              {historyItems.map((item) => {
                const totalInst = item.totalInstallments || 1;
                const recInst = item.receivedInstallments || 0;
                const isRefunded = item.status === 'refunded' || item.status === 'partially_refunded' || item.type === 'refund';
                const installmentText = isRefunded
                  ? (totalInst > 1 ? `${recInst} de ${totalInst} parcelas reembolsadas` : 'Reembolso integral')
                  : (totalInst > 1 ? `${recInst} de ${totalInst} parcelas pagas` : 'À vista');

                if (item.isCombo) {
                  const displayDesc = `Combo • ${item.lessonCount} aulas`;
                  const isExpanded = expandedId === item.id;
                  return (
                    <div 
                      key={item.id} 
                      onClick={() => toggleExpand(item.id)}
                      className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 border-l-4 border-green-500 flex flex-col cursor-pointer transition-all hover:bg-gray-50"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-4">
                          <div className="w-10 h-10 rounded-full bg-green-50 text-green-600 flex items-center justify-center text-lg">
                            📦
                          </div>
                          <div>
                            <h3 className="font-semibold text-gray-900 text-sm leading-tight">{displayDesc}</h3>
                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                              {item.instructorName}
                            </p>
                            <p className="text-[10px] text-gray-400 mt-0.5">{installmentText}</p>
                            {item.latestPaymentDate && (
                              <p className="text-[10px] text-gray-400">Último pagamento: {formatDate(item.latestPaymentDate)}</p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="block font-bold text-sm text-gray-900">
                            {formatCurrency(Math.abs(item.amount))}
                          </span>
                          <span className="text-[10px] text-gray-400">
                            {item.status === 'pending' && (
                              <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-bold">
                                Pendente
                              </span>
                            )}
                            {item.status === 'completed' && (
                              recInst < totalInst ? (
                                <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">
                                  Em andamento
                                </span>
                              ) : (
                                <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold">
                                  Concluído
                                </span>
                              )
                            )}
                            {item.status === 'failed' && (
                              <span className="text-[9px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">
                                Falhou
                              </span>
                            )}
                          </span>
                        </div>
                      </div>

                      {/* Dropdown Indicator */}
                      <div className="flex items-center justify-center mt-2 text-[10px] text-gray-400 font-medium">
                        {isExpanded ? '▲ Ocultar aulas' : '▼ Ver aulas'}
                      </div>

                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-gray-100 space-y-3 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                          <div className="text-xs font-semibold text-gray-700">Aulas do Combo ({item.lessonCount}):</div>
                          <div className="space-y-1.5 bg-gray-50 p-2.5 rounded-xl border border-gray-100">
                            {item.lessons?.map((lesson, idx) => (
                              <div key={lesson.id} className="flex justify-between text-[11px] text-gray-600">
                                <span>Aula {idx + 1}: {formatDate(lesson.date)}</span>
                                <span className="font-medium text-gray-500">
                                  {lesson.startTime ? `${lesson.startTime.slice(0, 5)} - ${lesson.endTime.slice(0, 5)}` : ''}
                                </span>
                              </div>
                            ))}
                          </div>

                          <div className="grid grid-cols-2 gap-y-2 text-[11px]">
                            <div className="text-gray-400">Valor Total da Compra:</div>
                            <div className="text-gray-700 font-medium text-right">{formatCurrency(Math.abs(item.amount || 0))}</div>

                            <div className="text-gray-400">Parcelamento:</div>
                            <div className="text-gray-700 font-medium text-right">{installmentText}</div>

                            <div className="text-gray-400">ID da Compra:</div>
                            <div className="text-gray-500 text-right font-mono">{(item.groupId || item.id).replace('combo_', '').slice(0, 12)}...</div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }

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
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {isTip ? 'Obrigado pelo reconhecimento ❤️' : installmentText}
                        </p>
                        {!item.isFinancial && isLesson && (
                            <p className={`text-[9px] font-bold uppercase mt-1 ${item.isPast ? 'text-blue-500' : 'text-orange-500'}`}>
                                {item.isPast ? 'Realizada' : 'Agendada'}
                            </p>
                        )}
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
                          recInst < totalInst ? (
                            <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">
                              Em andamento
                            </span>
                          ) : (
                            <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold">
                              Concluído
                            </span>
                          )
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