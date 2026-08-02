import React, { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { DateSelector } from '../../components/DateSelector';
import { RatingBadge } from '../../components/RatingBadge';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { getGoogleMapsUrl } from '../../src/utils/maps';
import { AGENDA_SLOTS, LESSON_DURATION } from '../../lib/slots';
import { getLowestActiveCategoryPrice } from '../../lib/instructorPricing';
import { calculateInstructorRating } from '../../lib/instructorRating';
import { PAYMENT_ERRORS } from '../../src/constants/paymentErrors';
import { CheckoutLauncher } from '../../lib/payments/CheckoutLauncher';

// Define Interface for the State matches DB structure
const MAX_INSTALLMENTS = 4;

interface DiscountRule {
  id: string;
  min_lessons: number;
  discount_percentage: number;
}

interface CategoryPrice {
  category: string;
  day_price: number;
  night_price: number;
}

interface Vehicle {
  type: 'car' | 'bike';
  model: string;
  year: number;
  transmission?: string;
}

interface InstructorProfileData {
  id: string;
  publicId: string | null;
  name: string;
  city: string;
  defaultLocation: string;
  meetingPointLat: number | null;
  meetingPointLng: number | null;
  meetingPointPlaceId: string | null;
  credential: string;
  whatsapp: string;
  rating: string;
  reviewsCount: number;
  formattedReviewsCount: string;
  photoUrl: string | null;
  lessonsTaught: number;
  priceDay: number; // Legacy Fallback
  priceNight: number; // Legacy Fallback
  hasNightLessons: boolean;
  workSaturdayAfternoon: boolean; // New Field
  lunchStartSlot: string;
  lunchDuration: number;
  lunchActive: boolean;
  category: 'A' | 'B' | 'AB';
  discounts: DiscountRule[]; 
  reviews: any[];
  categoryPrices: CategoryPrice[]; // New Pricing Structure
  vehicles: Vehicle[];
}

// CPF mathematical validation helper
const validateCpf = (cpf: string): boolean => {
  const cleanCpf = cpf.replace(/\D/g, '');
  if (cleanCpf.length !== 11) return false;
  
  // Repetitive patterns check
  if (/^(\d)\1{10}$/.test(cleanCpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cleanCpf.charAt(i)) * (10 - i);
  }
  let rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cleanCpf.charAt(9))) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(cleanCpf.charAt(i)) * (11 - i);
  }
  rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cleanCpf.charAt(10))) return false;

  return true;
};

const formatCpfInput = (value: string) => {
  const v = value.replace(/\D/g, '').slice(0, 11);
  if (v.length <= 3) return v;
  if (v.length <= 6) return `${v.slice(0, 3)}.${v.slice(3)}`;
  if (v.length <= 9) return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6)}`;
  return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9, 11)}`;
};

