import React, { useState, useEffect } from 'react';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { AsaasPartnerSeal } from '../components/AsaasPartnerSeal';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input } from '../components/Input';
import { Info, ChevronDown, CircleHelp, ExternalLink } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { invokeSecureFunction } from '../lib/functions';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { toTitleCase } from '../lib/stringUtils';

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
  provider_payment_id?: string;
  profiles: {
    full_name: string;
  };
  appointments?: {
    id: string;
    group_id?: string;
    provider_payment_id?: string;
    date: string;
    start_time: string;
    end_time: string;
    status: string;
  } | null;
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
  type: 'lesson' | 'tip' | 'refund' | 'combo';
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
}

// Updated Status Types for Asaas Dashboard Integration
type AsaasStatus = 'none' | 'pending' | 'processing' | 'active' | 'denied';

// Mask Helpers
const formatCpfCnpj = (value: string) => {
  const clean = value.replace(/\D/g, '').slice(0, 14);
  if (clean.length <= 11) {
    return clean
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  } else {
    return clean
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }
};

const formatCep = (value: string) => {
  const clean = value.replace(/\D/g, '').slice(0, 8);
  return clean.replace(/(\d{5})(\d{1,3})$/, '$1-$2');
};

const formatPhone = (value: string) => {
  const clean = value.replace(/\D/g, '').slice(0, 11);
  if (clean.length <= 10) {
    return clean
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{4})(\d{1,4})$/, '$1-$2');
  } else {
    return clean
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{5})(\d{1,4})$/, '$1-$2');
  }
};

const formatToBRL = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  const cents = parseInt(digits, 10);
  if (isNaN(cents)) return '';
  const amount = cents / 100;
  return "R$ " + amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatBirthDateInput = (value: string): string => {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) {
    return digits;
  }
  if (digits.length <= 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
};

const isValidBirthDate = (birthDateStr: string): { valid: boolean; reason?: string } => {
  const regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  if (!regex.test(birthDateStr)) {
    return { valid: false, reason: 'Informe a data no formato dd/mm/aaaa.' };
  }

  const [, dayStr, monthStr, yearStr] = birthDateStr.match(regex)!;
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10);
  const year = parseInt(yearStr, 10);

  if (year < 1900) {
    return { valid: false, reason: 'O ano de nascimento não pode ser anterior a 1900.' };
  }
  const currentYear = new Date().getFullYear();
  if (year > currentYear) {
    return { valid: false, reason: 'O ano de nascimento não pode ser no futuro.' };
  }

  if (month < 1 || month > 12) {
    return { valid: false, reason: 'Mês de nascimento inválido.' };
  }

  if (day < 1 || day > 31) {
    return { valid: false, reason: 'Dia de nascimento inválido.' };
  }

  const tempDate = new Date(year, month - 1, day);
  const isRealDate = (
    tempDate.getFullYear() === year &&
    tempDate.getMonth() === month - 1 &&
    tempDate.getDate() === day
  );

  if (!isRealDate) {
    return { valid: false, reason: 'Esta data de nascimento não é válida no calendário.' };
  }

  const today = new Date();
  let age = today.getFullYear() - year;
  const monthDiff = today.getMonth() - (month - 1);
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < day)) {
    age--;
  }

  if (age < 18) {
    return { valid: false, reason: 'Apenas maiores de 18 anos podem se cadastrar.' };
  }
  if (age > 120) {
    return { valid: false, reason: 'Idade máxima permitida é de 120 anos.' };
  }

  return { valid: true };
};

const parseBRLToNumber = (value: string): number => {
  const clean = value
    .replace(/R\$\s?/g, '') // remove R$
    .replace(/\s/g, '')     // remove any spaces
    .replace(/\./g, '')     // remove thousands dots
    .replace(',', '.');     // replace decimal comma with dot
  return parseFloat(clean);
};

