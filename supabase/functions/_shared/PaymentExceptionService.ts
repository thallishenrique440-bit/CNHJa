// =============================================================================
// ARQUIVO GERADO AUTOMATICAMENTE — NAO EDITAR
//
// Fonte: lib/payments/PaymentExceptionService.ts
// Gerador: scripts/sync-shared.ts  (P-1.20.1B)
//
// Edite a fonte e rode `npx tsx scripts/sync-shared.ts`.
// `npx tsx scripts/sync-shared.ts --check` falha se este arquivo divergir.
// =============================================================================

// FASE 1 — excecoes de pagamento: pagamento recebido sem reserva valida.
//
// O QUE ESTE MODULO FAZ
//   Registra, de forma idempotente, UMA ocorrencia por pagamento do provedor
//   quando um pagamento chega e nao existe reserva valida para recebe-lo
//   (reserva expirada, cancelada, rejeitada, inexistente ou sem grupo).
//
// O QUE ESTE MODULO NUNCA FAZ
//   Nao confirma aula, nao reativa reserva, nao ocupa nem libera horario, nao
//   pede estorno, nao apaga registros e nao chama o provedor de pagamento. So'
//   le `transactions`, `payment_installments` e `appointments` e escreve em
//   `payment_exceptions`.
//
// IDEMPOTENCIA
//   A unicidade e' do banco: UNIQUE (exception_type, provider_payment_id). O
//   INSERT usa ON CONFLICT DO NOTHING; quem chega depois (evento repetido,
//   outro evento do mesmo pagamento, a conciliacao) encontra a linha existente.
//
// ESTADO DO PAGAMENTO
//   `CONFIRMED` (cartao autorizado) NAO e' recebimento. A fase do pagamento so'
//   avanca (other -> authorized -> received) e nunca regride por evento atrasado.
//   Uma excecao resolvida nunca e' reaberta: so' os fatos do pagamento avancam.
//
// A gestao (consulta, resolucao, responsavel) sera' do painel ADMCNHJa.
//
// Modulo compartilhado: a copia em supabase/functions/_shared e' GERADA por
// scripts/sync-shared.ts. Sem imports alem do tipo do cliente.

import { createClient } from 'npm:@supabase/supabase-js@2';
type SupabaseClient = ReturnType<typeof createClient>;

export const PAYMENT_WITHOUT_VALID_BOOKING = 'payment_without_valid_booking';

/** Fase financeira do pagamento no provedor, do ponto de vista do CNHJa. */
export type ProviderPaymentPhase = 'other' | 'authorized' | 'received';
export type ExceptionDetectionSource = 'webhook' | 'reconciliation';

const PHASE_RANK: Record<ProviderPaymentPhase, number> = { other: 0, authorized: 1, received: 2 };

/** Eventos do Asaas que o webhook trata como "pagamento da reserva". */
const PAID_EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_UPDATED'];
/** Estados em que a aula nao pode mais receber um pagamento (mesma lista do webhook). */
export const INVALID_BOOKING_STATUSES: readonly string[] = ['expired', 'cancelled', 'rejected'];
/**
 * `payment_status` que mostra que o sistema JA' atribuiu este pagamento 'a
 * reserva (aula paga e depois cancelada/expirada, com estorno em qualquer
 * situacao). Nesses casos o pagamento NAO e' orfao: e' assunto do fluxo de
 * estorno, nao desta tabela.
 */
export const ACKNOWLEDGED_PAYMENT_STATUSES: readonly string[] = ['paid', 'refund_requested', 'refund_denied', 'refunded'];

export class PaymentExceptionPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentExceptionPersistenceError';
  }
}

/**
 * RECEIVED / RECEIVED_IN_CASH = recebimento efetivo.
 * CONFIRMED = cartao autorizado, credito ainda futuro (NAO e' liquidacao).
 * Qualquer outro estado = `other`.
 */
