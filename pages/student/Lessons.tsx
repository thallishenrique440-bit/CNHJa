import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { StudentBottomNav } from '../../components/StudentBottomNav';
import { Button } from '../../components/Button';
import { DateSelector } from '../../components/DateSelector';
import { Modal } from '../../components/Modal';
import { supabase } from '../../lib/supabase';
import { invokeSecureFunction } from '../../lib/functions';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { getDerivedStatus, LessonDisplayStatus } from '../../lib/lessonStatus';
import { getGoogleMapsUrl } from '../../src/utils/maps';

// --- Types ---
type LessonStatus = LessonDisplayStatus;

interface Lesson {
  id: string;
  instructorName: string;
  instructorId: string;
  instructorPhoto?: string;
  instructorWhatsapp?: string;
  vehicleModel?: string;
  date: Date;
  dateStr: string;
  time: string;
  endTime: string;
  status: LessonStatus;
  dbStatus: string;
  price: number;
  location: string;
  lat?: number | null;
  lng?: number | null;
  placeId?: string | null;
  lessonCategory: 'A' | 'B';
  isReviewed?: boolean; 
  rescheduleRequestedAt?: Date | null;
  rescheduledAt?: Date | null;
}

interface DBAppointment {
  id: string;
  date: string;
  start_time: string;
  end_time: string | null;
  status: string;
  price: number;
  category: string;
  instructor_id: string;
  reschedule_requested_at: string | null;
  rescheduled_at: string | null;
  cancelled_reason: string | null;
  instructors: {
    whatsapp: string;
    meeting_point: string;
    meeting_point_lat: number | null;
    meeting_point_lng: number | null;
    meeting_point_place_id: string | null;
    profiles: {
      full_name: string;
      avatar_url: string;
      experience_level: string;
      cnh_process_type: string;
    };
    instructor_vehicles: {
      type: string;
      model: string;
    }[];
  };
  reviews: { id: string }[];
}

interface LessonGroup extends Omit<Lesson, 'id' | 'price' | 'endTime'> {
    ids: string[];
    totalPrice: number;
    endTime: string;
    count: number;
}

// --- Helpers ---
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

