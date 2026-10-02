// FASE 0 — fila de notificacoes push: ciclo do worker, recuperacao e politica de
// tentativas.
//
// PROBLEMA QUE ESTE MODULO RESOLVE
//   `claim_notification_jobs` move o job de `pending` para `processing` e so'
//   `mark_notification_job_sent` o tirava de la'. Quando o envio falhava, o
//   worker apenas registrava o erro: o job ficava em `processing` para sempre,
//   com `attempts = 0`, e nunca mais era selecionado (a RPC so' le `pending`).
//   Nao havia recuperacao apos falha, timeout ou reinicio do worker.
//
// O QUE MUDA (sem alteracao de schema — a tabela ja' tem `attempts`,
// `max_attempts`, `next_run_at`, `last_error`, `metadata` e os status
// `failed`, `dead`, `cancelled`, `expired`):
//   - falha de envio devolve o job a `pending` com tentativa contada e espera
//     crescente; ao atingir `max_attempts` vira `dead`;
//   - job abandonado em `processing` alem de um prazo seguro e' recuperado;
//   - notificacao antiga demais para ainda fazer sentido vira `expired`;
//   - so' vira `sent` o que o provedor de push CONFIRMOU ter aceitado;
//   - envio de desfecho desconhecido (worker morreu depois de iniciar o envio)
//     NAO e' reenviado e NAO e' marcado como entregue: vira `failed`.
//
// CONCORRENCIA
//   Toda escrita e' condicional (`status = 'processing'` e `locked_by` igual ao
//   de quem leu). Dois workers nunca aplicam a mesma transicao: o segundo nao
//   altera nenhuma linha.
//
// Sem imports de Deno nem de URL: o modulo roda tambem no Node, para teste.

/** Subconjunto do cliente Supabase usado aqui (permite banco em memoria no teste). */
// deno-lint-ignore no-explicit-any
export type QueueDb = any;

export interface NotificationJobRow {
  notification_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  next_run_at: string;
  last_error: string | null;
  // deno-lint-ignore no-explicit-any
  metadata: Record<string, any> | null;
  created_at: string;
}

export interface QueueConfig {
  /** Job em `processing` ha' mais que isto e' considerado abandonado. */
  staleProcessingMs: number;
  /**
   * Validade do push para tipos TEMPORALMENTE CRITICOS (ver
   * TIME_CRITICAL_TYPES): criada ha' mais que isto, nao e' mais enviada.
   */
  maxNotificationAgeMs: number;
  /** Validade para os demais tipos (o aviso continua util por mais tempo). */
  maxStandardNotificationAgeMs: number;
  /** Espera antes da nova tentativa: base * 2^(tentativa - 1), com teto. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** Quantos jobs abandonados examinar por ciclo. */
  recoveryBatchSize: number;
  /** Quantos jobs reivindicar por ciclo. */
  batchSize: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  // Bem acima do tempo maximo de execucao de uma Edge Function: um job so' e'
  // tratado como abandonado quando o worker que o reivindicou ja' nao existe.
  staleProcessingMs: 10 * 60 * 1000,
  // Um push que chega horas depois de "nova solicitacao" ou "agendamento
  // expirado" e' ruido. O aviso continua disponivel dentro do aplicativo.
  maxNotificationAgeMs: 60 * 60 * 1000,
  maxStandardNotificationAgeMs: 24 * 60 * 60 * 1000,
  retryBaseMs: 60 * 1000,
  retryMaxMs: 15 * 60 * 1000,
  recoveryBatchSize: 50,
  batchSize: 10,
};

/**
 * Tipos cujo push so' serve se chegar logo: pedem uma acao com prazo ou
 * informam o desfecho de um agendamento. Recebem tratamento diferenciado:
 *   - validade curta (`maxNotificationAgeMs`): um aviso atrasado nao e' enviado;
 *   - quando NAO sao entregues (dead, failed, expired, desfecho desconhecido),
 *     entram em `criticalUndelivered` e o ciclo e' registrado em nivel de erro.
 * Os demais tipos (lembrete, caixinha, repasse, remarcacao, sistema) usam a
 * validade longa e nao disparam o alerta de critico.
 */