export function classifyProviderPaymentStatus(status: unknown): { status: string; phase: ProviderPaymentPhase } {
  const normalized = String(status ?? '').trim().toUpperCase();
  if (normalized === 'RECEIVED' || normalized === 'RECEIVED_IN_CASH') return { status: normalized, phase: 'received' };
  if (normalized === 'CONFIRMED') return { status: normalized, phase: 'authorized' };
  return { status: normalized || 'UNKNOWN', phase: 'other' };
}

export interface BookingLessonState {
  id?: string | null;
  status?: string | null;
  payment_status?: string | null;
  student_id?: string | null;
  instructor_id?: string | null;
}

export type BookingState =
  | 'no_group' | 'not_found' | 'expired' | 'cancelled' | 'rejected' | 'mixed_invalid' | 'partially_invalid';

export interface BookingEvaluation {
  /** true = pagamento sem reserva valida: registrar. */
  shouldRecord: boolean;
  bookingState: BookingState | 'valid' | 'payment_acknowledged';
}

/**
 * Decide se o pagamento esta' sem reserva valida, a partir do estado ATUAL das
 * aulas. Mesma regra para o webhook e para a conciliacao.
 */
export function evaluateBooking(groupId: string | null | undefined, lessons: BookingLessonState[] | null | undefined): BookingEvaluation {
  const list = lessons || [];
  if (list.length === 0) return { shouldRecord: true, bookingState: groupId ? 'not_found' : 'no_group' };

  const invalid = list.filter((l) => INVALID_BOOKING_STATUSES.includes(String(l.status)));
  if (invalid.length === 0) return { shouldRecord: false, bookingState: 'valid' };

  // A reserva ja' foi paga antes de ser encerrada: o dinheiro esta' vinculado a
  // ela e segue o fluxo de estorno. Nao e' pagamento orfao.
  if (list.some((l) => ACKNOWLEDGED_PAYMENT_STATUSES.includes(String(l.payment_status)))) {
    return { shouldRecord: false, bookingState: 'payment_acknowledged' };
  }

  if (invalid.length < list.length) return { shouldRecord: true, bookingState: 'partially_invalid' };
  const statuses = Array.from(new Set(invalid.map((l) => String(l.status))));
  return { shouldRecord: true, bookingState: statuses.length === 1 ? (statuses[0] as BookingState) : 'mixed_invalid' };
}

export interface PaymentExceptionCandidate {
  providerPaymentId: string;
  provider?: string;
  providerPaymentStatus: string;
  groupId?: string | null;
  installmentNumber?: number | null;
  amountCents?: number | null;
  netAmountCents?: number | null;
  currency?: string;
  billingType?: string | null;
  receivedAt?: string | null;
  // deno-lint-ignore no-explicit-any
  splitSnapshot?: any;
  sourceEventId?: string | null;
  sourceEventType?: string | null;
}

const toCents = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

/**
 * Extrai do payload do Asaas o que interessa a esta tabela. Devolve null quando
 * o evento nao e' um pagamento de reserva (evento de outro tipo, estado nao
 * pago, caixinha, ou sem identificador de pagamento).
 */
