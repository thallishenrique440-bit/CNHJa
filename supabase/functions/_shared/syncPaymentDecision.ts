// FASE 0 — decisoes da conciliacao (`sync-payment-status`), como funcoes puras.
//
// Sao as MESMAS condicoes que ja' existiam dentro do handler, extraidas sem
// mudanca de regra para poderem ser testadas fora do Deno. O handler continua
// sendo o unico lugar que le o gateway e escreve no banco.
//
// Sem imports de Deno nem de URL: o modulo roda tambem no Node, para teste.

/** Estados operacionais que significam "aula encerrada". */
export const CLOSED_GROUP_STATUSES = ['expired', 'cancelled', 'rejected'];

export type SyncGroupDecision =
  /** Asaas diz REFUNDED (estorno integral): alinhar `payment_status`, ledger e parcela. */
  | 'repair_refunded'
  /** Asaas diz PARTIALLY_REFUNDED: nada a fazer aqui (decidido por operacao de estorno). */
  | 'skip_partial_refund'
  /** Pagamento recebido/confirmado e alguma aula do grupo ja' encerrada: so' o estorno e' avaliado. */
  | 'closed_group'
  /** Cartao autorizado (CONFIRMED), credito ainda futuro: nenhuma acao. */
  | 'skip_not_received'
  /** Pagamento efetivamente recebido e grupo aberto: delegar a liquidacao oficial. */
  | 'reconcile_payment'
  /** Qualquer outro status do gateway (pendente, vencido, desconhecido): nenhuma acao. */
  | 'skip_other';

export function classifySyncGroup(asaasStatus: string | null | undefined, groupStatuses: string[]): SyncGroupDecision {
  const status = String(asaasStatus || '').toUpperCase();
  if (status === 'REFUNDED') return 'repair_refunded';
  if (status === 'PARTIALLY_REFUNDED') return 'skip_partial_refund';
  if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(status)) {
    if ((groupStatuses || []).some((s) => CLOSED_GROUP_STATUSES.includes(s))) return 'closed_group';
    return ['RECEIVED', 'RECEIVED_IN_CASH'].includes(status) ? 'reconcile_payment' : 'skip_not_received';
  }
  return 'skip_other';
}

export type ClosedGroupRefundAction =
  /** O gateway mostra o estorno recusado: ledger `failed`, aula `refund_denied`/`paid`. */
  | 'mark_denied'
  /** O gateway mostra o estorno concluido: aula `refunded`, ledger `completed`. */
  | 'mark_refunded'
  /** Pendente, ausente ou desconhecido: preservar. Ausencia de evidencia NAO e' recusa. */
  | 'preserve_pending'
  /** Nao ha' transacao de estorno pendente no banco: nada a conciliar. */
  | 'skip_closed';

export function classifyClosedGroupRefund(refundState: string | null | undefined, pendingRefundTxCount: number): ClosedGroupRefundAction {
  if (!pendingRefundTxCount || pendingRefundTxCount <= 0) return 'skip_closed';
  if (refundState === 'DENIED') return 'mark_denied';
  if (refundState === 'COMPLETED') return 'mark_refunded';
  return 'preserve_pending';
}

/**
 * `payment_status` de uma aula cujo estorno foi recusado pelo gateway.
 * Recusa de estorno NUNCA vira pagamento falho: aula encerrada -> `refund_denied`;
 * aula ainda aberta -> `paid` (mesma regra de BookingCancellationCore.releaseAfterDenial).
 */
export function paymentStatusAfterRefundDenial(appointmentStatus: string): 'refund_denied' | 'paid' {
  return ['cancelled', 'expired'].includes(appointmentStatus) ? 'refund_denied' : 'paid';
}

