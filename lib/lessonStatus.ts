
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
    return (dbStatus === 'pending_approval' ? 'pending' : dbStatus) as LessonDisplayStatus;
  }

  // Lógica baseada em tempo APENAS para aulas confirmadas ou agendadas
  if (dbStatus === 'confirmed' || dbStatus === 'scheduled') {
    if (now < start) return 'confirmed';
    if (now >= start && now < end) return 'in_progress';
    return 'awaiting_completion';
  }

  // Mapeamento necessário para compatibilidade com LessonDisplayStatus
  if (dbStatus === 'pending_approval') return 'pending';

  // Para todos os outros status (cancelled, rejected, completed, expired, etc.), 
  // retorna o status original sem modificação baseada em tempo.
  return dbStatus as LessonDisplayStatus;
}
