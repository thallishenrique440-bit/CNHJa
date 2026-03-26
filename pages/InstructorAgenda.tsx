import React, { useState, useEffect, useMemo } from 'react';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { getDerivedStatus as getSharedDerivedStatus, LessonDisplayStatus } from '../lib/lessonStatus';

// --- Types ---
type LessonStatus = 'free' | 'confirmed' | 'blocked' | 'lunch' | 'pending' | 'cancelled' | 'completed' | 'expired' | 'rejected';
type DisplayStatus = LessonDisplayStatus | 'finished' | 'past_free' | 'past_pending' | 'cancelled_view' | 'unavailable';

interface Lesson {
  id: string;
  status: LessonStatus;
  dbStatus?: string;
  studentName?: string;
  studentPhoto?: string | null;
  studentPhone?: string | null; // NEW FIELD
  cnhCategory?: string;
  dailyLessonCount?: number; 
  experience?: 'never' | 'few' | 'frequent';
  processType?: 'first' | 'rehab' | 'addition' | 'recycle';
  difficulties?: string[];
  observations?: string;
  price?: number;
  // Metadata for cancellation message
  dateStr?: string;
  timeStr?: string;
  isReserved?: boolean; // NEW FIELD
  groupId?: string; // NEW FIELD FOR GROUPING
}

interface LunchConfig {
  start: string;
  end: string;
  isActive: boolean;
}