export const StudentLessons: React.FC = () => {
  const navigate = useNavigate();
  const { session, signOut, serverTimeOffset } = useAuth();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  
  // Security Profile Data
  const [trustedContact, setTrustedContact] = useState<string | null>(null);
  
  const [selectedDate, setSelectedDate] = useState(new Date());
  
  // Finalization Flow State
  const [finalizingLessonGroup, setFinalizingLessonGroup] = useState<LessonGroup | null>(null);
  const [flowStep, setFlowStep] = useState<'rating' | 'tip' | 'success' | null>(null);
  const [isAutoModal, setIsAutoModal] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [shouldCreateReview, setShouldCreateReview] = useState(false);
  const processingFinalizationRef = React.useRef(false);

  // Cancellation Flow State
  const [lessonToCancel, setLessonToCancel] = useState<LessonGroup | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  // Rescheduling Flow State
  const [lessonForAction, setLessonForAction] = useState<LessonGroup | null>(null);
  const [lessonToReschedule, setLessonToReschedule] = useState<LessonGroup | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState(new Date());
  const [rescheduleTime, setRescheduleTime] = useState<string | null>(null);
  const [rescheduleBusySlots, setRescheduleBusySlots] = useState<string[]>([]);
  const [instructorConfig, setInstructorConfig] = useState<{ hasNight: boolean, workSat: boolean } | null>(null);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(false);

  // Tip Flow State
  const [selectedTip, setSelectedTip] = useState<number | null>(20); // Default to 20 as suggested
  const [customTip, setCustomTip] = useState('');
  const [isSubmittingTip, setIsSubmittingTip] = useState(false);
  const [tipClientSecret, setTipClientSecret] = useState<string | null>(null);
  const [tipPaymentData, setTipPaymentData] = useState<{
    paymentId: string;
    invoiceUrl: string;
    qrCodeImage: string;
    copiaColaCode: string;
    amount: number;
  } | null>(null);
  const [tipGiven, setTipGiven] = useState(false);

  // Security Flow State
  // (isLocating state removed as GPS/geolocation captures are no longer needed)

  // Pending Review State
  const [pendingReviewAptId, setPendingReviewAptId] = useState<string | null>(null);
  const hasPromptedReview = React.useRef(false);

  const [rawLessons, setRawLessons] = useState<DBAppointment[]>([]);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [processingStartTimes, setProcessingStartTimes] = useState<Record<string, number>>({});
  const [showVerifyButton, setShowVerifyButton] = useState<Record<string, boolean>>({});
  const [hasAutoRefreshed, setHasAutoRefreshed] = useState<Record<string, boolean>>({});

  // --- DERIVE LESSONS FROM RAW DATA ---
  const lessons = useMemo(() => {
    const now = new Date(Date.now() + serverTimeOffset);
    
    return rawLessons.map((apt): Lesson | null => {
      // Exclude expired lessons or technical cancellations (user_retry_new_attempt, system_cleanup_expired, stripe_creation_failed)
      const isTechnicalCancelled = 
        apt.status === 'cancelled' && 
        (apt.cancelled_reason === 'user_retry_new_attempt' || 
         apt.cancelled_reason === 'system_cleanup_expired' || 
         apt.cancelled_reason === 'stripe_creation_failed');

      if (apt.status === 'expired' || isTechnicalCancelled) {
        return null;
      }

      try {
        const [year, month, day] = apt.date.split('-').map(Number);
        const [hours, minutes] = apt.start_time.split(':').map(Number);
        const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        
        const endTimeStr = apt.end_time 
          ? apt.end_time.substring(0, 5) 
          : addMinutesToTime(timeStr, 50);

        const lessonDate = new Date(year, month - 1, day);
        
        const displayStatus = getDerivedStatus(
          apt.status,
          apt.date,
          apt.start_time,
          apt.end_time || addMinutesToTime(apt.start_time, 50),
          now
        );
        
        const hasReview = apt.reviews && apt.reviews.length > 0;
        const instructorData = apt.instructors;
        const category = apt.category as 'A' | 'B';
        
        let vehicleModel = undefined;
        if (instructorData?.instructor_vehicles) {
            if (category === 'B') {
                const car = instructorData.instructor_vehicles.find((v) => v.type === 'car');
                if (car) vehicleModel = car.model;
            } else if (category === 'A') {
                const bike = instructorData.instructor_vehicles.find((v) => v.type === 'bike');
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
          lat: instructorData?.meeting_point_lat,
          lng: instructorData?.meeting_point_lng,
          placeId: instructorData?.meeting_point_place_id,
          date: lessonDate,
          dateStr: apt.date,
          time: timeStr,
          endTime: endTimeStr,
          status: displayStatus,
          dbStatus: apt.status,
          price: apt.price,
          lessonCategory: category,
          isReviewed: hasReview,
          rescheduleRequestedAt: apt.reschedule_requested_at ? new Date(apt.reschedule_requested_at) : null,
          rescheduledAt: apt.rescheduled_at ? new Date(apt.rescheduled_at) : null
        };
      } catch (mapErr) {
        console.error('Error mapping individual lesson:', apt.id, mapErr);
        return null;
      }
    }).filter((l): l is Lesson => l !== null);
  }, [rawLessons, serverTimeOffset, refreshCounter]);

  // --- AUTO-REFRESH TIMER ---
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshCounter(prev => prev + 1);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

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
    if (!loading && lessons.length > 0 && !hasPromptedReview.current && !flowStep) {
      // Find all lessons that are "awaiting_completion"
      const awaitingLessons = lessons.filter(l => l.status === 'awaiting_completion');
      
      // Only auto-open if there is exactly ONE pending lesson
      if (awaitingLessons.length === 1) {
        hasPromptedReview.current = true;
        const apt = awaitingLessons[0];
        
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
          dateStr: apt.dateStr,
          time: apt.time,
          status: apt.status,
          dbStatus: apt.dbStatus,
          location: apt.location,
          lessonCategory: apt.lessonCategory,
          isReviewed: apt.isReviewed,
          rescheduleRequestedAt: apt.rescheduleRequestedAt,
          rescheduledAt: apt.rescheduledAt
        };
        setIsAutoModal(true);
        startFinalization(group);
      }
    }
  }, [loading, lessons, flowStep]);

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
            end_time,
            status,
            price,
            category,
            instructor_id,
            reschedule_requested_at,
            rescheduled_at,
            cancelled_reason,
            instructors (
              whatsapp,
              meeting_point,
              meeting_point_lat,
              meeting_point_lng,
              meeting_point_place_id,
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
          setRawLessons(data as unknown as DBAppointment[]);
        }
      } catch (err: any) {
        console.error('Error fetching lessons:', err);
        addToast('Erro ao carregar suas aulas. Tente novamente.', 'error');
      } finally {
        setLoading(false);
      }
    };

    fetchLessons();

    const interval = setInterval(fetchLessons, 60000);
    return () => clearInterval(interval);

  }, [session, selectedDate, refreshCounter]);

  // --- DERIVE LESSONS FROM RAW DATA ---
  // (Removed duplicate useMemo block)

  // --- UX RESILIENCE FOR PROCESSING STATES ---
  useEffect(() => {
    const now = Date.now();
    const newStartTimes = { ...processingStartTimes };
    const newShowVerify = { ...showVerifyButton };
    const newAutoRefreshed = { ...hasAutoRefreshed };
    let changed = false;

    // Get all current processing group IDs
    const processingGroups = new Set(
      lessons
        .filter(l => l.status === 'reserved' || l.status === 'pending_approval')
        .map(l => l.id) // Using ID here as proxy for group if not grouped yet, but lessons are individual here
    );

    // Add new ones
    processingGroups.forEach(id => {
      if (!newStartTimes[id]) {
        newStartTimes[id] = now;
        changed = true;
      }
    });

    // Remove old ones
    Object.keys(newStartTimes).forEach(id => {
      if (!processingGroups.has(id)) {
        delete newStartTimes[id];
        delete newShowVerify[id];
        delete newAutoRefreshed[id];
        changed = true;
      }
    });

    if (changed) {
      setProcessingStartTimes(newStartTimes);
      setShowVerifyButton(newShowVerify);
      setHasAutoRefreshed(newAutoRefreshed);
    }
  }, [lessons]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const newShowVerify = { ...showVerifyButton };
      const newAutoRefreshed = { ...hasAutoRefreshed };

      Object.entries(processingStartTimes).forEach(([id, startTime]) => {
        const elapsed = now - startTime;
        
        // Auto-refresh at 10s
        if (elapsed >= 10000 && !newAutoRefreshed[id]) {
          console.log(`[UX Resilience] Auto-refreshing for ${id}...`);
          // We can't easily call fetchLessons here without moving it out of useEffect or using a ref
          // But we can trigger a refresh by updating a dummy state or calling a ref-stored function
          window.dispatchEvent(new CustomEvent('refresh-lessons'));
          newAutoRefreshed[id] = true;
          changed = true;
        }

        // Show button at 12s
        if (elapsed >= 12000 && !newShowVerify[id]) {
          newShowVerify[id] = true;
          changed = true;
        }
      });

      if (changed) {
        setShowVerifyButton(newShowVerify);
        setHasAutoRefreshed(newAutoRefreshed);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [processingStartTimes, showVerifyButton, hasAutoRefreshed]);

  // Listener for auto-refresh
  useEffect(() => {
    const handleRefresh = () => {
      setRefreshCounter(prev => prev + 1);
    };
    window.addEventListener('refresh-lessons', handleRefresh);
    return () => window.removeEventListener('refresh-lessons', handleRefresh);
  }, []);

  // Fetch Student Profile for Security Features
  useEffect(() => {
    if (!session?.user) return;

    const fetchProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('trusted_contact')
          .eq('id', session.user.id)
          .single();

        if (error) throw error;

        if (data) {
          setTrustedContact(data.trusted_contact);
        }
      } catch (error) {
        console.error('Error fetching profile for security:', error);
      }
    };

    fetchProfile();
  }, [session]);

  // Poll for tip payment confirmation automatically
  useEffect(() => {
    if (!tipPaymentData || !finalizingLessonGroup) return;

    let isActive = true;
    let isQueryPending = false;

    const intervalId = setInterval(async () => {
      if (!isActive) return;
      if (isQueryPending) {
        console.log('[Polling] A query is already pending, skipping this interval tick.');
        return;
      }

      isQueryPending = true;
      try {
        const appointmentId = finalizingLessonGroup.ids[finalizingLessonGroup.ids.length - 1];
        const { data, error } = await supabase
          .from('transactions')
          .select('status')
          .eq('appointment_id', appointmentId)
          .eq('type', 'tip')
          .eq('status', 'completed')
          .maybeSingle();

        if (error) {
          console.error('Error polling tip transaction:', error);
          return;
        }

        if (!isActive) return;

        if (data) {
          console.log('🎉 Caixinha confirmed on database! Auto-completing modal...');
          isActive = false; // Intercept further executions immediately
          clearInterval(intervalId);
          completeLessonFlow(tipPaymentData.amount);
        }
      } catch (err) {
        console.error('Error in caixinha polling interval:', err);
      } finally {
        isQueryPending = false;
      }
    }, 3000); // Check every 3 seconds

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [tipPaymentData, finalizingLessonGroup]);

  const startFinalization = async (group: LessonGroup) => {
    if (!session?.user?.id) return;
    setFinalizingLessonGroup(group);
    setRating(0);
    setComment('');
    setSelectedTip(10); // Default to 10
    setCustomTip('');
    setIsSubmittingTip(false);
    setTipClientSecret(null);

    // Fonte Única de Verdade: Check if already reviewed this instructor in memory
    const hasAlreadyReviewed = lessons.some(
      (l) => l.instructorId === group.instructorId && l.isReviewed
    );

    if (hasAlreadyReviewed) {
      setShouldCreateReview(false);
      setFlowStep('tip');
    } else {
      setShouldCreateReview(true);
      setFlowStep('rating');
    }
  };

  const submitRating = async () => {
    if (isFinalizing) return;
    
    if (rating >= 4) {
      setFlowStep('tip');
    } else {
      // If rating is low, skip tip and finish
      await completeLessonFlow(0);
    }
  };

  const handleTipPayment = async (amount: number) => {
    if (!finalizingLessonGroup || !session?.user || amount < 1) return;
    
    setIsSubmittingTip(true);
    try {
      // 1. Create PIX Charge via Edge Function
      const { data, error } = await invokeSecureFunction('create-tip', {
        body: {
          appointment_id: finalizingLessonGroup.ids[finalizingLessonGroup.ids.length - 1],
          amount: Math.round(amount * 100) // Convert to cents
        }
      });

      if (error) {
        if (error.message === 'SESSION_EXPIRED') {
          addToast("Sessão expirada. Por favor, entre novamente.", 'error');
          signOut();
          return;
        }
        throw error;
      }
      if (!data?.qrCodeImage) throw new Error('Falha ao gerar PIX para caixinha.');

      // 2. Set payment data to show PIX details
      setTipPaymentData({
        paymentId: data.paymentId,
        invoiceUrl: data.invoiceUrl,
        qrCodeImage: data.qrCodeImage,
        copiaColaCode: data.copiaColaCode,
        amount: data.amount
      });
      // Set this to non-null so that the outer modal switches steps
      setTipClientSecret(data.paymentId);
    } catch (err: any) {
      console.error("Error creating tip PIX:", err);
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
    if (processingFinalizationRef.current) {
      console.log('[Lock] completeLessonFlow already running (synchronous ref lock).');
      return;
    }
    processingFinalizationRef.current = true;
    setIsFinalizing(true);
    setIsSubmittingTip(true);
    if (tipAmount > 0) setTipGiven(true);
    
    const lessonIds = finalizingLessonGroup.ids;
    // We attach the review/tip to the LAST lesson in the group for simplicity in this MVP
    const mainReferenceId = lessonIds[lessonIds.length - 1]; 

    try {
       // 1. Create Review (ONLY if rating > 0)
       if (shouldCreateReview && rating > 0) {
         const reviewData: any = {
           appointment_id: mainReferenceId,
           student_id: session.user.id,
           instructor_id: finalizingLessonGroup.instructorId,
           rating: rating,
           comment: comment
         };

         const { error: reviewError } = await supabase
           .from('reviews')
           .insert(reviewData);
         
         if (reviewError) {
           const isDuplicate = reviewError.code === '23505' || 
                              (reviewError.message && reviewError.message.toLowerCase().includes('duplicate key')) ||
                              (reviewError.message && reviewError.message.toLowerCase().includes('already exists'));
           
           if (isDuplicate) {
             console.log('[Idempotency] Review already exists (duplicate key). Treating as success.');
           } else {
             throw reviewError;
           }
         }
       }

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
       setRawLessons(prev => prev.map(l => 
          lessonIds.includes(l.id)
             ? { ...l, reviews: (shouldCreateReview && rating > 0) ? [{ id: 'new' }] : [], status: 'completed' } 
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
        setIsFinalizing(false);
        processingFinalizationRef.current = false;
    }
  };

  // --- CANCELLATION LOGIC START ---
  const handleCancelClick = (group: LessonGroup) => {
    const now = new Date(Date.now() + serverTimeOffset);
    // Parse start time "HH:MM"
    const [h, m] = group.time.split(':').map(Number);
    const lessonStart = new Date(group.date);
    lessonStart.setHours(h, m, 0, 0);

    // CRITICAL: Block if already started or passed
    if (now >= lessonStart) {
      addToast("Não é possível cancelar aulas que já começaram ou passaram.", "warning");
      return;
    }

    // 1. Pending: Always allow cancel (if not passed)
    if (group.status === 'pending') {
      setLessonToCancel(group);
      return;
    }

    // 2. Scheduled: Check 24h rule
    const diffMs = lessonStart.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 24) {
      // BLOCK: Educational Toast
      addToast("Faltam menos de 24h. Para cancelar, contate seu instrutor diretamente pelo WhatsApp.", "warning");
      
      if (group.instructorWhatsapp) {
         // Offer to open WhatsApp
         const clean = group.instructorWhatsapp.replace(/\D/g, '');
         const full = clean.startsWith('55') ? clean : `55${clean}`;
         const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(group.date);
         const msg = encodeURIComponent(`Olá, preciso cancelar minha aula do dia ${dateStr} às ${group.time}, mas o app não permite com menos de 24h. Podemos conversar?`);
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

  // --- REQUEST RESCHEDULE (<24h) ---
  const [isRequestingReschedule, setIsRequestingReschedule] = useState(false);
  const requestReschedule = async (group: LessonGroup) => {
    if (!session?.user) return;
    setIsRequestingReschedule(true);
    try {
      const { error } = await supabase
        .from('appointments')
        .update({ reschedule_requested_at: new Date().toISOString() })
        .in('id', group.ids);

      if (error) throw error;

      addToast("Solicitação enviada! O instrutor foi notificado.", "success");
      setLessonForAction(null);
      
      // Refresh lessons
      const { data: updatedData } = await supabase
        .from('appointments')
        .select('id, reschedule_requested_at')
        .in('id', group.ids);
      
      if (updatedData) {
        setRawLessons(prev => prev.map(l => {
          const updated = updatedData.find(u => u.id === l.id);
          if (updated) return { ...l, reschedule_requested_at: updated.reschedule_requested_at };
          return l;
        }));
      }
    } catch (err) {
      console.error("Error requesting reschedule:", err);
      addToast("Erro ao enviar solicitação. Tente novamente.", "error");
    } finally {
      setIsRequestingReschedule(false);
    }
  };

  // --- ACTION CLICK (DECISION MODAL) ---
  const handleActionClick = (group: LessonGroup) => {
    const now = new Date(Date.now() + serverTimeOffset);
    const [h, m] = group.time.split(':').map(Number);
    const lessonStart = new Date(group.date);
    lessonStart.setHours(h, m, 0, 0);

    if (now >= lessonStart) {
      addToast("Não é possível alterar aulas que já começaram ou passaram.", "warning");
      return;
    }

    setLessonForAction(group);
  };

  // --- FETCH AVAILABILITY FOR RESCHEDULING ---
  useEffect(() => {
    if (!lessonToReschedule || !session?.user) return;

    const fetchRescheduleAvailability = async () => {
      setIsLoadingAvailability(true);
      const dateKey = rescheduleDate.toISOString().split('T')[0];
      
      try {
        // Fetch instructor config if not already fetched
        if (!instructorConfig) {
          const { data: instData } = await supabase
            .from('instructors')
            .select('has_night_lessons, work_saturday_afternoon')
            .eq('id', lessonToReschedule.instructorId)
            .single();
          
          if (instData) {
            setInstructorConfig({
              hasNight: !!instData.has_night_lessons,
              workSat: !!instData.work_saturday_afternoon
            });
          }
        }

        // Fetch busy slots
        const { data: instructorData } = await supabase
          .from('appointments')
          .select('id, start_time, status, student_id')
          .eq('instructor_id', lessonToReschedule.instructorId)
          .eq('date', dateKey)
          .in('status', ['pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment']);

        const { data: studentData } = await supabase
          .from('appointments')
          .select('id, start_time, status, instructor_id')
          .eq('student_id', session.user.id)
          .eq('date', dateKey)
          .in('status', ['pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment']);

        const busySlotsSet = new Set<string>();
        if (instructorData) {
          instructorData.forEach(apt => {
            // Don't mark as busy if it's one of the appointments we are rescheduling
            if (lessonToReschedule.ids.includes(apt.id)) return;
            busySlotsSet.add(apt.start_time.substring(0, 5));
          });
        }
        if (studentData) {
          studentData.forEach(apt => {
            if (lessonToReschedule.ids.includes(apt.id)) return;
            busySlotsSet.add(apt.start_time.substring(0, 5));
          });
        }

        setRescheduleBusySlots(Array.from(busySlotsSet));
      } catch (err) {
        console.error("Error fetching reschedule availability:", err);
      } finally {
        setIsLoadingAvailability(false);
      }
    };

    fetchRescheduleAvailability();
  }, [rescheduleDate, lessonToReschedule, session]);

  const confirmReschedule = async () => {
    if (!lessonToReschedule || !rescheduleTime) return;
    setIsRescheduling(true);

    try {
      const dateKey = rescheduleDate.toISOString().split('T')[0];
      
      // 1. Double check past time
      const now = new Date(Date.now() + serverTimeOffset);
      const slotDate = new Date(`${dateKey}T${rescheduleTime}:00-03:00`);
      
      if (slotDate <= now) {
        throw new Error("Não é possível reagendar para um horário no passado.");
      }

      // 2. Double check availability
      const { data: conflict } = await supabase
        .from('appointments')
        .select('id')
        .eq('instructor_id', lessonToReschedule.instructorId)
        .eq('date', dateKey)
        .eq('start_time', rescheduleTime)
        .in('status', ['pending', 'pending_approval', 'confirmed', 'scheduled', 'reserved', 'awaiting_payment'])
        .not('id', 'in', `(${lessonToReschedule.ids.join(',')})`)
        .maybeSingle();

      if (conflict) {
        throw new Error("Este horário já foi ocupado. Por favor, escolha outro.");
      }
      
      // If it's a group, we need to update all appointments in sequence
      // For simplicity, we'll assume they are back-to-back 50min slots
      const updates = lessonToReschedule.ids.map((id, index) => {
        const [h, m] = rescheduleTime.split(':').map(Number);
        const startTime = new Date(rescheduleDate);
        startTime.setHours(h, m + (index * 50), 0, 0);
        const startTimeStr = `${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')}:00`;
        
        const endTime = new Date(rescheduleDate);
        endTime.setHours(h, m + ((index + 1) * 50), 0, 0);
        const endTimeStr = `${String(endTime.getHours()).padStart(2, '0')}:${String(endTime.getMinutes()).padStart(2, '0')}:00`;

        return supabase
          .from('appointments')
          .update({
            date: dateKey,
            start_time: startTimeStr,
            end_time: endTimeStr,
            status: 'pending_approval',
            updated_at: new Date().toISOString()
          })
          .eq('id', id);
      });

      const results = await Promise.all(updates);
      const error = results.find(r => r.error)?.error;
      if (error) {
        const isConflict = 
          error.code === '23505' || 
          error.message?.toLowerCase().includes('duplicate') || 
          error.message?.toLowerCase().includes('unique');

        if (isConflict) {
          throw new Error("Este horário já foi ocupado. Por favor, escolha outro.");
        }
        throw error;
      }

      addToast("Aula reagendada com sucesso! Aguarde a aprovação do instrutor.", "success");
      setLessonToReschedule(null);
      setRescheduleTime(null);
      
      // Refresh lessons
      window.location.reload(); // Simple way to refresh everything

    } catch (err: any) {
      console.error("Error rescheduling:", err);
      addToast("Erro ao reagendar: " + err.message, "error");
    } finally {
      setIsRescheduling(false);
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
      setRawLessons(prev => prev.filter(l => !lessonToCancel.ids.includes(l.id)));
      
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
    setTipPaymentData(null);
    setTipGiven(false);
    setIsAutoModal(false);
    setRating(0);
    setComment('');
    setShouldCreateReview(false);
  };

  const handleSecurityClick = () => {
    // Use state data instead of localStorage
    const contact = trustedContact || '';
    const cleanContact = contact.replace(/\D/g, '');

    if (!cleanContact) {
        addToast("Você precisa cadastrar um contato de confiança no seu Perfil primeiro.", 'warning');
        navigate('/student/profile');
        return;
    }

    const text = `Olá!\n\nEstou em uma aula pelo CNHJá.\n\nVou compartilhar minha localização em tempo real pelo WhatsApp para que você possa acompanhar meu deslocamento com segurança.`;
    const encodedText = encodeURIComponent(text);
    
    // Ensure country code
    const fullContact = cleanContact.startsWith('55') ? cleanContact : `55${cleanContact}`;
    
    const waLink = `https://wa.me/${fullContact}?text=${encodedText}`;
    window.open(waLink, '_blank');

    addToast("Compartilhe sua Localização em tempo real pelo WhatsApp.", 'info');
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
        dateStr: daily[0].dateStr,
        time: daily[0].time,
        status: daily[0].status,
        dbStatus: daily[0].dbStatus,
        location: daily[0].location,
        lat: daily[0].lat,
        lng: daily[0].lng,
        placeId: daily[0].placeId,
        lessonCategory: daily[0].lessonCategory,
        isReviewed: daily[0].isReviewed,
        rescheduleRequestedAt: daily[0].rescheduleRequestedAt,
        rescheduledAt: daily[0].rescheduledAt
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
                dateStr: next.dateStr,
                time: next.time,
                status: next.status,
                dbStatus: next.dbStatus,
                location: next.location,
                lat: next.lat,
                lng: next.lng,
                placeId: next.placeId,
                lessonCategory: next.lessonCategory,
                isReviewed: next.isReviewed,
                rescheduleRequestedAt: next.rescheduleRequestedAt,
                rescheduledAt: next.rescheduledAt
            };
        }
    }
    groups.push(currentGroup);

    return groups.sort((a, b) => {
      const getWeight = (s: LessonStatus) => {
        if (s === 'in_progress') return 1;
        if (s === 'confirmed' || s === 'pending') return 2;
        return 3;
      };
      const wA = getWeight(a.status);
      const wB = getWeight(b.status);
      if (wA !== wB) return wA - wB;
      return a.time.localeCompare(b.time);
    });
  }, [lessons, selectedDate]);

  const renderStatusBadge = (status: LessonStatus, groupId?: string) => {
    switch (status) {
      case 'confirmed': 
         return <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">Agendada</span>;
      case 'reserved':
      case 'awaiting_payment':
      case 'pending_approval':
        return (
          <div className="flex flex-col items-end space-y-1">
            <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-100 animate-pulse">Processando...</span>
            {groupId && showVerifyButton[groupId] && (
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent('refresh-lessons'));
                }}
                className="text-[10px] font-bold text-blue-600 hover:text-blue-800 underline decoration-blue-300 underline-offset-2"
              >
                Verificar status
              </button>
            )}
          </div>
        );
      case 'pending': 
         return <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100">Aguardando</span>;
      case 'in_progress': 
        return <span className="text-xs font-bold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-100 animate-pulse">Em andamento</span>;
      case 'awaiting_completion':
        return <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-100">Aguardando finalização</span>;
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
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-gray-900">Minhas Aulas</h1>
          <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        </div>

        <DateSelector 
          selectedDate={selectedDate} 
          onDateSelect={setSelectedDate} 
          daysBefore={30} 
          daysAfter={30} 
        />
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
                    {group.rescheduleRequestedAt && (
                        <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full border border-amber-200 ml-1 animate-pulse">
                           Reagendamento solicitado
                        </span>
                    )}
                  </div>
                  
                  <div className="flex items-center">
                      {renderStatusBadge(group.status, group.ids[0])}
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
                    <a 
                      href={getGoogleMapsUrl({
                        address: group.location,
                        lat: group.lat,
                        lng: group.lng,
                        placeId: group.placeId
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center text-xs text-blue-600 hover:text-blue-700 transition-colors truncate pr-2 group/location"
                    >
                      <svg className="w-4 h-4 mr-1.5 text-blue-400 flex-shrink-0 group-hover/location:text-blue-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span className="truncate underline decoration-blue-200 underline-offset-2 group-hover/location:decoration-blue-400 transition-colors">
                        {group.location}
                      </span>
                    </a>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Action Button - Decision Modal */}
                        {(() => {
                            if (group.rescheduleRequestedAt) {
                                return (
                                    <span className="text-[10px] text-amber-600 font-medium italic">
                                        Aguardando instrutor...
                                    </span>
                                );
                            }

                            const isActionableStatus = group.dbStatus === 'confirmed' || group.dbStatus === 'scheduled' || group.dbStatus === 'pending_approval';
                            if (!isActionableStatus) return null;

                            const now = new Date(Date.now() + serverTimeOffset);
                            const [y, m, d] = group.dateStr.split('-').map(Number);
                            const [h, min] = group.time.split(':').map(Number);
                            const lessonStart = new Date(y, m - 1, d, h, min);

                            if (now < lessonStart) {
                                return (
                                    <Button 
                                      variant="outline"
                                      onClick={() => handleActionClick(group)}
                                      className="text-xs px-3 py-1.5 h-8 min-h-0 bg-white border-blue-200 text-blue-600 hover:bg-blue-50 hover:border-blue-300"
                                    >
                                      Remarcar / Cancelar
                                    </Button>
                                );
                            }
                            return null;
                        })()}

                        {/* WhatsApp Button */}
                        {group.instructorWhatsapp && (group.status === 'confirmed' || group.status === 'in_progress' || group.status === 'pending') && (
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
                        
                        {/* Finalize/Review Button */}
                        {(group.status === 'awaiting_completion' || (group.status === 'completed' && !group.isReviewed)) && (
                            <Button 
                            variant="primary" 
                            onClick={() => startFinalization(group)}
                            className="text-xs px-4 py-2 h-8 min-h-0 shadow-sm"
                            >
                            {group.status === 'completed' ? 'Avaliar aula' : 'Finalizar aula'}
                            </Button>
                        )}

                        {/* Location/Security Button */}
                        {group.status === 'in_progress' && (
                            <Button
                                onClick={handleSecurityClick}
                                className="bg-white text-gray-500 hover:text-gray-700 border-gray-200 shadow-none px-3 py-1.5 text-xs h-8 min-h-0 flex items-center gap-1.5"
                                variant="outline"
                            >
                                <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                Compartilhe sua localização
                            </Button>
                        )}
                    </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Decision Modal */}
      <Modal
        isOpen={!!lessonForAction}
        onClose={() => setLessonForAction(null)}
        title={(() => {
          if (!lessonForAction) return "";
          const now = new Date(Date.now() + serverTimeOffset);
          const [h, m] = lessonForAction.time.split(':').map(Number);
          const lessonStart = new Date(lessonForAction.date);
          lessonStart.setHours(h, m, 0, 0);
          const diffMs = lessonStart.getTime() - now.getTime();
          const diffHours = diffMs / (1000 * 60 * 60);
          
          if (diffHours < 24 && lessonForAction.status !== 'pending') {
            return "Solicitar reagendamento?";
          }
          return "Deseja cancelar ou remarcar sua aula?";
        })()}
        footer={null}
      >
        <div className="space-y-4 py-2">
          {(() => {
            if (!lessonForAction) return null;
            const now = new Date(Date.now() + serverTimeOffset);
            const [h, m] = lessonForAction.time.split(':').map(Number);
            const lessonStart = new Date(lessonForAction.date);
            lessonStart.setHours(h, m, 0, 0);
            const diffMs = lessonStart.getTime() - now.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            const isUnder24h = diffHours < 24 && lessonForAction.status !== 'pending';

            if (isUnder24h) {
              return (
                <>
                  <div className="text-center mb-6">
                    <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                      ⚠️
                    </div>
                    <p className="text-sm text-gray-600 font-medium">
                      Faltam menos de 24h para a aula.
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      Alterações neste período dependem da aprovação do instrutor. Você pode solicitar o reagendamento aqui ou falar com ele pelo WhatsApp.
                    </p>
                  </div>

                  <Button 
                    fullWidth 
                    onClick={() => requestReschedule(lessonForAction)}
                    disabled={isRequestingReschedule}
                    className="h-12 text-base shadow-md shadow-amber-100 bg-amber-600 hover:bg-amber-700"
                  >
                    {isRequestingReschedule ? 'Enviando...' : 'Pedir Reagendamento'}
                  </Button>

                  {lessonForAction.instructorWhatsapp && (
                    <button 
                      onClick={() => {
                        const clean = lessonForAction.instructorWhatsapp!.replace(/\D/g, '');
                        const full = clean.startsWith('55') ? clean : `55${clean}`;
                        const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(lessonForAction.date);
                        const msg = encodeURIComponent(`Olá, gostaria de reagendar minha aula do dia ${dateStr} às ${lessonForAction.time}. Podemos conversar?`);
                        window.open(`https://wa.me/${full}?text=${msg}`, '_blank');
                      }}
                      className="w-full text-center py-2 text-sm text-green-600 font-medium hover:underline"
                    >
                      Falar via WhatsApp
                    </button>
                  )}

                  <button 
                    onClick={() => setLessonForAction(null)}
                    className="w-full text-center py-2 text-sm text-gray-400"
                  >
                    Voltar
                  </button>
                </>
              );
            }

            return (
              <>
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                    🗓️
                  </div>
                  <p className="text-sm text-gray-600">
                    Reagendar não tem custo e mantém sua vaga garantida com o instrutor.
                  </p>
                </div>

                <Button 
                  fullWidth 
                  onClick={() => {
                    setInstructorConfig(null);
                    setRescheduleDate(new Date());
                    setRescheduleTime(null);
                    setLessonToReschedule(lessonForAction);
                    setLessonForAction(null);
                  }}
                  className="h-12 text-base shadow-md shadow-blue-100"
                >
                  Remarcar aula
                </Button>

                <button 
                  onClick={() => {
                    setLessonToCancel(lessonForAction);
                    setLessonForAction(null);
                  }}
                  className="w-full text-center py-2 text-sm text-gray-400 hover:text-red-500 transition-colors"
                >
                  Cancelar aula
                </button>
              </>
            );
          })()}
        </div>
      </Modal>

      {/* Reschedule Modal */}
      <Modal
        isOpen={!!lessonToReschedule}
        onClose={() => {
          setLessonToReschedule(null);
          setRescheduleTime(null);
        }}
        title="Escolha o novo horário"
        footer={
          <div className="flex space-x-3 w-full">
            <Button 
              variant="outline" 
              fullWidth 
              onClick={() => {
                setLessonToReschedule(null);
                setRescheduleTime(null);
              }}
            >
              Voltar
            </Button>
            <Button 
              fullWidth 
              onClick={confirmReschedule}
              disabled={!rescheduleTime || isRescheduling}
              className="shadow-md shadow-blue-100"
            >
              {isRescheduling ? 'Confirmando...' : 'Confirmar'}
            </Button>
          </div>
        }
      >
        <div className="space-y-6 py-2">
          <DateSelector 
            selectedDate={rescheduleDate} 
            onDateSelect={setRescheduleDate} 
            daysBefore={0} 
            daysAfter={7} 
          />

          {isLoadingAvailability ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {(instructorConfig ? (() => {
                const slots = [
                  '07:00', '07:50', '08:40', '09:30', '10:20', '11:10',
                  '13:40', '14:30', '15:20', '16:10', '17:00'
                ];
                if (instructorConfig.hasNight) {
                  slots.push('18:00', '18:50', '19:40', '20:30', '21:20', '22:10');
                }
                return slots;
              })() : []).map((time) => {
                const isBusy = rescheduleBusySlots.includes(time);
                const isSelected = rescheduleTime === time;
                
                // Sunday check
                const isSunday = rescheduleDate.getDay() === 0;
                
                // Saturday check
                let isSatOff = false;
                if (rescheduleDate.getDay() === 6) {
                  const [h, m] = time.split(':').map(Number);
                  const minutes = h * 60 + m;
                  const limit = instructorConfig?.workSat ? (17 * 60) : (11 * 60 + 10);
                  if (minutes > limit) isSatOff = true;
                }

                // Past time check
                let isPast = false;
                const now = new Date(Date.now() + serverTimeOffset);
                const slotDate = new Date(rescheduleDate);
                const [h, m] = time.split(':').map(Number);
                slotDate.setHours(h, m, 0, 0);
                if (slotDate <= now) isPast = true;

                const isDisabled = isBusy || isSunday || isSatOff || isPast;

                return (
                  <button
                    key={time}
                    onClick={() => setRescheduleTime(time)}
                    disabled={isDisabled}
                    className={`
                      py-2 rounded-lg text-sm font-medium transition-all
                      ${isSelected 
                        ? 'bg-blue-600 text-white shadow-md' 
                        : !isDisabled 
                          ? 'bg-white text-gray-700 border border-gray-200 hover:border-blue-300' 
                          : 'bg-gray-50 text-gray-300 cursor-not-allowed border border-transparent'
                      }
                    `}
                  >
                    {time}
                  </button>
                );
              })}
            </div>
          )}
          
          {lessonToReschedule && lessonToReschedule.count > 1 && (
            <p className="text-[10px] text-gray-400 text-center italic">
              * Você está reagendando um bloco de {lessonToReschedule.count} aulas. O novo horário selecionado será o início da primeira aula.
            </p>
          )}
        </div>
      </Modal>

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
           {lessonToCancel?.status === 'confirmed' && (
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
            flowStep === 'tip' ? "Quer reconhecer o trabalho do seu instrutor?" :
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
                <Button fullWidth onClick={submitRating} disabled={rating === 0 || isFinalizing}>
                    {isFinalizing ? 'Finalizando...' : 'Avaliar'}
                </Button>
                <button onClick={closeFlow} disabled={isFinalizing} className="w-full text-center text-sm text-gray-400 py-2">
                    {isAutoModal ? 'Ignorar por enquanto' : 'Cancelar'}
                </button>
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
                <p className="text-xl font-bold text-blue-600 mt-2">Quer reconhecer o trabalho do seu instrutor?</p>
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
                          ${val === 10 && !selectedTip && !customTip ? 'ring-2 ring-blue-500/20 border-blue-200' : ''}
                        `}
                      >
                        <span className="text-xs font-medium opacity-60 mb-0.5">R$</span>
                        {val}
                        {val === 10 && (
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
                    <p className="text-sm font-semibold text-gray-800">100% da caixinha vai para o instrutor ❤️</p>
                    <p className="text-[10px] text-gray-400">Descontadas apenas taxas operacionais do Asaas</p>
                    <p className="text-[11px] text-blue-600 font-medium bg-blue-50 p-2 rounded-lg border border-blue-100 italic">
                      "Ao enviar este valor, você confirma que a aula foi realizada com sucesso."
                    </p>
                  </div>

                  <div className="space-y-3 pt-2">
                    <Button 
                      fullWidth 
                      variant="primary"
                      onClick={() => handleTipPayment(customTip ? Number(customTip) : (selectedTip || 0))} 
                      disabled={(!selectedTip && !customTip) || isSubmittingTip || isFinalizing}
                      className="shadow-lg shadow-blue-100 h-12 text-base"
                    >
                      {isSubmittingTip ? 'Iniciando...' : `Enviar R$ ${(customTip ? Number(customTip) : (selectedTip || 0)).toFixed(2).replace('.', ',')} de caixinha 🎁`}
                    </Button>
                    <p className="text-center text-[10px] text-gray-400 uppercase tracking-widest font-bold">
                      Pagamento imediato via PIX
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

                    {isAutoModal && (
                      <button 
                        onClick={closeFlow} 
                        className="w-full text-center text-xs text-gray-400 py-1 hover:text-gray-600"
                      >
                        Ignorar por enquanto
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="animate-fade-in flex flex-col items-center text-center space-y-5">
                  {tipPaymentData ? (
                    <>
                      <div className="space-y-1">
                        <span className="bg-emerald-50 text-emerald-700 text-xs font-semibold px-2.5 py-1 rounded-full border border-emerald-100">
                          PIX Gerado com Sucesso
                        </span>
                        <h4 className="text-xl font-extrabold text-gray-900 mt-2">
                          R$ {tipPaymentData.amount.toFixed(2).replace('.', ',')}
                        </h4>
                      </div>

                      {/* QR Code Container */}
                      <div className="relative p-3 bg-gray-50 rounded-2xl border border-gray-200/50 flex flex-col items-center justify-center shadow-inner">
                        <img 
                          src={`data:image/png;base64,${tipPaymentData.qrCodeImage}`} 
                          alt="QR Code PIX" 
                          referrerPolicy="no-referrer"
                          className="w-48 h-48 rounded-lg select-none pointer-events-none" 
                        />
                      </div>

                      {/* Copy Pix Button */}
                      <div className="w-full space-y-2">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(tipPaymentData.copiaColaCode);
                            addToast("Código PIX copiado para a área de transferência!", "success");
                          }}
                          className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold rounded-xl transition-all shadow-md shadow-blue-200"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                          </svg>
                          Copiar Código PIX
                        </button>

                        <a
                          href={tipPaymentData.invoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs text-blue-600 hover:text-blue-800 hover:underline font-semibold transition-colors"
                        >
                          Pagar no ambiente Asaas (Alternativa)
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>

                      {/* Loading/Status indicator */}
                      <div className="flex items-center justify-center gap-2.5 py-3 px-4 bg-gray-50 border border-gray-100 rounded-xl w-full">
                        <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-xs text-gray-500 font-medium">
                          Aguardando confirmação do pagamento...
                        </span>
                      </div>

                      {/* Skip/Back */}
                      <button
                        onClick={closeFlow}
                        className="text-xs text-gray-400 hover:text-gray-600 font-medium pt-1"
                      >
                        Cancelar e voltar
                      </button>
                    </>
                  ) : (
                    <div className="py-8 flex flex-col items-center justify-center space-y-3">
                      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                      <span className="text-sm text-gray-500 font-semibold">Gerando cobrança PIX...</span>
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