import React, { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { RatingBadge } from '../../components/RatingBadge';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';

// Define Interface for the State matches DB structure
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
  priceDay: number; // Legacy Fallback
  priceNight: number; // Legacy Fallback
  hasNightLessons: boolean;
  workSaturdayAfternoon: boolean; // New Field
  category: 'A' | 'B' | 'AB';
  discounts: DiscountRule[]; 
  reviews: any[];
  categoryPrices: CategoryPrice[]; // New Pricing Structure
  vehicles: Vehicle[];
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
  const [existingLessonsCount, setExistingLessonsCount] = useState(0); // Count of lessons with this instructor on selected date
  
  // Modal State
  const [isReviewsModalOpen, setIsReviewsModalOpen] = useState(false);
  const [visibleReviewsCount, setVisibleReviewsCount] = useState(3);
  
  // Payment Error State
  const [isPaymentErrorOpen, setIsPaymentErrorOpen] = useState(false);
  const [paymentErrorMessage, setPaymentErrorMessage] = useState('');
  
  // Too Close Error State
  const [isTooCloseModalOpen, setIsTooCloseModalOpen] = useState(false);
  
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

  // Max Booking Date (7 days from today)
  const maxBookingDate = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 7);
    return d;
  }, []);

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
  const [isPhotoModalOpen, setIsPhotoModalOpen] = useState(false);
  
  // Review State
  const [canReview, setCanReview] = useState(false);
  const [existingReview, setExistingReview] = useState<any>(null);
  const [isSubmitReviewModalOpen, setIsSubmitReviewModalOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

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
            whatsapp,
            credential_number,
            location_text,
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
              year
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
            
            // Fetch existing review
            const { data: myReview } = await supabase
              .from('reviews')
              .select('*')
              .eq('student_id', session.user.id)
              .eq('instructor_id', id)
              .maybeSingle();
              
            if (myReview) {
              setExistingReview(myReview);
              setReviewRating(myReview.rating);
              setReviewComment(myReview.comment || '');
            }
          }
        }

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
            defaultLocation: data.location_text || 'Local a combinar',
            rating: displayRating,
            reviewsCount: formattedReviews.length,
            lessonsTaught: formattedReviews.length * 5, 
            priceDay: basePrice,
            priceNight: data.night_price || basePrice,
            hasNightLessons: !!data.has_night_lessons,
            workSaturdayAfternoon: !!data.work_saturday_afternoon,
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
             // 1. Query all appointments for this instructor on this date
             const { data: instructorData, error: instructorError } = await supabase
                .from('appointments')
                .select('start_time, status, student_id')
                .eq('instructor_id', instructor.id)
                .eq('date', dateKey)
                .not('status', 'in', '("cancelled","failed","rejected","expired")'); 

             if (instructorError) throw instructorError;

             // 2. Query all appointments for the student on this date (to prevent double booking)
             const { data: studentData, error: studentError } = await supabase
                .from('appointments')
                .select('start_time, status, instructor_id')
                .eq('student_id', session.user.id)
                .eq('date', dateKey)
                .not('status', 'in', '("cancelled","failed","rejected","expired")');

             if (studentError) throw studentError;

             const busySlotsSet = new Set<string>();
             let existingCount = 0;

             if (instructorData) {
                 instructorData.forEach(apt => {
                     // Allow the student to retry booking their own abandoned checkouts
                     if ((apt.status === 'awaiting_payment' || apt.status === 'reserved') && apt.student_id === session.user.id) {
                         return; // Do not mark as busy
                     }
                     busySlotsSet.add(apt.start_time.substring(0, 5));
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


  // Navigation handlers
  const handlePrevRange = () => {
    const prevDate = addDays(viewDate, -7);
    // Optional: Prevent going too far back (e.g., before current week)
    // const currentWeekStart = getStartOfWeek(new Date());
    // if (prevDate < currentWeekStart) return;
    setViewDate(prevDate);
  };

  const handleNextRange = () => {
    const nextDate = addDays(viewDate, 7);
    // Prevent navigating if the start of the next week is beyond the max booking date
    if (nextDate > maxBookingDate) return;
    setViewDate(nextDate);
  };
  
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

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
  };

  const timeSlots = useMemo(() => {
    const slots = [
      '07:00', '07:50', '08:40', '09:30', '10:20', '11:10', // Morning
      // Lunch 12:00 - 13:50 Skipped
      '13:50', '14:40', '15:30', '16:20', '17:10' // Afternoon
    ];

    if (instructor?.hasNightLessons) {
      slots.push('18:00', '18:50', '19:40', '20:30', '21:20', '22:10');
    }
    return slots;
  }, [instructor?.hasNightLessons]);

  // --- CHECK REAL AVAILABILITY ---
  const isSlotAvailable = (time: string) => {
      // 1. Check if DB says it's busy
      if (busySlots.includes(time)) return false;

      // 2. Check Sunday Rule (Always OFF)
      if (selectedDate.getDay() === 0) return false;

      // 3. Check Saturday Rule
      if (selectedDate.getDay() === 6) {
          const [h, m] = time.split(':').map(Number);
          const minutes = h * 60 + m;
          
          // If instructor works saturday afternoon, allow until 17:10 (end 18:00)
          // Else allow until 11:10 (end 12:00)
          const limit = instructor?.workSaturdayAfternoon ? (17 * 60 + 10) : (11 * 60 + 10);
          
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

    const dailySlots = newSlots.filter(s => s.startsWith(dateKey));
    if (dailySlots.length + existingLessonsCount > 3) {
      addToast("Você pode agendar no máximo 3 aulas por dia com este instrutor.", 'warning');
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
      addToast("Não é permitido agendar 3 aulas consecutivas sem intervalo.", 'warning');
      return; 
    }

    setSelectedSlots(newSlots);
  };

  const limits = useMemo(() => {
    const dateKey = getDateKey(selectedDate);
    const dailySlots = selectedSlots.filter(s => s.startsWith(dateKey));
    
    const isGlobalLimitReached = selectedSlots.length >= 20;
    const isDailyLimitReached = dailySlots.length + existingLessonsCount >= 3;

    return { isGlobalLimitReached, isDailyLimitReached };
  }, [selectedSlots, selectedDate, existingLessonsCount]);

  const totalPrice = useMemo(() => {
    if (!instructor) return 0;

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
        // Find the best applicable discount
        // Sort by min_lessons desc to find the highest threshold met
        const sortedDiscounts = [...instructor.discounts].sort((a, b) => b.min_lessons - a.min_lessons);
        
        const applicableRule = sortedDiscounts.find(d => lessonCount >= d.min_lessons);
        if (applicableRule) {
            discountPercentage = applicableRule.discount_percentage;
        }
    }

    if (discountPercentage > 0) {
        const discountAmount = Math.round(basePrice * (discountPercentage / 100));
        return basePrice - discountAmount;
    }

    return basePrice;
  }, [selectedSlots, instructor, selectedLessonCategory]);


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
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError || !sessionData.session) {
         addToast("Sua sessão expirou. Faça login novamente.", 'error');
         navigate('/login');
         return; 
      }

      const token = sessionData.session.access_token;
      const studentId = sessionData.session.user.id;

      // 3. Montar Payload
      // Calculate price per slot for the payload (backend will recalculate but needs base info)
      // Actually backend needs lessons array with date, startTime, endTime, price
      
      const lessons = selectedSlots.map(slotKey => {
         const [dateStr, timeStr] = slotKey.split('|');
         const isNight = parseInt(timeStr.split(':')[0]) >= 18;
         
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

         // Calculate end time (50 mins later)
         const [h, m] = timeStr.split(':').map(Number);
         const endDate = new Date();
         endDate.setHours(h, m + 50, 0, 0);
         const endTimeStr = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;

         return {
           date: dateStr,
           startTime: timeStr,
           endTime: endTimeStr,
           price: price
         };
      });

      const payload = {
        instructorId: instructor.id,
        studentId: studentId,
        category: selectedLessonCategory,
        lessons: lessons
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
        throw new Error(data.error || 'Falha ao criar reserva');
      }

      // 5. Sucesso
      if (data && data.clientSecret && data.groupId) {
         navigate('/student/payment', { 
            state: { 
               clientSecret: data.clientSecret, 
               purchaseId: data.groupId // Using groupId as purchaseId for compatibility
            } 
         });
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
      
      const { data: refreshedInstructorData } = await supabase
         .from('appointments')
         .select('start_time, status, student_id')
         .eq('instructor_id', instructor.id)
         .eq('date', dateKey)
         .not('status', 'in', '("cancelled","failed","rejected","expired")');
         
      const { data: refreshedStudentData } = await supabase
         .from('appointments')
         .select('start_time, status, instructor_id')
         .eq('student_id', session?.user?.id)
         .eq('date', dateKey)
         .not('status', 'in', '("cancelled","failed","rejected","expired")');

      const busySlotsSet = new Set<string>();
      if (refreshedInstructorData) {
          refreshedInstructorData.forEach(apt => {
              if ((apt.status === 'awaiting_payment' || apt.status === 'reserved') && apt.student_id === session?.user?.id) {
                  return;
              }
              busySlotsSet.add(apt.start_time.substring(0, 5));
          });
      }
      if (refreshedStudentData) {
          refreshedStudentData.forEach(apt => {
              if (apt.instructor_id === instructor.id && (apt.status === 'awaiting_payment' || apt.status === 'reserved')) {
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
      const dates = selectedSlots.map(s => s.date);
      const times = selectedSlots.map(s => s.time);
      
      try {
        await supabase
          .from('appointments')
          .update({
            status: 'failed',
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
    
    const time = selectedSlots[0]?.time || 'agora';
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
      // We need an appointment_id to link the review. 
      // We can fetch the most recent completed appointment.
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

      const { error } = await supabase
        .from('reviews')
        .upsert({
          appointment_id: latestApt.id,
          student_id: session.user.id,
          instructor_id: instructor.id,
          rating: reviewRating,
          comment: reviewComment
        }, { onConflict: 'student_id,instructor_id' });

      if (error) throw error;

      addToast("Avaliação salva com sucesso!", "success");
      setIsSubmitReviewModalOpen(false);
      
      // Update local state to reflect the new review
      setExistingReview({
        rating: reviewRating,
        comment: reviewComment
      });

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
        setInstructor(prev => prev ? { ...prev, reviews: reviewsData } : null);
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
        <div className="px-6 pt-6 pb-4 bg-white">
          <div className="flex justify-between items-start w-full">
            <div className="flex items-start flex-1 min-w-0">
              {/* Avatar */}
              <div 
                onClick={() => instructor.photoUrl && setIsPhotoModalOpen(true)}
                className={`relative w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center text-2xl border-2 border-gray-50 flex-shrink-0 mr-4 text-gray-400 overflow-hidden shadow-sm ${instructor.photoUrl ? 'cursor-pointer hover:scale-105 transition-transform group' : ''}`}
              >
                {instructor.photoUrl ? (
                    <>
                      <img src={instructor.photoUrl} alt={instructor.name} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <svg className="w-5 h-5 text-white drop-shadow-md" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                        </svg>
                      </div>
                    </>
                ) : (
                    "👤"
                )}
              </div>
              
              {/* Name & ID & Stats */}
              <div className="flex flex-col min-w-0 pr-2 pt-0.5">
                <div className="flex items-center space-x-2 mb-0.5">
                  <h1 className="font-bold text-gray-900 text-xl leading-tight truncate">
                    {instructor.name}
                  </h1>
                  {instructor.publicId && (
                    <span className="bg-blue-50 text-blue-600 text-[10px] font-bold px-2 py-0.5 rounded-full border border-blue-100 flex-shrink-0">
                      ID: {instructor.publicId}
                    </span>
                  )}
                </div>
                
                {/* Rating & Lessons */}
                <div className="flex items-center text-xs text-gray-500 mt-1">
                  <button 
                    onClick={handleOpenReviews}
                    disabled={instructor.reviews.length === 0}
                    className={`group flex items-center transition-colors ${instructor.reviews.length > 0 ? 'hover:text-gray-800 cursor-pointer' : 'cursor-default'}`}
                  >
                    <span className="text-yellow-400 mr-1">⭐</span>
                    <span className="font-medium text-gray-700">{instructor.rating}</span>
                    <span className={`ml-1 ${instructor.reviews.length > 0 ? 'underline decoration-gray-300 underline-offset-2 group-hover:decoration-gray-500' : ''}`}>
                      ({instructor.reviewsCount} avaliações)
                    </span>
                    {instructor.reviews.length > 0 && (
                      <svg className="w-3 h-3 ml-0.5 text-gray-400 group-hover:text-gray-800" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                  </button>
                  <span className="mx-2 text-gray-300">•</span>
                  <span className="flex items-center">
                    <span className="mr-1">🎓</span>
                    <span>{instructor.lessonsTaught}+ aulas</span>
                  </span>
                </div>
              </div>
            </div>

            {/* WhatsApp Button */}
            {instructor.whatsapp && (
              <button
                onClick={openWhatsApp}
                className="flex items-center justify-center w-10 h-10 bg-green-50 border border-green-100 rounded-full hover:bg-green-100 transition-colors active:scale-95 text-green-600 flex-shrink-0 ml-2"
                title="Contato via WhatsApp"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                   <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </button>
            )}
          </div>

          {/* Location */}
          <div className="mt-5 space-y-1.5">
            <div className="flex items-center text-sm text-gray-600">
              <svg className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="font-medium">{instructor.city}</span>
            </div>
            {instructor.defaultLocation && (
              <div className="flex items-start text-xs text-gray-500 pl-6">
                <span className="truncate">Ponto de encontro: {instructor.defaultLocation}</span>
              </div>
            )}
          </div>

          {/* Tags (Category, Vehicles, Credential) */}
          <div className="flex flex-wrap gap-2 mt-4">
            <span className="inline-flex items-center px-2 py-1 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold uppercase tracking-wide">
              {instructor.category === 'AB' ? 'Categoria A/B' : `Categoria ${instructor.category}`}
            </span>
            
            {instructor.vehicles?.map((v, idx) => (
              <span key={idx} className="inline-flex items-center px-2 py-1 rounded bg-gray-50 text-gray-600 text-[10px] font-medium border border-gray-100">
                {v.type === 'car' ? '🚘' : '🏍️'} {v.model || (v.type === 'car' ? 'Carro' : 'Moto')}
              </span>
            ))}

            {instructor.credential && instructor.credential !== 'N/A' && (
              <span className="inline-flex items-center px-2 py-1 rounded bg-gray-50 text-gray-500 text-[10px] font-medium border border-gray-100">
                <svg className="w-3.5 h-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
                </svg>
                Credencial: {instructor.credential}
              </span>
            )}
          </div>

          {/* Pricing Bar */}
          <div className="mt-5 bg-gray-50 rounded-xl p-3 border border-gray-100 flex items-center justify-between">
            <div className="flex items-center">
              <span className="text-lg mr-2">💰</span>
              <div className="flex flex-col">
                <span className="text-sm font-bold text-gray-900">{formatCurrency(currentDisplayPrices.day)} <span className="text-xs font-normal text-gray-500">/ aula</span></span>
              </div>
            </div>
            {instructor.hasNightLessons && (
              <div className="flex items-center pl-4 border-l border-gray-200">
                <span className="text-lg mr-2">🌙</span>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Noturno:</span>
                  <span className="text-sm font-bold text-gray-900">{formatCurrency(currentDisplayPrices.night)}</span>
                </div>
              </div>
            )}
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
        <div className="h-2 bg-gray-50 border-y border-gray-100"></div>

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
                   Selecione a categoria acima para ver os preços e liberar os horários.
                </p>
             )}
          </div>
        )}

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

           <div className="flex items-center justify-between space-x-2 pb-4">
              <button onClick={handlePrevRange} className="p-2 text-gray-400 hover:text-blue-600 rounded-full hover:bg-gray-50 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <div className="flex-1 flex justify-between items-center space-x-1">
                  {weekDays.map((date, index) => {
                      const isSelected = date.toDateString() === selectedDate.toDateString();
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const isToday = today.toDateString() === date.toDateString();
                      
                      // Disable if date is past maxBookingDate OR if date is in the past (before today)
                      const isDisabled = date > maxBookingDate || date < today;

                      return (
                      <button
                          key={index}
                          onClick={() => !isDisabled && handleDayClick(date)}
                          disabled={isDisabled}
                          className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl flex-1 transition-all duration-200 
                          ${isSelected ? 'bg-blue-600 text-white shadow-md transform scale-105' : isDisabled ? 'bg-gray-50 opacity-40 cursor-not-allowed' : 'bg-transparent text-gray-500 hover:bg-gray-50'}
                          `}
                      >
                          <span className={`text-[10px] font-medium uppercase ${isSelected ? 'text-blue-100' : isDisabled ? 'text-gray-300' : 'text-gray-400'}`}>{getDayLabel(date)}</span>
                          <span className={`text-sm font-bold leading-none mt-0.5 ${isSelected ? 'text-white' : isDisabled ? 'text-gray-300' : 'text-gray-700'}`}>{date.getDate()}</span>
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

                const isDisabled = !isAvailable || isPastTime || (limits.isDailyLimitReached && !isSelected);

                return (
                  <button
                    key={time}
                    onClick={() => toggleSlot(time)}
                    disabled={isDisabled}
                    className={`
                      py-2 rounded-lg text-sm font-medium transition-all duration-200 relative
                      ${isSelected 
                        ? 'bg-blue-600 text-white shadow-md transform scale-105 z-10' 
                        : !isDisabled 
                          ? 'bg-white text-gray-700 border border-gray-200 hover:border-blue-300 hover:bg-blue-50' 
                          : 'bg-gray-50 text-gray-300 cursor-not-allowed border border-transparent'
                      }
                    `}
                  >
                    {time}
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

        <div className="h-2 bg-gray-50"></div>

        <div className="px-6 py-6 space-y-4 pb-12">
          <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Promoções deste instrutor</h2>
          
          {instructor.discounts.length === 0 ? (
             <div className="text-center py-6 bg-gray-50 rounded-xl border border-gray-100 border-dashed">
                <p className="text-gray-400 text-sm">Nenhuma promoção ativa no momento.</p>
             </div>
          ) : (
             <div className="space-y-3">
                {instructor.discounts.map((rule) => (
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
                         </div>
                      </div>
                      <div className="text-green-600 font-bold text-xs bg-white px-2 py-1 rounded-md border border-green-100 shadow-sm">
                         Automático
                      </div>
                   </div>
                ))}
             </div>
          )}
        </div>

      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-gray-100 sm:max-w-md sm:mx-auto z-20">
        <Button 
          fullWidth 
          onClick={handleBook} 
          disabled={selectedSlots.length === 0 || !selectedLessonCategory || isProcessingPayment || isSuccess}
          className={`shadow-lg transition-all duration-300 ${
            isSuccess 
              ? 'bg-green-600 hover:bg-green-700 border-transparent text-white shadow-green-200' 
              : (selectedSlots.length === 0 || !selectedLessonCategory || isProcessingPayment) 
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
            : selectedSlots.length > 0 
                  ? `Pagar ${selectedSlots.length} ${selectedSlots.length === 1 ? 'aula' : 'aulas'} — ${formatCurrency(totalPrice)}`
                  : 'Selecione um horário'
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
            <button
              onClick={handleWhatsAppContact}
              className="w-full bg-[#25D366] hover:bg-[#128C7E] text-white py-3 px-4 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
              Falar com o instrutor no WhatsApp
            </button>
            <button
              onClick={() => {
                setIsTooCloseModalOpen(false);
                setSelectedSlots([]);
              }}
              className="w-full bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 py-3 px-4 rounded-xl font-medium transition-colors"
            >
              Escolher outro horário
            </button>
          </div>
        }
      >
        <p className="text-gray-600">
          Esse horário está muito próximo para agendamento automático. Você pode tentar falar diretamente com o instrutor para verificar se ele ainda pode atender.
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

    </div>
  );
};