// deno-lint-ignore no-explicit-any
export function candidateFromAsaasPayload(payload: any, sourceEventId?: string | null): PaymentExceptionCandidate | null {
  const event = String(payload?.event ?? '').toUpperCase();
  if (!PAID_EVENTS.includes(event)) return null;
  const payment = payload?.payment || {};
  const providerPaymentId = payment.id || payload?.paymentId || null;
  if (!providerPaymentId) return null;

  const externalReference = typeof payment.externalReference === 'string' ? payment.externalReference : '';
  if (externalReference.startsWith('tip:')) return null; // caixinha tem fluxo proprio

  // O evento informa o estado; na falta dele vale o nome do evento.
  const fallback = event === 'PAYMENT_RECEIVED' ? 'RECEIVED' : event === 'PAYMENT_CONFIRMED' ? 'CONFIRMED' : '';
  const { status, phase } = classifyProviderPaymentStatus(payment.status || fallback);
  if (phase === 'other') return null; // PAYMENT_UPDATED sem pagamento: nao e' ocorrencia

  return {
    providerPaymentId: String(providerPaymentId),
    provider: 'asaas',
    providerPaymentStatus: status,
    groupId: externalReference || null,
    installmentNumber: Number.isFinite(Number(payment.installmentNumber)) && payment.installmentNumber ? Number(payment.installmentNumber) : null,
    amountCents: toCents(payment.value),
    netAmountCents: toCents(payment.netValue),
    currency: 'BRL',
    billingType: payment.billingType || null,
    receivedAt: phase === 'received' ? (payment.paymentDate || payment.clientPaymentDate || null) : null,
    splitSnapshot: Array.isArray(payment.split) ? payment.split : null,
    sourceEventId: sourceEventId ?? payload?.id ?? null,
    sourceEventType: event,
  };
}

export interface RecordResult {
  outcome: 'created' | 'advanced' | 'unchanged' | 'not_applicable';
  exceptionId?: string;
  bookingState?: string;
  /** Estado da ocorrencia (open/resolved) depois da chamada. */
  status?: string;
}

const TABLE = 'payment_exceptions';
const SELECT_COLS = 'id, status, provider_payment_status, provider_payment_phase, received_at';

