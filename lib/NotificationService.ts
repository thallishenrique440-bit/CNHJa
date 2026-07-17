import { createClient } from '@supabase/supabase-js';

// Centralized Enums
export enum NotificationType {
  BOOKING_REQUEST = 'booking_request',
  BOOKING_ACCEPTED = 'booking_accepted',
  BOOKING_REJECTED = 'booking_rejected',
  BOOKING_CANCELLED = 'booking_cancelled',
  BOOKING_EXPIRED = 'booking_expired',
  PAYMENT_RELEASED = 'payment_released',
  REMINDER = 'reminder',
  SYSTEM = 'system',
  TIP = 'tip',
  // booking_request foi mantido por compatibilidade com a CHECK constraint existente no PostgreSQL;
  // a diferenciação entre uma nova solicitação e uma solicitação de remarcação acontece através do título e da mensagem da notificação;
  // esta decisão foi tomada para evitar qualquer alteração estrutural no banco.
  BOOKING_RESCHEDULED = 'booking_request'
}

export enum EntityType {
  PACKAGE = 'package',
  LESSON = 'lesson',
  FINANCE = 'finance',
  CHAT = 'chat',
  REVIEW = 'review',
  PROMOTION = 'promotion'
}

export enum NotificationTargetScreen {
  STUDENT_LESSONS = 'student_lessons',
  INSTRUCTOR_AGENDA = 'instructor_agenda',
  INSTRUCTOR_FINANCE = 'instructor_finance',
  STUDENT_FINANCE = 'student_finance'
}

const supabaseUrl = process.env.SUPABASE_URL || 'https://ohftsqsxymtrclnpadam.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

let isConfigured = false;
async function ensureConfig() {
  if (isConfigured) return;
  try {
    const edgeUrl = `${supabaseUrl}/functions/v1`;
    await supabaseAdmin.from('notification_config').upsert([
      { key: 'edge_function_url', value: edgeUrl }
    ]);
    isConfigured = true;
  } catch (err) {
    console.error('[NotificationService] Failed to auto-configure notification_config:', err);
  }
}

export class NotificationService {
  /**
   * Universal method to create a notification. Calls the PostgreSQL RPC function
   * which handles deduplication, idempotency, and database storage.
   */
  static async createNotification(params: {
    userId: string;
    title: string;
    message: string;
    type: NotificationType;
    entityType: EntityType;
    targetScreen: NotificationTargetScreen;
    comboCount?: number;
    groupId?: string | null;
    appointmentId?: string | null;
  }) {
    await ensureConfig();
    const { data, error } = await supabaseAdmin.rpc('create_unified_notification', {
      p_user_id: params.userId,
      p_title: params.title,
      p_message: params.message,
      p_type: params.type,
      p_entity_type: params.entityType,
      p_target_screen: params.targetScreen,
      p_combo_count: params.comboCount || 1,
      p_group_id: params.groupId || null,
      p_appointment_id: params.appointmentId || null
    });

    if (error) {
      console.error('[NotificationService] Error creating notification:', error);
      throw error;
    }

    return data; // Returns the generated notification UUID (or existing notification UUID)
  }

  // Predefined high-level helper methods
  static async sendBookingRequest(params: {
    instructorId: string;
    studentName: string;
    comboCount: number;
    groupId: string;
  }) {
    const title = params.comboCount > 1 ? 'Novo combo solicitado' : 'Nova solicitação de aula';
    const message = params.comboCount > 1 
      ? `Você recebeu um novo pacote contendo ${params.comboCount} aulas de ${params.studentName}.`
      : `Você recebeu uma nova solicitação de aula de ${params.studentName}.`;

    return this.createNotification({
      userId: params.instructorId,
      title,
      message,
      type: NotificationType.BOOKING_REQUEST,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: NotificationTargetScreen.INSTRUCTOR_AGENDA,
      comboCount: params.comboCount,
      groupId: params.groupId
    });
  }

  static async sendBookingAccepted(params: {
    studentId: string;
    comboCount: number;
    groupId: string;
  }) {
    const title = params.comboCount > 1 ? 'Pacote aprovado!' : 'Aula confirmada!';
    const message = params.comboCount > 1
      ? `Seu pacote de ${params.comboCount} aulas foi aceito pelo instrutor.`
      : 'Sua aula foi confirmada pelo instrutor.';

    return this.createNotification({
      userId: params.studentId,
      title,
      message,
      type: NotificationType.BOOKING_ACCEPTED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: params.comboCount,
      groupId: params.groupId
    });
  }

  static async sendBookingRejected(params: {
    studentId: string;
    comboCount: number;
    groupId: string;
  }) {
    const title = params.comboCount > 1 ? 'Pacote recusado' : 'Aula recusada';
    const message = params.comboCount > 1
      ? `Seu pacote de ${params.comboCount} aulas foi recusado pelo instrutor e o valor foi reembolsado.`
      : 'Sua solicitação de aula foi recusada pelo instrutor e o valor foi reembolsado.';

    return this.createNotification({
      userId: params.studentId,
      title,
      message,
      type: NotificationType.BOOKING_REJECTED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: params.comboCount,
      groupId: params.groupId
    });
  }

  static async sendBookingCancelled(params: {
    userId: string;
    isInstructor: boolean;
    comboCount: number;
    groupId: string;
  }) {
    const title = params.comboCount > 1 ? 'Pacote cancelado' : 'Aula cancelada';
    const message = params.comboCount > 1
      ? `O pacote de ${params.comboCount} aulas foi cancelado.`
      : 'A aula agendada foi cancelada.';

    return this.createNotification({
      userId: params.userId,
      title,
      message,
      type: NotificationType.BOOKING_CANCELLED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: params.isInstructor ? NotificationTargetScreen.INSTRUCTOR_AGENDA : NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: params.comboCount,
      groupId: params.groupId
    });
  }