interface TimeSlot {
  start: string;
  end: string;
  isLunch?: boolean;
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

const getDayName = (date: Date) => {
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return days[date.getDay()];
};

const formatDateFull = (dateStr: string) => {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
};

const timeToMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const minutesToTime = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const formatCurrency = (val: number) => {
    return (val / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

// Label Mappers
const getExperienceLabel = (val?: string) => {
  switch (val) {
    case 'never': return 'Nunca dirigiu';
    case 'few': return 'Dirigiu pouco';
    case 'frequent': return 'Já dirige';
    default: return 'Não informado';
  }
};

const getProcessLabel = (val?: string) => {
  switch (val) {
    case 'first': return '1ª Habilitação';
    case 'rehab': return 'Reabilitação';
    case 'addition': return 'Adição Categ.';
    case 'recycle': return 'Reciclagem';
    default: return 'Não informado';
  }
};

export const InstructorAgenda: React.FC = () => {
  const { session, serverTimeOffset } = useAuth();
  const { addToast } = useToast();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewDate, setViewDate] = useState(getStartOfWeek(new Date()));
  const [nightLessonsEnabled, setNightLessonsEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  
  // Agenda Config State
  const [lunchConfig, setLunchConfig] = useState<LunchConfig>({
    start: '12:00',
    end: '13:50',
    isActive: true
  });
  const [workSaturdayAfternoon, setWorkSaturdayAfternoon] = useState(false);
  const [showAgendaModal, setShowAgendaModal] = useState(false);
  
  // Temp states for modal
  const [tempLunchConfig, setTempLunchConfig] = useState<LunchConfig>(lunchConfig);
  const [tempWorkSaturdayAfternoon, setTempWorkSaturdayAfternoon] = useState(false);

  // Modal State
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [groupLessons, setGroupLessons] = useState<Lesson[]>([]); // NEW STATE FOR COMBO
  const [selectedDisplayStatus, setSelectedDisplayStatus] = useState<DisplayStatus | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  // Cancellation State
  const [viewState, setViewState] = useState<'details' | 'cancel_form' | 'cancel_success'>('details');
  const [cancelReason, setCancelReason] = useState('');

  // FETCH SETTINGS FROM DB
  useEffect(() => {
    const fetchSettings = async () => {
      if (!session?.user) return;
      try {
        const { data, error } = await supabase
          .from('instructors')
          .select('has_night_lessons, work_saturday_afternoon')
          .eq('id', session.user.id)
          .single();
        
        if (data) {
          setNightLessonsEnabled(!!data.has_night_lessons);
          setWorkSaturdayAfternoon(!!data.work_saturday_afternoon);
          setTempWorkSaturdayAfternoon(!!data.work_saturday_afternoon);
        }
      } catch (err) {
        console.error("Error fetching settings:", err);
      }
    };
    fetchSettings();
  }, [session]);

  const generateKey = (date: Date, time: string) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${time}`;
  };

  // --- NOTIFICATION LISTENER ---
  useEffect(() => {
    if (!session?.user) return;

    const channel = supabase
      .channel('instructor-notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${session.user.id}`
        },
        (payload) => {
          const notification = payload.new as any;
          // Show toast for any new notification
          addToast(notification.message || notification.title || "Nova notificação", 'success');
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, addToast]);

  const dynamicSlots = useMemo<TimeSlot[]>(() => {
    const slots: TimeSlot[] = [];
    let currentMins = timeToMinutes('07:00');
    
    // Determine end of day based on day of week and settings
    const dayOfWeek = selectedDate.getDay(); // 0=Sun, 6=Sat
    let endOfDayMins = nightLessonsEnabled ? timeToMinutes('22:10') : timeToMinutes('17:10');

    if (dayOfWeek === 0) {
        // Sunday: Show slots but they will be visually blocked/disabled in UI logic if needed
        // For now, let's keep showing them so instructor sees the grid, 
        // OR we could return empty array if we want to hide completely.
        // Requirement says: "appear visually but blocked". 
        // So we generate standard slots.
    } else if (dayOfWeek === 6) {
        // Saturday
        if (workSaturdayAfternoon) {
            endOfDayMins = timeToMinutes('17:10'); // Ends at 18:00
        } else {
            endOfDayMins = timeToMinutes('11:10'); // Ends at 12:00
        }
    }

    const lessonDuration = 50;

    const lunchStartMins = lunchConfig.isActive ? timeToMinutes(lunchConfig.start) : -1;
    const lunchEndMins = lunchConfig.isActive ? timeToMinutes(lunchConfig.end) : -1;

    while (currentMins <= endOfDayMins) {
      if (lunchConfig.isActive && currentMins >= lunchStartMins && currentMins < lunchEndMins) {
        slots.push({
          start: minutesToTime(lunchStartMins),
          end: minutesToTime(lunchEndMins),
          isLunch: true
        });
        currentMins = lunchEndMins; 
        continue;
      }

      if (lunchConfig.isActive && currentMins < lunchStartMins && (currentMins + lessonDuration) > lunchStartMins) {
         currentMins = lunchStartMins;
         continue;
      }

      let endMins = currentMins + lessonDuration;
      if (currentMins > endOfDayMins + 10) break;

      slots.push({
        start: minutesToTime(currentMins),
        end: minutesToTime(endMins),
        isLunch: false
      });

      currentMins = endMins;
    }
    return slots;
  }, [lunchConfig, nightLessonsEnabled, selectedDate, workSaturdayAfternoon]);

  // --- REAL DATA STATE ---
  const [appointments, setAppointments] = useState<Record<string, Lesson>>({});

  const fetchAppointments = React.useCallback(async () => {
    if (!session?.user) return;

    setLoading(true);
    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;

    try {
        const { data, error } = await supabase
            .from('appointments')
            .select(`
                id,
                date,
                start_time,
                status,
                category,
                price,
                group_id,
                profiles:student_id (
                    full_name,
                    avatar_url,
                    phone,  
                    experience_level,
                    cnh_process_type,
                    email
                )
            `)
            .eq('instructor_id', session.user.id)
            .eq('date', dateStr);

        if (error) throw error;

        const newAppointments: Record<string, Lesson> = {};

        if (data) {
            data.forEach((apt: any) => {
                const timeKey = apt.start_time.substring(0, 5); 
                const key = `${dateStr}-${timeKey}`;
                
                let uiStatus: LessonStatus | null = null;
                let isReserved = false;

                // STRICT STATUS MAPPING
                if (apt.status === 'pending_approval' || apt.status === 'pending') {
                    uiStatus = 'pending';
                } else if (apt.status === 'blocked') {
                    uiStatus = 'blocked';
                } else if (apt.status === 'confirmed' || apt.status === 'scheduled') {
                    uiStatus = 'confirmed';
                } else if (apt.status === 'completed') {
                    uiStatus = 'completed';
                } else if (apt.status === 'cancelled') {
                    uiStatus = 'cancelled';
                } else if (apt.status === 'reserved') {
                    // Reserved slots are currently being booked by a student.
                    // We must show them as occupied to prevent the instructor from trying to block them
                    // and causing a unique constraint violation.
                    uiStatus = 'blocked'; 
                    isReserved = true;
                } else {
                    // Fallback for unknown statuses (e.g. expired, rejected)
                    // If we want to show them, we need to map them. 
                    // For now, treat as free/hidden unless explicitly handled.
                    uiStatus = null;
                }

                if (uiStatus) {
                    newAppointments[key] = {
                        id: apt.id,
                        status: uiStatus,
                        dbStatus: apt.status,
                        studentName: apt.profiles?.full_name || 'Aluno',
                        studentPhoto: apt.profiles?.avatar_url,
                        studentPhone: apt.profiles?.phone, // Map phone
                        cnhCategory: apt.category,
                        experience: apt.profiles?.experience_level,
                        processType: apt.profiles?.cnh_process_type,
                        price: apt.price,
                        dateStr: apt.date,
                        timeStr: timeKey,
                        isReserved: isReserved,
                        groupId: apt.group_id
                    };
                }
            });
        }
        
        setAppointments(newAppointments);

    } catch (err) {
        console.error('Error fetching appointments:', err);
    } finally {
        setLoading(false);
    }
  }, [selectedDate, session]);

  // Initial Fetch & Realtime Subscription
  useEffect(() => {
    fetchAppointments();

    if (!session?.user) return;

    const channel = supabase
      .channel('instructor-agenda-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'appointments',
          filter: `instructor_id=eq.${session.user.id}`
        },
        (payload) => {
           // Refresh data when any appointment changes for this instructor
           // We could optimize to check if the date matches, but simple refetch is safer
           console.log('Realtime update:', payload);
           fetchAppointments();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchAppointments, session]);

  const weekStart = getStartOfWeek(viewDate);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  
  const handlePrevRange = () => setViewDate(current => addDays(current, -7));
  const handleNextRange = () => setViewDate(current => addDays(current, 7));
  const handleDayClick = (date: Date) => setSelectedDate(date);

  const getSlotData = (date: Date, slot: TimeSlot): Lesson => {
    if (slot.isLunch) return { id: 'lunch', status: 'lunch' };
    const key = generateKey(date, slot.start);
    return appointments[key] || { id: 'free', status: 'free' };
  };

  const getDerivedStatus = (lesson: Lesson, slot: TimeSlot, now: Date): DisplayStatus => {
    if (selectedDate.getDay() === 0) return 'unavailable';
    if (lesson.status === 'lunch') return 'lunch';
    
    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
    
    const sharedStatus = getSharedDerivedStatus(
      lesson.dbStatus || lesson.status,
      dateStr,
      slot.start,
      slot.end,
      now,
      true // isInstructor
    );

    // Map shared status to instructor UI status
    if (sharedStatus === 'completed') return 'finished';
    if (sharedStatus === 'cancelled') return 'cancelled_view';
    if (sharedStatus === 'awaiting_completion') return 'past_pending';
    
    // Handle special cases for instructor grid
    if (sharedStatus === 'free') {
        const [startH, startM] = slot.start.split(':').map(Number);
        const start = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), startH, startM);
        if (now > start) return 'past_free';
        return 'free';
    }

    return sharedStatus as DisplayStatus;
  };

