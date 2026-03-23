
export type LessonDBStatus = 
  | 'pending' 
  | 'pending_approval' 
  | 'confirmed' 
  | 'scheduled' 
  | 'completed' 
  | 'cancelled' 
  | 'rejected' 
  | 'expired' 
  | 'blocked' 
  | 'reserved';

export type LessonDisplayStatus = 
  | 'pending'           // Aguardando aprovação
  | 'confirmed'         // Confirmada (futura)
  | 'in_progress'       // Em andamento (agora)
  | 'awaiting_completion' // Aguardando finalização (passada mas não concluída no banco)
  | 'completed'         // Concluída (no banco)
  | 'cancelled'         // Cancelada
  | 'rejected'          // Recusada
  | 'expired'           // Expirada (não confirmada a tempo)
  | 'blocked'           // Bloqueada pelo instrutor
  | 'reserved'          // Reservada (pagamento em curso)
  | 'free'              // Livre (apenas instrutor)
  | 'lunch'             // Almoço (apenas instrutor)
  | 'unavailable';      // Indisponível (apenas instrutor)

/**
 * Deriva o status de exibição de uma aula com base no status do banco e no tempo atual.
 */
export function getDerivedStatus(
  dbStatus: string,
  dateStr: string,
  startTimeStr: string,
  endTimeStr: string,
  now: Date
): LessonDisplayStatus {
  // Parsing date and time
  // Ensure we only take the YYYY-MM-DD part if dateStr contains time
  const cleanDateStr = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  const [year, month, day] = cleanDateStr.split('-').map(Number);
  const [startH, startM] = startTimeStr.split(':').map(Number);
  const [endH, endM] = endTimeStr.split(':').map(Number);

  const start = new Date(year, month - 1, day, startH, startM);
  const end = new Date(year, month - 1, day, endH, endM);

  // Safety check for invalid dates
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return dbStatus as LessonDisplayStatus;
  }

  // Status terminais do banco
  if (dbStatus === 'completed') return 'completed';
  if (dbStatus === 'cancelled') return 'cancelled';
  if (dbStatus === 'rejected') return 'rejected';
  if (dbStatus === 'blocked') return 'blocked';
  if (dbStatus === 'reserved') return 'reserved';
  if (dbStatus === 'expired') return 'expired';

  // Lógica para pendentes (não confirmadas)
  if (dbStatus === 'pending' || dbStatus === 'pending_approval') {
    if (now >= start) return 'expired';
    return 'pending';
  }

  // Lógica para confirmadas/agendadas
  if (dbStatus === 'confirmed' || dbStatus === 'scheduled') {
    if (now < start) return 'confirmed';
    if (now >= start && now < end) return 'in_progress';
    return 'awaiting_completion';
  }

  return dbStatus as LessonDisplayStatus;
}