export const TIME_CRITICAL_TYPES: readonly string[] = [
  'booking_request', 'booking_accepted', 'booking_rejected', 'booking_cancelled', 'booking_expired',
];

export function isTimeCritical(type: string | null | undefined): boolean {
  return TIME_CRITICAL_TYPES.includes(String(type || ''));
}

/** Validade do push conforme o tipo. Tipo desconhecido usa a validade longa. */
export function maxAgeMsFor(type: string | null | undefined, cfg: QueueConfig): number {
  return isTimeCritical(type) ? cfg.maxNotificationAgeMs : cfg.maxStandardNotificationAgeMs;
}

/** Resultado do envio, ja' interpretado. */
export type DispatchOutcome =
  /** O provedor aceitou a mensagem para ao menos um aparelho. */
  | { kind: 'delivered'; delivered: number; failed: number }
  /** O destinatario nao tem aparelho registrado: nao ha' o que enviar. */
  | { kind: 'no_recipient_devices' }
  /** Falha que pode passar sozinha (rede, 5xx, 401 de configuracao, limite). */
  | { kind: 'transient_failure'; error: string }
  /** Falha que nova tentativa nao resolve (todos os aparelhos invalidos, notificacao inexistente). */
  | { kind: 'permanent_failure'; error: string };

export type Dispatcher = (notificationId: string) => Promise<DispatchOutcome>;

export interface CycleReport {
  recovered: { requeued: number; expired: number; dead: number; failedUnknown: number; confirmedSent: number };
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  failed: number;
  expired: number;
  noDevices: number;
  /** Jobs cuja transicao final nao pode ser gravada (ficam para a recuperacao). */
  unresolved: number;
  /** Jobs que terminaram `dead` neste ciclo (envio ou recuperacao). */
  deadIds: string[];
  /** Notificacoes temporalmente criticas que NAO foram entregues neste ciclo. */
  criticalUndelivered: Array<{ id: string; type: string; outcome: string }>;
}

const truncate = (value: unknown, max = 500): string => String(value ?? '').slice(0, max);

export function retryDelayMs(attemptNumber: number, cfg: QueueConfig): number {
  const exp = Math.max(0, attemptNumber - 1);
  return Math.min(cfg.retryMaxMs, cfg.retryBaseMs * Math.pow(2, exp));
}

/**
 * Interpreta a resposta do `send-push-notification`.
 * `httpOk = false` cobre tambem o erro de invocacao (ex.: 401, 500, rede).
 */
// deno-lint-ignore no-explicit-any
export function interpretDispatchResponse(httpOk: boolean, body: any, invokeError?: string | null): DispatchOutcome {
  if (!httpOk || !body) {
    // 404 "Notification not found" e' definitivo; o resto pode ser passageiro.
    if (body && body.error === 'Notification not found') return { kind: 'permanent_failure', error: 'notification_not_found' };
    return { kind: 'transient_failure', error: truncate(body?.error ?? invokeError ?? 'dispatch_failed') };
  }
  if (body.success !== true) {
    return { kind: 'transient_failure', error: truncate(body.error ?? 'dispatch_reported_failure') };
  }
  // deno-lint-ignore no-explicit-any
  const results: any[] = Array.isArray(body.results) ? body.results : [];
  if (results.length === 0) return { kind: 'no_recipient_devices' };

  const delivered = results.filter((r) => r && r.success === true).length;
  const failed = results.length - delivered;
  if (delivered > 0) return { kind: 'delivered', delivered, failed };

  // Nenhum aparelho aceitou. Se TODOS falharam por token invalido (o proprio
  // dispatcher ja' apaga esses tokens), tentar de novo nao muda nada.
  const isInvalidToken = (r: any) => {
    const status = r?.error?.status;
    const code = r?.error?.details?.[0]?.errorCode;
    return status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT' || code === 'UNREGISTERED';
  };
  if (results.every(isInvalidToken)) return { kind: 'permanent_failure', error: 'all_device_tokens_invalid' };
  return { kind: 'transient_failure', error: truncate(JSON.stringify(results[0]?.error ?? 'push_provider_rejected')) };
}

/** O que fazer com um job encontrado abandonado em `processing`. */
export type RecoveryDecision = 'expire' | 'confirm_sent' | 'fail_unknown' | 'requeue' | 'dead';

