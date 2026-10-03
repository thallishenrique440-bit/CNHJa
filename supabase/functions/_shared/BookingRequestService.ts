// =============================================================================
// ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR
//
// Fonte: lib/payments/BookingRequestService.ts
// Gerador: scripts/sync-shared.ts  (P-1.20.1B)
//
// Edite a fonte e rode `npx tsx scripts/sync-shared.ts`.
// `npx tsx scripts/sync-shared.ts --check` falha se este arquivo divergir.
// =============================================================================

// FASE 3 — novo fluxo de agendamento: camada de backend sobre o contrato da Fase 2.
//
// Pedido sem pagamento -> aceite do instrutor -> janela de pagamento ->
// pagamento confirmado pelo provedor -> aula confirmada.
//
// Este modulo NAO decide estado sozinho: toda transicao e' feita pelas funcoes
// atomicas do banco `booking_request_*` (migrations 20261003_booking_request_
// atomic_ops e 20261003_booking_request_accept_deadline), que travam o grupo
// inteiro e sao idempotentes. Aqui ficam:
//   - as chamadas tipadas as funcoes do banco;
//   - regras puras (prazo de resposta, decisao de expiracao com cobranca).
//
// Decisao de 03/10/2026: o novo fluxo e' o PADRAO, sem chave de ativacao.
// Linhas antigas (`booking_flow = 'legacy'`) continuam no caminho anterior ate'
// a remocao do legado; elas nunca passam por aqui.
//
// Modulo compartilhado: a copia em supabase/functions/_shared e' GERADA por
// scripts/sync-shared.ts. Sem imports alem do tipo do cliente.

import { createClient } from 'npm:@supabase/supabase-js@2';
type SupabaseClient = ReturnType<typeof createClient>;

export const BOOKING_FLOW_REQUEST = 'request';
export const BOOKING_FLOW_LEGACY = 'legacy';
/**
 * Janela de pagamento apos o aceite (minutos). O banco grava
 * expires_at = min(aceite + janela, inicio da primeira aula) e e' a autoridade.
 */
export const PAYMENT_WINDOW_MINUTES = 15;

// ---------------------------------------------------------------------------
// Prazos
// ---------------------------------------------------------------------------

type LessonTime = { date?: string | null; start_time?: string | null; startTime?: string | null };

