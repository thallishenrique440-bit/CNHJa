import React, { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { RatingBadge } from '../../components/RatingBadge';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';

// Define Interface for the State matches DB structure
interface Package {
  id: string;
  title: string;
  lesson_count: number;
  price: number; // in cents
  description: string | null;
  includes_night: boolean;
  includes_exam: boolean;
  is_highlight: boolean;
}

interface InstructorProfileData {
  id: string;
  publicId: string | null;
  name: string;
  city: string;
  defaultLocation: string;
  credential: string;
  whatsapp: string;
  rating: number;
  reviewsCount: number;
  photoUrl: string | null;
  lessonsTaught: number;
  priceDay: number;
  priceNight: number;
  hasNightLessons: boolean;
  category: 'A' | 'B' | 'AB';
  packages: Package[]; 
  reviews: any[]; 
}

export const StudentInstructorProfile: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const { addToast } = useToast();

  // Data States
  const [instructor, setInstructor] = useState<InstructorProfileData | null>(null);
  const [loading, setLoading] = useState(true);

  // Real Availability State
  const [busySlots, setBusySlots] = useState<string[]>([]); // Array of "HH:MM"
  
  // Modal State
  const [isReviewsModalOpen, setIsReviewsModalOpen] = useState(false);
  const [visibleReviewsCount, setVisibleReviewsCount] = useState(3);
  
  // Payment Error State
  const [isPaymentErrorOpen, setIsPaymentErrorOpen] = useState(false);
  const [paymentErrorMessage, setPaymentErrorMessage] = useState('');
  
  // Processing & Success State
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  // Note: isSuccess is handled by the redirect flow mostly, but kept for transient UI states if needed
  const [isSuccess, setIsSuccess] = useState(false);

  // --- Helpers for Agenda ---
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

  const getDayLabel = (date: Date) => {
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    return days[date.getDay()];
  };

  const timeToMinutes = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };

  const formatCurrency = (value: number) => {
    return (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper to create consistent Date keys (YYYY-MM-DD)
  const getDateKey = (date: Date) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  // Agenda State
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewDate, setViewDate] = useState(getStartOfWeek(new Date()));
  
  // Selected Slots now stores composite keys: "YYYY-MM-DD|HH:MM"
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  
  // Package State
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);

  // FETCH INSTRUCTOR DATA
  useEffect(() => {
    const fetchInstructor = async () => {
      if (!id) return;
      setLoading(true);

      try {
        // 1. Fetch Instructor Basic Info
        const { data, error } = await supabase
          .from('instructors')
          .select(`
            id,
            public_id,
            base_price,
            night_price,
            has_night_lessons,
            whatsapp,
            credential_number,
            location_text,
            categories,
            profiles (
              full_name,
              city,
              avatar_url
            )
          `)
          .eq('id', id)
          .single();

        if (error) throw error;

        // 2. Fetch Real Packages
        const { data: packagesData, error: packagesError } = await supabase
          .from('instructor_packages')
          .select('*')
          .eq('instructor_id', id)
          .order('price', { ascending: true }); // Show cheaper first

        if (packagesError) console.error("Error fetching packages:", packagesError);

        // 3. Fetch Reviews
        const { data: reviewsData, error: reviewsError } = await supabase
          .from('reviews')
          .select(`
            id,
            rating,
            comment,
            created_at,
            profiles:student_id (
              full_name
            )
          `)
          .eq('instructor_id', id)
          .order('created_at', { ascending: false });

        if (reviewsError) console.error("Error fetching reviews:", reviewsError);

        if (data) {
          // Normalize Categories
          let cat: 'A' | 'B' | 'AB' = 'B';
          const rawCats = data.categories;

          if (Array.isArray(rawCats) && rawCats.length > 0) {
             const hasA = rawCats.includes('A');
             const hasB = rawCats.includes('B');
             
             if (hasA && hasB) cat = 'AB';
             else if (hasA) cat = 'A';
             else if (hasB) cat = 'B';
          }

          const basePrice = data.base_price || 0;
          
          // Process Reviews
          const formattedReviews = reviewsData ? reviewsData.map((r: any) => {
             const studentName = Array.isArray(r.profiles) 
               ? r.profiles[0]?.full_name 
               : r.profiles?.full_name || 'Aluno';
             
             return {
               id: r.id,
               studentName: studentName,
               date: new Date(r.created_at).toLocaleDateString('pt-BR'),
               rating: r.rating,
               comment: r.comment
             };
          }) : [];

          // Calculate Rating
          const totalRating = formattedReviews.reduce((acc, r) => acc + r.rating, 0);
          const avgRating = formattedReviews.length > 0 ? (totalRating / formattedReviews.length) : 0;
          const displayRating = Number(avgRating.toFixed(1));

          // Handle profiles relation which might be an array or single object
          // Supabase types often infer arrays for joined relations
          const profileData = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;

          setInstructor({
            id: data.id,
            publicId: data.public_id || null,
            name: profileData?.full_name || 'Instrutor',
            city: profileData?.city || 'Cidade não informada',
            photoUrl: profileData?.avatar_url || null,
            whatsapp: data.whatsapp || '',
            credential: data.credential_number || 'N/A',
            defaultLocation: data.location_text || 'Local a combinar',
            rating: displayRating,
            reviewsCount: formattedReviews.length,
            lessonsTaught: formattedReviews.length * 5, 
            priceDay: basePrice,
            priceNight: data.night_price || basePrice,
            hasNightLessons: !!data.has_night_lessons,
            category: cat,
            packages: packagesData || [], // Using REAL packages from DB
            reviews: formattedReviews
          });
        }
      } catch (err) {
        console.error('Error fetching instructor:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchInstructor();
  }, [id]);

  // --- FETCH AVAILABILITY FOR SELECTED DATE ---
  useEffect(() => {
     if (!instructor?.id) return;

     const fetchAvailability = async () => {
         const dateKey = getDateKey(selectedDate);
         
         try {
             // Query all appointments for this instructor on this date
             const { data, error } = await supabase
                .from('appointments')
                .select('start_time, status')
                .eq('instructor_id', instructor.id)
                .eq('date', dateKey)
                .neq('status', 'cancelled'); 

             if (error) throw error;

             if (data) {
                 const busy = data.map(apt => apt.start_time.substring(0, 5));
                 setBusySlots(busy);
             }
         } catch (err) {
             console.error("Error fetching availability:", err);
         }
     };

     fetchAvailability();
  }, [selectedDate, instructor]);


  // Navigation handlers
  const handlePrevRange = () => setViewDate(current => addDays(current, -7));
  const handleNextRange = () => setViewDate(current => addDays(current, 7));
  
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(viewDate, i));

  // --- CATEGORY SELECTION LOGIC ---
  const availableCategories = useMemo(() => {
    if (!instructor) return [];
    if (instructor.category === 'AB') return ['A', 'B'];
    return [instructor.category];
  }, [instructor]);

  const [selectedLessonCategory, setSelectedLessonCategory] = useState<string | null>(null);

  useEffect(() => {
    if (availableCategories.length === 1) {
        setSelectedLessonCategory(availableCategories[0]);
    }
  }, [availableCategories]);

  const activePackage = useMemo(() => {
    if (!instructor) return null;
    return instructor.packages.find(p => p.id === selectedPackageId) || null;
  }, [selectedPackageId, instructor]);

  const sortedPackages = useMemo(() => {
    if (!instructor) return [];
    return [...instructor.packages].sort((a, b) => {
      // Prioritize highlights
      if (a.is_highlight === b.is_highlight) return 0;
      return a.is_highlight ? -1 : 1;
    });
  }, [instructor]);

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    if (!activePackage) {
      setSelectedSlots([]); 
    }
  };

  const timeSlots = useMemo(() => {
    const slots = [
      '07:00', '07:50', '08:40', '09:30', '10:20', '11:10', // Morning
      // Lunch 12:00 - 13:50 Skipped
      '13:50', '14:40', '15:30', '16:20', '17:10' // Afternoon
    ];

    if (instructor?.hasNightLessons) {
      slots.push('18:00', '18:50', '19:40', '20:30', '21:20');
    }
    return slots;
  }, [instructor?.hasNightLessons]);

  const toggleSlot = (time: string) => {
    // 1. CRITICAL VALIDATION: Ensure category is selected
    if (availableCategories.length > 1 && !selectedLessonCategory) {
        addToast("Por favor, selecione a categoria da aula (A ou B) acima antes de escolher um horário.", 'warning');
        return;
    }

    const dateKey = getDateKey(selectedDate);
    const slotKey = `${dateKey}|${time}`;

    if (selectedSlots.includes(slotKey)) {
      setSelectedSlots(prev => prev.filter(s => s !== slotKey));
      return;
    }

    const newSlots = [...selectedSlots, slotKey];

    if (activePackage && newSlots.length > activePackage.lesson_count) {
      return; 
    }

    const dailySlots = newSlots.filter(s => s.startsWith(dateKey));
    if (dailySlots.length > 3) {
      return; 
    }

    const sortedMinutes = dailySlots
      .map(s => timeToMinutes(s.split('|')[1]))
      .sort((a, b) => a - b);
    
    const LESSON_DURATION = 50;
    let hasTriplet = false;

    for (let i = 0; i < sortedMinutes.length - 2; i++) {
       if (
         sortedMinutes[i] + LESSON_DURATION === sortedMinutes[i+1] && 
         sortedMinutes[i+1] + LESSON_DURATION === sortedMinutes[i+2]
       ) {
         hasTriplet = true;
         break;
       }
    }

    if (hasTriplet) {
      return; 
    }

    setSelectedSlots(newSlots);
  };

  // CHECK REAL AVAILABILITY
  const isSlotAvailable = (time: string) => {
      // 1. Check if DB says it's busy
      if (busySlots.includes(time)) return false;
      return true;
  };

  const limits = useMemo(() => {
    const dateKey = getDateKey(selectedDate);
    const dailySlots = selectedSlots.filter(s => s.startsWith(dateKey));
    
    const isGlobalLimitReached = activePackage ? selectedSlots.length >= activePackage.lesson_count : selectedSlots.length >= 3;
    const isDailyLimitReached = dailySlots.length >= 3;

    return { isGlobalLimitReached, isDailyLimitReached };
  }, [selectedSlots, activePackage, selectedDate]);

  const totalPrice = useMemo(() => {
    if (!instructor) return 0;
    if (activePackage) {
      return activePackage.price;
    }

    return selectedSlots.reduce((acc, slotKey) => {
      const time = slotKey.split('|')[1];
      const isNight = parseInt(time.split(':')[0]) >= 18;
      const price = (isNight && instructor.priceNight) ? instructor.priceNight : instructor.priceDay;
      return acc + price;
    }, 0);
  }, [selectedSlots, activePackage, instructor]);

  const handlePackageSelect = (pkgId: string) => {
    if (selectedPackageId === pkgId) {
      setSelectedPackageId(null);
    } else {
      setSelectedPackageId(pkgId);
    }
    setSelectedSlots([]);
  };

  const handleBook = async () => {
    // 1. Validação básica de estado local
    if (!instructor) return;
    
    if (selectedSlots.length === 0) {
      addToast("Por favor, selecione pelo menos um horário para iniciar.", 'warning');
      return;
    }

    if (!selectedLessonCategory) {
      addToast("Por favor, selecione a categoria da aula (A, B ou AB) no topo da tela antes de agendar.", 'warning');
      return;
    }

    setIsProcessingPayment(true);

    try {
      // 2. Validação de Sessão Forte e Obtenção de Token
      // Obtemos a sessão diretamente do cliente para garantir que temos um token novo/válido
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError || !sessionData.session) {
         // Se não houver sessão válida, força logout e redireciona
         addToast("Sua sessão expirou. Faça login novamente.", 'error');
         navigate('/login');
         return; 
      }

      const token = sessionData.session.access_token;

      // 3. Montar Payload
      const payload = {
        instructor_id: instructor.id,
        category: selectedLessonCategory,
        slots: selectedSlots.map(slotKey => {
           const [dateStr, timeStr] = slotKey.split('|');
           return {
             date: dateStr,
             time: timeStr
           };
        })
      };

      // 4. Invocar Edge Function com Token Explícito
      // A injeção manual do header Authorization garante que o token correto seja enviado,
      // contornando possíveis falhas de sincronização do cliente global.
      const { data, error } = await supabase.functions.invoke('create-booking', {
        body: payload,
        headers: {
            Authorization: `Bearer ${token}`
        }
      });

      if (error) {
        throw error; 
      }

      // 5. Sucesso
      if (data && data.paymentUrl) {
         window.location.href = data.paymentUrl;
      } else if (data && data.error) {
         throw new Error(data.error);
      } else {
         throw new Error("Resposta inválida do servidor de pagamento.");
      }

    } catch (error: any) {
      console.error("Booking Error:", error);
      
      if (error.message && error.message.includes("409")) {
         setPaymentErrorMessage("Alguns dos horários selecionados não estão mais disponíveis. Por favor, atualize e tente novamente.");
      } else {
         setPaymentErrorMessage(error.message || "Erro de conexão ao criar reserva.");
      }
      
      setIsProcessingPayment(false);
      setIsPaymentErrorOpen(true);
      
      // Refresh slots
      const dateKey = getDateKey(selectedDate);
      const { data: refreshedData } = await supabase
         .from('appointments')
         .select('start_time')
         .eq('instructor_id', instructor.id)
         .eq('date', dateKey)
         .neq('status', 'cancelled');
      if (refreshedData) {
          setBusySlots(refreshedData.map(apt => apt.start_time.substring(0, 5)));
      }
    }
  };

  const handleRetryPayment = () => {
    setIsPaymentErrorOpen(false);
  };

  const openWhatsApp = () => {
    if (!instructor?.whatsapp) return;
    const cleanNumber = instructor.whatsapp.replace(/\D/g, '');
    if (cleanNumber.length < 10) return;
    const fullNumber = cleanNumber.startsWith('55') ? cleanNumber : `55${cleanNumber}`;
    window.open(`https://wa.me/${fullNumber}`, '_blank', 'noopener,noreferrer');
  };

  const handleOpenReviews = () => {
    if (instructor && instructor.reviews.length > 0) {
      setIsReviewsModalOpen(true);
    }
  };

  const handleCloseReviews = () => {
    setIsReviewsModalOpen(false);
    setTimeout(() => setVisibleReviewsCount(3), 200); 
  };

  const handleLoadMoreReviews = () => {
    setVisibleReviewsCount((prev) => prev + 3);
  };

  if (loading) {
      return <div className="min-h-screen flex items-center justify-center bg-white text-gray-500">Carregando instrutor...</div>;
  }

  if (!instructor) {
      return (
          <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6 text-center">
              <h2 className="text-xl font-bold text-gray-900 mb-2">Instrutor não encontrado</h2>
              <p className="text-gray-500 mb-6">O perfil que você está procurando não está disponível.</p>
              <Button onClick={() => navigate('/student/home')}>Voltar para a lista</Button>
          </div>
      );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      <div className="px-4 py-4 sticky top-0 bg-white/90 backdrop-blur-md z-20 border-b border-gray-100 flex items-center">
        <button 
          onClick={() => navigate(-1)} 
          className="p-2 -ml-2 text-gray-600 hover:text-gray-900 rounded-full hover:bg-gray-100 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="ml-2 font-semibold text-gray-900">Perfil do Instrutor</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-6 flex flex-col items-center text-center">
          
          <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center text-4xl mb-3 border-4 border-white shadow-sm overflow-hidden">
             {instructor.photoUrl ? (
                <img src={instructor.photoUrl} alt={instructor.name} className="w-full h-full object-cover" />
             ) : (
                "👤"
             )}
          </div>
          
          {instructor.publicId && (
            <div className="mb-2 bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs font-bold border border-blue-100">
                ID: {instructor.publicId}
            </div>
          )}
          
          <h1 className="text-xl font-bold text-gray-900">{instructor.name}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{instructor.city}</p>
          <p className="text-sm text-gray-600 mt-2">
            Local padrão: 📍 {instructor.defaultLocation}
          </p>
          
          <div className="flex items-center justify-center gap-3 mt-4 mb-4 w-full">
            <div className="px-2.5 py-1.5 bg-gray-50 border border-gray-100 rounded-lg text-xs text-gray-400 font-medium">
              Credencial: {instructor.credential}
            </div>

            {instructor.whatsapp && (
              <button
                onClick={openWhatsApp}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-green-50 border border-green-100 rounded-full hover:bg-green-100 transition-colors active:scale-95 text-green-700"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                   <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
                <span className="text-xs font-bold">WhatsApp</span>
              </button>
            )}
          </div>
        </div>

        <div className="px-6 pb-6 pt-2">
           <div className="grid grid-cols-2 gap-2">
              <button 
                 onClick={handleOpenReviews}
                 disabled={instructor.reviews.length === 0}
                 className={`bg-yellow-50 py-2 px-2 rounded-xl flex flex-col items-center justify-center border border-yellow-100 transition-transform ${instructor.reviews.length > 0 ? 'active:scale-95 hover:bg-yellow-100 cursor-pointer' : 'cursor-default opacity-80'}`}
              >
                 <RatingBadge 
                    rating={instructor.rating} 
                    count={instructor.reviewsCount} 
                    variant="profile" 
                 />
              </button>

              <div className="bg-blue-50 py-2 px-2 rounded-xl flex flex-col items-center justify-center border border-blue-100">
                 <div className="flex items-center mb-0.5 space-x-1">
                    <span className="text-sm">📘</span>
                    <span className="font-bold text-gray-900 text-base">{instructor.lessonsTaught}+</span>
                 </div>
                 <span className="text-[10px] text-blue-600/80 text-center leading-none">Aulas dadas</span>
              </div>

              <div className="bg-green-50 py-2 px-2 rounded-xl flex flex-col items-center justify-center border border-green-100">
                 <div className="flex items-center mb-0.5 space-x-1">
                    <span className="text-sm">💰</span>
                    <span className="font-bold text-gray-900 text-base">{formatCurrency(instructor.priceDay)}</span>
                 </div>
                 <span className="text-[10px] text-green-700/80 text-center leading-none">/ aula</span>
              </div>

              {instructor.hasNightLessons && (
                <div className="bg-indigo-50 py-2 px-2 rounded-xl flex flex-col items-center justify-center border border-indigo-100">
                   <div className="flex items-center mb-0.5 space-x-1">
                      <span className="text-sm">🌙</span>
                      <span className="font-bold text-gray-900 text-base">{formatCurrency(instructor.priceNight)}</span>
                   </div>
                   <span className="text-[10px] text-indigo-600/80 text-center leading-none">/ noite</span>
                </div>
              )}
           </div>
        </div>

        {availableCategories.length > 0 && (
          <div className="px-6 pt-3 pb-1 animate-fade-in">
             <h2 className="text-xs font-bold text-gray-900 uppercase tracking-wide mb-2">Categoria da aula</h2>
             
             {availableCategories.length > 1 ? (
               <div className="flex space-x-3">
                 {availableCategories.map((cat) => (
                   <button
                     key={cat}
                     onClick={() => setSelectedLessonCategory(cat)}
                     className={`
                       flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all duration-200
                       ${selectedLessonCategory === cat 
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm' 
                          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                       }
                     `}
                   >
                     Categoria {cat}
                   </button>
                 ))}
               </div>
             ) : (
                <div className="inline-flex items-center bg-gray-100 border border-gray-200 rounded-lg px-3 py-1.5">
                   <span className="text-xs font-bold text-gray-700">Categoria {availableCategories[0]}</span>
                   <span className="ml-2 text-[10px] text-gray-400 font-medium">Única disponível</span>
                </div>
             )}
             
             {availableCategories.length > 1 && !selectedLessonCategory && (
                <p className="text-xs text-gray-500 mt-2">
                   Selecione a categoria acima para liberar os horários.
                </p>
             )}
          </div>
        )}

        <div className="px-6 pb-6 pt-4">
           <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-1">Horários disponíveis</h2>
           <div className="mb-4">
             <p className="text-xs text-gray-500">
               {activePackage 
                 ? `Selecionando para: ${activePackage.title}. Selecione até ${activePackage.lesson_count} aulas. (Máx 3 por dia)`
                 : "Selecione horários individuais ou escolha um pacote abaixo."
               }
             </p>
             <p className="text-xs text-gray-400 mt-1">
               Em caso de dúvidas, você pode falar diretamente com o instrutor pelo WhatsApp.
             </p>
           </div>

           <div className="flex items-center justify-between space-x-2 pb-4">
              <button onClick={handlePrevRange} className="p-2 text-gray-400 hover:text-blue-600 rounded-full hover:bg-gray-50 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <div className="flex-1 flex justify-between items-center space-x-1">
                  {weekDays.map((date, index) => {
                      const isSelected = date.toDateString() === selectedDate.toDateString();
                      const isToday = new Date().toDateString() === date.toDateString();
                      return (
                      <button
                          key={index}
                          onClick={() => handleDayClick(date)}
                          className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl flex-1 transition-all duration-200 
                          ${isSelected ? 'bg-blue-600 text-white shadow-md transform scale-105' : 'bg-transparent text-gray-500 hover:bg-gray-50'}
                          `}
                      >
                          <span className={`text-[10px] font-medium uppercase ${isSelected ? 'text-blue-100' : 'text-gray-400'}`}>{getDayLabel(date)}</span>
                          <span className={`text-sm font-bold leading-none mt-0.5 ${isSelected ? 'text-white' : 'text-gray-700'}`}>{date.getDate()}</span>
                          {isToday && (<div className={`w-1 h-1 rounded-full mt-1 ${isSelected ? 'bg-white' : 'bg-blue-600'}`}></div>)}
                      </button>
                      );
                  })}
              </div>
              <button onClick={handleNextRange} className="p-2 text-gray-400 hover:text-blue-600 rounded-full hover:bg-gray-50 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
              </button>
           </div>

           <div className="grid grid-cols-4 gap-2">
              {timeSlots.map((time) => {
                const isAvailable = isSlotAvailable(time);
                const dateKey = getDateKey(selectedDate);
                const slotKey = `${dateKey}|${time}`;
                const isSelected = selectedSlots.includes(slotKey);
                
                const isNight = parseInt(time.split(':')[0]) >= 18;
                const [hours, minutes] = time.split(':').map(Number);
                const slotDateTime = new Date(selectedDate);
                slotDateTime.setHours(hours, minutes, 0, 0);

                const now = new Date();
                const isPast = slotDateTime.getTime() <= now.getTime();
                
                const isDisabled = !isAvailable || 
                                   isPast || 
                                   (!isSelected && (limits.isGlobalLimitReached || limits.isDailyLimitReached));

                return (
                  <button
                    key={time}
                    disabled={isDisabled}
                    onClick={() => toggleSlot(time)}
                    className={`
                      relative py-2.5 rounded-lg text-xs font-bold transition-all duration-200 border
                      ${!isAvailable 
                        ? 'bg-gray-50 text-gray-300 border-transparent cursor-not-allowed opacity-60' // Dimmed for busy
                        : isPast 
                            ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
                        : isSelected 
                              ? 'bg-gray-900 text-white border-gray-900 shadow-md ring-2 ring-offset-1 ring-gray-900' 
                              : isDisabled 
                                ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed' 
                                : 'bg-gray-50 text-gray-900 border-gray-100 hover:border-gray-300 active:scale-95'
                      }
                    `}
                  >
                    {time}
                    {isNight && isAvailable && !isSelected && !isDisabled && !isPast && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 bg-indigo-500 rounded-full"></span>
                    )}
                  </button>
                );
              })}
           </div>
           
           {instructor.hasNightLessons && (
             <div className="flex justify-end mt-2">
                <span className="text-[10px] text-gray-400 flex items-center">
                  <span className="w-2 h-2 bg-indigo-500 rounded-full mr-1"></span> Horário Noturno
                </span>
             </div>
           )}
        </div>

        <div className="h-2 bg-gray-50"></div>

        <div className="px-6 py-6 space-y-4 pb-12">
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Pacotes disponíveis</h2>
          
          {sortedPackages.length === 0 ? (
             <div className="text-center py-6 bg-gray-50 rounded-xl border border-gray-100 border-dashed">
                <p className="text-gray-400 text-sm">Este instrutor ainda não cadastrou pacotes.</p>
             </div>
          ) : (
            sortedPackages.map((pkg) => {
              const isPkgSelected = selectedPackageId === pkg.id;
              
              return (
                <div 
                  key={pkg.id} 
                  onClick={() => handlePackageSelect(pkg.id)}
                  className={`border rounded-2xl p-4 relative overflow-hidden shadow-sm transition-all duration-200 cursor-pointer
                    ${isPkgSelected ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-gray-200 bg-white hover:border-blue-300'}
                  `}
                >
                  {pkg.is_highlight && (
                    <div className="absolute top-0 right-0 bg-yellow-100 text-yellow-800 text-[10px] font-bold px-3 py-1 rounded-bl-xl uppercase tracking-wide">
                      ⭐ Melhor pacote
                    </div>
                  )}
                  
                  {isPkgSelected && (
                     <div className="absolute top-3 right-3 text-blue-600">
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                     </div>
                  )}

                  <div className="pr-10">
                    <h3 className={`font-bold text-lg ${isPkgSelected ? 'text-blue-900' : 'text-gray-900'}`}>{pkg.title}</h3>
                    {pkg.description && (
                      <p className={`text-xs mt-1 mb-2 line-clamp-2 leading-relaxed ${isPkgSelected ? 'text-blue-800/70' : 'text-gray-500'}`}>
                        {pkg.description}
                      </p>
                    )}
                    <p className={`text-sm mb-3 ${isPkgSelected ? 'text-blue-700' : 'text-gray-500'}`}>{pkg.lesson_count} {pkg.lesson_count === 1 ? 'aula' : 'aulas'}</p>
                  </div>
                  
                  <div className="flex justify-between items-end">
                    <div className="space-y-1">
                      {pkg.includes_night && (
                        <div className="flex items-center text-xs text-green-700">
                          <span className="mr-1">✓</span> Inclui aulas noturnas
                        </div>
                      )}
                      {pkg.includes_exam && (
                        <div className="flex items-center text-xs text-green-700">
                          <span className="mr-1">✓</span> Inclui dia do exame
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="block text-xl font-bold text-blue-600">{formatCurrency(pkg.price)}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-gray-100 sm:max-w-md sm:mx-auto z-20">
        <Button 
          fullWidth 
          onClick={handleBook} 
          disabled={(!activePackage && selectedSlots.length === 0) || (activePackage && selectedSlots.length === 0) || !selectedLessonCategory || isProcessingPayment || isSuccess}
          className={`shadow-lg transition-all duration-300 ${
            isSuccess 
              ? 'bg-green-600 hover:bg-green-700 border-transparent text-white shadow-green-200' 
              : ((!activePackage && selectedSlots.length === 0) || (activePackage && selectedSlots.length === 0) || !selectedLessonCategory || isProcessingPayment) 
                ? 'bg-gray-300 cursor-not-allowed shadow-none' 
                : 'shadow-blue-200 bg-blue-600'
          }`}
        >
          {isSuccess ? (
             <span className="flex items-center justify-center">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                Redirecionando...
             </span>
          ) : isProcessingPayment 
            ? 'Processando pagamento...' 
            : activePackage 
              ? `(${selectedSlots.length}) Ir para Pagamento — ${formatCurrency(totalPrice)}`
              : selectedSlots.length > 0 
                  ? `Pagar ${selectedSlots.length} ${selectedSlots.length === 1 ? 'aula' : 'aulas'} — ${formatCurrency(totalPrice)}`
                  : 'Selecione um horário ou pacote'
          }
        </Button>
      </div>

      <Modal
        isOpen={isPaymentErrorOpen}
        onClose={() => setIsPaymentErrorOpen(false)}
        title="Não foi possível agendar"
        footer={
           <div className="space-y-3 w-full">
              <Button fullWidth onClick={handleRetryPayment}>
                Entendi
              </Button>
            </div>
        }
      >
        <div className="text-center">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl">
              🚫
            </div>
            <p className="text-sm text-gray-500 mb-2 leading-relaxed">
              {paymentErrorMessage}
            </p>
        </div>
      </Modal>

      <Modal
        isOpen={isReviewsModalOpen}
        onClose={handleCloseReviews}
        title="Avaliações"
        footer={
           visibleReviewsCount < (instructor?.reviews?.length || 0) && (
              <button 
                  onClick={handleLoadMoreReviews}
                  className="w-full py-2 text-sm font-semibold text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                >
                  Ver mais avaliações
                </button>
           )
        }
      >
        <div className="space-y-4">
              {instructor?.reviews?.slice(0, visibleReviewsCount).map((review: any) => (
                <div key={review.id} className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-semibold text-gray-900 text-sm">{review.studentName}</span>
                    <span className="text-xs text-gray-400">{review.date}</span>
                  </div>
                  <div className="flex mb-2">
                    {[...Array(5)].map((_, i) => (
                      <span key={i} className={`text-xs ${i < review.rating ? 'text-yellow-400' : 'text-gray-300'}`}>★</span>
                    ))}
                  </div>
                  <p className="text-sm text-gray-600 italic leading-relaxed">"{review.comment}"</p>
                </div>
              ))}
            </div>
      </Modal>

    </div>
  );
};