export const InstructorFinance: React.FC = () => {
  const { session, signOut, refreshProfile } = useAuth();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  
  // Data State
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [isInfoExpanded, setIsInfoExpanded] = useState(false);
  
  // Financial Metrics
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [monthlyRevenue, setMonthlyRevenue] = useState(0);
  const [lessonMonthRevenue, setLessonMonthRevenue] = useState(0);
  const [lessonTotalRevenue, setLessonTotalRevenue] = useState(0);
  const [tipMonthRevenue, setTipMonthRevenue] = useState(0);
  const [tipTotalRevenue, setTipTotalRevenue] = useState(0);
  
  // Asaas States
  const [asaasStatus, setAsaasStatus] = useState<AsaasStatus>('none');
  const [isAsaasModalOpen, setIsAsaasModalOpen] = useState(false);
  const [submittingAsaas, setSubmittingAsaas] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [syncingAsaas, setSyncingAsaas] = useState(false);

  // Form Fields
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [companyType, setCompanyType] = useState<'INDIVIDUAL' | 'MEI' | 'LIMITED'>('INDIVIDUAL');
  const [postalCode, setPostalCode] = useState('');
  const [address, setAddress] = useState('');
  const [addressNumber, setAddressNumber] = useState('');
  const [complement, setComplement] = useState('');
  const [province, setProvince] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [incomeValue, setIncomeValue] = useState('');
  
  // UI States
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

  const handleOpenAsaasApp = () => {
    const now = Date.now();
    const playStoreUrl = "https://play.google.com/store/apps/details?id=com.asaas.android";
    const appStoreUrl = "https://apps.apple.com/br/app/asaas-conta-digital-pj/id1040854613";
    const officialDownloadUrl = "https://www.asaas.com/aplicativo-asaas";

    const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
    let fallbackUrl = officialDownloadUrl;
    let deepLink = "asaas://";

    if (/android/i.test(userAgent)) {
      fallbackUrl = playStoreUrl;
      deepLink = "intent://#Intent;scheme=asaas;package=com.asaas.android;end";
    } else if (/iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream) {
      fallbackUrl = appStoreUrl;
      deepLink = "asaas://";
    }

    window.location.href = deepLink;

    setTimeout(() => {
      if (Date.now() - now < 2000) {
        window.open(fallbackUrl, '_blank');
      }
    }, 1500);
  };

  const loadData = async () => {
    if (!session?.user) return;
    try {
        setLoading(true);
        const userId = session.user.id;

        // 1. Fetch Instructor Asaas Status
        const { data: instructorData, error: instructorError } = await supabase
            .from('instructors')
            .select('provider_account_id, provider_status, provider_onboarding_completed')
            .eq('id', userId)
            .single();

        if (instructorError) throw instructorError;

        if (!instructorData?.provider_account_id) {
            setAsaasStatus('none');
        } else {
            const status = (instructorData.provider_status || '').toUpperCase();
            if (status === 'APPROVED' || status === 'ACTIVE') {
                setAsaasStatus('active');
            } else if (status === 'PENDING' || status === 'AWAITING_APPROVAL') {
                setAsaasStatus('processing');
            } else if (status === 'AWAITING_DOCUMENTS') {
                setAsaasStatus('pending');
            } else if (status === 'REJECTED') {
                setAsaasStatus('denied');
            } else {
                setAsaasStatus('none');
            }
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
                provider_payment_id,
                profiles ( full_name ),
                appointments (
                    id,
                    group_id,
                    provider_payment_id,
                    date,
                    start_time,
                    end_time,
                    status
                )
            `)
            .eq('instructor_id', userId)
            .in('status', ['completed'])
            .order('event_date', { ascending: false });

        if (transError) throw transError;

        const typedTrans = (transData || []).map((t: any) => ({
            ...t,
            profiles: Array.isArray(t.profiles) ? t.profiles[0] : t.profiles,
            appointments: Array.isArray(t.appointments) ? t.appointments[0] : t.appointments
        })) as Transaction[];

        // --- Financial Calculations (Strictly from transactions) ---
        let totalRev = 0;
        let monthRev = 0;
        let lessonMRev = 0;
        let lessonTRev = 0;
        let tipMRev = 0;
        let tipTRev = 0;

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        typedTrans.forEach(t => {
            // Include captured and completed
            if (!['completed'].includes(t.status)) return;

            const val = t.net_amount || 0;

            // Earnings Summary (Total historical earnings)
            const tDate = new Date(t.event_date || t.created_at);
            const isCurrentMonth = tDate.getMonth() === currentMonth && tDate.getFullYear() === currentYear;
            
            if (t.type === 'lesson_payment') {
                totalRev += val;
                lessonTRev += val;
                if (isCurrentMonth) {
                    monthRev += val;
                    lessonMRev += val;
                }
            } else if (t.type === 'tip') {
                totalRev += val;
                tipTRev += val;
                if (isCurrentMonth) {
                    monthRev += val;
                    tipMRev += val;
                }
            } else if (t.type === 'refund') {
                totalRev += val; // val is negative for refunds
                lessonTRev += val;
                if (isCurrentMonth) {
                    monthRev += val;
                    lessonMRev += val;
                }
            }
        });

        setTotalRevenue(totalRev);
        setMonthlyRevenue(monthRev);
        setLessonMonthRevenue(lessonMRev);
        setLessonTotalRevenue(lessonTRev);
        setTipMonthRevenue(tipMRev);
        setTipTotalRevenue(tipTRev);
        
        // --- Build History (Transactions ONLY with in-memory grouping of combos) ---
        const lessonPaymentsToGroup: Transaction[] = [];
        const nonGroupedItems: HistoryItem[] = [];

        typedTrans.forEach(t => {
            const logicalDate = t.event_date || t.created_at;
            if (t.type === 'lesson_payment') {
                const groupId = t.appointments?.group_id;
                const providerPaymentId = t.provider_payment_id || t.appointments?.provider_payment_id;

                if (groupId || providerPaymentId) {
                    lessonPaymentsToGroup.push(t);
                } else {
                    nonGroupedItems.push({
                        id: t.id,
                        timestamp: logicalDate,
                        sortDate: logicalDate,
                        type: 'lesson',
                        isFinancial: true,
                        amount: t.net_amount,
                        grossAmount: t.gross_amount,
                        platformFee: t.platform_fee,
                        netAmount: t.net_amount,
                        status: t.status,
                        studentName: t.profiles?.full_name || 'Aluno',
                        stripePayoutId: t.stripe_payout_id
                    });
                }
            } else {
                nonGroupedItems.push({
                    id: t.id,
                    timestamp: logicalDate,
                    sortDate: logicalDate,
                    type: t.type === 'tip' ? 'tip' : 'refund',
                    isFinancial: true,
                    amount: t.net_amount,
                    grossAmount: t.gross_amount,
                    platformFee: t.platform_fee,
                    netAmount: t.net_amount,
                    status: t.status,
                    studentName: t.profiles?.full_name || 'Aluno',
                    stripePayoutId: t.stripe_payout_id
                });
            }
        });

        const groupMap = new Map<string, Transaction[]>();
        lessonPaymentsToGroup.forEach(t => {
            const groupKey = t.appointments?.group_id || t.provider_payment_id || t.appointments?.provider_payment_id || '';
            if (groupKey) {
                if (!groupMap.has(groupKey)) {
                    groupMap.set(groupKey, []);
                }
                groupMap.get(groupKey)!.push(t);
            }
        });

        const comboHistoryItems: HistoryItem[] = [];

        groupMap.forEach((transactionsInGroup, groupKey) => {
            if (transactionsInGroup.length === 1) {
                const t = transactionsInGroup[0];
                const logicalDate = t.event_date || t.created_at;
                nonGroupedItems.push({
                    id: t.id,
                    timestamp: logicalDate,
                    sortDate: logicalDate,
                    type: 'lesson',
                    isFinancial: true,
                    amount: t.net_amount,
                    grossAmount: t.gross_amount,
                    platformFee: t.platform_fee,
                    netAmount: t.net_amount,
                    status: t.status,
                    studentName: t.profiles?.full_name || 'Aluno',
                    stripePayoutId: t.stripe_payout_id
                });
            } else {
                const sortedGroup = [...transactionsInGroup].sort(
                    (a, b) => new Date(b.event_date || b.created_at).getTime() - new Date(a.event_date || a.created_at).getTime()
                );

                const latestTrans = sortedGroup[0];
                const logicalDate = latestTrans.event_date || latestTrans.created_at;

                let totalGross = 0;
                let totalFee = 0;
                let totalNet = 0;

                sortedGroup.forEach(t => {
                    totalGross += t.gross_amount || 0;
                    totalFee += t.platform_fee || 0;
                    totalNet += t.net_amount || 0;
                });

                const subLessons = sortedGroup.map(t => ({
                    id: t.id,
                    date: t.appointments?.date || t.event_date || t.created_at,
                    startTime: t.appointments?.start_time || '',
                    endTime: t.appointments?.end_time || '',
                    netAmount: t.net_amount
                })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

                comboHistoryItems.push({
                    id: `combo_${groupKey}`,
                    timestamp: logicalDate,
                    sortDate: logicalDate,
                    type: 'combo',
                    isFinancial: true,
                    amount: totalNet,
                    grossAmount: totalGross,
                    platformFee: totalFee,
                    netAmount: totalNet,
                    status: latestTrans.status,
                    studentName: latestTrans.profiles?.full_name || 'Aluno',
                    stripePayoutId: latestTrans.stripe_payout_id,
                    isCombo: true,
                    lessonCount: sortedGroup.length,
                    lessons: subLessons,
                    groupId: latestTrans.appointments?.group_id || groupKey
                });
            }
        });

        const items: HistoryItem[] = [...nonGroupedItems, ...comboHistoryItems].sort(
            (a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime()
        );

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

  const handleCpfCnpjChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = e.target.value;
    const formatted = formatCpfCnpj(rawVal);
    setCpfCnpj(formatted);

    const clean = rawVal.replace(/\D/g, '');
    if (clean.length <= 11) {
      setCompanyType('INDIVIDUAL');
    } else {
      if (companyType === 'INDIVIDUAL') {
        setCompanyType('MEI');
      }
    }
  };

  const handleCepChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    const formatted = formatCep(rawValue);
    setPostalCode(formatted);

    const cleanCep = rawValue.replace(/\D/g, '');
    if (cleanCep.length === 8) {
      setCepLoading(true);
      try {
        const res = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`);
        const data = await res.json();
        if (!data.erro) {
          setAddress(data.logradouro || '');
          setProvince(data.bairro || '');
          setCity(data.localidade || '');
          setState(data.uf || '');
        } else {
          addToast('CEP não encontrado.', 'warning');
        }
      } catch (err) {
        console.error('Erro ao buscar CEP', err);
      } finally {
        setCepLoading(false);
      }
    }
  };

  const handleSubmitAsaas = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const cleanCpfCnpj = cpfCnpj.replace(/\D/g, '');
    const cleanPostalCode = postalCode.replace(/\D/g, '');
    const cleanPhone = phone.replace(/\D/g, '');

    // Basic Validation
    if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
      addToast('Documento CPF (11 dígitos) ou CNPJ (14 dígitos) inválido.', 'error');
      return;
    }
    const isIndividual = cleanCpfCnpj.length <= 11;
    if (isIndividual) {
      if (!birthDate) {
        addToast('Informe sua data de nascimento para concluir o cadastro financeiro.', 'error');
        return;
      }
      const validation = isValidBirthDate(birthDate);
      if (!validation.valid) {
        addToast(validation.reason || 'Informe uma data de nascimento válida.', 'error');
        return;
      }
    }
    if (cleanPostalCode.length !== 8) {
      addToast('CEP inválido.', 'error');
      return;
    }
    if (!address.trim()) {
      addToast('O endereço é obrigatório.', 'error');
      return;
    }
    if (!addressNumber.trim()) {
      addToast('O número do endereço é obrigatório.', 'error');
      return;
    }
    if (!province.trim()) {
      addToast('O bairro é obrigatório.', 'error');
      return;
    }
    if (!city.trim()) {
      addToast('A cidade é obrigatória.', 'error');
      return;
    }
    if (!state.trim()) {
      addToast('O estado é obrigatório.', 'error');
      return;
    }

    const numIncome = parseBRLToNumber(incomeValue);
    if (!incomeValue || isNaN(numIncome) || numIncome <= 0) {
      const fieldName = isIndividual ? 'Renda Mensal Estimada' : 'Faturamento Mensal Estimado';
      addToast(`Informe o campo: ${fieldName}, com um valor maior que zero.`, 'error');
      return;
    }

    setSubmittingAsaas(true);
    try {
      const normalizedAddress = toTitleCase(address);
      const normalizedProvince = toTitleCase(province);
      const normalizedCity = toTitleCase(city);

      // Sincroniza estados do formulário para exibir normalizado na tela
      setAddress(normalizedAddress);
      setProvince(normalizedProvince);
      setCity(normalizedCity);

      const payload: any = {
        cpfCnpj: cleanCpfCnpj,
        companyType: cleanCpfCnpj.length <= 11 ? 'INDIVIDUAL' : companyType,
        postalCode: cleanPostalCode,
        address: normalizedAddress,
        addressNumber,
        complement,
        province: normalizedProvince,
        city: normalizedCity,
        state,
        phone: cleanPhone || undefined, // optional
        incomeValue: numIncome
      };

      if (isIndividual && birthDate) {
        const [, d, m, y] = birthDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || [];
        if (d && m && y) {
          payload.birthDate = `${y}-${m}-${d}`;
        }
      }

      const { data, error } = await invokeSecureFunction('create-asaas-account', {
        method: 'POST',
        body: payload
      });

      if (error) {
        if (error.message === 'SESSION_EXPIRED') {
          addToast("Sessão expirada. Por favor, realize o login novamente.", 'error');
          signOut();
          return;
        }
        throw error;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      addToast('Conta Asaas configurada com sucesso!', 'success');
      setIsAsaasModalOpen(false);
      
      // Auto reload data
      await loadData();
    } catch (err: any) {
      console.error('Error creating Asaas account:', err);
      addToast('Erro ao criar conta Asaas: ' + (err.message || 'tente novamente.'), 'error');
    } finally {
      setSubmittingAsaas(false);
    }
  };

  const handleSyncAsaasStatus = async () => {
    if (!session?.access_token) {
      addToast('Você precisa estar logado para sincronizar o status.', 'error');
      return;
    }

    try {
      setSyncingAsaas(true);
      const response = await fetch('/api/sync-asaas-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        }
      });

      const resData = await response.json();
      if (!response.ok) {
        throw new Error(resData.error || 'Falha ao sincronizar status.');
      }

      addToast('Status da conta Asaas atualizado com sucesso!', 'success');
      
      // Reload financial/onboarding status data in screen
      await loadData();
    } catch (err: any) {
      console.error('Error syncing Asaas status:', err);
      addToast('Erro ao sincronizar status: ' + (err.message || 'tente novamente.'), 'error');
    } finally {
      setSyncingAsaas(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const visibleItems = showAllHistory ? historyItems : historyItems.slice(0, 5);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 sm:max-w-md sm:mx-auto relative flex flex-col">
      
      <div className="px-6 py-6 bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="flex items-center justify-between">
          {/* Left Column: Title and Subtitle */}
          <div className="flex flex-col">
            <h1 className="text-xl font-bold text-gray-900 leading-tight">Financeiro</h1>
            <p className="text-xs text-gray-500 mt-0.5">Gestão de repasses</p>
          </div>
          
          {/* Right Column: Institutional Financial Partner Logo and Label */}
          <AsaasPartnerSeal className="min-w-[160px] shrink-0" />
        </div>
      </div>

      <div className="flex-1 px-6 py-6 space-y-6">
        
        <div className="space-y-4">
          {/* Main Card: Este mês */}
          <div className="bg-indigo-600 p-6 rounded-3xl shadow-lg shadow-indigo-100 flex flex-col text-white">
            <span className="text-[10px] text-indigo-200 font-bold uppercase tracking-widest mb-1 block">Este mês</span>
            <span className="text-4xl font-bold block mb-1">
                {loading ? '...' : formatCurrency(monthlyRevenue)}
            </span>
            <p className="text-[10px] text-indigo-200 font-medium mb-4">Valor líquido após taxas</p>
            
            {/* Seção de detalhamento do mês */}
            <div className="pt-4 border-t border-indigo-500/50 space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="text-indigo-200">Recebido em aulas</span>
                <span className="font-semibold">{loading ? '...' : formatCurrency(lessonMonthRevenue)}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-indigo-200">Recebido em caixinhas</span>
                <span className="font-semibold">{loading ? '...' : formatCurrency(tipMonthRevenue)}</span>
              </div>
            </div>

            {/* Parte inferior do card (Ganhos Totais e Total em Caixinhas) */}
            <div className="pt-4 mt-4 border-t border-indigo-500/50 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-indigo-200 uppercase font-bold tracking-wider">Ganhos totais</span>
                <span className="text-sm font-bold">{loading ? '...' : formatCurrency(totalRevenue)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-indigo-200 uppercase font-bold tracking-wider">Total em caixinhas</span>
                <span className="text-sm font-bold">{loading ? '...' : formatCurrency(tipTotalRevenue)}</span>
              </div>
            </div>
          </div>

          {/* Info Card - Accordion */}
          <div className="bg-gray-50 border border-gray-100 rounded-2xl overflow-hidden transition-all duration-300">
            <button
              onClick={() => setIsInfoExpanded(!isInfoExpanded)}
              className="w-full flex items-center justify-between p-4 hover:bg-gray-100/50 transition-colors text-left focus:outline-none"
            >
              <div className="flex items-center gap-3">
                <CircleHelp size={18} className="text-slate-500 shrink-0" />
                <div>
                  <h4 className="text-sm font-semibold text-gray-800 leading-tight">Como funcionam os repasses</h4>
                  <span className="text-[10px] text-gray-400 font-medium">Toque para saber mais</span>
                </div>
              </div>
              <ChevronDown 
                className={`w-4 h-4 text-gray-400 transition-transform duration-300 shrink-0 ${isInfoExpanded ? 'rotate-180' : ''}`}
              />
            </button>
            
            <div className={`grid transition-all duration-300 ease-in-out ${isInfoExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="px-4 pb-5 pt-1 border-t border-gray-100 space-y-4 text-xs text-gray-600">
                  
                  {/* Item 1 */}
                  <div className="space-y-1">
                    <h5 className="font-bold text-gray-800 flex items-center gap-1.5">
                      <span>💰</span> Comissão da plataforma
                    </h5>
                    <p className="leading-relaxed text-gray-500 pl-5">
                      A plataforma retém uma comissão fixa de 10% sobre cada aula. Essa comissão é vitalícia e não aumenta conforme seu crescimento dentro da plataforma.
                    </p>
                  </div>

                  {/* Item 2 */}
                  <div className="space-y-1">
                    <h5 className="font-bold text-gray-800 flex items-center gap-1.5">
                      <span>📈</span> Definição do valor da aula
                    </h5>
                    <p className="leading-relaxed text-gray-500 pl-5">
                      Você define livremente o valor da sua aula. Se desejar receber exatamente um determinado valor líquido por aula, considere definir o preço levando em conta a comissão fixa de 10%.
                    </p>
                  </div>

                  {/* Item 3 */}
                  <div className="space-y-1">
                    <h5 className="font-bold text-gray-800 flex items-center gap-1.5">
                      <span>💳</span> Pagamentos parcelados
                    </h5>
                    <p className="leading-relaxed text-gray-500 pl-5">
                      O aluno pode parcelar o pagamento. O parcelamento não altera o valor líquido da sua aula. Seu repasse permanece exatamente o mesmo.
                    </p>
                  </div>

                  {/* Item 4 */}
                  <div className="space-y-1">
                    <h5 className="font-bold text-gray-800 flex items-center gap-1.5">
                      <span>🎁</span> Caixinhas
                    </h5>
                    <p className="leading-relaxed text-gray-500 pl-5">
                      As caixinhas são repassadas integralmente ao instrutor. Quando existirem taxas do meio de pagamento, apenas essas taxas poderão ser descontadas.
                    </p>
                  </div>

                  {/* Item 5 */}
                  <div className="space-y-1">
                    <h5 className="font-bold text-gray-800 flex items-center gap-1.5">
                      <span>🏦</span> Recebimentos
                    </h5>
                    <p className="leading-relaxed text-gray-500 pl-5">
                      Os pagamentos são processados pelo Asaas, parceiro financeiro oficial da plataforma. Você pode acompanhar seus recebimentos tanto nesta tela quanto pelo aplicativo oficial do Asaas.
                    </p>
                  </div>

                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Asaas Callout Area */}
        <div className={`rounded-2xl p-5 border relative overflow-hidden transition-colors
            ${asaasStatus === 'active' ? 'bg-white border-gray-200' : 
              asaasStatus === 'processing' ? 'bg-blue-50 border-blue-100' :
              asaasStatus === 'denied' ? 'bg-red-50 border-red-100' :
              asaasStatus === 'none' ? 'bg-white border-gray-200' :
              'bg-yellow-50 border-yellow-100'
            }`}>
            
            <div className="relative z-10">
                <h3 className={`font-bold text-sm mb-1
                    ${asaasStatus === 'active' ? 'text-gray-900' : 
                      asaasStatus === 'processing' ? 'text-blue-900' :
                      asaasStatus === 'denied' ? 'text-red-900' :
                      asaasStatus === 'none' ? 'text-gray-900' :
                      'text-yellow-900'
                    }`}>
                    {asaasStatus === 'active' && 'Sua conta financeira está pronta'}
                    {asaasStatus === 'processing' && 'Conta em Análise no Asaas'}
                    {asaasStatus === 'pending' && 'Ação Necessária Asaas'}
                    {asaasStatus === 'denied' && 'Cadastro Rejeitado Asaas'}
                    {asaasStatus === 'none' && 'Comece a receber pelas suas aulas'}
                </h3>
                <p className={`text-xs leading-relaxed mb-4 max-w-[85%]
                    ${asaasStatus === 'active' ? 'text-gray-600' : 
                      asaasStatus === 'processing' ? 'text-blue-700/80' :
                      asaasStatus === 'denied' ? 'text-red-700/80' :
                      asaasStatus === 'none' ? 'text-gray-600' :
                      'text-yellow-800/80'
                    }`}>
                    {asaasStatus === 'active' && 'Agora você pode receber os pagamentos das suas aulas diretamente pela sua conta Asaas. Acompanhe seus repasses e movimentações sempre que precisar pelo aplicativo.'}
                    {asaasStatus === 'processing' && 'O Asaas está verificando seus dados e documentos. Isso pode levar alguns minutos ou horas.'}
                    {asaasStatus === 'pending' && 'Sua conta Asaas necessita do envio de documentos adicionais. Por favor, regularize no painel Asaas.'}
                    {asaasStatus === 'denied' && 'Seu cadastro de conta foi rejeitado pelo Asaas. Entre em contato com o suporte para mais informações.'}
                    {asaasStatus === 'none' && 'Crie gratuitamente sua conta Asaas e receba os pagamentos das suas aulas com segurança. Depois de concluído o cadastro, seus repasses serão enviados diretamente para sua conta financeira.'}
                </p>
                
                <div className="flex flex-col space-y-2">
                    {asaasStatus === 'none' && (
                        <Button 
                            variant="primary"
                            onClick={() => setIsAsaasModalOpen(true)}
                            className="bg-blue-600 hover:bg-blue-700 text-white border-transparent text-xs py-2.5 px-4 h-auto shadow-none w-full"
                        >
                            Criar Conta Asaas
                        </Button>
                    )}

                    {asaasStatus === 'active' && (
                        <Button 
                            variant="primary"
                            onClick={handleOpenAsaasApp}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white border-transparent text-xs py-2.5 px-4 h-auto shadow-none w-full flex items-center justify-center gap-2"
                        >
                            <ExternalLink size={14} />
                            Abrir aplicativo Asaas 📱
                        </Button>
                    )}

                    {asaasStatus !== 'none' && asaasStatus !== 'active' && (
                        <div className="flex flex-col space-y-3 w-full">
                            <div className="text-xs text-gray-500 flex flex-col space-y-1">
                                <span className="font-semibold text-gray-700">Canal de Recebimento de Aulas</span>
                                <span className="text-[11px]">Provedor Ativo: Asaas (Sandbox)</span>
                            </div>
                            <Button 
                                variant="outline"
                                onClick={handleSyncAsaasStatus}
                                loading={syncingAsaas}
                                className="bg-white border-2 border-gray-200 text-gray-700 hover:bg-gray-50 text-xs py-2.5 px-4 h-auto shadow-none w-full"
                            >
                                Verificar Status Asaas
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            
            {asaasStatus !== 'none' && asaasStatus !== 'active' && (
                <div className={`absolute -right-6 -bottom-8 w-24 h-24 rounded-full opacity-50 mix-blend-multiply filter blur-xl
                    ${asaasStatus === 'processing' ? 'bg-blue-200' : 
                      asaasStatus === 'denied' ? 'bg-red-200' :
                      'bg-yellow-200'
                    }`}></div>
            )}
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
            <div className="space-y-4">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50 overflow-hidden">
                  {visibleItems.map((item) => {
                      if (item.isCombo) {
                          const displayDesc = `Pacote • ${item.lessonCount} aulas`;
                          return (
                              <div 
                                  key={item.id} 
                                  onClick={() => toggleExpand(item.id)}
                                  className="p-4 flex flex-col hover:bg-gray-50 transition-colors cursor-pointer border-l-4 border-green-500"
                              >
                                  <div className="flex justify-between items-center w-full">
                                      <div className="flex flex-col space-y-1">
                                          <div className="flex items-center gap-2">
                                              <span className="text-xs text-gray-400 font-medium">{formatDate(item.sortDate)}</span>
                                              <span className="text-[10px] text-gray-300">•</span>
                                              <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">✅ {displayDesc}</span>
                                          </div>
                                          <span className="text-sm font-semibold text-gray-800">
                                              {item.studentName}
                                          </span>
                                      </div>
                                      <div className="text-right">
                                          <span className="block font-bold text-sm text-green-600">
                                              + {formatCurrency(Math.abs(item.netAmount || 0))}
                                          </span>
                                          <span className="text-[10px] text-gray-400">
                                              {item.status === 'pending' && 'Pendente'}
                                              {item.status === 'completed' && (
                                                  item.stripePayoutId 
                                                      ? 'Transferido' 
                                                      : <span className="text-green-600 font-bold">Concluído</span>
                                              )}
                                              {item.status === 'failed' && 'Falha'}
                                              {!['pending', 'completed', 'failed'].includes(item.status) && item.status}
                                          </span>
                                      </div>
                                  </div>

                                  {expandedId === item.id && (
                                      <div className="mt-3 pt-3 border-t border-gray-100 space-y-3 animate-fade-in">
                                          <div className="text-xs font-semibold text-gray-700">Aulas do Pacote ({item.lessonCount}):</div>
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
                                              <div className="text-gray-400">Valor Bruto Total:</div>
                                              <div className="text-gray-700 font-medium text-right">{formatCurrency(Math.abs(item.grossAmount || 0))}</div>
                                              
                                              {item.platformFee !== undefined && item.platformFee > 0 && (
                                                  <>
                                                      <div className="text-gray-400">Taxa Plataforma (10%):</div>
                                                      <div className="text-red-500 font-medium text-right">-{formatCurrency(Math.abs(item.platformFee))}</div>
                                                  </>
                                              )}
                                              
                                              <div className="text-gray-400 font-bold">Valor Líquido Total:</div>
                                              <div className="text-green-600 font-bold text-right">{formatCurrency(Math.abs(item.netAmount || 0))}</div>

                                              <div className="text-gray-400">ID da Compra:</div>
                                              <div className="text-gray-500 text-right font-mono">{(item.groupId || item.id).replace('combo_', '').slice(0, 12)}...</div>
                                          </div>
                                      </div>
                                  )}
                              </div>
                          );
                      }

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
                                          {item.status === 'pending' && 'Pendente'}
                                          {item.status === 'completed' && (
                                              item.stripePayoutId 
                                                  ? 'Transferido' 
                                                  : <span className="text-green-600 font-bold">Concluído</span>
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
                                                  
                                                  {item.type === 'lesson' && item.platformFee !== undefined && item.platformFee > 0 && (
                                                      <>
                                                          <div className="text-gray-400">Taxa Plataforma (10%):</div>
                                                          <div className="text-red-500 font-medium text-right">-{formatCurrency(Math.abs(item.platformFee))}</div>
                                                      </>
                                                  )}
                                                  
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
              {historyItems.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAllHistory(!showAllHistory)}
                  className="w-full text-center py-3 bg-white hover:bg-gray-50 text-gray-500 hover:text-gray-700 text-xs font-bold rounded-xl border border-gray-100 transition-colors flex items-center justify-center gap-1.5 focus:outline-none"
                >
                  {showAllHistory ? (
                    <>Mostrar menos ▲</>
                  ) : (
                    <>Ver histórico completo ({historyItems.length}) ▼</>
                  )}
                </button>
              )}
            </div>
          )}
        </div>

      </div>

      <Modal
        isOpen={isAsaasModalOpen}
        onClose={() => !submittingAsaas && setIsAsaasModalOpen(false)}
        title="Conta de Recebimentos Asaas"
      >
        <form onSubmit={handleSubmitAsaas} className="space-y-4">
          <p className="text-xs text-gray-500 leading-relaxed mb-2">
            Complete seu cadastro para ativar sua Conta de Recebimentos Asaas. Após a aprovação, você poderá receber pagamentos das aulas, acompanhar seu saldo, realizar pagamentos e solicitar o Cartão Asaas, utilizando sua própria conta Asaas sem precisar transferir o dinheiro para outro banco.
          </p>

          <Input
            label="CPF ou CNPJ"
            placeholder="000.000.000-00 ou 00.000.000/0000-00"
            value={cpfCnpj}
            onChange={handleCpfCnpjChange}
            type="text"
            required
            disabled={submittingAsaas}
          />

          {cpfCnpj.replace(/\D/g, '').length <= 11 && (
            <Input
              label="Data de Nascimento"
              value={birthDate}
              onChange={(e) => setBirthDate(formatBirthDateInput(e.target.value))}
              type="text"
              inputMode="numeric"
              placeholder="dd/mm/aaaa"
              maxLength={10}
              required={cpfCnpj.replace(/\D/g, '').length <= 11}
              disabled={submittingAsaas}
            />
          )}

          {cpfCnpj.replace(/\D/g, '').length > 11 && (
            <div className="flex flex-col space-y-2 w-full text-left">
              <label className="text-sm font-semibold text-gray-700 ml-1">
                Tipo de Empresa
              </label>
              <select
                value={companyType}
                onChange={(e) => setCompanyType(e.target.value as 'MEI' | 'LIMITED')}
                className="w-full px-4 py-3.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all duration-200"
                disabled={submittingAsaas}
                required
              >
                <option value="MEI">Microempreendedor Individual (MEI)</option>
                <option value="LIMITED">Sociedade Limitada (LTDA)</option>
              </select>
            </div>
          )}

          <div className="relative">
            <Input
              label="CEP"
              placeholder="00000-000"
              value={postalCode}
              onChange={handleCepChange}
              type="text"
              required
              disabled={submittingAsaas || cepLoading}
            />
            {cepLoading && (
              <span className="absolute right-4 bottom-3.5 text-xs text-blue-500 flex items-center gap-1">
                <svg className="animate-spin h-3.5 w-3.5 text-blue-500 animate-fade-in" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                Buscando...
              </span>
            )}
          </div>

          <Input
            label="Rua / Endereço"
            placeholder="Nome da rua"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            type="text"
            required
            disabled={submittingAsaas}
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Número"
              placeholder="Ex: 123"
              value={addressNumber}
              onChange={(e) => setAddressNumber(e.target.value)}
              type="text"
              required
              disabled={submittingAsaas}
            />
            <Input
              label="Complemento"
              placeholder="Apto, Bloco..."
              value={complement}
              onChange={(e) => setComplement(e.target.value)}
              type="text"
              disabled={submittingAsaas}
            />
          </div>

          <Input
            label="Bairro"
            placeholder="Nome do bairro"
            value={province}
            onChange={(e) => setProvince(e.target.value)}
            type="text"
            required
            disabled={submittingAsaas}
          />

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input
                label="Cidade"
                placeholder="Ex.: São Paulo"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                type="text"
                required
                disabled={submittingAsaas}
              />
            </div>
            <div>
              <Input
                label="UF"
                placeholder="SP"
                value={state}
                onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
                type="text"
                required
                disabled={submittingAsaas}
              />
            </div>
          </div>

          <Input
            label="Telefone *"
            placeholder="(11) 99999-9999"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            type="text"
            disabled={submittingAsaas}
          />

          <div className="flex flex-col space-y-1">
            <Input
              label={cpfCnpj.replace(/\D/g, '').length <= 11 ? "Renda Mensal Estimada (R$)" : "Faturamento Mensal Estimado (R$)"}
              placeholder="R$ 0,00"
              value={incomeValue}
              onChange={(e) => setIncomeValue(formatToBRL(e.target.value))}
              type="text"
              inputMode="numeric"
              required
              disabled={submittingAsaas}
            />
            <p className="text-[11px] text-gray-500 ml-1 leading-relaxed">
              Informação exigida pelo parceiro financeiro Asaas para validação regulatória da conta de recebimentos.
            </p>
          </div>

          <div className="pt-4 flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsAsaasModalOpen(false)}
              disabled={submittingAsaas}
              className="flex-1 py-3 text-xs"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={submittingAsaas}
              className="flex-1 py-3 text-xs"
            >
              Confirmar
            </Button>
          </div>
        </form>
      </Modal>

      <InstructorBottomNav />
    </div>
  );
};