/** Inicio da aula em UTC (data e hora gravadas em horario de Brasilia, -03:00). */
export function lessonStartMs(l: LessonTime): number {
  const date = String(l.date ?? '').slice(0, 10);
  const time = String(l.start_time ?? l.startTime ?? '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  return new Date(`${date}T${time}:00-03:00`).getTime();
}

/**
 * Prazo de RESPOSTA do instrutor para um pedido: o inicio da primeira aula do
 * grupo. Depois disso o pedido nao pode mais ser aceito (o banco devolve
 * REQUEST_EXPIRED) e a expiracao libera os horarios.
 */
export function requestResponseDeadlineIso(lessons: LessonTime[]): string | null {
  const starts = lessons.map(lessonStartMs).filter(Number.isFinite);
  if (starts.length === 0) return null;
  return new Date(Math.min(...starts)).toISOString();
}

// ---------------------------------------------------------------------------
// Chamadas as funcoes atomicas
// ---------------------------------------------------------------------------

export interface OpResult {
  ok: boolean;
  outcome: string;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

export class BookingRequestOpError extends Error {
  constructor(public readonly op: string, message: string) {
    super(`${op}: ${message}`);
    this.name = 'BookingRequestOpError';
  }
}

// deno-lint-ignore no-explicit-any
async function callOp(db: SupabaseClient, fn: string, args: Record<string, any>): Promise<OpResult> {
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db as any).rpc(fn, args);
  if (error) throw new BookingRequestOpError(fn, error.message || String(error));
  if (!data || typeof data !== 'object' || typeof data.outcome !== 'string') {
    throw new BookingRequestOpError(fn, 'resposta inesperada do banco');
  }
  return data as OpResult;
}

export class BookingRequestService {
  static accept(db: SupabaseClient, groupId: string, instructorId: string, windowMinutes = PAYMENT_WINDOW_MINUTES) {
    return callOp(db, 'booking_request_accept', { p_group_id: groupId, p_instructor_id: instructorId, p_payment_window_minutes: windowMinutes });
  }
  static reject(db: SupabaseClient, groupId: string, instructorId: string) {
    return callOp(db, 'booking_request_reject', { p_group_id: groupId, p_instructor_id: instructorId });
  }
  static cancelByStudent(db: SupabaseClient, groupId: string, studentId: string) {
    return callOp(db, 'booking_request_cancel_by_student', { p_group_id: groupId, p_student_id: studentId });
  }
  static startPayment(db: SupabaseClient, groupId: string, studentId: string) {
    return callOp(db, 'booking_request_start_payment', { p_group_id: groupId, p_student_id: studentId });
  }
  static attachPayment(db: SupabaseClient, groupId: string, providerName: string, providerPaymentId: string) {
    return callOp(db, 'booking_request_attach_payment', { p_group_id: groupId, p_provider_name: providerName, p_provider_payment_id: providerPaymentId });
  }
  static confirmPayment(db: SupabaseClient, groupId: string, providerPaymentId: string) {
    return callOp(db, 'booking_request_confirm_payment', { p_group_id: groupId, p_provider_payment_id: providerPaymentId });
  }
  static expire(db: SupabaseClient, groupId: string, chargeSettled: boolean) {
    return callOp(db, 'booking_request_expire', { p_group_id: groupId, p_charge_settled: chargeSettled });
  }
}

/** Resultado da funcao do banco -> status HTTP da API. */
export function httpStatusForOutcome(r: Pick<OpResult, 'ok' | 'outcome'>): number {
  if (r.ok) return 200;
  switch (r.outcome) {
    case 'INVALID_ARGUMENT': return 400;
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    default: return 409; // INVALID_STATE, REQUEST_EXPIRED, TOO_LATE, RESERVATION_EXPIRED, HAS_PAYMENT, PAYMENT_CONFLICT, ...
  }
}

// ---------------------------------------------------------------------------
// Pagamento: estados do provedor
// ---------------------------------------------------------------------------

/**
 * Estados do Asaas que confirmam a reserva. Mesma regra do fluxo atual no
 * webhook: RECEIVED / RECEIVED_IN_CASH (recebido) e CONFIRMED (cartao
 * aprovado). A liquidacao financeira continua so' em RECEIVED (SettlementService).
 */
export function isBookingConfirmingStatus(status: unknown): boolean {
  return ['RECEIVED', 'RECEIVED_IN_CASH', 'CONFIRMED'].includes(String(status ?? '').toUpperCase());
}

/**
 * Expiracao de um pedido com cobranca vinculada. O prazo venceu, mas o
 * horario continua protegido ate' a decisao:
 *   - provedor diz que esta' pago      -> NAO expira; aguarda a confirmacao
 *                                         (webhook ou conciliacao). O pagamento
 *                                         aconteceu enquanto a reserva estava ativa.
 *   - provedor diz que nao esta' pago  -> cancela a cobranca e so' entao expira.
 *   - estado desconhecido (falha)      -> nao faz nada; tenta no proximo ciclo.
 */
export type RequestExpiryAction = 'expire' | 'cancel_charge_then_expire' | 'await_confirmation' | 'retry_later';

export function decideRequestExpiry(hasCharge: boolean, gatewayStatus: string | null | undefined): RequestExpiryAction {
  if (!hasCharge) return 'expire';
  if (gatewayStatus === null || gatewayStatus === undefined || gatewayStatus === '') return 'retry_later';
  if (isBookingConfirmingStatus(gatewayStatus)) return 'await_confirmation';
  return 'cancel_charge_then_expire';
}

// ---------------------------------------------------------------------------
// Expiracao (cron check-expired-bookings, Modulo C)
// ---------------------------------------------------------------------------

export interface RequestExpiryReport {
  groups: number;
  expired: number;
  awaitingConfirmation: number;
  retryLater: number;
  skipped: number;
  failed: number;
  expiredGroups: Array<{ groupId: string; studentId: string | null; instructorId: string | null; lessons: number; stage: string }>;
}

/**
 * Um ciclo de expiracao do novo fluxo. Idempotente: repetir o ciclo nao
 * expira de novo (o banco devolve ALREADY_EXPIRED) nem cancela cobranca paga.
 * O provedor e' acessado pelas funcoes injetadas (o modulo nao faz rede).
 */
export async function runRequestExpiryCycle(p: {
  db: SupabaseClient;
  nowIso: string;
  limit?: number;
  /** Estado da cobranca no provedor; null = desconhecido (falha de consulta). */
  getGatewayStatus: (providerPaymentId: string) => Promise<string | null>;
  /** Cancela a cobranca no provedor; true = cancelada (ou ja' inexistente). */
  cancelCharge: (providerPaymentId: string) => Promise<boolean>;
}): Promise<RequestExpiryReport> {
  const report: RequestExpiryReport = { groups: 0, expired: 0, awaitingConfirmation: 0, retryLater: 0, skipped: 0, failed: 0, expiredGroups: [] };
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (p.db as any)
    .from('appointments')
    .select('id, group_id, status, student_id, instructor_id, provider_payment_id, expires_at')
    .eq('booking_flow', BOOKING_FLOW_REQUEST)
    .in('status', ['pending', 'reserved', 'awaiting_payment'])
    .lt('expires_at', p.nowIso)
    .order('expires_at', { ascending: true })
    .limit(p.limit ?? 100);
  if (error) throw new BookingRequestOpError('request_expiry_lookup', error.message || String(error));

  // deno-lint-ignore no-explicit-any
  const byGroup = new Map<string, any[]>();
  for (const row of data || []) {
    if (!row.group_id) { report.skipped++; continue; }
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, []);
    byGroup.get(row.group_id)!.push(row);
  }
  report.groups = byGroup.size;

  for (const [groupId, rows] of byGroup) {
    try {
      const chargeId: string | null = rows.find((r) => r.provider_payment_id)?.provider_payment_id ?? null;
      const gatewayStatus = chargeId ? await p.getGatewayStatus(chargeId) : null;
      let action = decideRequestExpiry(!!chargeId, gatewayStatus);

      if (action === 'await_confirmation') { report.awaitingConfirmation++; continue; }
      if (action === 'retry_later') { report.retryLater++; continue; }
      if (action === 'cancel_charge_then_expire') {
        const cancelled = await p.cancelCharge(chargeId as string);
        if (!cancelled) { report.retryLater++; continue; }
        action = 'expire';
      }

      const r = await BookingRequestService.expire(p.db, groupId, !!chargeId);
      if (r.ok && r.outcome === 'EXPIRED') {
        report.expired++;
        const first = rows[0];
        report.expiredGroups.push({
          groupId, studentId: first.student_id ?? null, instructorId: first.instructor_id ?? null,
          lessons: r.lessons ?? rows.length, stage: String(first.status),
        });
      } else if (r.ok) {
        report.skipped++; // ALREADY_EXPIRED: outra execucao ja' tratou
      } else {
        report.skipped++; // NOT_DUE / INVALID_STATE (ex.: confirmado entre a leitura e a chamada)
      }
    } catch (err) {
      report.failed++;
      // deno-lint-ignore no-explicit-any
      console.error(`[BookingRequestExpiry] grupo ${groupId}: ${(err as any)?.message ?? err}`);
    }
  }
  return report;
}