  const sortedSlots = useMemo(() => {
    const now = new Date(Date.now() + serverTimeOffset);
    const isToday = selectedDate.toDateString() === now.toDateString();
    
    let currentMins = -1;
    if (isToday) {
        currentMins = now.getHours() * 60 + now.getMinutes();
    }

    const processed = dynamicSlots.map(slot => {
       const lesson = getSlotData(selectedDate, slot);
       const startMins = timeToMinutes(slot.start);
       const endMins = timeToMinutes(slot.end);

       let queueGroup = 1; 
       let timeState: 'current' | 'future' | 'past' = 'future';

       if (isToday) {
           if (endMins <= currentMins) {
               queueGroup = 2; 
               timeState = 'past';
           } else if (startMins <= currentMins && currentMins < endMins) {
               queueGroup = 0; 
               timeState = 'current';
           }
       } else if (selectedDate < now) {
            queueGroup = 2;
            timeState = 'past';
       }

       const displayStatus = getDerivedStatus(lesson, slot, now);

       return { slot, lesson, displayStatus, startMins, queueGroup };
    });

    return processed.sort((a, b) => {
       if (a.queueGroup !== b.queueGroup) return a.queueGroup - b.queueGroup;
       return a.startMins - b.startMins;
    });

  }, [selectedDate, appointments, lunchConfig, dynamicSlots]);

  const handleSlotClick = (slot: TimeSlot, lesson: Lesson, status: DisplayStatus) => {
    if (status === 'lunch' || status === 'past_free' || status === 'unavailable') return;
    setSelectedDisplayStatus(status);

    switch (status) {
      case 'free': toggleBlock(slot.start, 'block'); break;
      case 'blocked': 
        if (lesson.isReserved) {
            addToast("Este horário está reservado por um aluno em processo de pagamento.", "warning");
            return;
        }
        toggleBlock(slot.start, 'unblock', lesson.id); 
        break; 
      case 'confirmed':
      case 'in_progress':
      case 'finished':
      case 'pending':
      case 'past_pending':
      case 'cancelled_view':
        openLessonModal(lesson);
        break;
      case 'expired':
        openLessonModal({ ...lesson, status: 'expired' });
        break;
    }
  };

  const openLessonModal = async (lesson: Lesson) => {
    setSelectedLesson(lesson);
    setViewState('details');
    setCancelReason('');
    setGroupLessons([]);

    // If it's a pending lesson and has a groupId, fetch the whole group
    if (lesson.status === 'pending' && lesson.groupId) {
        try {
            const { data, error } = await supabase
                .from('appointments')
                .select('id, date, start_time, status, price')
                .eq('group_id', lesson.groupId)
                .order('date', { ascending: true })
                .order('start_time', { ascending: true });
            
            if (!error && data) {
                const mapped: Lesson[] = data.map(apt => ({
                    id: apt.id,
                    status: apt.status as LessonStatus,
                    dateStr: apt.date,
                    timeStr: apt.start_time.substring(0, 5),
                    price: apt.price
                }));
                setGroupLessons(mapped);
            }
        } catch (err) {
            console.error("Error fetching group lessons:", err);
        }
    }
  };

  const closeLessonModal = () => {
    setSelectedLesson(null);
    setViewState('details');
  };

  const toggleBlock = async (time: string, action: 'block' | 'unblock', lessonId?: string) => {
     setLoading(true);
     const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
     const key = generateKey(selectedDate, time);

     try {
       if (action === 'block') {
          const startMins = timeToMinutes(time);
          const endMins = startMins + 50;
          const endTime = minutesToTime(endMins);

          const { data, error } = await supabase
            .from('appointments')
            .insert({
              instructor_id: session?.user?.id,
              date: dateStr,
              start_time: time,
              end_time: endTime,
              status: 'blocked',
              price: 0,
              start_time_utc: new Date(Date.UTC(
                Number(dateStr.split('-')[0]), 
                Number(dateStr.split('-')[1]) - 1, 
                Number(dateStr.split('-')[2]), 
                Number(time.split(':')[0]) + 3, 
                Number(time.split(':')[1])
              )).toISOString()
            })
            .select()
            .single();

          if (error) throw error;

          setAppointments(prev => ({
             ...prev,
             [key]: {
               id: data.id,
               status: 'blocked',
               price: 0
             }
          }));
          addToast("Horário bloqueado.", 'success');

       } else if (action === 'unblock' && lessonId) {
          const { error } = await supabase
            .from('appointments')
            .delete()
            .eq('id', lessonId);
          
          if (error) throw error;

          setAppointments(prev => {
             const updated = { ...prev };
             delete updated[key];
             return updated;
          });
          addToast("Horário liberado.", 'success');
       }
     } catch (err: any) {
        console.error("Error toggling block:", err);
        addToast("Erro ao bloquear/desbloquear: " + err.message, 'error');
     } finally {
        setLoading(false);
     }
  };

  const handleConfirmLesson = async () => {
    if (!selectedLesson) return;
    setIsActionLoading(true);

    try {
        // Call Edge Function to capture payment
        const { data, error } = await supabase.functions.invoke('approve-booking', {
            body: { appointment_id: selectedLesson.id }
        });

        if (error) {
            if (error.status === 409) {
                throw new Error('STATUS_CHANGED');
            }
            throw error;
        }
        
        // Handle application-level errors from the function
        if (data?.error) {
            // Check for specific error codes if available, or message content
            if (data.code === 'AUTH_EXPIRED' || data.error.includes('expired')) {
                throw new Error('AUTH_EXPIRED');
            }
            throw new Error(data.error);
        }

        const keyToUpdate = Object.keys(appointments).find(k => appointments[k].id === selectedLesson.id);
        if (keyToUpdate) {
            setAppointments(prev => ({
                ...prev,
                [keyToUpdate]: { ...prev[keyToUpdate], status: 'confirmed' }
            }));
        }
        
        closeLessonModal();
        addToast("Aula confirmada e pagamento capturado!", 'success');

    } catch (err: any) {
        console.error("Error approving:", err);
        
        if (err.message === 'AUTH_EXPIRED') {
             addToast("Autorização do pagamento expirou. Solicite novo pagamento ao aluno.", 'error');
             // Remove from view as it is now cancelled
             const keyToUpdate = Object.keys(appointments).find(k => appointments[k].id === selectedLesson.id);
             if (keyToUpdate) {
                setAppointments(prev => {
                    const updated = { ...prev };
                    delete updated[keyToUpdate]; 
                    return updated;
                });
             }
             closeLessonModal();
        } else if (err.message === 'STATUS_CHANGED' || err.message.includes('Invalid status change')) {
             addToast("Esta aula já foi atualizada ou cancelada pelo aluno.", 'error');
             closeLessonModal();
             // Reload appointments to get fresh state
             fetchAppointments();
        } else {
             addToast("Erro ao confirmar: " + err.message, 'error');
        }
    } finally {
        setIsActionLoading(false);
    }
  };