const formatPhoneInput = (value: string) => {
  const v = value.replace(/\D/g, '').slice(0, 11);
  if (v.length <= 2) return v;
  if (v.length <= 6) return `(${v.slice(0, 2)}) ${v.slice(2)}`;
  if (v.length <= 10) return `(${v.slice(0, 2)}) ${v.slice(2, 6)}-${v.slice(6)}`;
  return `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
};

export const StudentInstructorProfile: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { session, serverTimeOffset } = useAuth();
  const { addToast } = useToast();

  // Data States
  const [instructor, setInstructor] = useState<InstructorProfileData | null>(null);
  const [loading, setLoading] = useState(true);

  // Real Availability State
  const [busySlots, setBusySlots] = useState<string[]>([]); // Array of "HH:MM"
  const [existingLessonsCount, setExistingLessonsCount] = useState(0); // Count of lessons with this instructor on selected date
  
  // Modal State
  const [isReviewsModalOpen, setIsReviewsModalOpen] = useState(false);
  const [visibleReviewsCount, setVisibleReviewsCount] = useState(3);
  
  // Payment Error State
  const [isPaymentErrorOpen, setIsPaymentErrorOpen] = useState(false);
  const [paymentErrorMessage, setPaymentErrorMessage] = useState('');
  const [paymentErrorCode, setPaymentErrorCode] = useState('');
  
  // Too Close Error State
  const [isTooCloseModalOpen, setIsTooCloseModalOpen] = useState(false);
  
  // Processing & Success State
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  // Note: isSuccess is handled by the redirect flow mostly, but kept for transient UI states if needed
  const [isSuccess, setIsSuccess] = useState(false);

  // CPF and Phone Modal State
  const [isCpfModalOpen, setIsCpfModalOpen] = useState(false);
  const [studentCpf, setStudentCpf] = useState('');
  const [studentPhone, setStudentPhone] = useState('');
  const [isSavingCpf, setIsSavingCpf] = useState(false);
  const [cpfModalIgnoreTooClose, setCpfModalIgnoreTooClose] = useState(false);

  // Payment Selection States (PIX + Installments)
  const [isPaymentMethodModalOpen, setIsPaymentMethodModalOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'PIX' | 'CREDIT_CARD'>('CREDIT_CARD');
  const [selectedInstallmentCount, setSelectedInstallmentCount] = useState<number>(1);
  const [paymentIgnoreTooClose, setPaymentIgnoreTooClose] = useState(false);

  // platform_financial_settings State
  const [financialSettings, setFinancialSettings] = useState<any>(null);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const { data, error } = await supabase
          .from('platform_financial_settings')
          .select('*')
          .limit(1)
          .maybeSingle();
        if (data) {
          setFinancialSettings(data);
        }
      } catch (err) {
        console.error('Error fetching financial settings:', err);
      }
    };
    fetchSettings();
  }, []);

  const activeSettings = useMemo(() => {
    return financialSettings || {
      pix_flat_fee: 149,
      credit_1x_fee: 3.99,
      credit_2x_fee: 5.49,
      credit_3x_fee: 6.49,
      credit_4x_fee: 7.49,
      credit_5x_fee: 8.49,
      credit_6x_fee: 9.49,
      credit_7x_fee: 10.49,
      credit_8x_fee: 11.49,
      credit_9x_fee: 12.49,
      credit_10x_fee: 13.49,
      credit_11x_fee: 14.49,
      credit_12x_fee: 15.49
    };
  }, [financialSettings]);

  const handleSaveCpfAndPhone = async () => {
    const cleanCpf = studentCpf.replace(/\D/g, '');
    const cleanPhone = studentPhone.replace(/\D/g, '');

    if (!cleanCpf) {
      addToast("CPF é obrigatório.", "warning");
      return;
    }
    if (!validateCpf(cleanCpf)) {
      addToast("CPF inválido. Por favor, verifique o número informado.", "error");
      return;
    }
    if (!cleanPhone) {
      addToast("Telefone é obrigatório.", "warning");
      return;
    }
    if (cleanPhone.length < 10) {
      addToast("Telefone inválido. Por favor, inclua o DDD.", "error");
      return;
    }

    setIsSavingCpf(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session) {
        addToast("Sua sessão expirou. Faça login novamente.", 'error');
        navigate('/login');
        return;
      }

      const studentId = sessionData.session.user.id;

      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          cpf: cleanCpf,
          phone: cleanPhone
        })
        .eq('id', studentId);

      if (updateError) {
        throw updateError;
      }

      addToast("Dados cadastrados com sucesso!", "success");
      setIsCpfModalOpen(false);
      
      // Continue automatically with payment flow!
      handleBook(cpfModalIgnoreTooClose);
    } catch (err: any) {
      console.error("Erro ao salvar CPF/Telefone:", err);
      addToast(err.message || "Erro ao salvar seus dados. Tente novamente.", "error");
    } finally {
      setIsSavingCpf(false);
    }
  };

  // Preview Logic
    const isPreview = searchParams.get('preview') === 'true';
    const isOwner = session?.user?.id === id;
    const showPreviewBanner = isPreview && isOwner;
    const fromInstructor = location.state?.fromInstructor;

  useEffect(() => {
    const success = searchParams.get('success');
    const canceled = searchParams.get('canceled');

    if (success === 'true') {
      clearPersistedSlots();
      setSelectedSlots([]);
      setIsSuccess(true);
      addToast('Pagamento concluído com sucesso! Suas aulas foram agendadas.', 'success');
      // Clean up URL
      navigate(`/student/instructor/${id}`, { replace: true, state: location.state });
    } else if (canceled === 'true') {
      addToast('Pagamento cancelado. Seus horários continuam reservados temporariamente.', 'error');
      // Clean up URL
      navigate(`/student/instructor/${id}`, { replace: true, state: location.state });
    }
  }, [searchParams, id, navigate, addToast]);

  // Max Booking Date (7 days from today)
  const maxBookingDate = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 7);
    return d;
  }, []);

  const timeToMinutes = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };

  const minutesToTime = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const formatCurrency = (value: number) => {
    return (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper to create consistent Date keys (YYYY-MM-DD)
  const getDateKey = (date: Date) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  const LOCAL_STORAGE_KEY = 'booking_selected_slots';
  const TTL_MS = 15 * 60 * 1000; // 15 minutes

  interface PersistedBookingData {
    slots: string[];
    category: string | null;
    date: string | null;
  }

  const getPersistedBookingData = (): PersistedBookingData => {
    try {
      const itemStr = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!itemStr) return { slots: [], category: null, date: null };
      const item = JSON.parse(itemStr);
      const now = new Date();
      if (now.getTime() > item.expiry) {
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        return { slots: [], category: null, date: null };
      }
      
      const val = item.value;
      // Backward compatibility: if val is an array, it's the old format (just slots)
      if (Array.isArray(val)) {
        return { slots: val, category: null, date: null };
      }
      
      return {
        slots: val?.slots || [],
        category: val?.category || null,
        date: val?.date || null
      };
    } catch (e) {
      return { slots: [], category: null, date: null };
    }
  };

  const savePersistedBookingData = (slots: string[], category: string | null, date: Date | null) => {
    try {
      const now = new Date();
      const item = {
        value: {
          slots,
          category,
          date: date ? date.toISOString() : null
        },
        expiry: now.getTime() + TTL_MS,
      };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(item));
    } catch (e) {
      console.error('Error saving to localStorage', e);
    }
  };

  const clearPersistedSlots = () => {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  };

  const persistedData = useMemo(() => getPersistedBookingData(), []);

  // Agenda State
  const [selectedDate, setSelectedDate] = useState(() => {
    if (persistedData.date) {
        const d = new Date(persistedData.date);
        if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  });
  
  // Selected Slots now stores composite keys: "YYYY-MM-DD|HH:MM"
  const [selectedSlots, setSelectedSlots] = useState<string[]>(persistedData.slots);
  const [isPhotoModalOpen, setIsPhotoModalOpen] = useState(false);
  const [isGPSModalOpen, setIsGPSModalOpen] = useState(false);

  // Review State
  const [canReview, setCanReview] = useState(false);
  const [existingReview, setExistingReview] = useState<any>(null);
  const [isSubmitReviewModalOpen, setIsSubmitReviewModalOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [isIdCopied, setIsIdCopied] = useState(false);

  const handleShare = async () => {
    if (instructor?.publicId) {
      const profileUrl = `${window.location.origin}/#/i/${instructor.publicId}`;
      const shareData = {
        title: 'CNHJá • Instrutor de Direção',
        text: `Gostei deste instrutor no CNHJá e recomendo.\n\nFaça uma aula com ele, acho que você vai gostar.\n\n👤 ${instructor.name}\n🆔 Código: ${instructor.publicId}\n\nAgende suas aulas pelo link abaixo.`,
        url: profileUrl,
      };

      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch (err) {
          console.log('Error sharing:', err);
          // Fallback to clipboard on error
          navigator.clipboard.writeText(profileUrl);
          setIsIdCopied(true);
          addToast('Link do instrutor copiado! Compartilhe onde desejar.', 'success');
          setTimeout(() => setIsIdCopied(false), 2000);
        }
      } else {
        navigator.clipboard.writeText(profileUrl);
        setIsIdCopied(true);
        addToast('Link do instrutor copiado! Compartilhe onde desejar.', 'success');
        setTimeout(() => setIsIdCopied(false), 2000);
      }
    }
  };

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
            work_saturday_afternoon,
            lunch_start_slot,
            lunch_duration,
            lunch_active,
            whatsapp,
            credential_number,
            meeting_point,
            meeting_point_lat,
            meeting_point_lng,
            meeting_point_place_id,
            categories,
            profiles (
              full_name,
              city,
              avatar_url
            ),
            instructor_categories (
              category,
              day_price,
              night_price
            ),
            instructor_vehicles (
              type,
              model,
              year,
              transmission
            )
          `)
          .eq('id', id)
          .single();

        if (error) throw error;

        // 2. Fetch Discounts
        const { data: discountsData, error: discountsError } = await supabase
          .from('instructor_discounts')
          .select('*')
          .eq('instructor_id', id)
          .order('min_lessons', { ascending: true });

        if (discountsError) console.error("Error fetching discounts:", discountsError);

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

        // 4. Check if student can review
        if (session?.user) {
          const { data: aptData } = await supabase
            .from('appointments')
            .select('id')
            .eq('student_id', session.user.id)
            .eq('instructor_id', id)
            .eq('status', 'completed')
            .limit(1);
          
          if (aptData && aptData.length > 0) {
            setCanReview(true);
            
            // Fetch existing review (get the latest one if multiple exist)
            const { data: myReviews } = await supabase
              .from('reviews')
              .select('*')
              .eq('student_id', session.user.id)
              .eq('instructor_id', id)
              .order('created_at', { ascending: false })
              .limit(1);
              
            if (myReviews && myReviews.length > 0) {
              const myReview = myReviews[0];
              setExistingReview(myReview);
              setReviewRating(myReview.rating);
              setReviewComment(myReview.comment || '');
            }
          }
        }

        // 5. Fetch total completed lessons via secure RPC (Hardening Fase 1.5)
        const { data: lessonsTaughtCount, error: countError } = await supabase
          .rpc('get_instructor_lessons_count', {
            p_instructor_id: id
          });

        if (countError) console.error("Error fetching lessons count:", countError);

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
          const { formattedRating, reviewsCount, formattedReviewsCount } = calculateInstructorRating(formattedReviews);

          // Handle profiles relation which might be an array or single object
          // Supabase types often infer arrays for joined relations
          const profileData = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;

          // Map Category Prices
          const catPrices: CategoryPrice[] = (data.instructor_categories || []).map((c: any) => ({
            category: c.category,
            day_price: c.day_price,
            night_price: c.night_price
          }));

          setInstructor({
            id: data.id,
            publicId: data.public_id || null,
            name: profileData?.full_name || 'Instrutor',
            city: profileData?.city || 'Cidade não informada',
            photoUrl: profileData?.avatar_url || null,
            whatsapp: data.whatsapp || '',
            credential: data.credential_number || 'N/A',
            defaultLocation: data.meeting_point || 'Local a combinar',
            meetingPointLat: data.meeting_point_lat || null,
            meetingPointLng: data.meeting_point_lng || null,
            meetingPointPlaceId: data.meeting_point_place_id || null,
            rating: formattedRating,
            reviewsCount: reviewsCount,
            formattedReviewsCount: formattedReviewsCount,
            lessonsTaught: lessonsTaughtCount || 0, 
            priceDay: basePrice,
            priceNight: data.night_price || basePrice,
            hasNightLessons: !!data.has_night_lessons,
            workSaturdayAfternoon: !!data.work_saturday_afternoon,
            lunchStartSlot: data.lunch_start_slot || '12:00',
            lunchDuration: data.lunch_duration || 2,
            lunchActive: !!data.lunch_active,
            category: cat,
            discounts: discountsData || [], // Using REAL discounts from DB
            reviews: formattedReviews,
            categoryPrices: catPrices,
            vehicles: data.instructor_vehicles || []
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
     if (!instructor?.id || !session?.user?.id) return;

     const fetchAvailability = async () => {
         const dateKey = getDateKey(selectedDate);
         
         try {
             // 1. Query all appointments availability via secure RPC
             const { data: availabilityData, error: availabilityError } = await supabase
                .rpc('get_instructor_availability', {
                    p_instructor_id: instructor.id,
                    p_start_date: dateKey,
                    p_end_date: dateKey
                });

             if (availabilityError) throw availabilityError;

             // 2. Query all appointments for the student on this date (to prevent double booking)
             const { data: studentData, error: studentError } = await supabase
                .from('appointments')
                .select('start_time, status, instructor_id')
                .eq('student_id', session.user.id)
                .eq('date', dateKey)
                .in('status', ['pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment']);

             if (studentError) throw studentError;

             const busySlotsSet = new Set<string>();
             let existingCount = 0;

             if (availabilityData) {
                 availabilityData.forEach((slot: any) => {
                     // Allow the student to retry booking their own abandoned checkouts
                     if (slot.status === 'my_reservation') {
                         return; // Do not mark as busy
                     }
                     busySlotsSet.add(slot.start_time.substring(0, 5));
                 });
             }
             
             if (studentData) {
                 studentData.forEach(apt => {
                     // Allow the student to retry booking their own abandoned checkouts for this instructor
                     if (apt.instructor_id === instructor.id && (apt.status === 'awaiting_payment' || apt.status === 'reserved')) {
                         return; // Do not mark as busy or count as existing
                     }
                     busySlotsSet.add(apt.start_time.substring(0, 5));
                     if (apt.instructor_id === instructor.id) {
                         existingCount++;
                     }
                 });
             }

             setBusySlots(Array.from(busySlotsSet));
             setExistingLessonsCount(existingCount);
         } catch (err) {
             console.error("Error fetching availability:", err);
         }
     };

     fetchAvailability();
  }, [selectedDate, instructor, session]);


  // --- CONTINUOUS VALIDATION OF SELECTED SLOTS ---
  useEffect(() => {
    if (!selectedSlots.length) return;

    const now = new Date();
    const dateKeyToday = getDateKey(now);
    const currentSelectedDateKey = getDateKey(selectedDate);

    const filteredSlots = selectedSlots.filter(slotKey => {
      const [dateStr, timeStr] = slotKey.split('|');
      
      // 1. Check if it's in the past
      const now = new Date(Date.now() + serverTimeOffset);
      const slotTime = new Date(`${dateStr}T${timeStr}:00-03:00`);
      
      if (slotTime <= now) return false;

      // 2. Check if it's busy on the CURRENT selected date
      // (We only have busySlots for the selectedDate)
      if (dateStr === currentSelectedDateKey && busySlots.includes(timeStr)) {
        return false;
      }

      return true;
    });

    if (filteredSlots.length !== selectedSlots.length) {
      setSelectedSlots(filteredSlots);
      addToast("Alguns horários não estão mais disponíveis e foram removidos", 'info');
    }
  }, [busySlots, selectedDate, instructor?.id]);

  // --- CATEGORY SELECTION LOGIC ---
  const availableCategories = useMemo(() => {
    if (!instructor) return [];
    if (instructor.category === 'AB') return ['A', 'B'];
    return [instructor.category];
  }, [instructor]);

  const [selectedLessonCategory, setSelectedLessonCategory] = useState<string | null>(persistedData.category);

  useEffect(() => {
    if (availableCategories.length === 1 && !selectedLessonCategory) {
        setSelectedLessonCategory(availableCategories[0]);
    }
  }, [availableCategories, selectedLessonCategory]);

  useEffect(() => {
    savePersistedBookingData(selectedSlots, selectedLessonCategory, selectedDate);
  }, [selectedSlots, selectedLessonCategory, selectedDate]);

  // --- DYNAMIC PRICE DISPLAY ---
  const currentDisplayPrices = useMemo(() => {
    if (!instructor) return { day: 0, night: 0 };
    
    // If category selected, try to find specific price
    if (selectedLessonCategory) {
      const catPrice = instructor.categoryPrices.find(c => c.category === selectedLessonCategory);
      if (catPrice) {
        return { day: catPrice.day_price, night: catPrice.night_price };
      }
    }

    // Fallback to legacy
    return { day: instructor.priceDay, night: instructor.priceNight };
  }, [instructor, selectedLessonCategory]);

  const timeSlots = useMemo(() => {
    if (!instructor) return [];
    
    let filteredSlots = [...AGENDA_SLOTS];

    // Filter based on night lessons
    if (!instructor.hasNightLessons) {
      const limitIndex = filteredSlots.indexOf('17:00');
      if (limitIndex !== -1) {
        filteredSlots = filteredSlots.slice(0, limitIndex + 1);
      }
    }

    // Saturday Rule
    if (selectedDate.getDay() === 6) {
      const limitTime = instructor.workSaturdayAfternoon ? '17:00' : '11:00';
      const limitIndex = filteredSlots.indexOf(limitTime);
      if (limitIndex !== -1) {
        filteredSlots = filteredSlots.slice(0, limitIndex + 1);
      }
    }
    
    if (!instructor.lunchActive) {
      return filteredSlots;
    }

    // Identify lunch slots
    const lunchSlots: string[] = [];
    const startIndex = filteredSlots.indexOf(instructor.lunchStartSlot);
    
    if (startIndex !== -1) {
      for (let i = 0; i < instructor.lunchDuration; i++) {
        if (filteredSlots[startIndex + i]) {
          lunchSlots.push(filteredSlots[startIndex + i]);
        }
      }
    }

    const items: (string | { type: 'lunch', start: string, end: string })[] = [];
    let lunchInserted = false;

    for (const time of filteredSlots) {
      if (lunchSlots.includes(time)) {
        if (!lunchInserted) {
          const lastLunchSlot = lunchSlots[lunchSlots.length - 1];
          const [h, m] = lastLunchSlot.split(':').map(Number);
          const endMins = h * 60 + m + LESSON_DURATION;
          const endTime = `${String(Math.floor(endMins / 60)).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
          
          items.push({ 
            type: 'lunch', 
            start: instructor.lunchStartSlot, 
            end: endTime 
          });
          lunchInserted = true;
        }
        // Skip other lunch slots
        continue;
      }
      items.push(time);
    }

    return items;
  }, [instructor, instructor?.lunchActive, instructor?.lunchStartSlot, instructor?.lunchDuration, selectedDate, instructor?.hasNightLessons, instructor?.workSaturdayAfternoon]);

  // --- CHECK REAL AVAILABILITY ---
  const isSlotAvailable = (time: string) => {
      // 0. Check Lunch Overlap (Slot-based)
      if (instructor?.lunchActive) {
          const startIndex = AGENDA_SLOTS.indexOf(instructor.lunchStartSlot);
          if (startIndex !== -1) {
            const lunchSlots = AGENDA_SLOTS.slice(startIndex, startIndex + instructor.lunchDuration);
            if (lunchSlots.includes(time)) return false;
          }
      }

      // 1. Check DB says it's busy
      if (busySlots.includes(time)) return false;

      // 2. Check Sunday Rule (Always OFF)
      if (selectedDate.getDay() === 0) return false;

      // 3. Check Saturday Rule
      if (selectedDate.getDay() === 6) {
          const [h, m] = time.split(':').map(Number);
          const minutes = h * 60 + m;
          
          // If instructor works saturday afternoon, allow until 17:00 (end 18:00)
          // Else allow until 11:00 (end 12:00)
          const limit = instructor?.workSaturdayAfternoon ? (17 * 60) : (11 * 60);
          
          if (minutes > limit) return false;
      }

      return true;
  };


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

    // Global Limit Check (20 lessons max)
    if (newSlots.length > 20) {
      addToast("Você pode selecionar no máximo 20 aulas por vez.", 'warning');
      return; 
    }

    setSelectedSlots(newSlots);
  };

  const limits = useMemo(() => {
    const isGlobalLimitReached = selectedSlots.length >= 20;
    return { isGlobalLimitReached };
  }, [selectedSlots]);

  const startingPrice = useMemo(() => {
    if (!instructor) return 0;
    return getLowestActiveCategoryPrice(instructor.category, instructor.categoryPrices, instructor.priceDay || 0);
  }, [instructor]);

  const priceInfo = useMemo(() => {
    if (!instructor) return { total: 0, base: 0, discountPct: 0 };

    // 1. Calculate Base Price
    const basePrice = selectedSlots.reduce((acc, slotKey) => {
      const time = slotKey.split('|')[1];
      const isNight = parseInt(time.split(':')[0]) >= 18;
      
      let price = 0;
      
      if (selectedLessonCategory) {
        const catPrice = instructor.categoryPrices.find(c => c.category === selectedLessonCategory);
        if (catPrice) {
          price = (isNight && instructor.hasNightLessons) ? catPrice.night_price : catPrice.day_price;
        } else {
          price = (isNight && instructor.hasNightLessons) ? instructor.priceNight : instructor.priceDay;
        }
      } else {
         price = (isNight && instructor.hasNightLessons) ? instructor.priceNight : instructor.priceDay;
      }

      return acc + price;
    }, 0);

    // 2. Apply Progressive Discount
    const lessonCount = selectedSlots.length;
    let discountPercentage = 0;

    if (instructor.discounts && instructor.discounts.length > 0) {
        const sortedDiscounts = [...instructor.discounts].sort((a, b) => b.min_lessons - a.min_lessons);
        const applicableRule = sortedDiscounts.find(d => lessonCount >= d.min_lessons);
        if (applicableRule) {
            discountPercentage = applicableRule.discount_percentage;
        }
    }

    const finalPrice = discountPercentage > 0 
      ? basePrice - Math.round(basePrice * (discountPercentage / 100))
      : basePrice;

    return {
      total: finalPrice,
      base: basePrice,
      discountPct: discountPercentage
    };
  }, [selectedSlots, instructor, selectedLessonCategory]);

  const totalPrice = priceInfo.total;

  const feeInfo = useMemo(() => {
    let fee = 0;
    if (selectedPaymentMethod === 'PIX') {
      fee = activeSettings.pix_flat_fee;
    } else if (selectedPaymentMethod === 'CREDIT_CARD') {
      const key = `credit_${selectedInstallmentCount}x_fee`;
      const percentage = activeSettings[key] !== undefined ? Number(activeSettings[key]) : 3.99;
      fee = Math.round(totalPrice * (percentage / 100));
    }
    return {
      fee,
      totalWithFee: totalPrice + fee
    };
  }, [totalPrice, selectedPaymentMethod, selectedInstallmentCount, activeSettings]);


  const handleBook = async (ignoreTooClose = false) => {
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
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError || !sessionData.session) {
         addToast("Sua sessão expirou. Faça login novamente.", 'error');
         navigate('/login');
         return; 
      }

      const token = sessionData.session.access_token;
      const studentId = sessionData.session.user.id;

      // Check if student profile has CPF and Phone filled
      const { data: studentProfile, error: profileErr } = await supabase
         .from('profiles')
         .select('cpf, phone')
         .eq('id', studentId)
         .single();

      if (profileErr) {
         console.error("Erro ao buscar perfil do aluno:", profileErr);
         throw new Error("Não foi possível carregar os dados de perfil do aluno.");
      }

      const hasCpf = studentProfile?.cpf && studentProfile.cpf.trim() !== '';
      const hasPhone = studentProfile?.phone && studentProfile.phone.trim() !== '';

      if (!hasCpf || !hasPhone) {
         // Open CPF/Phone modal
         setStudentCpf(studentProfile?.cpf || '');
         setStudentPhone(studentProfile?.phone || '');
         setCpfModalIgnoreTooClose(ignoreTooClose);
         setIsCpfModalOpen(true);
         setIsProcessingPayment(false);
         return;
      }

      // If they have CPF and Phone, open Payment Method Selection Modal!
      setPaymentIgnoreTooClose(ignoreTooClose);
      setIsPaymentMethodModalOpen(true);
      setIsProcessingPayment(false);
    } catch (error: any) {
      console.error("Booking Check Error:", error);
      setPaymentErrorMessage(error.message || "Erro de conexão ao verificar agendamento.");
      setIsProcessingPayment(false);
      setIsPaymentErrorOpen(true);
    }
  };

  const executeActualBooking = async (method: 'PIX' | 'CREDIT_CARD', installments: number) => {
    console.group('[executeActualBooking]');
    console.log({
      timestamp: Date.now()
    });
    console.trace();
    console.groupEnd();

    if (isProcessingPayment) return;
    setIsProcessingPayment(true);
    setIsPaymentMethodModalOpen(false);
    setPaymentErrorCode('');

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError || !sessionData?.session) {
         addToast("Sua sessão expirou. Faça login novamente.", 'error');
         navigate('/login');
         return; 
      }

      const token = sessionData.session.access_token;
      const studentId = sessionData.session.user.id;

      // 3. Montar Payload
      const lessons = selectedSlots.map(slotKey => {
         const [dateStr, timeStr] = slotKey.split('|');
         const isNight = parseInt(timeStr.split(':')[0]) >= 18;
         
         let price = 0;
         if (selectedLessonCategory) {
            const catPrice = instructor!.categoryPrices.find(c => c.category === selectedLessonCategory);
            if (catPrice) {
              price = (isNight && instructor!.hasNightLessons) ? catPrice.night_price : catPrice.day_price;
            } else {
              price = (isNight && instructor!.hasNightLessons) ? instructor!.priceNight : instructor!.priceDay;
            }
         } else {
             price = (isNight && instructor!.hasNightLessons) ? instructor!.priceNight : instructor!.priceDay;
         }

         // Calculate end time using the official LESSON_DURATION
         const [h, m] = timeStr.split(':').map(Number);
         const endDate = new Date();
         endDate.setHours(h, m + LESSON_DURATION, 0, 0);
         const endTimeStr = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;

         return {
           date: dateStr,
           startTime: timeStr,
           endTime: endTimeStr,
           price: price
         };
      });

      const payload = {
        instructorId: instructor!.id,
        studentId: studentId,
        category: selectedLessonCategory,
        lessons: lessons,
        ignoreTooClose: paymentIgnoreTooClose,
        paymentMethod: method,
        installmentCount: installments
      };

      // 4. Call API Route
      const response = await fetch('/api/create-booking-intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.errorCode === 'TOO_CLOSE') {
          setIsTooCloseModalOpen(true);
          setIsProcessingPayment(false);
          return;
        }
        if (data.code === 'INSTRUCTOR_ASAAS_NOT_READY') {
          setPaymentErrorCode('INSTRUCTOR_ASAAS_NOT_READY');
          setPaymentErrorMessage(data.error || 'Instructor not ready for Asaas payments');
          setIsProcessingPayment(false);
          setIsPaymentErrorOpen(true);
          return;
        }
        throw new Error(data.error || 'Falha ao criar reserva');
      }

      // 5. Sucesso
      if (data && data.groupId && (data.clientSecret || data.invoiceUrl)) {
         const isStandalone = CheckoutLauncher.isStandalone();
         console.log({
             invoiceUrl: data.invoiceUrl,
             isStandalone,
             fluxo: 'CheckoutLauncher.launch (TESTE DE REVERSÃO - TODOS AMBIENTES)'
         });
         // DESATIVAR TEMPORARIAMENTE O USO DA PAYMENTPAGE - TODOS OS AMBIENTES USAM CHECKOUTLAUNCHER DIRETO
         localStorage.removeItem('booking_selected_slots');
         CheckoutLauncher.launch(data.invoiceUrl);
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
      
      const { data: refreshedAvailabilityData } = await supabase
         .rpc('get_instructor_availability', {
             p_instructor_id: instructor!.id,
             p_start_date: dateKey,
             p_end_date: dateKey
         });
         
      const { data: refreshedStudentData } = await supabase
         .from('appointments')
         .select('start_time, status, instructor_id')
         .eq('student_id', session?.user?.id)
         .eq('date', dateKey)
         .not('status', 'in', '("cancelled","failed","rejected","expired")');

      const busySlotsSet = new Set<string>();
      if (refreshedAvailabilityData) {
          refreshedAvailabilityData.forEach((slot: any) => {
              if (slot.status === 'my_reservation') {
                  return;
              }
              busySlotsSet.add(slot.start_time.substring(0, 5));
          });
      }
      if (refreshedStudentData) {
          refreshedStudentData.forEach(apt => {
              if (apt.instructor_id === instructor!.id && (apt.status === 'awaiting_payment' || apt.status === 'reserved')) {
                  return;
              }
              busySlotsSet.add(apt.start_time.substring(0, 5));
          });
      }
      setBusySlots(Array.from(busySlotsSet));
    }
  };

  const handleRetryPayment = () => {
    setIsPaymentErrorOpen(false);
    clearPersistedSlots();
    window.location.reload();
  };

  const openWhatsApp = () => {
    if (!instructor?.whatsapp) return;
    const cleanNumber = instructor.whatsapp.replace(/\D/g, '');
    if (cleanNumber.length < 10) return;
    const fullNumber = cleanNumber.startsWith('55') ? cleanNumber : `55${cleanNumber}`;
    window.open(`https://wa.me/${fullNumber}`, '_blank', 'noopener,noreferrer');
  };

  const handleWhatsAppContact = async () => {
    if (!instructor?.whatsapp) return;
    
    // Release any temporary reservations for these slots
    if (selectedSlots.length > 0 && session?.user?.id) {
      const dates = selectedSlots.map(s => s.split('|')[0]);
      const times = selectedSlots.map(s => s.split('|')[1]);
      
      try {
        await supabase
          .from('appointments')
          .update({
            status: 'cancelled',
            payment_status: 'failed',
            cancelled_reason: 'user_contacted_instructor'
          })
          .eq('instructor_id', instructor.id)
          .in('date', dates)
          .in('start_time', times)
          .eq('student_id', session.user.id)
          .in('status', ['reserved', 'pending', 'awaiting_payment']);
      } catch (err) {
        console.error("Error releasing slots before WhatsApp contact:", err);
      }
    }

    const cleanNumber = instructor.whatsapp.replace(/\D/g, '');
    if (cleanNumber.length < 10) return;
    const fullNumber = cleanNumber.startsWith('55') ? cleanNumber : `55${cleanNumber}`;
    
    const time = selectedSlots[0]?.split('|')[1] || 'agora';
    const message = `Olá, ${instructor.name}! Tentei agendar uma aula pelo aplicativo para hoje às ${time}, mas o sistema informou que o horário está muito em cima. Você ainda consegue me atender?`;
    
    const whatsappUrl = `https://wa.me/${fullNumber}?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
    
    setIsTooCloseModalOpen(false);
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

  const submitReview = async () => {
    if (!session?.user || !instructor) return;
    setIsSubmittingReview(true);

    try {
      let appointmentId = existingReview?.appointment_id;

      // If no existing review, we need an appointment_id to link the review. 
      // We fetch the most recent completed appointment.
      if (!appointmentId) {
        const { data: latestApt } = await supabase
          .from('appointments')
          .select('id')
          .eq('student_id', session.user.id)
          .eq('instructor_id', instructor.id)
          .eq('status', 'completed')
          .order('date', { ascending: false })
          .limit(1)
          .single();

        if (!latestApt) throw new Error("Nenhuma aula concluída encontrada.");
        appointmentId = latestApt.id;
      }

      const reviewData: any = {
        appointment_id: appointmentId,
        student_id: session.user.id,
        instructor_id: instructor.id,
        rating: reviewRating,
        comment: reviewComment
      };

      // If editing, include the ID to ensure update
      if (existingReview?.id) {
        reviewData.id = existingReview.id;
      }

      const { error, data: savedReview } = await supabase
        .from('reviews')
        .upsert(reviewData)
        .select()
        .single();

      if (error) throw error;

      addToast("Avaliação salva com sucesso!", "success");
      setIsSubmitReviewModalOpen(false);
      
      // Update local state to reflect the new/updated review
      if (savedReview) {
        setExistingReview(savedReview);
        setReviewRating(savedReview.rating);
        setReviewComment(savedReview.comment || '');
      }

      // Optionally refresh the instructor's reviews list
      const { data: reviewsData } = await supabase
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
        .eq('instructor_id', instructor.id)
        .order('created_at', { ascending: false });

      if (reviewsData) {
        const formattedReviews = reviewsData.map((r: any) => {
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
        });

        const { formattedRating, reviewsCount, formattedReviewsCount } = calculateInstructorRating(formattedReviews);

        setInstructor(prev => prev ? { 
          ...prev, 
          reviews: formattedReviews,
          rating: formattedRating,
          reviewsCount: reviewsCount,
          formattedReviewsCount: formattedReviewsCount
        } : null);
      }

    } catch (err: any) {
      console.error("Error submitting review:", err);
      addToast("Erro ao salvar avaliação: " + err.message, "error");
    } finally {
      setIsSubmittingReview(false);
    }
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
      
      {/* Preview Banner */}
      {showPreviewBanner && (
        <div className="bg-blue-600 px-6 py-2.5 z-[40] sticky top-0 shadow-lg">
          <div className="flex items-center justify-between text-white">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <span className="text-xs font-bold uppercase tracking-wider">Modo de Visualização</span>
            </div>
            {fromInstructor && (
              <button 
                onClick={() => navigate('/instructor/profile')}
                className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded-full text-[10px] font-bold transition-colors"
              >
                Voltar para edição
              </button>
            )}
          </div>
          <p className="text-[10px] text-blue-100 mt-0.5 font-medium">
            Você está vendo seu perfil como aluno. Agendamentos desabilitados.
          </p>
        </div>
      )}

      <div className={`px-4 py-4 sticky ${showPreviewBanner ? 'top-[52px]' : 'top-0'} bg-white/90 backdrop-blur-md z-20 border-b border-gray-100 flex items-center transition-all duration-300`}>
        <button 
          onClick={() => {
            const hasHistory = (location.state?.fromApp || location.state?.fromInstructor) && window.history.length > 1;
            if (hasHistory) {
              navigate(-1);
            } else {
              navigate('/student/home');
            }
          }} 
          className="p-2 -ml-2 text-gray-600 hover:text-gray-900 rounded-full hover:bg-gray-100 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="ml-2 font-semibold text-gray-900">Perfil do Instrutor</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-6 pb-4 bg-white">
          <div className="flex justify-between items-start w-full">
            <div className="flex flex-col flex-1 min-w-0">
              
              {/* 1. Identity Block */}
              <div className="flex items-start justify-between w-full mb-4">
                <div className="flex flex-col pr-4">
                  <h1 className="text-2xl font-bold text-gray-900 leading-tight mb-1">
                    {instructor.name}
                  </h1>
                  
                  {/* Rating & Experience */}
                  <div className="flex flex-col gap-1.5 mb-3">
                    <div className="flex items-center text-sm">
                      <span className="text-yellow-400 mr-1">
                        <svg className="w-4 h-4 fill-current" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      </span>
                      <span className="font-bold text-gray-800 mr-1">{instructor.rating}</span>
                      <button onClick={handleOpenReviews} disabled={instructor.reviews.length === 0} className={`text-gray-500 underline decoration-gray-300 underline-offset-2 ${instructor.reviews.length > 0 ? 'hover:text-gray-700' : 'cursor-default'}`}>
                        ({instructor.formattedReviewsCount})
                      </button>
                    </div>
                    {instructor.lessonsTaught > 0 && (
                      <div className="flex items-center text-xs text-gray-500 font-medium">
                        <svg className="w-3.5 h-3.5 mr-1 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        +{instructor.lessonsTaught} aulas realizadas
                      </div>
                    )}
                  </div>

                  {/* Price Highlight */}
                  {startingPrice > 0 && (
                    <div className="flex flex-col items-start">
                      <div className="inline-flex items-baseline text-blue-700">
                        {!selectedLessonCategory ? (
                          <>
                            <span className="text-xs font-medium mr-1 text-gray-500">A partir de</span>
                            <span className="text-xl font-black">{formatCurrency(startingPrice)}</span>
                            <span className="text-xs font-medium ml-1 text-gray-500">/ aula</span>
                          </>
                        ) : (
                          <>
                            <span className="text-xl font-black">{formatCurrency(currentDisplayPrices.day)}</span>
                            <span className="text-xs font-medium ml-1 text-gray-500">/ aula</span>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-col items-center">
                  {/* Avatar */}
                  <div 
                    onClick={() => instructor.photoUrl && setIsPhotoModalOpen(true)}
                    className={`relative w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center text-3xl border border-gray-200 flex-shrink-0 text-gray-400 overflow-hidden shadow-sm ${instructor.photoUrl ? 'cursor-pointer hover:scale-105 transition-transform group' : ''}`}
                  >
                    {instructor.photoUrl ? (
                      <>
                        <img src={instructor.photoUrl} alt={instructor.name} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <svg className="w-6 h-6 text-white drop-shadow-md" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                          </svg>
                        </div>
                      </>
                    ) : (
                      "👤"
                    )}
                  </div>
                </div>
              </div>

              {/* WhatsApp Button (Prominent but secondary) */}
              {instructor.whatsapp && (
                <button
                  onClick={openWhatsApp}
                  className="w-full mb-5 flex items-center justify-center gap-2 py-2.5 bg-green-50 border border-green-200 rounded-xl hover:bg-green-100 transition-colors text-green-700 font-semibold text-sm"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                  Falar com o instrutor
                </button>
              )}

              {/* 2. Chips (Category, Credential) */}
              <div className="flex flex-wrap gap-2">
                {instructor.credential && instructor.credential !== 'N/A' && (
                  <div className="inline-flex items-center whitespace-nowrap px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-700 text-xs font-medium border border-gray-200">
                    <svg className="w-4 h-4 mr-1.5 text-gray-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    Credencial DETRAN &bull; {instructor.credential}
                  </div>
                )}

                <div className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-700 text-xs font-medium border border-gray-200">
                  <svg className="w-4 h-4 mr-1.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
                  </svg>
                  Cat. {instructor.category === 'AB' ? 'A/B' : instructor.category}
                </div>
              </div>

              {/* 3. Vehicles Highlight */}
              {instructor.vehicles && instructor.vehicles.length > 0 && (
                <div className="mt-4 bg-blue-50/50 rounded-xl p-4 border border-blue-100 flex flex-col gap-2">
                  <span className="text-xs font-bold text-blue-900 uppercase tracking-wide">Veículos disponíveis</span>
                  <div className="flex flex-col gap-2">
                    {instructor.vehicles.map((v, idx) => (
                      <div key={idx} className="flex items-center text-sm text-gray-800 font-medium">
                        <span className="mr-2 text-lg">{v.type === 'car' ? '🚘' : '🏍️'}</span>
                        {v.model || (v.type === 'car' ? 'Carro' : 'Moto')}
                        {v.year ? <span className="text-gray-500 font-normal ml-1">({v.year})</span> : null}
                        {v.transmission && (
                          <span className="text-gray-400 font-normal ml-1.5">
                            • {v.transmission === 'automatic' ? 'Automático' : 'Manual'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 4. Location (City + Meeting point in a light card) */}
              <div className="mt-4 bg-gray-50 rounded-xl p-4 border border-gray-100 flex items-start">
                <div className="bg-white p-2 rounded-full shadow-sm border border-gray-100 mr-3 flex-shrink-0">
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-gray-900 mb-0.5">{instructor.city}</span>
                  {instructor.defaultLocation ? (
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-600 leading-snug">
                        Ponto de encontro: {' '}
                        <a 
                          href={instructor ? getGoogleMapsUrl({
                            address: instructor.defaultLocation,
                            lat: instructor.meetingPointLat,
                            lng: instructor.meetingPointLng,
                            placeId: instructor.meetingPointPlaceId
                          }) : '#'} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-700 underline decoration-blue-200 underline-offset-2 transition-colors"
                        >
                          {instructor.defaultLocation}
                        </a>
                      </span>
                      {instructor.meetingPointLat !== null && instructor.meetingPointLng !== null && (
                        <button 
                          onClick={() => setIsGPSModalOpen(true)}
                          className="mt-2 flex items-center text-blue-600 text-xs font-bold hover:text-blue-700 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          </svg>
                          Abrir no GPS
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-gray-500 italic">Ponto de encontro a combinar</span>
                  )}
                </div>
              </div>

              {/* 5. Discrete ID */}
              {instructor.publicId && (
                <div className="mt-5 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">
                    ID do Instrutor
                  </span>
                  
                  <button 
                    onClick={handleShare}
                    className="group flex items-center gap-2 mt-1 px-3 py-1.5 text-gray-500 hover:text-gray-800 transition-colors"
                  >
                    <span className="font-mono text-sm font-semibold tracking-wide text-gray-700 group-hover:text-gray-900 transition-colors">
                      {instructor.publicId}
                    </span>
                    <span className="flex items-center text-xs text-gray-400 group-hover:text-gray-600 transition-colors gap-1 ml-1">
                      {isIdCopied ? (
                        <>
                          <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="text-[10px] font-medium text-green-500">Copiado!</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="18" cy="5" r="3"/>
                            <circle cx="6" cy="12" r="3"/>
                            <circle cx="18" cy="19" r="3"/>
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                          </svg>
                          <span className="text-[10px] font-medium">Compartilhar</span>
                        </>
                      )}
                    </span>
                  </button>

                  <p className="text-[10px] text-gray-400 mt-1">
                    Gostou deste instrutor?<br />Então compartilhe com seus amigos.
                  </p>
                </div>
              )}

            </div>
          </div>

          {/* Review Action Button */}
          {canReview && (
            <div className="mt-5">
              <Button 
                variant="outline" 
                fullWidth 
                onClick={() => setIsSubmitReviewModalOpen(true)}
                className="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                {existingReview ? 'Editar Avaliação' : 'Avaliar Instrutor'}
              </Button>
            </div>
          )}

        </div>

        {/* Divider before category selection */}
        {!showPreviewBanner && <div className="h-2 bg-gray-50 border-y border-gray-100"></div>}

        {availableCategories.length > 0 && !showPreviewBanner && (
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
                   Selecione a categoria acima para ver os preços e liberar os horários.
                </p>
             )}
          </div>
        )}

        {!showPreviewBanner && (
          <div className="px-6 pb-6 pt-4">
             <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-1">Horários disponíveis</h2>
             <div className="mb-4">
               <p className="text-xs text-gray-500">
                 Selecione os horários desejados. Descontos progressivos são aplicados automaticamente.
               </p>
               <p className="text-xs text-gray-400 mt-1">
                 Em caso de dúvidas, você pode falar diretamente com o instrutor pelo WhatsApp.
               </p>
             </div>

             <div className="mt-2">
                <DateSelector 
                  selectedDate={selectedDate} 
                  onDateSelect={setSelectedDate} 
                  daysBefore={0} 
                  daysAfter={7} 
                />
             </div>

             <div className="grid grid-cols-4 gap-2">
                {timeSlots.map((item, index) => {
                  if (typeof item === 'object' && item.type === 'lunch') {
                    return (
                      <button
                        key={`lunch-${index}`}
                        disabled={true}
                        className="py-2 rounded-lg text-xs font-medium bg-orange-50 text-orange-400 border border-orange-100 cursor-not-allowed flex flex-col items-center leading-tight min-h-[44px] justify-center"
                      >
                        <span className="text-[10px]">{item.start}</span>
                        <span className="text-[8px] font-bold uppercase tracking-tighter">Almoço</span>
                      </button>
                    );
                  }

                  const time = item as string;
                  const isAvailable = isSlotAvailable(time);
                  const dateKey = getDateKey(selectedDate);
                  const slotKey = `${dateKey}|${time}`;
                  const isSelected = selectedSlots.includes(slotKey);
                  
                  // Determine if it's night
                  const hour = parseInt(time.split(':')[0]);
                  const isNight = hour >= 18;

                  // NEW: Check if time has passed for today
                  let isPastTime = false;
                  const today = new Date();
                  
                  // Robust comparison: Check if selectedDate is the same day as today
                  const isToday = selectedDate.getDate() === today.getDate() &&
                                  selectedDate.getMonth() === today.getMonth() &&
                                  selectedDate.getFullYear() === today.getFullYear();
                  
                  if (isToday) {
                      const [h, m] = time.split(':').map(Number);
                      const now = new Date();
                      const slotDate = new Date();
                      slotDate.setHours(h, m, 0, 0);
                      
                      if (slotDate < now) {
                          isPastTime = true;
                      }
                  }

                  const isDisabled = !isAvailable || isPastTime;

                  return (
                    <button
                      key={time}
                      onClick={() => toggleSlot(time)}
                      disabled={isDisabled}
                      className={`
                        py-2 rounded-lg text-sm font-medium transition-all duration-200 relative min-h-[44px] flex items-center justify-center
                        ${isSelected 
                          ? 'bg-blue-600 text-white shadow-md transform scale-105 z-10' 
                          : !isDisabled 
                            ? 'bg-white text-gray-700 border border-gray-200 hover:border-blue-300 hover:bg-blue-50' 
                            : 'bg-gray-50 text-gray-300 cursor-not-allowed border border-transparent'
                        }
                      `}
                    >
                      <span>{time}</span>
                      {isNight && !isDisabled && !isSelected && (
                        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-indigo-400 rounded-full"></span>
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
        )}

        <div className="h-2 bg-gray-50"></div>

        <div className="px-6 py-6 space-y-4 pb-12">
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Promoções deste instrutor</h2>
          
          {instructor.discounts.length === 0 ? (
             <div className="text-center py-6 bg-gray-50 rounded-xl border border-gray-100 border-dashed">
                <p className="text-gray-400 text-sm">Nenhuma promoção ativa no momento.</p>
             </div>
          ) : (
             <div className="space-y-3">
                {instructor.discounts.map((rule) => {
                   const basePriceForDiscount = selectedLessonCategory ? currentDisplayPrices.day : startingPrice;
                   const discountAmount = (basePriceForDiscount * rule.discount_percentage) / 100;
                   
                   return (
                    <div key={rule.id} className="bg-green-50 border border-green-100 rounded-xl p-4 flex items-center justify-between">
                       <div className="flex items-center space-x-3">
                          <div className="bg-green-100 p-2 rounded-lg text-green-700">
                             <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                             </svg>
                          </div>
                          <div>
                             <p className="text-green-900 font-bold text-sm">
                                {rule.discount_percentage}% de Desconto
                             </p>
                             <p className="text-green-700 text-xs">
                                Na compra de {rule.min_lessons} ou mais aulas
                             </p>
                             <p className="text-green-600 font-semibold text-[11px] mt-0.5">
                                {formatCurrency(discountAmount)} de economia por aula
                             </p>
                          </div>
                       </div>
                       <div className="text-green-600 font-bold text-xs bg-white px-2 py-1 rounded-md border border-green-100 shadow-sm">
                          Automático
                       </div>
                    </div>
                   );
                })}
             </div>
          )}
        </div>

      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-gray-100 sm:max-w-md sm:mx-auto z-20 flex items-center justify-between">
        <div className="flex flex-col">
          {selectedSlots.length > 0 ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-500 font-medium">Total ({selectedSlots.length} {selectedSlots.length === 1 ? 'aula' : 'aulas'})</span>
                {priceInfo.discountPct > 0 && (
                  <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded uppercase">-{priceInfo.discountPct}%</span>
                )}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold text-gray-900">{formatCurrency(totalPrice)}</span>
                {priceInfo.discountPct > 0 && (
                  <span className="text-xs text-gray-400 line-through">{formatCurrency(priceInfo.base)}</span>
                )}
              </div>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-500 font-medium">
                {!selectedLessonCategory ? 'A partir de' : 'Valor da aula'}
              </span>
              <span className="text-xl font-bold text-gray-900">
                {formatCurrency(!selectedLessonCategory ? startingPrice : currentDisplayPrices.day)}
                <span className="text-sm font-normal text-gray-500">/aula</span>
              </span>
            </>
          )}
        </div>
        <Button 
          onClick={() => handleBook()} 
          disabled={selectedSlots.length === 0 || !selectedLessonCategory || isProcessingPayment || isSuccess || showPreviewBanner}
          className={`shadow-lg transition-all duration-300 px-8 py-3 ${
            isSuccess 
              ? 'bg-green-600 hover:bg-green-700 border-transparent text-white shadow-green-200' 
              : (selectedSlots.length === 0 || !selectedLessonCategory || isProcessingPayment || showPreviewBanner) 
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
            ? 'Processando...' 
            : showPreviewBanner
              ? 'Preview'
              : selectedSlots.length > 0 
                ? 'Pagar agora'
                : 'Agendar'
          }
        </Button>
      </div>

      <Modal
        isOpen={isPaymentErrorOpen}
        onClose={() => setIsPaymentErrorOpen(false)}
        title={paymentErrorCode === 'INSTRUCTOR_ASAAS_NOT_READY' ? PAYMENT_ERRORS.INSTRUCTOR_ASAAS_NOT_READY.title : "Não foi possível agendar"}
        footer={
           <div className="space-y-3 w-full">
              <Button fullWidth onClick={handleRetryPayment}>
                Entendi
              </Button>
            </div>
        }
      >
        <div className="text-center">
            {paymentErrorCode === 'INSTRUCTOR_ASAAS_NOT_READY' ? (
              <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">
                ⏳
              </div>
            ) : (
              <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">
                🚫
              </div>
            )}
            <p className="text-sm text-gray-600 mb-2 leading-relaxed">
              {paymentErrorCode === 'INSTRUCTOR_ASAAS_NOT_READY' 
                ? PAYMENT_ERRORS.INSTRUCTOR_ASAAS_NOT_READY.message
                : paymentErrorMessage}
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

      {/* Photo Fullscreen Modal */}
      {isPhotoModalOpen && instructor?.photoUrl && (
        <div 
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setIsPhotoModalOpen(false)}
        >
          <button className="absolute top-6 right-6 text-white/70 hover:text-white p-2 transition-colors">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          
          <img 
            src={instructor.photoUrl} 
            alt={instructor.name} 
            className="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Too Close Modal */}
      <Modal
        isOpen={isTooCloseModalOpen}
        onClose={() => setIsTooCloseModalOpen(false)}
        title="Horário muito próximo"
        footer={
          <div className="flex flex-col gap-3 w-full">
            <Button
              fullWidth
              onClick={() => {
                setIsTooCloseModalOpen(false);
                handleBook(true);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              Confirmar e continuar
            </Button>
            <button
              onClick={handleWhatsAppContact}
              className="w-full bg-green-50 hover:bg-green-100 text-green-700 py-3 px-4 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 border border-green-200"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
            </button>
            <button
              onClick={() => {
                setIsTooCloseModalOpen(false);
              }}
              className="w-full bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 py-3 px-4 rounded-xl font-medium transition-colors"
            >
              Voltar
            </button>
          </div>
        }
      >
        <p className="text-gray-600">
          Esse horário está próximo do início. Você já confirmou com o instrutor que ele pode te atender?
        </p>
      </Modal>

      {/* Submit Review Modal */}
      <Modal
        isOpen={isSubmitReviewModalOpen}
        onClose={() => setIsSubmitReviewModalOpen(false)}
        title={existingReview ? "Editar Avaliação" : "Avaliar Instrutor"}
      >
        <div className="flex flex-col items-center space-y-4">
          <p className="text-sm text-gray-600 text-center">
            Como foi sua experiência com {instructor?.name}?
          </p>
          
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onClick={() => setReviewRating(star)}
                className={`text-4xl transition-colors ${
                  star <= reviewRating ? 'text-yellow-400' : 'text-gray-200'
                }`}
              >
                ★
              </button>
            ))}
          </div>

          <textarea
            value={reviewComment}
            onChange={(e) => setReviewComment(e.target.value)}
            placeholder="Deixe um comentário (opcional)"
            className="w-full p-3 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            rows={3}
          />

          <div className="w-full space-y-2 pt-2">
            <Button 
              fullWidth 
              onClick={submitReview} 
              disabled={reviewRating === 0 || isSubmittingReview}
            >
              {isSubmittingReview ? 'Salvando...' : 'Salvar Avaliação'}
            </Button>
            <button 
              onClick={() => setIsSubmitReviewModalOpen(false)} 
              className="w-full text-center text-sm text-gray-400 py-2"
            >
              Cancelar
            </button>
          </div>
        </div>
      </Modal>

      {/* GPS Modal */}
      <Modal
        isOpen={isGPSModalOpen}
        onClose={() => setIsGPSModalOpen(false)}
        title="Abrir no GPS"
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-4">
            Escolha seu aplicativo de navegação preferido:
          </p>
          
          <button
            onClick={() => {
              const url = `https://www.google.com/maps/dir/?api=1&destination=${instructor.meetingPointLat},${instructor.meetingPointLng}`;
              window.open(url, '_blank');
              setIsGPSModalOpen(false);
            }}
            className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100 hover:bg-blue-50 hover:border-blue-200 transition-all group"
          >
            <div className="flex items-center">
              <div className="w-10 h-10 bg-white rounded-lg shadow-sm border border-gray-100 flex items-center justify-center mr-3">
                <img src="https://upload.wikimedia.org/wikipedia/commons/a/aa/Google_Maps_icon_%282020%29.svg" alt="Google Maps" className="w-6 h-6" />
              </div>
              <span className="font-bold text-gray-900">Google Maps</span>
            </div>
            <svg className="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          <button
            onClick={() => {
              const url = `https://waze.com/ul?ll=${instructor.meetingPointLat},${instructor.meetingPointLng}&navigate=yes`;
              window.open(url, '_blank');
              setIsGPSModalOpen(false);
            }}
            className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100 hover:bg-orange-50 hover:border-orange-200 transition-all group"
          >
            <div className="flex items-center">
              <div className="w-10 h-10 bg-white rounded-lg shadow-sm border border-gray-100 flex items-center justify-center mr-3">
                <img src="https://upload.wikimedia.org/wikipedia/commons/6/66/Waze_icon.svg" alt="Waze" className="w-6 h-6" />
              </div>
              <span className="font-bold text-gray-900">Waze</span>
            </div>
            <svg className="w-5 h-5 text-gray-400 group-hover:text-orange-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          <button
            onClick={() => setIsGPSModalOpen(false)}
            className="w-full py-3 text-sm font-medium text-gray-400 hover:text-gray-600 transition-colors"
          >
            Cancelar
          </button>
        </div>
      </Modal>

      {/* CPF and Phone Completion Modal */}
      <Modal
        isOpen={isCpfModalOpen}
        onClose={() => setIsCpfModalOpen(false)}
        title="Complete seus dados para finalizar"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Para processar pagamentos de forma segura, precisamos do seu CPF e telefone. Você só precisará preencher estes dados uma vez.
          </p>
          
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wilder mb-2">
                CPF *
              </label>
              <input
                type="text"
                value={studentCpf}
                onChange={(e) => setStudentCpf(formatCpfInput(e.target.value))}
                placeholder="000.000.000-00"
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                disabled={isSavingCpf}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wilder mb-2">
                Telefone Celular *
              </label>
              <input
                type="text"
                value={studentPhone}
                onChange={(e) => setStudentPhone(formatPhoneInput(e.target.value))}
                placeholder="(00) 00000-0000"
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                disabled={isSavingCpf}
              />
            </div>
          </div>

          <div className="pt-2 space-y-2">
            <Button
              fullWidth
              onClick={handleSaveCpfAndPhone}
              disabled={isSavingCpf}
            >
              {isSavingCpf ? "Salvando..." : "Salvar e Continuar"}
            </Button>
            <button
              onClick={() => setIsCpfModalOpen(false)}
              disabled={isSavingCpf}
              className="w-full text-center text-sm font-medium text-gray-400 hover:text-gray-600 py-2 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      </Modal>

      {/* Payment Method Selection Modal (PIX + Installments) */}
      <Modal
        isOpen={isPaymentMethodModalOpen}
        onClose={() => setIsPaymentMethodModalOpen(false)}
        title="Forma de Pagamento"
      >
        <div className="space-y-6">
          <p className="text-sm text-gray-500 leading-relaxed">
            Escolha como prefere realizar o pagamento do seu agendamento de aulas.
          </p>

          <div className="space-y-3">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Selecione a opção
            </label>
            
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                id="payment-method-pix"
                aria-label="Pagamento via Pix"
                onClick={() => {
                  setSelectedPaymentMethod('PIX');
                  setSelectedInstallmentCount(1);
                }}
                className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  selectedPaymentMethod === 'PIX'
                    ? 'border-blue-600 bg-blue-50/50 text-blue-900 font-semibold'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <img 
                  src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/PIX.png" 
                  alt="Pix Logo" 
                  className="h-10 w-auto object-contain mb-1"
                  referrerPolicy="no-referrer"
                />
                <span className="text-sm font-medium">PIX</span>
              </button>

              <button
                type="button"
                id="payment-method-cc"
                onClick={() => setSelectedPaymentMethod('CREDIT_CARD')}
                className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  selectedPaymentMethod === 'CREDIT_CARD'
                    ? 'border-blue-600 bg-blue-50/50 text-blue-900 font-semibold'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <span className="text-2xl mb-1">💳</span>
                <span className="text-sm font-medium">Cartão de Crédito</span>
              </button>
            </div>
          </div>

          {selectedPaymentMethod === 'CREDIT_CARD' && (
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Parcelamento
              </label>
              
              <div className="relative">
                <select
                  id="payment-installments-select"
                  value={selectedInstallmentCount}
                  onChange={(e) => setSelectedInstallmentCount(Number(e.target.value))}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all cursor-pointer appearance-none text-sm font-medium"
                >
                  {Array.from({ length: MAX_INSTALLMENTS }, (_, i) => i + 1).map((count) => {
                    const key = `credit_${count}x_fee`;
                    const percentage = activeSettings[key] !== undefined ? Number(activeSettings[key]) : 3.99;
                    const fee = Math.round(totalPrice * (percentage / 100));
                    const totalWithFeeForOption = totalPrice + fee;
                    const installmentValue = totalWithFeeForOption / count;
                    return (
                      <option key={count} value={count}>
                        {count}x de {formatCurrency(installmentValue)} (com taxa de {percentage}%)
                      </option>
                    );
                  })}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-gray-500">
                  <svg className="fill-current h-4 w-4" viewBox="0 0 20 20">
                    <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                  </svg>
                </div>
              </div>
            </div>
          )}

          {/* Checkout Info Box */}
          <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4 space-y-2">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Quantidade de aulas:</span>
              <span className="font-semibold text-gray-700">{selectedSlots.length} aula(s)</span>
            </div>
            <div className="flex justify-between text-xs text-gray-500 pt-1 border-t border-gray-100 font-medium">
              <span>Valor das aulas:</span>
              <span>{formatCurrency(totalPrice)}</span>
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span>Taxa de processamento ({selectedPaymentMethod === 'PIX' ? 'PIX' : `Cartão ${selectedInstallmentCount}x`}):</span>
              <span className="font-semibold text-gray-700">{formatCurrency(feeInfo.fee)}</span>
            </div>
            <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
              <span className="font-bold text-gray-900">Total a pagar:</span>
              <span className="font-extrabold text-blue-700 text-base">{formatCurrency(feeInfo.totalWithFee)}</span>
            </div>
            {selectedPaymentMethod === 'CREDIT_CARD' && (
              <div className="flex justify-between text-xs text-blue-600 font-medium pt-1">
                <span>Plano de parcelamento:</span>
                <span>{selectedInstallmentCount}x de {formatCurrency(feeInfo.totalWithFee / selectedInstallmentCount)}</span>
              </div>
            )}
          </div>

          <div className="pt-2 space-y-2">
            <Button
              fullWidth
              id="confirm-payment-btn"
              loading={isProcessingPayment}
              disabled={isProcessingPayment}
              onClick={() => executeActualBooking(selectedPaymentMethod, selectedInstallmentCount)}
            >
              Confirmar e Pagar
            </Button>
            <button
              type="button"
              id="cancel-payment-btn"
              disabled={isProcessingPayment}
              onClick={() => setIsPaymentMethodModalOpen(false)}
              className="w-full text-center text-sm font-medium text-gray-400 hover:text-gray-600 py-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Voltar
            </button>
          </div>
        </div>
      </Modal>

    </div>
  );
};