// =============================================================================
// ELEGIBILIDADE OPERACIONAL — aulas passadas ficam fora da conciliacao
// =============================================================================
//
// Decisao de negocio (2026-10-01): aulas passadas nao sao objeto de recuperacao
// nem de conciliacao historica. O job so' trabalha sobre o que ainda tem
// obrigacao operacional vigente.
//
// REGRA
//   Um grupo (ou uma operacao de estorno) e' elegivel quando a ULTIMA aula
//   envolvida termina em, ou depois de, `limite`, onde
//       limite = max(agora - tolerancia, data minima configurada)
//   - aula futura ou em andamento: termina depois de agora -> sempre elegivel;
//   - aula encerrada ha' menos que a tolerancia: elegivel (o pagamento ou o
//     estorno dela ainda pode estar sendo processado);
//   - aula encerrada ha' mais que a tolerancia: historica -> ignorada, sem
//     consulta ao gateway e sem nenhuma escrita.
//   Em combos vale a aula que termina por ultimo: um combo com uma aula futura
//   continua elegivel inteiro.
//
// O horario da aula e' interpretado em America/Sao_Paulo (-03:00), como no
// restante do sistema. Dado ausente ou invalido NAO torna o registro elegivel.

export interface SyncEligibilityConfig {
  /** Quanto tempo depois do fim da aula o registro ainda e' conciliado. */
  pastLessonGraceMs: number;
  /** Aulas que terminam antes deste instante sao sempre ignoradas (opcional). */
  minLessonEndMs: number | null;
}

export const DEFAULT_PAST_LESSON_GRACE_HOURS = 24;

/** Le a configuracao do ambiente. Valores ausentes ou invalidos caem no padrao. */
export function resolveSyncEligibilityConfig(getEnv: (name: string) => string | undefined): SyncEligibilityConfig {
  const hours = Number(getEnv('SYNC_PAST_LESSON_GRACE_HOURS'));
  const graceHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PAST_LESSON_GRACE_HOURS;
  // SYNC_MIN_LESSON_DATE=AAAA-MM-DD: nada com aula anterior a esta data (horario de Brasilia) e' processado.
  const rawDate = String(getEnv('SYNC_MIN_LESSON_DATE') || '').trim();
  const minMs = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? new Date(`${rawDate}T00:00:00-03:00`).getTime() : NaN;
  return { pastLessonGraceMs: graceHours * 60 * 60 * 1000, minLessonEndMs: Number.isFinite(minMs) ? minMs : null };
}

export interface LessonTimeRef { date?: string | null; start_time?: string | null; end_time?: string | null }

/** Fim da aula em ms (UTC). Sem `end_time`, usa inicio + 60 min. `null` se nao for possivel determinar. */
export function lessonEndMs(lesson: LessonTimeRef): number | null {
  const date = String(lesson?.date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hhmm = (v: unknown) => {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  };
  const end = hhmm(lesson.end_time);
  const start = hhmm(lesson.start_time);
  if (end) {
    const ms = new Date(`${date}T${end}:00-03:00`).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (start) {
    const ms = new Date(`${date}T${start}:00-03:00`).getTime();
    return Number.isFinite(ms) ? ms + 60 * 60 * 1000 : null;
  }
  return null;
}

/** Instante a partir do qual o fim da aula ainda conta como operacionalmente vigente. */
export function eligibilityThresholdMs(nowMs: number, cfg: SyncEligibilityConfig): number {
  const byGrace = nowMs - cfg.pastLessonGraceMs;
  return cfg.minLessonEndMs !== null ? Math.max(byGrace, cfg.minLessonEndMs) : byGrace;
}

/** Ha' obrigacao operacional vigente? Vale a aula que termina por ultimo. */
export function isOperationallyCurrent(lessons: LessonTimeRef[], nowMs: number, cfg: SyncEligibilityConfig): boolean {
  const ends = (lessons || []).map(lessonEndMs).filter((v): v is number => v !== null);
  if (ends.length === 0) return false;
  return Math.max(...ends) >= eligibilityThresholdMs(nowMs, cfg);
}
