import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { StudentBottomNav } from '../../components/StudentBottomNav';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';

// --- Types ---
type LessonStatus = 'scheduled' | 'pending' | 'completed' | 'cancelled' | 'in_progress' | 'expired' | 'rejected' | 'confirmed';

interface Lesson {
  id: string;
  instructorName: string;
  instructorId: string;
  instructorPhoto?: string;
  instructorWhatsapp?: string;
  vehicleModel?: string;
  date: Date;
  time: string;
  endTime: string;
  status: LessonStatus;
  price: number;
  location: string;
  lessonCategory: 'A' | 'B';
  isReviewed?: boolean; 
}

interface LessonGroup extends Omit<Lesson, 'id' | 'price' | 'endTime'> {
    ids: string[];
    totalPrice: number;
    endTime: string;
    count: number;
}

// --- Helpers ---
const getStartOfWeek = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const formatDate = (date: Date) => {
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
};

const getDayName = (date: Date) => {
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return days[date.getDay()];
};

const addMinutesToTime = (time: string, minutesToAdd: number) => {
  const [h, m] = time.split(':').map(Number);
  const date = new Date();
  date.setHours(h, m + minutesToAdd, 0, 0);
  const endH = String(date.getHours()).padStart(2, '0');
  const endM = String(date.getMinutes()).padStart(2, '0');
  return `${endH}:${endM}`;
};

const isNightLesson = (time: string) => {
  const [h] = time.split(':').map(Number);
  return h >= 18;
};

// --- Stripe Initialization ---
const stripeKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY;
const stripePromise = stripeKey ? loadStripe(stripeKey) : null;

// --- Tip Checkout Form ---
const TipCheckoutForm = ({ 
  clientSecret, 
  onSuccess, 
  onCancel, 
  amount, 
  isSubmitting 
}: { 
  clientSecret: string; 
  onSuccess: () => void; 
  onCancel: () => void;
  amount: number;
  isSubmitting: boolean;
}) => {
  const stripe = useStripe();
  const elements = useElements();
  const { addToast } = useToast();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!stripe || !elements) return;

    setErrorMessage(null);

    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/#/student/lessons`,
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Erro ao processar pagamento.');
        addToast(error.message || 'Erro ao processar pagamento.', 'error');
      } else if (paymentIntent && paymentIntent.status === 'succeeded') {
        onSuccess();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Erro interno.');
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

      <div className="space-y-3 pt-2">
        <Button 
          type="submit" 
          fullWidth 
          variant="primary"
          disabled={!stripe || isSubmitting}
          className="shadow-lg shadow-blue-100"
        >
          {isSubmitting ? 'Processando...' : `Confirmar R$ ${amount.toFixed(2).replace('.', ',')}`}
        </Button>
        <p className="text-center text-[10px] text-gray-400 uppercase tracking-widest font-bold">
          Pagamento imediato
        </p>

        <Button 
          fullWidth 
          variant="outline" 
          onClick={onCancel}
          disabled={isSubmitting}
          className="border-transparent text-gray-500 hover:bg-gray-50 hover:text-gray-700 shadow-none"
        >
          Pular caixinha
        </Button>
      </div>
    </form>
  );
};