  const handleRejectLesson = async () => {
    if (!selectedLesson) return;
    if (!confirm("Tem certeza que deseja recusar esta solicitação? O valor será estornado ao aluno.")) return;

    setIsActionLoading(true);

    try {
        const { data, error } = await supabase.functions.invoke('reject-booking', {
            body: { appointment_id: selectedLesson.id }
        });

        if (error) {
            if (error.status === 409) {
                throw new Error('STATUS_CHANGED');
            }
            throw error;
        }
        if (data?.error) throw new Error(data.error);

        const keyToUpdate = Object.keys(appointments).find(k => appointments[k].id === selectedLesson.id);
        if (keyToUpdate) {
            setAppointments(prev => {
                const updated = { ...prev };
                delete updated[keyToUpdate];
                return updated;
            });
        }
        
        closeLessonModal();
        addToast("Solicitação recusada e valor estornado.", 'info');

    } catch (err: any) {
        console.error("Error rejecting:", err);
        if (err.message === 'STATUS_CHANGED' || err.message.includes('Invalid status change')) {
            addToast("Esta aula já foi atualizada ou cancelada pelo aluno.", 'error');
            closeLessonModal();
            fetchAppointments();
        } else {
            addToast("Erro ao recusar: " + err.message, 'error');
        }
    } finally {
        setIsActionLoading(false);
    }
  };

