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
  TIP = 'tip'
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
}
