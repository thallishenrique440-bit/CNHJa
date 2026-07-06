
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
  | 'reserved'
  | 'awaiting_payment'
  | 'no_show';

export type LessonDisplayStatus = 
  | 'pending'           // Aguardando aprovação (legacy/fallback)
  | 'pending_approval'  // Aguardando aprovação do instrutor
  | 'confirmed'         // Confirmada (futura)
  | 'in_progress'       // Em andamento (agora)
  | 'awaiting_completion' // Aguardando finalização (passada mas não concluída no banco)
  | 'completed'         // Concluída (no banco)
  | 'cancelled'         // Cancelada
  | 'rejected'          // Recusada
  | 'expired'           // Expirada (não confirmada a tempo)
  | 'blocked'           // Bloqueada pelo instrutor
  | 'reserved'          // Reservada (pagamento em curso)
  | 'awaiting_payment'  // Aguardando confirmação de pagamento (Asaas)
  | 'no_show'           // Aluno não compareceu
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
  now: Date,
  isInstructor: boolean = false
): LessonDisplayStatus {
  // Defensive checks for missing or invalid inputs
  if (!dateStr || !startTimeStr || !endTimeStr) {
    console.warn('getDerivedStatus: Missing required time fields', { dateStr, startTimeStr, endTimeStr });
    return dbStatus as LessonDisplayStatus;
  }

  // Parsing date and time
  // Ensure we only take the YYYY-MM-DD part if dateStr contains time
  const cleanDateStr = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  const dateParts = cleanDateStr.split('-').map(Number);
  const startParts = startTimeStr.split(':').map(Number);
  const endParts = endTimeStr.split(':').map(Number);

  if (dateParts.length < 3 || startParts.length < 2 || endParts.length < 2) {
    return dbStatus as LessonDisplayStatus;
  }

  const [year, month, day] = dateParts;
  const [startH, startM] = startParts;
  const [endH, endM] = endParts;

  // Use explicit Brazil timezone offset (-03:00) for consistent interpretation
  // across both frontend (browser) and backend (Edge Functions/UTC)
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(startH)}:${pad(startM)}:00-03:00`);
  const end = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(endH)}:${pad(endM)}:00-03:00`);

  // Safety check for invalid dates
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return dbStatus as LessonDisplayStatus;
  }

  // Lógica baseada em tempo APENAS para aulas confirmadas ou agendadas
  if (dbStatus === 'confirmed' || dbStatus === 'scheduled') {
    if (now < start) return 'confirmed';
    if (now >= start && now < end) return 'in_progress';
    
    // Para instrutores, aulas passadas são sempre 'completed' na UI
    if (isInstructor) return 'completed';
    
    return 'awaiting_completion';
  }

  // Para todos os outros status (cancelled, rejected, completed, expired, etc.), 
  // retorna o status original sem modificação baseada em tempo.
  return dbStatus as LessonDisplayStatus;
}