  const handleFinalizeLesson = async () => {
    if (!selectedLesson) return;
    setIsActionLoading(true);
    try {
      const { error } = await supabase
        .from('appointments')
        .update({ 
          status: 'completed',
          updated_at: new Date().toISOString()
        })
        .eq('id', selectedLesson.id);

      if (error) throw error;
      
      addToast('Aula finalizada com sucesso!', 'success');
      closeLessonModal();
    } catch (error: any) {
      addToast(error.message, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // --- NEW CANCEL FLOW START ---
  const handleInstructorCancel = async () => {
    if (!selectedLesson) return;
    
    setIsActionLoading(true);
    try {
        const { error } = await supabase
            .from('appointments')
            .update({ 
                status: 'cancelled',
                cancelled_by: 'instructor',
                cancelled_reason: cancelReason 
            })
            .eq('id', selectedLesson.id);

        if (error) throw error;

        // Update local state immediately to 'cancelled'
        const keyToUpdate = Object.keys(appointments).find(k => appointments[k].id === selectedLesson.id);
        if (keyToUpdate) {
            setAppointments(prev => {
                const updated = { ...prev };
                updated[keyToUpdate] = {
                    ...updated[keyToUpdate],
                    status: 'cancelled'
                };
                return updated;
            });
        }

        setViewState('cancel_success');
        addToast("Aula cancelada e horário liberado.", 'success');

    } catch (err: any) {
        console.error(err);
        addToast("Erro ao cancelar: " + err.message, 'error');
    } finally {
        setIsActionLoading(false);
    }
  };

  const sendWhatsAppNotification = () => {
    if (!selectedLesson) return;
    
    // Construct Message
    const msg = `Olá, ${selectedLesson.studentName}! Precisei cancelar nossa aula de ${formatDateFull(selectedLesson.dateStr!)} às ${selectedLesson.timeStr}. Motivo: ${cancelReason}. Podemos reagendar?`;
    
    // Use student's phone if available, else open generic picker
    let url = '';
    if (selectedLesson.studentPhone) {
        const cleanPhone = selectedLesson.studentPhone.replace(/\D/g, '');
        const fullPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
        url = `https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}`;
    } else {
        url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    }
    
    window.open(url, '_blank');
    closeLessonModal();
  };
  // --- NEW CANCEL FLOW END ---

  // Open WhatsApp directly for active lesson
  const openStudentWhatsApp = () => {
     if (!selectedLesson?.studentPhone) {
         addToast("Aluno não cadastrou telefone.", "warning");
         return;
     }
     const cleanPhone = selectedLesson.studentPhone.replace(/\D/g, '');
     const fullPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
     const msg = encodeURIComponent(`Olá, ${selectedLesson.studentName}. Sobre nossa aula...`);
     window.open(`https://wa.me/${fullPhone}?text=${msg}`, '_blank');
  };


  const handleOpenAgendaModal = () => {
    setTempLunchConfig({ ...lunchConfig });
    setTempWorkSaturdayAfternoon(workSaturdayAfternoon);
    setShowAgendaModal(true);
  };

  const handleSaveAgenda = async () => {
    const s = timeToMinutes(tempLunchConfig.start);
    const e = timeToMinutes(tempLunchConfig.end);
    
    if(tempLunchConfig.isActive && s >= e) {
      addToast("O horário de início do almoço deve ser anterior ao fim.", 'warning');
      return;
    }

    setLoading(true);
    try {
        // Save to DB
        const { error } = await supabase
            .from('instructors')
            .update({ work_saturday_afternoon: tempWorkSaturdayAfternoon })
            .eq('id', session?.user?.id);

        if (error) throw error;

        // Update Local State
        setLunchConfig({ ...tempLunchConfig });
        setWorkSaturdayAfternoon(tempWorkSaturdayAfternoon);
        setShowAgendaModal(false);
        addToast("Configurações da agenda atualizadas.", 'success');

    } catch (err: any) {
        console.error("Error saving agenda settings:", err);
        addToast("Erro ao salvar configurações.", 'error');
    } finally {
        setLoading(false);
    }
  };

  const formatDateTitle = (date: Date) => {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  };

  useEffect(() => {
    const interval = setInterval(() => {
      setSelectedDate(d => new Date(d)); 
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-20 sm:max-w-md sm:mx-auto relative">
      <div className="bg-white px-4 pt-6 pb-4 border-b border-gray-100 shadow-sm z-10 sticky top-0">
        <div className="flex items-center justify-between mb-4 px-2">
          <div className="flex flex-col">
            <h1 className="text-xl font-bold text-gray-900">Minha agenda</h1>
            <span className="text-xs text-gray-500 capitalize">{formatDateTitle(selectedDate)}</span>
          </div>
          
          <button 
            onClick={handleOpenAgendaModal}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-blue-600 hover:text-blue-700 hover:bg-blue-50 active:bg-blue-100 transition-all"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>Configurar agenda</span>
          </button>
        </div>

        <div className="flex items-center justify-between space-x-2">
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
                        <span className={`text-[10px] font-medium uppercase ${isSelected ? 'text-blue-100' : 'text-gray-400'}`}>{getDayName(date)}</span>
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
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
             <div className="flex items-center justify-center py-10">
                 <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
             </div>
        ) : sortedSlots.map(({ slot, lesson, displayStatus, queueGroup }) => {
          let cardClasses = "border";
          let textClasses = "text-gray-900"; 
          let statusLabel = "";
          let statusIcon = null;
          let subText = null;

          const showPastDivider = queueGroup === 2 && sortedSlots.find(s => s.queueGroup === 2)?.slot.start === slot.start;
          
          const isNightStart = timeToMinutes(slot.start) >= timeToMinutes('18:00');
          const showNightDivider = isNightStart && 
                                   (queueGroup === 0 || queueGroup === 1) && 
                                   !sortedSlots.find(s => s.queueGroup === queueGroup && s.startMins < timeToMinutes(slot.start) && s.startMins >= timeToMinutes('18:00'));

          switch (displayStatus) {
            case 'pending':
               cardClasses = "bg-yellow-50 border-yellow-200 border-l-4 border-l-yellow-400 shadow-sm cursor-pointer animate-fade-in";
               textClasses = "text-[10px] font-bold text-yellow-700 uppercase tracking-wider mb-0.5";
               statusLabel = "Pagamento autorizado";
               statusIcon = <span className="text-2xl animate-pulse">🔔</span>;
               subText = (
                  <div className="flex flex-col">
                     <span className="text-base font-bold text-gray-900 leading-tight">{lesson.studentName}</span>
                     <span className="text-[10px] text-yellow-800 font-medium mt-1">Aguardando sua ação (Toque aqui)</span>
                  </div>
               );
               break;
            case 'in_progress':
              cardClasses = "bg-white border-green-500 border-l-4 border-l-green-500 ring-1 ring-green-100 shadow-md transform scale-[1.01] cursor-pointer";
              textClasses = "text-[10px] font-bold text-green-600 uppercase tracking-wider mb-0.5";
              statusLabel = "Em andamento";
              statusIcon = lesson.studentPhoto ? (
                <img src={lesson.studentPhoto} alt="Aluno" className="w-10 h-10 rounded-full object-cover border-2 border-green-100 shadow-sm" />
              ) : (
                <span className="text-2xl">👤</span>
              );
              subText = (
                 <div className="flex flex-col">
                    <div className="flex items-baseline space-x-1.5">
                      <span className="text-base font-bold text-gray-900 leading-tight">{lesson.studentName}</span>
                      {lesson.cnhCategory && <span className="text-[10px] font-bold text-gray-500">[ CAT {lesson.cnhCategory} ]</span>}
                    </div>
                    <span className="text-[10px] text-green-600 font-bold uppercase tracking-wider mt-1">Finaliza às {slot.end}</span>
                 </div>
              );
              break;
            case 'free':
              if (queueGroup === 0) {
                  cardClasses = "bg-blue-50 border-blue-200 shadow-sm cursor-pointer";
                  textClasses = "text-sm font-bold text-blue-800";
                  statusLabel = "AGORA: Disponível";
                  statusIcon = <span className="text-blue-500 text-xl">⏱️</span>;
                  subText = <span className="text-[10px] text-blue-600 font-medium">Horário atual livre</span>;
              } else {
                  cardClasses = "bg-white border-dashed border-gray-300 hover:border-blue-300 cursor-pointer active:scale-[0.99] transition-transform";
                  textClasses = "text-sm font-semibold text-blue-600";
                  statusLabel = "Disponível";
                  statusIcon = <span className="text-gray-300 text-xl">+</span>;
                  subText = <span className="text-[10px] text-green-600 font-medium">Toque para agendar ou bloquear</span>;
              }
              break;
            case 'blocked':
              if (lesson.isReserved) {
                  cardClasses = "bg-yellow-50 border-yellow-200 cursor-not-allowed opacity-80";
                  textClasses = "text-[10px] font-bold text-yellow-700 uppercase tracking-wider mb-0.5";
                  statusLabel = "Reservando...";
                  statusIcon = <span className="text-yellow-600 text-lg animate-pulse">⏳</span>;
                  subText = <span className="text-[10px] text-yellow-600 font-medium">Aluno em checkout</span>;
              } else {
                  cardClasses = "bg-gray-100 border-gray-200 cursor-pointer";
                  textClasses = "text-sm font-semibold text-gray-500";
                  statusLabel = "Bloqueado";
                  statusIcon = <span className="text-gray-400 text-lg">🔒</span>;
                  subText = <span className="text-[10px] text-gray-400 font-medium">Toque para liberar</span>;
              }
              break;
            case 'confirmed':
              cardClasses = "bg-blue-50 border-blue-200 border-l-4 border-l-blue-500 cursor-pointer active:scale-[0.99] transition-transform";
              textClasses = "text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-0.5";
              statusLabel = "Confirmada";
              statusIcon = lesson.studentPhoto ? (
                <img src={lesson.studentPhoto} alt="Aluno" className="w-10 h-10 rounded-full object-cover border-2 border-blue-200 shadow-sm" />
              ) : (
                <span className="text-2xl">👤</span>
              );
              subText = (
                <div className="flex flex-col">
                   <div className="flex items-baseline space-x-1.5">
                      <span className="text-base font-bold text-gray-900 leading-tight">{lesson.studentName}</span>
                      {lesson.cnhCategory && <span className="text-[10px] font-bold text-gray-500">[ CAT {lesson.cnhCategory} ]</span>}
                   </div>
                </div>
              );
              break;
            case 'finished':
              cardClasses = "bg-gray-50 border-gray-200 cursor-pointer hover:bg-gray-100"; 
              textClasses = "text-sm font-semibold text-gray-600";
              statusLabel = lesson.studentName || "Aula finalizada";
              statusIcon = <span className="grayscale opacity-70">🏁</span>;
              subText = <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Finalizada (Toque para ver)</span>;
              break;
            case 'past_free':
              cardClasses = "bg-gray-50 border-gray-100 opacity-50 cursor-default";
              textClasses = "text-sm font-semibold text-gray-400";
              statusLabel = "Não agendado";
              statusIcon = null;
              subText = null;
              break;
            case 'expired':
              cardClasses = "bg-gray-100 border-gray-200 border-l-4 border-l-gray-300 opacity-70 cursor-default";
              textClasses = "text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-0.5";
              statusLabel = "Solicitação Expirada";
              statusIcon = <span className="text-xl grayscale opacity-50">🚫</span>;
              subText = (
                 <div className="flex flex-col">
                    <span className="text-base font-bold text-gray-500 leading-tight line-through decoration-gray-400">{lesson.studentName}</span>
                    <span className="text-[10px] text-gray-400 font-medium mt-1">Horário expirou sem confirmação</span>
                 </div>
              );
              break;
            case 'past_pending':
              cardClasses = "bg-yellow-50/50 border-yellow-100 cursor-pointer hover:bg-yellow-50";
              textClasses = "text-sm font-semibold text-yellow-700";
              statusLabel = lesson.studentName || "Aula realizada";
              statusIcon = <span className="text-xl grayscale opacity-70">⚠️</span>;
              subText = <span className="text-[10px] text-yellow-600 font-medium uppercase tracking-wide">Pendente de finalização</span>;
              break;
            case 'cancelled_view':
              cardClasses = "bg-gray-50 border-gray-100 opacity-60 cursor-pointer grayscale";
              textClasses = "text-sm font-semibold text-gray-400 line-through decoration-gray-400";
              statusLabel = lesson.studentName || "Aula cancelada";
              statusIcon = <span className="text-xl opacity-50">❌</span>;
              subText = <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide no-underline">Cancelada pelo instrutor</span>;
              break;
            case 'lunch':
              cardClasses = "bg-gray-100 border-transparent opacity-100 cursor-default pointer-events-none";
              textClasses = "text-sm font-semibold text-gray-400";
              statusLabel = "Almoço";
              statusIcon = <span className="text-xl grayscale opacity-50">🍽️</span>;
              subText = <span className="text-[10px] text-gray-400 font-medium">Intervalo</span>;
              break;
            case 'unavailable':
              cardClasses = "bg-gray-50 border-gray-100 opacity-60 cursor-not-allowed";
              textClasses = "text-sm font-semibold text-gray-400";
              statusLabel = "Indisponível";
              statusIcon = <span className="text-xl grayscale opacity-50">🚫</span>;
              subText = <span className="text-[10px] text-gray-400 font-medium">Domingo (Folga)</span>;
              break;
          }

          return (
            <React.Fragment key={slot.start}>
                {showNightDivider && (
                  <div className="flex items-center space-x-2 py-3">
                     <div className="h-px bg-indigo-100 flex-1"></div>
                     <span className="flex items-center text-[10px] font-bold text-indigo-500 uppercase tracking-widest bg-indigo-50 px-2 py-1 rounded-full"><span className="mr-1 text-xs">🌙</span> Aulas Noturnas</span>
                     <div className="h-px bg-indigo-100 flex-1"></div>
                  </div>
                )}
                {showPastDivider && (
                    <div className="flex items-center space-x-2 py-2">
                        <div className="h-px bg-gray-200 flex-1"></div>
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Histórico do dia</span>
                        <div className="h-px bg-gray-200 flex-1"></div>
                    </div>
                )}
                <div onClick={() => handleSlotClick(slot, lesson, displayStatus)} className={`flex items-center p-3 rounded-xl shadow-sm relative overflow-hidden transition-all duration-200 ${cardClasses}`}>
                  <div className="flex flex-col w-16 border-r border-gray-100 pr-3 mr-3 text-center">
                      <span className={`text-sm font-bold ${displayStatus === 'past_free' || displayStatus === 'lunch' || displayStatus === 'expired' ? 'text-gray-400' : 'text-gray-700'}`}>{slot.start}</span>
                      <span className="text-[10px] text-gray-400">{slot.end}</span>
                  </div>
                  <div className="flex-1">
                      <div className={textClasses}>{statusLabel}</div>
                      {subText}
                  </div>
                  <div className="ml-2">{statusIcon}</div>
                </div>
            </React.Fragment>
          );
        })}
        <div className="text-center py-6">
           <p className="text-xs text-gray-400">Fim dos horários para este dia.</p>
        </div>
      </div>

      <Modal
        isOpen={!!selectedLesson}
        onClose={viewState === 'cancel_success' ? sendWhatsAppNotification : closeLessonModal}
        title={
            viewState === 'cancel_success' ? "Aula cancelada!" :
            viewState === 'cancel_form' ? "Cancelar aula" :
            selectedLesson?.status === 'pending' ? (groupLessons.length > 1 ? "Solicitação de Combo" : "Solicitação de aula") : 
            "Detalhes da aula"
        }
        footer={
          viewState === 'cancel_success' ? (
             <div className="space-y-2 w-full">
                <Button fullWidth onClick={sendWhatsAppNotification} className="bg-green-600 hover:bg-green-700 text-white shadow-green-100">
                   Enviar aviso no WhatsApp
                </Button>
                <Button variant="text" fullWidth onClick={closeLessonModal} className="text-gray-400">
                   Fechar
                </Button>
             </div>
          ) : viewState === 'cancel_form' ? (
             <div className="space-y-3 w-full">
                <Button fullWidth onClick={handleInstructorCancel} disabled={isActionLoading || cancelReason.length < 3} className="bg-red-600 hover:bg-red-700 text-white">
                   {isActionLoading ? 'Cancelando...' : 'Confirmar cancelamento'}
                </Button>
                <Button variant="outline" fullWidth onClick={() => setViewState('details')}>
                   Voltar
                </Button>
             </div>
          ) : selectedLesson?.status === 'pending' ? (() => {
              const now = new Date(Date.now() + serverTimeOffset);
              const [y, m, d] = selectedLesson.dateStr!.split('-').map(Number);
              const [h, min] = selectedLesson.timeStr!.split(':').map(Number);
              const lessonStart = new Date(y, m - 1, d, h, min);

              if (now >= lessonStart) {
                  return (
                      <div className="w-full text-center py-2">
                          <p className="text-xs text-gray-400 italic">Esta solicitação expirou (horário já passou).</p>
                          <Button variant="outline" fullWidth onClick={closeLessonModal} className="mt-2">Fechar</Button>
                      </div>
                  );
              }

              return (
                 <div className="flex flex-col space-y-3 w-full">
                    <div className="flex space-x-3 w-full">
                        <Button variant="outline" fullWidth onClick={handleRejectLesson} disabled={isActionLoading} className="border-red-200 text-red-600 hover:bg-red-50">{isActionLoading ? '...' : groupLessons.length > 1 ? 'Recusar Combo' : 'Recusar'}</Button>
                        <Button fullWidth onClick={handleConfirmLesson} disabled={isActionLoading}>{isActionLoading ? 'Processando...' : groupLessons.length > 1 ? 'Aceitar Combo' : 'Aceitar e Confirmar'}</Button>
                    </div>
                    {groupLessons.length > 1 && (
                        <p className="text-[10px] text-gray-400 text-center italic">
                            * Ao aceitar ou recusar, a ação será aplicada a todas as {groupLessons.length} aulas do combo.
                        </p>
                    )}
                 </div>
              );
          })() : (
             <div className="space-y-3 w-full">
                {selectedLesson?.status !== 'free' && selectedLesson?.status !== 'blocked' && (
                    <Button 
                       fullWidth 
                       onClick={openStudentWhatsApp}
                       disabled={!selectedLesson?.studentPhone}
                       className="bg-green-600 hover:bg-green-700 text-white shadow-green-200"
                    >
                        Chamar no WhatsApp
                    </Button>
                )}
                
                <Button fullWidth variant="outline" onClick={closeLessonModal} className="py-2.5 text-sm h-10 min-h-0">Fechar</Button>
                
                {/* Cancel Button for Scheduled/Confirmed Lessons - Only if not started yet */}
                {(selectedLesson?.dbStatus === 'confirmed' || selectedLesson?.dbStatus === 'scheduled') && (() => {
                    const now = new Date(Date.now() + serverTimeOffset);
                    const [y, m, d] = selectedLesson.dateStr!.split('-').map(Number);
                    const [h, min] = selectedLesson.timeStr!.split(':').map(Number);
                    const lessonStart = new Date(y, m - 1, d, h, min);
                    
                    if (now < lessonStart) {
                        return (
                            <button 
                              onClick={() => setViewState('cancel_form')}
                              className="w-full text-center text-xs text-red-500 font-semibold hover:text-red-600 pt-2"
                            >
                              Cancelar esta aula
                            </button>
                        );
                    }
                    return null;
                })()}
             </div>
          )
        }
      >
        {selectedLesson && (
            <div className="flex flex-col items-center">
                {/* STATE: SUCCESS */}
                {viewState === 'cancel_success' && (
                    <div className="text-center py-4">
                       <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                          ✅
                       </div>
                       <p className="text-gray-600 text-sm leading-relaxed mb-4">
                         O horário foi liberado com sucesso.
                         <br/>
                         <span className="font-bold">Agora, avise o aluno para evitar desencontros.</span>
                       </p>
                    </div>
                )}

                {/* STATE: CANCEL FORM */}
                {viewState === 'cancel_form' && (
                    <div className="w-full text-left">
                       <p className="text-sm text-gray-500 mb-4 text-center">
                         Você está prestes a cancelar esta aula. O horário ficará livre novamente.
                       </p>
                       <label className="block text-xs font-bold text-gray-700 mb-1 ml-1">
                         Motivo do cancelamento (Obrigatório)
                       </label>
                       <textarea 
                          className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-red-500 focus:outline-none resize-none h-24"
                          placeholder="Ex: Imprevisto com o veículo, problema de saúde..."
                          value={cancelReason}
                          onChange={(e) => setCancelReason(e.target.value)}
                       />
                       <p className="text-[10px] text-gray-400 mt-2 ml-1">
                         Este motivo será usado para preencher a mensagem de aviso ao aluno.
                       </p>
                    </div>
                )}

                {/* STATE: DETAILS (DEFAULT) */}
                {viewState === 'details' && (
                    <>
                        <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center text-2xl border-2 border-white shadow-sm mb-3">
                            {selectedLesson.studentPhoto ? <img src={selectedLesson.studentPhoto} alt="" className="w-full h-full rounded-full object-cover" /> : "👤"}
                        </div>
                        <h2 className="text-lg font-bold text-gray-900 leading-tight mb-1">{selectedLesson.studentName || 'Horário Selecionado'}</h2>
                        {selectedLesson.cnhCategory && <span className="text-xs font-bold text-blue-600 uppercase tracking-wide mb-4">Categoria {selectedLesson.cnhCategory}</span>}

                        {/* COMBO DISPLAY */}
                        {selectedLesson.status === 'pending' && groupLessons.length > 1 && (
                            <div className="w-full mb-4 bg-indigo-50 rounded-xl p-3 border border-indigo-100">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Aulas neste combo ({groupLessons.length})</span>
                                    <span className="text-[10px] font-bold text-indigo-500 bg-white px-1.5 py-0.5 rounded border border-indigo-100">Decisão Única</span>
                                </div>
                                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                                    {groupLessons.map((gl, idx) => (
                                        <div key={gl.id} className="flex items-center justify-between text-xs py-1.5 border-b border-indigo-100/50 last:border-0">
                                            <div className="flex items-center space-x-2">
                                                <span className="text-indigo-400">📅</span>
                                                <span className="font-medium text-gray-700">{formatDateFull(gl.dateStr!)} • {gl.timeStr}</span>
                                            </div>
                                            {gl.id === selectedLesson.id && (
                                                <span className="text-[9px] font-bold text-indigo-500 bg-indigo-100 px-1 rounded">Este slot</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-3 pt-2 border-t border-indigo-100 flex justify-between items-center">
                                    <span className="text-[10px] font-bold text-gray-500 uppercase">Total do Combo:</span>
                                    <span className="text-sm font-bold text-indigo-700">
                                        {formatCurrency(groupLessons.reduce((acc, curr) => acc + (curr.price || 0), 0))}
                                    </span>
                                </div>
                            </div>
                        )}

                        <div className="w-full space-y-4 text-left">
                        {selectedLesson.status !== 'free' && selectedLesson.status !== 'blocked' ? (
                            <>
                            {!(selectedLesson.status === 'pending' && groupLessons.length > 1) && (
                                <div className="flex items-center justify-center space-x-2 bg-gray-50 rounded-lg py-2 border border-gray-100">
                                    <span className="text-xs text-gray-500 font-semibold uppercase tracking-wide">Valor:</span>
                                    <span className="text-sm font-bold text-green-600">{formatCurrency(selectedLesson.price || 0)}</span>
                                </div>
                            )}
                            {/* Phone Display */}
                            <div className="flex flex-col items-center bg-blue-50/50 rounded-lg p-3 border border-blue-100">
                                <span className="text-[10px] text-blue-800 uppercase font-bold tracking-wider mb-1">WhatsApp do Aluno</span>
                                {selectedLesson.studentPhone ? (
                                    <span className="text-sm font-semibold text-gray-800">{selectedLesson.studentPhone}</span>
                                ) : (
                                    <span className="text-sm text-gray-400 italic">Não informado</span>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-3 text-center">
                                <div className="bg-gray-50 rounded-lg p-2 border border-gray-100">
                                    <span className="block text-[9px] text-gray-400 uppercase font-bold tracking-wider">Experiência</span>
                                    <span className="text-xs font-semibold text-gray-800 leading-tight block mt-0.5 truncate">{getExperienceLabel(selectedLesson.experience)}</span>
                                </div>
                                <div className="bg-gray-50 rounded-lg p-2 border border-gray-100">
                                    <span className="block text-[9px] text-gray-400 uppercase font-bold tracking-wider">Processo</span>
                                    <span className="text-xs font-semibold text-gray-800 leading-tight block mt-0.5 truncate">{getProcessLabel(selectedLesson.processType)}</span>
                                </div>
                            </div>
                            {selectedLesson.observations && (
                                <div>
                                    <div className="bg-yellow-50 p-2.5 rounded-lg border border-yellow-100">
                                    <p className="text-xs text-gray-700 italic leading-relaxed line-clamp-3">"{selectedLesson.observations}"</p>
                                    </div>
                                </div>
                            )}
                            </>
                        ) : (
                            <p className="text-center text-sm text-gray-400 py-4">Informações indisponíveis</p>
                        )}
                        </div>
                    </>
                )}
            </div>
        )}
      </Modal>

      <Modal
        isOpen={showAgendaModal}
        onClose={() => setShowAgendaModal(false)}
        title="Configurar Agenda"
        footer={
          <div className="flex space-x-3 w-full">
            <Button variant="outline" onClick={() => setShowAgendaModal(false)} fullWidth>Cancelar</Button>
            <Button onClick={handleSaveAgenda} loading={loading} fullWidth>Salvar</Button>
          </div>
        }
      >
        <div className="space-y-6">
           {/* Section 1: Lunch */}
           <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
              <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Horário de Almoço</h3>
                  <div className="relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in">
                      <input 
                        type="checkbox" 
                        name="lunch-toggle" 
                        id="lunch-toggle" 
                        className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer transition-transform duration-200 ease-in-out checked:translate-x-full checked:border-blue-600"
                        checked={tempLunchConfig.isActive}
                        onChange={(e) => setTempLunchConfig({...tempLunchConfig, isActive: e.target.checked})}
                      />
                      <label htmlFor="lunch-toggle" className={`toggle-label block overflow-hidden h-5 rounded-full cursor-pointer ${tempLunchConfig.isActive ? 'bg-blue-600' : 'bg-gray-300'}`}></label>
                  </div>
              </div>
              
              {tempLunchConfig.isActive && (
                <div className="grid grid-cols-2 gap-4 animate-fade-in">
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Início</label>
                        <input 
                            type="time" 
                            className="w-full p-2 border border-gray-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            value={tempLunchConfig.start}
                            onChange={(e) => setTempLunchConfig({...tempLunchConfig, start: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Fim</label>
                        <input 
                            type="time" 
                            className="w-full p-2 border border-gray-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            value={tempLunchConfig.end}
                            onChange={(e) => setTempLunchConfig({...tempLunchConfig, end: e.target.value})}
                        />
                    </div>
                </div>
              )}
           </div>

           {/* Section 2: Saturday */}
           <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
              <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Sábado à Tarde</h3>
                  <div className="relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in">
                      <input 
                        type="checkbox" 
                        name="sat-toggle" 
                        id="sat-toggle" 
                        className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer transition-transform duration-200 ease-in-out checked:translate-x-full checked:border-blue-600"
                        checked={tempWorkSaturdayAfternoon}
                        onChange={(e) => setTempWorkSaturdayAfternoon(e.target.checked)}
                      />
                      <label htmlFor="sat-toggle" className={`toggle-label block overflow-hidden h-5 rounded-full cursor-pointer ${tempWorkSaturdayAfternoon ? 'bg-blue-600' : 'bg-gray-300'}`}></label>
                  </div>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                 {tempWorkSaturdayAfternoon 
                    ? "Sua agenda ficará aberta até as 18:00 aos sábados." 
                    : "Sua agenda encerrará às 12:00 aos sábados (padrão)."
                 }
              </p>
           </div>

           {/* Section 3: Info */}
           <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 flex items-start space-x-3">
              <span className="text-xl">ℹ️</span>
              <p className="text-xs text-blue-800 leading-relaxed">
                 <strong>Domingos:</strong> Por padrão, domingos são dias de folga e não permitem agendamentos.
              </p>
           </div>
        </div>
      </Modal>
      <InstructorBottomNav />
    </div>
  );
};