export const StudentLessons: React.FC = () => {
  const navigate = useNavigate();
  const { session, serverTimeOffset } = useAuth();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  
  // Security Profile Data
  const [trustedContact, setTrustedContact] = useState<string | null>(null);
  const [securityMessage, setSecurityMessage] = useState<string>('Estou em aula agora e compartilho minha localização.');
  
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDayIndex, setSelectedDayIndex] = useState(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1);
  
  // Finalization Flow State
  const [finalizingLessonGroup, setFinalizingLessonGroup] = useState<LessonGroup | null>(null);
  const [flowStep, setFlowStep] = useState<'rating' | 'tip' | 'success' | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  // Cancellation Flow State
  const [lessonToCancel, setLessonToCancel] = useState<LessonGroup | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  // Tip Flow State
  const [selectedTip, setSelectedTip] = useState<number | null>(20); // Default to 20 as suggested
  const [customTip, setCustomTip] = useState('');
  const [isSubmittingTip, setIsSubmittingTip] = useState(false);
  const [tipClientSecret, setTipClientSecret] = useState<string | null>(null);
  const [tipGiven, setTipGiven] = useState(false);

  // Security Flow State
  const [isLocating, setIsLocating] = useState(false);

  // Pending Review State
  const [pendingReviewAptId, setPendingReviewAptId] = useState<string | null>(null);
  const hasPromptedReview = React.useRef(false);

  const weekStart = getStartOfWeek(currentDate);
  const weekEnd = addDays(weekStart, 6);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const selectedDate = weekDays[selectedDayIndex];

  const [lessons, setLessons] = useState<Lesson[]>([]);

  // --- FETCH PENDING REVIEW ---
  useEffect(() => {
    if (!session?.user) return;
    const checkPendingReview = async () => {
      try {
        const { data, error } = await supabase.rpc('get_pending_review', { p_student_id: session.user.id });
        if (!error && data && data.length > 0) {
          setPendingReviewAptId(data[0].appointment_id);
        }
      } catch (err) {
        console.error('Error checking pending review:', err);
      }
    };
    checkPendingReview();
  }, [session?.user]);

  // --- AUTO-OPEN REVIEW MODAL ---
  useEffect(() => {
    if (pendingReviewAptId && lessons.length > 0 && !hasPromptedReview.current && !flowStep) {
      const apt = lessons.find(l => l.id === pendingReviewAptId);
      if (apt) {
        hasPromptedReview.current = true;
        const group: LessonGroup = {
          ids: [apt.id],
          count: 1,
          totalPrice: apt.price,
          endTime: apt.endTime,
          instructorName: apt.instructorName,
          instructorId: apt.instructorId,
          instructorPhoto: apt.instructorPhoto,
          instructorWhatsapp: apt.instructorWhatsapp,
          vehicleModel: apt.vehicleModel,
          date: apt.date,
          time: apt.time,
          status: apt.status,
          location: apt.location,
          lessonCategory: apt.lessonCategory,
          isReviewed: apt.isReviewed
        };
        startFinalization(group);
      }
    }
  }, [pendingReviewAptId, lessons, flowStep]);

  // --- FETCH REAL DATA ---
  useEffect(() => {
    if (!session?.user) return;

    const fetchLessons = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('appointments')
          .select(`
            id,
            date,
            start_time,
            status,
            price,
            category,
            instructor_id,
            instructors (
              whatsapp,
              meeting_point,
              profiles (
                full_name,
                avatar_url,
                experience_level,
                cnh_process_type
              ),
              instructor_vehicles (
                type,
                model
              )
            ),
            reviews (
               id
            )
          `)
          .eq('student_id', session.user.id)
          .neq('status', 'cancelled');

        if (error) throw error;

        if (data) {
          const now = new Date(Date.now() + serverTimeOffset);

          const mappedLessons: Lesson[] = data.map((apt: any) => {
            const [year, month, day] = apt.date.split('-').map(Number);
            const [hours, minutes] = apt.start_time.split(':').map(Number);
            const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            const endTimeStr = addMinutesToTime(timeStr, 50);

            const lessonDate = new Date(year, month - 1, day);
            const lessonStartDateTime = new Date(year, month - 1, day, hours, minutes);
            const lessonEndDateTime = new Date(lessonStartDateTime);
            lessonEndDateTime.setMinutes(lessonEndDateTime.getMinutes() + 50);

            let displayStatus: LessonStatus = apt.status as LessonStatus;
            
            const hasReview = apt.reviews && apt.reviews.length > 0;

            if (apt.status === 'pending' || apt.status === 'pending_approval') {
               const [year, month, day] = apt.date.split('-').map(Number);
               const [hours, minutes] = apt.start_time.split(':').map(Number);
               const lessonStartDateTime = new Date(year, month - 1, day, hours, minutes);
               const now = new Date(Date.now() + serverTimeOffset);
               
               if (now >= lessonStartDateTime) {
                  displayStatus = 'expired';
               } else {
                  displayStatus = 'pending';
               }
            }

            const instructorData = apt.instructors;
            const category = apt.category as 'A' | 'B';
            
            let vehicleModel = undefined;
            if (instructorData?.instructor_vehicles) {
                if (category === 'B') {
                    const car = instructorData.instructor_vehicles.find((v: any) => v.type === 'car');
                    if (car) vehicleModel = car.model;
                } else if (category === 'A') {
                    const bike = instructorData.instructor_vehicles.find((v: any) => v.type === 'bike');
                    if (bike) vehicleModel = bike.model;
                }
            }

            return {
              id: apt.id,
              instructorId: apt.instructor_id,
              instructorName: instructorData?.profiles?.full_name || 'Instrutor',
              instructorPhoto: instructorData?.profiles?.avatar_url,
              instructorWhatsapp: instructorData?.whatsapp,
              vehicleModel: vehicleModel,
              location: instructorData?.meeting_point || 'Local a combinar',
              date: lessonDate,
              time: timeStr,
              endTime: endTimeStr,
              status: displayStatus,
              price: apt.price,
              lessonCategory: category,
              isReviewed: hasReview
            };
          });

          setLessons(mappedLessons);
        }
      } catch (err) {
        console.error('Error fetching lessons:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchLessons();

    const interval = setInterval(fetchLessons, 30000);
    return () => clearInterval(interval);

  }, [session, currentDate]);

  // Fetch Student Profile for Security Features
  useEffect(() => {
    if (!session?.user) return;

    const fetchProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('trusted_contact, security_message')
          .eq('id', session.user.id)
          .single();

        if (error) throw error;

        if (data) {
          setTrustedContact(data.trusted_contact);
          if (data.security_message) {
            setSecurityMessage(data.security_message);
          }
        }
      } catch (error) {
        console.error('Error fetching profile for security:', error);
      }
    };

    fetchProfile();
  }, [session]);

  const handlePrevWeek = () => setCurrentDate(addDays(currentDate, -7));
  const handleNextWeek = () => setCurrentDate(addDays(currentDate, 7));

  const startFinalization = (group: LessonGroup) => {
    setFinalizingLessonGroup(group);
    setFlowStep('rating');
    setRating(0);
    setComment('');
    setSelectedTip(20); // Reset to 20
    setCustomTip('');
    setIsSubmittingTip(false);
    setTipClientSecret(null);
  };

  const submitRating = () => {
    if (rating >= 4) {
      setFlowStep('tip');
    } else {
      // If rating is low, skip tip and finish
      completeLessonFlow(0);
    }
  };

  const handleTipPayment = async (amount: number) => {
    if (!finalizingLessonGroup || !session?.user || amount < 1) return;
    
    setIsSubmittingTip(true);
    try {
      // 1. Create PaymentIntent via Edge Function
      const { data, error } = await supabase.functions.invoke('create-tip', {
        body: {
          appointment_id: finalizingLessonGroup.ids[finalizingLessonGroup.ids.length - 1],
          amount: Math.round(amount * 100) // Convert to cents
        }
      });

      if (error) throw error;
      if (!data?.clientSecret) throw new Error('Falha ao gerar intenção de pagamento.');

      // 2. Set clientSecret to show Stripe Elements
      setTipClientSecret(data.clientSecret);
    } catch (err: any) {
      console.error("Error creating tip intent:", err);
      addToast(err.message || "Erro ao iniciar pagamento da caixinha.", 'error');
    } finally {
      setIsSubmittingTip(false);
    }
  };

  const handleSkipTip = () => {
    completeLessonFlow(0);
  };

  const completeLessonFlow = async (tipAmount: number) => {
    if (!finalizingLessonGroup || !session?.user) return;
    setIsSubmittingTip(true);
    if (tipAmount > 0) setTipGiven(true);
    
    const lessonIds = finalizingLessonGroup.ids;
    // We attach the review/tip to the LAST lesson in the group for simplicity in this MVP
    const mainReferenceId = lessonIds[lessonIds.length - 1]; 

    try {
       // 1. Create or Update Review
       const { error: reviewError } = await supabase
         .from('reviews')
         .upsert({
           appointment_id: mainReferenceId,
           student_id: session.user.id,
           instructor_id: finalizingLessonGroup.instructorId,
           rating: rating,
           comment: comment
         }, { onConflict: 'student_id,instructor_id' });
       
       if (reviewError) throw reviewError;

       // 1.5 Update Appointment Status to 'completed'
       const { error: statusError } = await supabase
         .from('appointments')
         .update({ 
           status: 'completed',
           updated_at: new Date().toISOString()
         })
         .in('id', lessonIds);
       
       if (statusError) throw statusError;

       // 3. Update Local State (Optimistic UI)
       setLessons(prev => prev.map(l => 
          lessonIds.includes(l.id)
             ? { ...l, isReviewed: true } 
             : l
       ));
       
       if (lessonIds.includes(pendingReviewAptId || '')) {
         setPendingReviewAptId(null);
       }

       setFlowStep('success');

    } catch (err: any) {
       console.error("Error finalizing lesson:", err);
       addToast("Erro ao finalizar a aula: " + err.message, 'error');
    } finally {
        setIsSubmittingTip(false);
    }
  };

  // --- CANCELLATION LOGIC START ---
  const handleCancelClick = (group: LessonGroup) => {
    // 1. Pending: Always allow cancel
    if (group.status === 'pending') {
      setLessonToCancel(group);
      return;
    }

    // 2. Scheduled: Check 24h rule
    const now = new Date(Date.now() + serverTimeOffset);
    // Parse start time "HH:MM"
    const [h, m] = group.time.split(':').map(Number);
    const lessonStart = new Date(group.date);
    lessonStart.setHours(h, m, 0, 0);

    const diffMs = lessonStart.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 24) {
      // BLOCK: Educational Toast
      addToast("Faltam menos de 24h. Para cancelar, contate seu instrutor diretamente pelo WhatsApp.", "warning");
      
      if (group.instructorWhatsapp) {
         // Offer to open WhatsApp
         const clean = group.instructorWhatsapp.replace(/\D/g, '');
         const full = clean.startsWith('55') ? clean : `55${clean}`;
         const msg = encodeURIComponent(`Olá, preciso cancelar minha aula do dia ${formatDate(group.date)} às ${group.time}, mas o app não permite com menos de 24h. Podemos conversar?`);
         setTimeout(() => {
            if(confirm("Deseja abrir o WhatsApp do instrutor agora?")) {
               window.open(`https://wa.me/${full}?text=${msg}`, '_blank');
            }
         }, 1500);
      }
    } else {
      // ALLOW: Open Modal
      setLessonToCancel(group);
    }
  };

  const confirmCancellation = async () => {
    if (!lessonToCancel) return;
    setIsCancelling(true);

    try {
      const { error } = await supabase
        .from('appointments')
        .update({ 
          status: 'cancelled',
          cancelled_by: 'student',
          cancelled_reason: 'user_cancelled'
        })
        .in('id', lessonToCancel.ids);

      if (error) throw error;

      // Optimistic Update
      setLessons(prev => prev.filter(l => !lessonToCancel.ids.includes(l.id)));
      
      addToast("Aula cancelada e horário liberado.", "success");
      setLessonToCancel(null);

    } catch (err: any) {
      console.error("Error cancelling:", err);
      addToast("Erro ao cancelar: " + err.message, "error");
    } finally {
      setIsCancelling(false);
    }
  };
  // --- CANCELLATION LOGIC END ---

  const closeFlow = () => {
    setFlowStep(null);
    setFinalizingLessonGroup(null);
    setIsSubmittingTip(false);
    setTipClientSecret(null);
    setTipGiven(false);
  };

  const handleSecurityClick = () => {
    setIsLocating(true);
    
    // Use state data instead of localStorage
    const contact = trustedContact || '';
    const cleanContact = contact.replace(/\D/g, '');

    if (!cleanContact) {
        addToast("Você precisa cadastrar um contato de confiança no seu Perfil primeiro.", 'warning');
        setIsLocating(false);
        navigate('/student/profile');
        return;
    }

    if (!navigator.geolocation) {
      addToast("Geolocalização não é suportada.", 'error');
      setIsLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;
        const text = `${securityMessage}\n\nMinha localização atual:\n${mapsLink}`;
        const encodedText = encodeURIComponent(text);
        
        // Ensure country code
        const fullContact = cleanContact.startsWith('55') ? cleanContact : `55${cleanContact}`;
        
        const waLink = `https://wa.me/${fullContact}?text=${encodedText}`;
        window.open(waLink, '_blank');
        setIsLocating(false);
      },
      (error) => {
        console.error("Geolocation error:", error);
        addToast("Não foi possível obter a localização. Verifique as permissões do navegador.", 'error');
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handleWhatsappClick = (whatsapp: string) => {
     const clean = whatsapp.replace(/\D/g, '');
     const full = clean.startsWith('55') ? clean : `55${clean}`;
     window.open(`https://wa.me/${full}`, '_blank');
  };

  // --- GROUPING LOGIC ---
  const sortedDailyLessons = useMemo<LessonGroup[]>(() => {
    const daily = lessons.filter(l => 
      l.date.toDateString() === selectedDate.toDateString()
    );

    daily.sort((a, b) => a.time.localeCompare(b.time));

    const groups: LessonGroup[] = [];
    if (daily.length === 0) return [];

    let currentGroup: LessonGroup = {
        ids: [daily[0].id],
        count: 1,
        totalPrice: daily[0].price,
        endTime: daily[0].endTime,
        instructorName: daily[0].instructorName,
        instructorId: daily[0].instructorId,
        instructorPhoto: daily[0].instructorPhoto,
        instructorWhatsapp: daily[0].instructorWhatsapp,
        vehicleModel: daily[0].vehicleModel,
        date: daily[0].date,
        time: daily[0].time,
        status: daily[0].status,
        location: daily[0].location,
        lessonCategory: daily[0].lessonCategory,
        isReviewed: daily[0].isReviewed
    };

    for (let i = 1; i < daily.length; i++) {
        const next = daily[i];
        
        if (
            currentGroup.endTime === next.time &&
            currentGroup.instructorName === next.instructorName &&
            currentGroup.status === next.status &&
            currentGroup.lessonCategory === next.lessonCategory
        ) {
            currentGroup.ids.push(next.id);
            currentGroup.count += 1;
            currentGroup.totalPrice += next.price;
            currentGroup.endTime = next.endTime; 
            
            if (!next.isReviewed) currentGroup.isReviewed = false;

        } else {
            groups.push(currentGroup);
            currentGroup = {
                ids: [next.id],
                count: 1,
                totalPrice: next.price,
                endTime: next.endTime,
                instructorName: next.instructorName,
                instructorId: next.instructorId,
                instructorPhoto: next.instructorPhoto,
                instructorWhatsapp: next.instructorWhatsapp,
                vehicleModel: next.vehicleModel,
                date: next.date,
                time: next.time,
                status: next.status,
                location: next.location,
                lessonCategory: next.lessonCategory,
                isReviewed: next.isReviewed
            };
        }
    }
    groups.push(currentGroup);

    return groups.sort((a, b) => {
      const getWeight = (s: LessonStatus) => {
        if (s === 'in_progress') return 1;
        if (s === 'scheduled' || s === 'pending') return 2;
        return 3;
      };
      const wA = getWeight(a.status);
      const wB = getWeight(b.status);
      if (wA !== wB) return wA - wB;
      return a.time.localeCompare(b.time);
    });
  }, [lessons, selectedDate]);

  const renderStatusBadge = (status: LessonStatus) => {
    switch (status) {
      case 'scheduled': 
         return <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">Agendada</span>;
      case 'pending': 
         return <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">Aguardando</span>;
      case 'in_progress': 
        return <span className="text-xs font-bold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-100 animate-pulse">Em andamento</span>;
      case 'confirmed':
        return <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">Aguardando finalização</span>;
      case 'completed': 
        return <span className="text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full border border-green-100">Aula concluída</span>;
      case 'expired':
        return <span className="text-xs font-medium text-gray-600 bg-gray-100 px-2.5 py-1 rounded-full border border-gray-200">Expirada</span>;
      case 'rejected':
        return <span className="text-xs font-medium text-red-600 bg-red-50 px-2.5 py-1 rounded-full border border-red-100">Recusada</span>;
      case 'cancelled':
        return <span className="text-xs font-medium text-red-600 bg-red-50 px-2.5 py-1 rounded-full border border-red-100">Cancelada</span>;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      {/* Header & Date Strip */}
      <div className="bg-white px-6 pt-6 pb-4 border-b border-gray-100 shadow-sm z-10 sticky top-0">
        <h1 className="text-xl font-bold text-gray-900 mb-4">Minhas Aulas</h1>
        
        {/* Week Controls */}
        <div className="flex items-center justify-between mb-4 bg-gray-50 rounded-lg p-1">
          <button onClick={handlePrevWeek} className="p-1.5 text-blue-600 hover:bg-white rounded-md">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-xs font-semibold text-gray-700">
            {formatDate(weekStart)} - {formatDate(weekEnd)}
          </span>
          <button onClick={handleNextWeek} className="p-1.5 text-blue-600 hover:bg-white rounded-md">
             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Days Strip */}
        <div className="flex justify-between items-center space-x-1">
          {weekDays.map((date, index) => {
            const isSelected = index === selectedDayIndex;
            const isToday = new Date().toDateString() === date.toDateString();
            return (
              <button
                key={index}
                onClick={() => setSelectedDayIndex(index)}
                className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl flex-1 transition-all duration-200 
                  ${isSelected ? 'bg-blue-600 text-white shadow-md transform scale-105' : 'bg-transparent text-gray-500 hover:bg-gray-50'}
                `}
              >
                <span className={`text-[10px] font-medium uppercase ${isSelected ? 'text-blue-100' : 'text-gray-400'}`}>
                  {getDayName(date)}
                </span>
                <span className={`text-sm font-bold leading-none mt-0.5 ${isSelected ? 'text-white' : 'text-gray-700'}`}>
                  {date.getDate()}
                </span>
                {isToday && (<div className={`w-1 h-1 rounded-full mt-1 ${isSelected ? 'bg-white' : 'bg-blue-600'}`}></div>)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lesson List */}
      <div className="px-4 py-4 space-y-4">
        
        {loading ? (
             <div className="flex items-center justify-center py-12">
                 <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
             </div>
        ) : sortedDailyLessons.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 font-medium">Nenhuma aula neste dia.</p>
          </div>
        ) : (
          sortedDailyLessons.map((group, index) => {
            const isNight = isNightLesson(group.time);
            const isMulti = group.count > 1;
            const isPast = ['completed', 'expired', 'cancelled', 'rejected'].includes(group.status);
            const isNext = !isPast && index === sortedDailyLessons.findIndex(g => !['completed', 'expired', 'cancelled', 'rejected'].includes(g.status));

            return (
              <div key={group.ids[0]} className={`bg-white p-4 rounded-2xl border flex flex-col relative overflow-hidden transition-all hover:shadow-md ${isNext ? 'border-blue-200 shadow-md ring-1 ring-blue-50' : 'border-gray-100 shadow-sm'} ${isPast ? 'opacity-70 grayscale-[0.2]' : ''}`}>
                
                {isNext && (
                  <div className="absolute top-0 left-0 right-0 h-1 bg-blue-500"></div>
                )}
                {isMulti && !isNext && (
                  <div className="absolute top-0 left-0 bottom-0 w-1 bg-blue-500"></div>
                )}

                {/* Top: Time and Status */}
                <div className="flex justify-between items-center mb-4">
                  <div className="flex items-center space-x-2">
                    <span className="text-xl font-bold text-gray-900 tracking-tight">
                      {group.time}
                    </span>
                    <span className="text-gray-400 text-sm font-medium">
                      – {group.endTime}
                    </span>
                    <span className="text-lg ml-1" title={isNight ? 'Noturna' : 'Diurna'}>
                      {isNight ? '🌙' : '☀️'}
                    </span>
                    {isMulti && (
                        <span className="text-[10px] font-bold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full border border-blue-200 ml-1">
                           {group.count} aulas
                        </span>
                    )}
                  </div>
                  
                  <div className="flex items-center">
                      {renderStatusBadge(group.status)}
                  </div>
                </div>

                {/* Middle: Instructor & Vehicle */}
                <div className="flex items-center mb-4">
                  {/* Avatar */}
                  <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-xl mr-3 border border-gray-100 overflow-hidden shrink-0 text-gray-400">
                    {group.instructorPhoto ? (
                      <img src={group.instructorPhoto} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span>👤</span>
                    )}
                  </div>
                  
                  {/* Name and Vehicle */}
                  <div className="flex flex-col min-w-0">
                     <span className="font-semibold text-gray-900 text-base leading-tight truncate">{group.instructorName}</span>
                     <div className="flex items-center text-xs text-gray-500 mt-1 truncate">
                       <span className="truncate">
                         {group.lessonCategory === 'A' ? '🏍' : '🚘'} {group.vehicleModel || 'Veículo'} • Cat. {group.lessonCategory}
                       </span>
                     </div>
                  </div>
                </div>

                {/* Bottom: Location & Actions */}
                <div className="flex items-center justify-between pt-3 border-t border-gray-50">
                    <div className="flex items-center text-xs text-gray-500 truncate pr-2">
                      <svg className="w-4 h-4 mr-1.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span className="truncate">{group.location}</span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Cancel Button */}
                        {(group.status === 'scheduled' || group.status === 'pending') && (
                           <Button 
                             variant="outline"
                             onClick={() => handleCancelClick(group)}
                             className="text-xs px-3 py-1.5 h-8 min-h-0 bg-white border-gray-200 text-red-500 hover:bg-red-50 hover:border-red-100"
                           >
                             Cancelar
                           </Button>
                        )}

                        {/* WhatsApp Button */}
                        {group.instructorWhatsapp && (group.status === 'scheduled' || group.status === 'in_progress' || group.status === 'pending') && (
                            <button 
                                onClick={() => handleWhatsappClick(group.instructorWhatsapp!)}
                                className="flex items-center justify-center w-8 h-8 rounded-full bg-green-50 text-green-600 hover:bg-green-100 border border-green-100 transition-colors shadow-sm"
                                aria-label="WhatsApp"
                            >
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                                </svg>
                            </button>
                        )}
                        
                        {/* Finalize Button */}
                        {group.status === 'confirmed' && (
                            <Button 
                            variant="primary" 
                            onClick={() => startFinalization(group)}
                            className="text-xs px-4 py-2 h-8 min-h-0 shadow-sm"
                            >
                            Finalizar aula
                            </Button>
                        )}

                        {/* Location/Security Button */}
                        {group.status === 'in_progress' && (
                            <Button
                                onClick={handleSecurityClick}
                                disabled={isLocating}
                                className="bg-white text-gray-500 hover:text-gray-700 border-gray-200 shadow-none px-3 py-1.5 text-xs h-8 min-h-0 flex items-center"
                                variant="outline"
                            >
                                {isLocating ? '...' : '📍 Compartilhar'}
                            </Button>
                        )}
                    </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Cancellation Modal */}
      <Modal
        isOpen={!!lessonToCancel}
        onClose={() => setLessonToCancel(null)}
        title="Cancelar aula"
        footer={
           <div className="flex space-x-3 w-full">
              <Button variant="outline" fullWidth onClick={() => setLessonToCancel(null)}>
                Não
              </Button>
              <Button 
                fullWidth 
                onClick={confirmCancellation}
                disabled={isCancelling}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-500 shadow-none"
              >
                {isCancelling ? 'Cancelando...' : 'Sim, cancelar'}
              </Button>
            </div>
        }
      >
        <div className="text-center py-2">
           <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl">
              🚫
           </div>
           <p className="text-sm text-gray-600 leading-relaxed">
             Tem certeza que deseja cancelar?
           </p>
           {lessonToCancel?.status === 'scheduled' && (
             <p className="text-xs text-gray-400 mt-2">
               O horário ficará livre para outro aluno agendar.
             </p>
           )}
        </div>
      </Modal>

      {/* Finalization Modal */}
      <Modal
        isOpen={!!flowStep}
        onClose={closeFlow}
        title={
            flowStep === 'rating' ? "Como foi a aula?" :
            flowStep === 'tip' ? "Gostaria de dar uma caixinha?" :
            "Aula finalizada!"
        }
        footer={null}
      >
        {flowStep === 'rating' && (
            <div className="space-y-6">
            <div className="text-center">
                <p className="text-sm text-gray-500">Avalie sua experiência com o instrutor</p>
            </div>
            
            <div className="flex justify-center space-x-2">
                {[1, 2, 3, 4, 5].map((star) => (
                <button 
                    key={star} 
                    onClick={() => setRating(star)}
                    className={`text-4xl focus:outline-none transition-transform active:scale-90 ${rating >= star ? 'text-yellow-400' : 'text-gray-200'}`}
                >
                    ★
                </button>
                ))}
            </div>

            <textarea
                placeholder="Escreva um comentário (opcional)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm resize-none"
                rows={3}
            />

            <div className="space-y-2">
                <Button fullWidth onClick={submitRating} disabled={rating === 0}>
                    Avaliar
                </Button>
                <button onClick={closeFlow} className="w-full text-center text-sm text-gray-400 py-2">Cancelar</button>
            </div>
            </div>
        )}

        {flowStep === 'tip' && (
            <div className="space-y-6">
              {/* Instructor Header */}
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 rounded-full bg-gray-100 border-2 border-white shadow-md overflow-hidden mb-3">
                  {finalizingLessonGroup?.instructorPhoto ? (
                    <img src={finalizingLessonGroup.instructorPhoto} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-3xl text-gray-400">👤</div>
                  )}
                </div>
                <h3 className="text-lg font-bold text-gray-900 leading-tight">
                  {finalizingLessonGroup?.instructorName}
                </h3>
                <p className="text-xl font-bold text-blue-600 mt-2">Gostou da aula?</p>
                <p className="text-sm text-gray-500 mt-2 leading-relaxed px-4">
                  A aula já foi concluída. Você pode enviar uma caixinha opcional. O valor será cobrado agora do seu cartão.
                </p>
              </div>

              {!tipClientSecret ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    {[5, 10, 20].map((val) => (
                      <button
                        key={val}
                        onClick={() => {
                          setSelectedTip(val);
                          setCustomTip('');
                        }}
                        className={`
                          py-4 border rounded-2xl font-bold text-lg transition-all active:scale-95 flex flex-col items-center justify-center
                          ${selectedTip === val && !customTip 
                            ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm ring-2 ring-blue-500/20' 
                            : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                          }
                          ${val === 20 && !selectedTip && !customTip ? 'ring-2 ring-blue-500/20 border-blue-200' : ''}
                        `}
                      >
                        <span className="text-xs font-medium opacity-60 mb-0.5">R$</span>
                        {val}
                        {val === 20 && (
                          <span className="absolute -top-2 bg-blue-600 text-white text-[9px] px-2 py-0.5 rounded-full uppercase tracking-wider">Sugestão</span>
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <span className="text-gray-400 font-medium text-sm">R$</span>
                    </div>
                    <input
                      type="number"
                      inputMode="numeric"
                      placeholder="Outro valor"
                      value={customTip}
                      onChange={(e) => {
                        setCustomTip(e.target.value);
                        if (e.target.value) setSelectedTip(null);
                      }}
                      className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all"
                    />
                  </div>

                  <div className="text-center space-y-1">
                    <p className="text-sm font-semibold text-gray-800">100% do valor vai para o instrutor</p>
                    <p className="text-[10px] text-gray-400">Descontadas apenas taxas do cartão</p>
                  </div>

                  <div className="space-y-3 pt-2">
                    <Button 
                      fullWidth 
                      variant="primary"
                      onClick={() => handleTipPayment(customTip ? Number(customTip) : (selectedTip || 0))} 
                      disabled={(!selectedTip && !customTip) || isSubmittingTip}
                      className="shadow-lg shadow-blue-100 h-12 text-base"
                    >
                      {isSubmittingTip ? 'Iniciando...' : `Confirmar R$ ${(customTip ? Number(customTip) : (selectedTip || 0)).toFixed(2).replace('.', ',')}`}
                    </Button>
                    <p className="text-center text-[10px] text-gray-400 uppercase tracking-widest font-bold">
                      Pagamento imediato
                    </p>

                    <Button 
                      fullWidth 
                      variant="outline" 
                      onClick={handleSkipTip}
                      disabled={isSubmittingTip}
                      className="border-transparent text-gray-500 hover:bg-gray-50 hover:text-gray-700 shadow-none"
                    >
                      Pular caixinha
                    </Button>
                  </div>
                </>
              ) : (
                <div className="animate-fade-in">
                  {stripePromise ? (
                    <Elements 
                      stripe={stripePromise} 
                      options={{ 
                        clientSecret: tipClientSecret,
                        appearance: { theme: 'stripe', variables: { colorPrimary: '#2563eb' } }
                      }}
                    >
                      <TipCheckoutForm 
                        clientSecret={tipClientSecret}
                        amount={customTip ? Number(customTip) : (selectedTip || 0)}
                        isSubmitting={isSubmittingTip}
                        onSuccess={() => completeLessonFlow(customTip ? Number(customTip) : (selectedTip || 0))}
                        onCancel={closeFlow}
                      />
                    </Elements>
                  ) : (
                    <div className="p-4 text-center text-red-500 bg-red-50 rounded-xl">
                      Erro ao carregar Stripe.
                    </div>
                  )}
                </div>
              )}
            </div>
        )}

        {flowStep === 'success' && (
            <div className="text-center space-y-6 py-4">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto text-3xl animate-scale-up">
                🎉
            </div>
            <div>
                <h3 className="text-lg font-bold text-gray-900">
                  {tipGiven ? 'Você é demais!' : 'Obrigado!'}
                </h3>
                <p className="text-gray-500 mt-1">
                  {tipGiven 
                    ? '🎉 Você fez o dia do seu instrutor melhor!' 
                    : 'Sua avaliação foi enviada com sucesso.'}
                </p>
            </div>
            <Button fullWidth onClick={closeFlow}>
                Concluir
            </Button>
            </div>
        )}
      </Modal>

      <StudentBottomNav />
    </div>
  );
};