  static async sendBookingExpired(params: {
    userId: string;
    isInstructor: boolean;
    comboCount: number;
    groupId: string;
  }) {
    const title = params.comboCount > 1 ? 'Pacote expirado' : 'Agendamento expirado';
    const message = params.comboCount > 1
      ? `O prazo para aprovação do pacote de ${params.comboCount} aulas expirou.`
      : 'O prazo para aceitar a solicitação de aula expirou.';

    return this.createNotification({
      userId: params.userId,
      title,
      message,
      type: NotificationType.BOOKING_EXPIRED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: params.isInstructor ? NotificationTargetScreen.INSTRUCTOR_AGENDA : NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: params.comboCount,
      groupId: params.groupId
    });
  }

  static async sendTip(params: {
    instructorId: string;
    amountFormatted: string;
    appointmentId?: string | null;
  }) {
    return this.createNotification({
      userId: params.instructorId,
      title: '🎉 Você recebeu uma caixinha!',
      message: `Seu aluno enviou uma caixinha de ${params.amountFormatted}. O valor está disponível no seu financeiro.`,
      type: NotificationType.TIP,
      entityType: EntityType.FINANCE,
      targetScreen: NotificationTargetScreen.INSTRUCTOR_FINANCE,
      comboCount: 1,
      appointmentId: params.appointmentId
    });
  }

  static async sendBookingRescheduled(params: {
    instructorId: string;
    studentName: string;
    comboCount: number;
    groupId: string;
    appointmentId?: string | null;
    lessonDate?: string;
    lessonTime?: string;
  }) {
    const title = '📅 Solicitação de remarcação';
    let message = '';

    if (params.comboCount > 1) {
      message = `O aluno ${params.studentName} solicitou o reagendamento de um pacote de ${params.comboCount} aulas`;
      if (params.lessonDate && params.lessonTime) {
        message += ` (início em ${params.lessonDate} às ${params.lessonTime}).`;
      } else {
        message += `.`;
      }
    } else {
      message = `O aluno ${params.studentName} solicitou a remarcação `;
      if (params.lessonDate && params.lessonTime) {
        message += `da aula de ${params.lessonDate} às ${params.lessonTime}.`;
      } else {
        message += `desta aula.`;
      }
    }

    return this.createNotification({
      userId: params.instructorId,
      title,
      message,
      type: NotificationType.BOOKING_RESCHEDULED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: NotificationTargetScreen.INSTRUCTOR_AGENDA,
      comboCount: params.comboCount,
      groupId: params.groupId || null,
      appointmentId: params.appointmentId || null
    });
  }

  static async sendRescheduleAccepted(params: {
    studentId: string;
    comboCount: number;
    groupId: string;
    appointmentId?: string | null;
    lessonDate?: string;
    lessonTime?: string;
  }) {
    const title = '📅 Remarcação aprovada';
    let message = 'Seu instrutor aprovou sua solicitação de remarcação.';
    if (params.lessonDate && params.lessonTime) {
      message += ` Sua aula foi atualizada para: ${params.lessonDate} às ${params.lessonTime}.`;
    }

    return this.createNotification({
      userId: params.studentId,
      title,
      message,
      type: NotificationType.BOOKING_ACCEPTED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: params.comboCount,
      groupId: params.groupId || null,
      appointmentId: params.appointmentId || null
    });
  }

  static async sendRescheduleRejected(params: {
    studentId: string;
    comboCount: number;
    groupId: string;
    appointmentId?: string | null;
  }) {
    const title = '📅 Remarcação não aprovada';
    const message = 'Seu instrutor não aprovou a solicitação de remarcação. Sua aula permanece no horário originalmente agendado.';

    return this.createNotification({
      userId: params.studentId,
      title,
      message,
      type: NotificationType.BOOKING_REJECTED,
      entityType: params.comboCount > 1 ? EntityType.PACKAGE : EntityType.LESSON,
      targetScreen: NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: params.comboCount,
      groupId: params.groupId || null,
      appointmentId: params.appointmentId || null
    });
  }

  static async sendPaymentReleased(params: {
    userId: string;
    amountFormatted: string;
    appointmentId?: string | null;
  }) {
    return this.createNotification({
      userId: params.userId,
      title: '💸 Pagamento liberado!',
      message: `O pagamento no valor de ${params.amountFormatted} foi liberado com sucesso.`,
      type: NotificationType.PAYMENT_RELEASED,
      entityType: EntityType.FINANCE,
      targetScreen: NotificationTargetScreen.INSTRUCTOR_FINANCE,
      comboCount: 1,
      appointmentId: params.appointmentId
    });
  }

  static async sendReminder(params: {
    userId: string;
    title: string;
    message: string;
    targetScreen?: NotificationTargetScreen;
    appointmentId?: string | null;
  }) {
    return this.createNotification({
      userId: params.userId,
      title: params.title,
      message: params.message,
      type: NotificationType.REMINDER,
      entityType: EntityType.LESSON,
      targetScreen: params.targetScreen || NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: 1,
      appointmentId: params.appointmentId
    });
  }

  static async sendSystemNotification(params: {
    userId: string;
    title: string;
    message: string;
    targetScreen?: NotificationTargetScreen;
  }) {
    return this.createNotification({
      userId: params.userId,
      title: params.title,
      message: params.message,
      type: NotificationType.SYSTEM,
      entityType: EntityType.PROMOTION,
      targetScreen: params.targetScreen || NotificationTargetScreen.STUDENT_LESSONS,
      comboCount: 1
    });
  }
}