export class PaymentExceptionService {
  /**
   * Cria a ocorrencia ou, se ja' existir, avanca os fatos do pagamento.
   * Lanca PaymentExceptionPersistenceError quando nao consegue ler/gravar — o
   * chamador NAO deve tratar o evento como processado.
   */
  static async record(
    supabase: SupabaseClient,
    candidate: PaymentExceptionCandidate,
    booking: { bookingState: string; lessons?: BookingLessonState[] | null },
    detectedBy: ExceptionDetectionSource,
    nowIso: string = new Date().toISOString(),
  ): Promise<RecordResult> {
    const { status: providerStatus, phase } = classifyProviderPaymentStatus(candidate.providerPaymentStatus);
    const lessons = (booking.lessons || []).filter(Boolean);
    const lessonIds = lessons.map((l) => l.id).filter(isUuid);
    const first = lessons[0] || {};

    const row = {
      exception_type: PAYMENT_WITHOUT_VALID_BOOKING,
      provider: candidate.provider || 'asaas',
      provider_payment_id: candidate.providerPaymentId,
      installment_number: candidate.installmentNumber ?? null,
      group_id: candidate.groupId ?? null,
      appointment_ids: lessonIds,
      student_id: isUuid(first.student_id) ? first.student_id : null,
      instructor_id: isUuid(first.instructor_id) ? first.instructor_id : null,
      amount_cents: candidate.amountCents ?? null,
      net_amount_cents: candidate.netAmountCents ?? null,
      currency: candidate.currency || 'BRL',
      billing_type: candidate.billingType ?? null,
      provider_payment_status: providerStatus,
      provider_payment_phase: phase,
      received_at: phase === 'received' ? (candidate.receivedAt || nowIso) : null,
      booking_state: booking.bookingState,
      booking_snapshot: lessons.map((l) => ({ id: l.id ?? null, status: l.status ?? null, payment_status: l.payment_status ?? null })),
      split_snapshot: candidate.splitSnapshot ?? null,
      detected_by: detectedBy,
      detected_at: nowIso,
      last_seen_at: nowIso,
      source_event_id: candidate.sourceEventId ?? null,
      status: 'open',
      metadata: { source_event_type: candidate.sourceEventType ?? null },
    };

    // INSERT ... ON CONFLICT (exception_type, provider_payment_id) DO NOTHING.
    // deno-lint-ignore no-explicit-any
    const inserted: any = await (supabase as any)
      .from(TABLE)
      .upsert(row, { onConflict: 'exception_type,provider_payment_id', ignoreDuplicates: true })
      .select(SELECT_COLS);
    if (inserted.error) throw new PaymentExceptionPersistenceError(`insert failed: ${inserted.error.message || inserted.error}`);
    if (Array.isArray(inserted.data) && inserted.data.length > 0) {
      return { outcome: 'created', exceptionId: inserted.data[0].id, bookingState: booking.bookingState, status: 'open' };
    }

    // Ja' existia (evento repetido, outro evento do mesmo pagamento, ou a outra origem).
    // deno-lint-ignore no-explicit-any
    const found: any = await (supabase as any)
      .from(TABLE)
      .select(SELECT_COLS)
      .eq('exception_type', PAYMENT_WITHOUT_VALID_BOOKING)
      .eq('provider_payment_id', candidate.providerPaymentId)
      .maybeSingle();
    if (found.error) throw new PaymentExceptionPersistenceError(`lookup failed: ${found.error.message || found.error}`);
    if (!found.data) throw new PaymentExceptionPersistenceError('conflict reported but existing exception not found');

    const existing = found.data;
    const existingPhase = (existing.provider_payment_phase || 'other') as ProviderPaymentPhase;
    if (PHASE_RANK[phase] <= (PHASE_RANK[existingPhase] ?? 0)) {
      // Evento repetido ou atrasado: nada regride, nada e' reaberto.
      return { outcome: 'unchanged', exceptionId: existing.id, bookingState: booking.bookingState, status: existing.status };
    }

    // Avanco de fase (ex.: autorizado -> recebido). So' fatos do pagamento; o
    // estado da ocorrencia e os campos de resolucao NAO sao tocados. A escrita e'
    // condicional 'a fase lida: dois eventos concorrentes nao se sobrepoem.
    // deno-lint-ignore no-explicit-any
    const advanced: any = await (supabase as any)
      .from(TABLE)
      .update({
        provider_payment_status: providerStatus,
        provider_payment_phase: phase,
        received_at: phase === 'received' ? (candidate.receivedAt || nowIso) : existing.received_at,
        last_seen_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', existing.id)
      .eq('provider_payment_phase', existingPhase)
      .select('id');
    if (advanced.error) throw new PaymentExceptionPersistenceError(`advance failed: ${advanced.error.message || advanced.error}`);
    const applied = Array.isArray(advanced.data) && advanced.data.length > 0;
    return { outcome: applied ? 'advanced' : 'unchanged', exceptionId: existing.id, bookingState: booking.bookingState, status: existing.status };
  }

  /**
   * Ponto de entrada do WEBHOOK: avalia a reserva e registra se for o caso.
   * `lessons` e' o estado atual das aulas do grupo ([] quando nao ha' grupo ou
   * nao ha' aulas).
   */
  static async recordFromWebhook(
    supabase: SupabaseClient,
    // deno-lint-ignore no-explicit-any
    p: { payload: any; groupId: string | null | undefined; lessons: BookingLessonState[] | null | undefined; providerEventId?: string | null },
  ): Promise<RecordResult> {
    const candidate = candidateFromAsaasPayload(p.payload, p.providerEventId);
    if (!candidate) return { outcome: 'not_applicable' };
    const evaluation = evaluateBooking(p.groupId, p.lessons);
    if (!evaluation.shouldRecord) return { outcome: 'not_applicable', bookingState: evaluation.bookingState };
    return PaymentExceptionService.record(
      supabase,
      { ...candidate, groupId: p.groupId ?? candidate.groupId ?? null },
      { bookingState: evaluation.bookingState, lessons: p.lessons },
      'webhook',
    );
  }

  /**
   * Ponto de entrada da CONCILIACAO: varre SOMENTE o banco.
   *
   * Fontes de "pagamento que chegou":
   *   1. o ledger de eventos do webhook (`transactions`, type=webhook_event) —
   *      e' o registro de que o provedor avisou do pagamento, mesmo quando a
   *      parcela ja' estava CANCELLED e nao pode transicionar;
   *   2. parcelas em CONFIRMED/RECEIVED (`payment_installments`).
   *
   * Limitacao conhecida: um pagamento cujo aviso nunca chegou ao sistema, ou
   * nao foi persistido, nao aparece em nenhuma das fontes e nao e' detectado.
   */
  static async scanFromDatabase(
    supabase: SupabaseClient,
    opts: { sinceIso: string; limit?: number; nowIso?: string },
  ): Promise<{ candidates: number; created: number; advanced: number; unchanged: number; skippedValid: number; skippedExisting: number }> {
    const limit = opts.limit ?? 200;
    // deno-lint-ignore no-explicit-any
    const db = supabase as any;
    const fail = (what: string, error: { message?: string } | null) => {
      if (error) throw new PaymentExceptionPersistenceError(`${what}: ${error.message || error}`);
    };

    const byPayment = new Map<string, PaymentExceptionCandidate>();
    const keepBest = (c: PaymentExceptionCandidate) => {
      const current = byPayment.get(c.providerPaymentId);
      if (!current) { byPayment.set(c.providerPaymentId, c); return; }
      const better = PHASE_RANK[classifyProviderPaymentStatus(c.providerPaymentStatus).phase]
        > PHASE_RANK[classifyProviderPaymentStatus(current.providerPaymentStatus).phase];
      const winner = better ? c : current;
      const other = better ? current : c;
      // Completa o que faltar com o que a outra fonte souber.
      byPayment.set(c.providerPaymentId, {
        ...winner,
        groupId: winner.groupId ?? other.groupId ?? null,
        amountCents: winner.amountCents ?? other.amountCents ?? null,
        netAmountCents: winner.netAmountCents ?? other.netAmountCents ?? null,
        installmentNumber: winner.installmentNumber ?? other.installmentNumber ?? null,
        billingType: winner.billingType ?? other.billingType ?? null,
        receivedAt: winner.receivedAt ?? other.receivedAt ?? null,
      });
    };

    // 1. Ledger de eventos do webhook. O tipo de evento e' filtrado NO BANCO
    // (`raw_payload->>event`), antes do limite: eventos sem relacao com
    // pagamento (criacao, visualizacao, split...) nao podem ocupar as vagas.
    // `raw_payload` e' o JSON recebido do Asaas, com `event` em maiusculas.
    const ledger = await db
      .from('transactions')
      .select('id, provider_payment_id, provider_event_id, raw_payload, created_at')
      .eq('type', 'webhook_event')
      .eq('provider', 'asaas')
      .in('raw_payload->>event', PAID_EVENTS)
      .gte('created_at', opts.sinceIso)
      .order('created_at', { ascending: false })
      .limit(limit);
    fail('ledger lookup failed', ledger.error);
    for (const ev of ledger.data || []) {
      const candidate = candidateFromAsaasPayload(ev.raw_payload, ev.provider_event_id);
      if (candidate) keepBest(candidate);
    }

    // 2. Parcelas registradas como confirmadas ou recebidas.
    const installments = await db
      .from('payment_installments')
      .select('provider_payment_id, installment_number, group_id, gross_amount, net_amount, status, payment_date, updated_at')
      .in('status', ['CONFIRMED', 'RECEIVED'])
      .gte('updated_at', opts.sinceIso)
      .order('updated_at', { ascending: false })
      .limit(limit);
    fail('installment lookup failed', installments.error);
    for (const inst of installments.data || []) {
      if (!inst.provider_payment_id) continue;
      keepBest({
        providerPaymentId: String(inst.provider_payment_id),
        provider: 'asaas',
        providerPaymentStatus: inst.status,
        groupId: inst.group_id || null,
        installmentNumber: inst.installment_number ?? null,
        amountCents: inst.gross_amount ?? null,
        netAmountCents: inst.net_amount ?? null,
        receivedAt: inst.status === 'RECEIVED' ? (inst.payment_date || null) : null,
        sourceEventType: 'INSTALLMENT_RECORD',
      });
    }

    const out = { candidates: byPayment.size, created: 0, advanced: 0, unchanged: 0, skippedValid: 0, skippedExisting: 0 };
    if (byPayment.size === 0) return out;
    const paymentIds = Array.from(byPayment.keys());

    // 3. Ocorrencias ja' registradas: nada a fazer se a fase nao avanca.
    const existing = await db
      .from(TABLE)
      .select('provider_payment_id, provider_payment_phase')
      .eq('exception_type', PAYMENT_WITHOUT_VALID_BOOKING)
      .in('provider_payment_id', paymentIds);
    fail('exception lookup failed', existing.error);
    const existingPhase = new Map<string, ProviderPaymentPhase>(
      ((existing.data || []) as Array<{ provider_payment_id: string; provider_payment_phase: ProviderPaymentPhase }>)
        .map((e) => [e.provider_payment_id, e.provider_payment_phase]));

    // 4. Estado atual das aulas: por grupo e, na falta dele, pelo pagamento.
    const selectLessons = 'id, group_id, status, payment_status, student_id, instructor_id, provider_payment_id';
    const groupIds = Array.from(new Set(Array.from(byPayment.values()).map((c) => c.groupId).filter(isUuid)));
    // deno-lint-ignore no-explicit-any
    const lessonsByGroup = new Map<string, any[]>();
    if (groupIds.length > 0) {
      const res = await db.from('appointments').select(selectLessons).in('group_id', groupIds);
      fail('appointment lookup failed', res.error);
      for (const l of res.data || []) {
        if (!lessonsByGroup.has(l.group_id)) lessonsByGroup.set(l.group_id, []);
        lessonsByGroup.get(l.group_id)!.push(l);
      }
    }
    const byPaymentLookup = paymentIds.filter((id) => !isUuid(byPayment.get(id)!.groupId));
    // deno-lint-ignore no-explicit-any
    const lessonsByPayment = new Map<string, any[]>();
    if (byPaymentLookup.length > 0) {
      const res = await db.from('appointments').select(selectLessons).in('provider_payment_id', byPaymentLookup);
      fail('appointment lookup failed', res.error);
      for (const l of res.data || []) {
        if (!lessonsByPayment.has(l.provider_payment_id)) lessonsByPayment.set(l.provider_payment_id, []);
        lessonsByPayment.get(l.provider_payment_id)!.push(l);
      }
    }

    // 5. Decide e registra.
    for (const candidate of byPayment.values()) {
      const phase = classifyProviderPaymentStatus(candidate.providerPaymentStatus).phase;
      const known = existingPhase.get(candidate.providerPaymentId);
      if (known !== undefined && PHASE_RANK[phase] <= (PHASE_RANK[known] ?? 0)) { out.skippedExisting++; continue; }

      let lessons = isUuid(candidate.groupId) ? (lessonsByGroup.get(candidate.groupId) || []) : (lessonsByPayment.get(candidate.providerPaymentId) || []);
      let groupId = candidate.groupId ?? null;
      if (!groupId && lessons.length > 0) groupId = lessons[0].group_id || null;
      lessons = lessons || [];

      const evaluation = evaluateBooking(groupId, lessons);
      if (!evaluation.shouldRecord) { out.skippedValid++; continue; }

      const result = await PaymentExceptionService.record(
        supabase, { ...candidate, groupId }, { bookingState: evaluation.bookingState, lessons }, 'reconciliation', opts.nowIso);
      if (result.outcome === 'created') out.created++;
      else if (result.outcome === 'advanced') out.advanced++;
      else out.unchanged++;
    }
    return out;
  }
}