export function decideRecovery(
  job: Pick<NotificationJobRow, 'attempts' | 'max_attempts' | 'metadata'>,
  notificationCreatedAt: string | null,
  nowMs: number,
  cfg: QueueConfig,
  notificationType?: string | null,
): RecoveryDecision {
  const meta = job.metadata || {};
  // O envio foi confirmado, mas a marcacao final nao foi gravada: e' entrega.
  if (meta.dispatch_confirmed_at) return 'confirm_sent';
  // O envio comecou e nao ha' registro do resultado: pode ter chegado ao
  // aparelho. Nao reenvia (duplicaria) e nao marca como entregue (nao ha' prova).
  if (meta.dispatch_started_at) return 'fail_unknown';

  const createdMs = notificationCreatedAt ? new Date(notificationCreatedAt).getTime() : NaN;
  if (!Number.isFinite(createdMs) || nowMs - createdMs > maxAgeMsFor(notificationType, cfg)) return 'expire';
  if ((job.attempts || 0) + 1 >= (job.max_attempts || 1)) return 'dead';
  return 'requeue';
}

/** Escrita condicional: so' altera o job se ele ainda e' `processing` e de `lockedBy`. */
async function transitionOwned(
  db: QueueDb,
  notificationId: string,
  lockedBy: string | null,
  // deno-lint-ignore no-explicit-any
  patch: Record<string, any>,
): Promise<boolean> {
  let q = db.from('notification_jobs').update(patch).eq('notification_id', notificationId).eq('status', 'processing');
  q = lockedBy === null ? q.is('locked_by', null) : q.eq('locked_by', lockedBy);
  const { data, error } = await q.select('notification_id');
  if (error) {
    console.error(`[NotificationQueue] transition failed for ${notificationId}: ${error.message || error}`);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Recupera jobs abandonados em `processing` (worker interrompido, timeout,
 * erro antes da correcao). Idempotente e seguro sob concorrencia.
 */
export async function recoverStaleJobs(
  db: QueueDb,
  nowMs: number,
  cfg: QueueConfig,
  track?: { deadIds: string[]; criticalUndelivered: Array<{ id: string; type: string; outcome: string }> },
): Promise<CycleReport['recovered']> {
  const out = { requeued: 0, expired: 0, dead: 0, failedUnknown: 0, confirmedSent: 0 };
  const cutoffIso = new Date(nowMs - cfg.staleProcessingMs).toISOString();

  const { data: stale, error } = await db
    .from('notification_jobs')
    .select('notification_id, status, attempts, max_attempts, locked_at, locked_by, next_run_at, last_error, metadata, created_at')
    .eq('status', 'processing')
    .lt('locked_at', cutoffIso)
    .order('locked_at', { ascending: true })
    .limit(cfg.recoveryBatchSize);
  if (error) {
    console.error(`[NotificationQueue] stale lookup failed: ${error.message || error}`);
    return out;
  }
  const jobs = (stale || []) as NotificationJobRow[];
  if (jobs.length === 0) return out;

  const { data: notifs } = await db
    .from('notifications')
    .select('id, created_at, type')
    .in('id', jobs.map((j) => j.notification_id));
  const notifById = new Map<string, { id: string; created_at: string; type?: string }>(
    ((notifs || []) as Array<{ id: string; created_at: string; type?: string }>).map((n) => [n.id, n]));

  const nowIso = new Date(nowMs).toISOString();
  for (const job of jobs) {
    const notif = notifById.get(job.notification_id);
    const decision = decideRecovery(job, notif?.created_at ?? null, nowMs, cfg, notif?.type);
    const attempts = (job.attempts || 0) + 1;
    const baseMeta = { ...(job.metadata || {}), recovered_at: nowIso, recovered_from_lock: job.locked_by };
    // deno-lint-ignore no-explicit-any
    let patch: Record<string, any>;
    if (decision === 'confirm_sent') {
      patch = { status: 'sent', completed_at: nowIso, last_error: null, metadata: baseMeta };
    } else if (decision === 'fail_unknown') {
      patch = { status: 'failed', completed_at: nowIso, last_error: 'dispatch_outcome_unknown', locked_at: null, locked_by: null, metadata: baseMeta };
    } else if (decision === 'expire') {
      patch = { status: 'expired', completed_at: nowIso, last_error: 'expired_before_delivery', locked_at: null, locked_by: null, metadata: baseMeta };
    } else if (decision === 'dead') {
      patch = { status: 'dead', attempts, completed_at: nowIso, last_error: 'abandoned_in_processing_max_attempts', locked_at: null, locked_by: null, metadata: baseMeta };
    } else {
      patch = { status: 'pending', attempts, next_run_at: nowIso, last_error: 'abandoned_in_processing', locked_at: null, locked_by: null, metadata: baseMeta };
    }
    const applied = await transitionOwned(db, job.notification_id, job.locked_by, patch);
    if (!applied) continue; // outro worker ja' tratou
    if (track && decision === 'dead') track.deadIds.push(job.notification_id);
    if (track && decision !== 'confirm_sent' && decision !== 'requeue' && isTimeCritical(notif?.type)) {
      track.criticalUndelivered.push({ id: job.notification_id, type: String(notif?.type), outcome: decision });
    }
    if (decision === 'confirm_sent') out.confirmedSent++;
    else if (decision === 'fail_unknown') out.failedUnknown++;
    else if (decision === 'expire') out.expired++;
    else if (decision === 'dead') out.dead++;
    else out.requeued++;
  }
  return out;
}

/**
 * Um ciclo completo do worker: recupera abandonados, reivindica pendentes,
 * envia e grava o desfecho de cada job.
 */
export async function runNotificationCycle(p: {
  db: QueueDb;
  dispatch: Dispatcher;
  workerId: string;
  nowMs?: number;
  config?: Partial<QueueConfig>;
}): Promise<CycleReport> {
  const cfg: QueueConfig = { ...DEFAULT_QUEUE_CONFIG, ...(p.config || {}) };
  const now = () => (p.nowMs ?? Date.now());
  const deadIds: string[] = [];
  const criticalUndelivered: Array<{ id: string; type: string; outcome: string }> = [];
  const report: CycleReport = {
    recovered: await recoverStaleJobs(p.db, now(), cfg, { deadIds, criticalUndelivered }),
    claimed: 0, sent: 0, retried: 0, dead: 0, failed: 0, expired: 0, noDevices: 0, unresolved: 0,
    deadIds, criticalUndelivered,
  };

  const { data: claimed, error: claimError } = await p.db.rpc('claim_notification_jobs', {
    p_worker_id: p.workerId,
    p_batch_size: cfg.batchSize,
  });
  if (claimError) throw claimError;
  const claimedIds: string[] = ((claimed || []) as Array<{ notification_id: string }>).map((j) => j.notification_id);
  report.claimed = claimedIds.length;
  if (claimedIds.length === 0) return report;

  // A RPC nao devolve tentativas nem metadados: le o estado atual dos jobs.
  const { data: rows } = await p.db
    .from('notification_jobs')
    .select('notification_id, status, attempts, max_attempts, locked_at, locked_by, next_run_at, last_error, metadata, created_at')
    .in('notification_id', claimedIds);
  const jobById = new Map<string, NotificationJobRow>(((rows || []) as NotificationJobRow[]).map((j) => [j.notification_id, j]));

  const { data: notifs } = await p.db.from('notifications').select('id, created_at, type').in('id', claimedIds);
  const notifById = new Map<string, { id: string; created_at: string; type?: string }>(
    ((notifs || []) as Array<{ id: string; created_at: string; type?: string }>).map((n) => [n.id, n]));
  const flagCritical = (id: string, outcome: string) => {
    const type = notifById.get(id)?.type;
    if (isTimeCritical(type)) criticalUndelivered.push({ id, type: String(type), outcome });
  };

  for (const id of claimedIds) {
    const job = jobById.get(id);
    const attemptsSoFar = job?.attempts || 0;
    const maxAttempts = job?.max_attempts || 5;
    const meta = { ...(job?.metadata || {}) };
    const nowIso = new Date(now()).toISOString();

    try {
      // Notificacao inexistente ou velha demais: nao envia.
      const createdAt = notifById.get(id)?.created_at;
      if (!createdAt) {
        if (await transitionOwned(p.db, id, p.workerId, { status: 'failed', completed_at: nowIso, last_error: 'notification_not_found', locked_at: null, locked_by: null })) report.failed++;
        else report.unresolved++;
        continue;
      }
      if (now() - new Date(createdAt).getTime() > maxAgeMsFor(notifById.get(id)?.type, cfg)) {
        if (await transitionOwned(p.db, id, p.workerId, { status: 'expired', completed_at: nowIso, last_error: 'expired_before_delivery', locked_at: null, locked_by: null })) { report.expired++; flagCritical(id, 'expired'); }
        else report.unresolved++;
        continue;
      }

      // Marca o inicio do envio ANTES de enviar. Se o worker morrer daqui em
      // diante, a recuperacao sabe que o desfecho e' desconhecido.
      const started = await transitionOwned(p.db, id, p.workerId, { metadata: { ...meta, dispatch_started_at: nowIso } });
      if (!started) { report.unresolved++; continue; } // perdeu o job para a recuperacao

      let outcome: DispatchOutcome;
      try {
        outcome = await p.dispatch(id);
      } catch (dispatchErr) {
        // deno-lint-ignore no-explicit-any
        outcome = { kind: 'transient_failure', error: truncate((dispatchErr as any)?.message ?? dispatchErr) };
      }

      const doneIso = new Date(now()).toISOString();
      const attempts = attemptsSoFar + 1;

      if (outcome.kind === 'delivered') {
        // Registra a confirmacao e so' entao finaliza. Se a finalizacao falhar,
        // a recuperacao conclui como `sent` (o envio esta' comprovado).
        await transitionOwned(p.db, id, p.workerId, {
          attempts,
          metadata: { ...meta, dispatch_started_at: nowIso, dispatch_confirmed_at: doneIso, delivered_devices: outcome.delivered, failed_devices: outcome.failed },
        });
        const { data: marked, error: markError } = await p.db.rpc('mark_notification_job_sent', { p_notification_id: id });
        if (markError || marked !== true) {
          console.error(`[NotificationQueue] mark sent failed for ${id}: ${markError?.message ?? 'not updated'}`);
          report.unresolved++;
        } else {
          report.sent++;
        }
        continue;
      }

      // Daqui em diante o envio NAO aconteceu: limpa o marcador de inicio.
      const cleanMeta = { ...meta };
      delete cleanMeta.dispatch_started_at;

      if (outcome.kind === 'no_recipient_devices') {
        const ok = await transitionOwned(p.db, id, p.workerId, {
          status: 'cancelled', attempts, completed_at: doneIso, last_error: 'no_recipient_devices', locked_at: null, locked_by: null, metadata: cleanMeta,
        });
        if (ok) report.noDevices++; else report.unresolved++;
        continue;
      }

      if (outcome.kind === 'permanent_failure') {
        const ok = await transitionOwned(p.db, id, p.workerId, {
          status: 'failed', attempts, completed_at: doneIso, last_error: truncate(outcome.error), locked_at: null, locked_by: null, metadata: cleanMeta,
        });
        if (ok) { report.failed++; flagCritical(id, 'failed'); } else report.unresolved++;
        continue;
      }

      // Falha passageira: nova tentativa com espera crescente, ate' o limite.
      if (attempts >= maxAttempts) {
        const ok = await transitionOwned(p.db, id, p.workerId, {
          status: 'dead', attempts, completed_at: doneIso, last_error: truncate(outcome.error), locked_at: null, locked_by: null, metadata: cleanMeta,
        });
        if (ok) { report.dead++; deadIds.push(id); flagCritical(id, 'dead'); console.error(`[NotificationQueue] job ${id} is DEAD after ${attempts} attempts: ${truncate(outcome.error, 200)}`); }
        else report.unresolved++;
      } else {
        const ok = await transitionOwned(p.db, id, p.workerId, {
          status: 'pending', attempts, next_run_at: new Date(now() + retryDelayMs(attempts, cfg)).toISOString(),
          last_error: truncate(outcome.error), locked_at: null, locked_by: null, metadata: cleanMeta,
        });
        if (ok) report.retried++; else report.unresolved++;
      }
    } catch (err) {
      // deno-lint-ignore no-explicit-any
      console.error(`[NotificationQueue] unexpected error on job ${id}: ${(err as any)?.message ?? err}`);
      report.unresolved++;
    }
  }
  return report;
}
