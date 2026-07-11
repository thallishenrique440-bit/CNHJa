import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Define the supported execution modes for the worker
export type WorkerMode = 'disabled' | 'shadow' | 'active';

// Define the structured worker log events
export type LogEvent =
  | 'WORKER_STARTED'
  | 'DATABASE_CONNECTED'
  | 'DATABASE_CONNECTION_FAILED'
  | 'POLLING_STARTED'
  | 'QUEUE_METRICS'
  | 'JOBS_FOUND'
  | 'NO_JOBS_FOUND'
  | 'WORKER_SUSPENDED'
  | 'WORKER_STOPPING'
  | 'WORKER_STOPPED'
  | 'POLLING_OVERLAP_PREVENTED'
  | 'POLLING_FAILED'
  | 'POLLING_ERROR'
  | 'CLAIM_STARTED'
  | 'CLAIM_FINISHED'
  | 'CLAIMED_JOB'
  | 'CLAIMED_COUNT'
  | 'NO_PENDING_JOBS'
  | 'CLAIM_FAILED'
  | 'PROCESSING_STARTED'
  | 'PROCESSING_FINISHED'
  | 'BATCH_PROCESSING_FINISHED'
  | 'JOB_PROCESSING_ERROR'
  | 'DISPATCH_STARTED'
  | 'DISPATCH_FINISHED'
  | 'DISPATCH_ERROR'
  | 'JOB_COMPLETED';

// Define all known domain states of a notification job
export enum JobStatus {
  Pending = 'pending',
  Processing = 'processing',
  Retry = 'retry',
  Failed = 'failed',
  Dead = 'dead',
  Sent = 'sent',
  Cancelled = 'cancelled',
  Expired = 'expired'
}

// Generate a immutable unique instance ID upon startup
const workerInstanceId = `worker-${crypto.randomBytes(3).toString('hex')}`;

let isRunning = false;
let isCycleRunning = false;
let pollTimeout: NodeJS.Timeout | null = null;
let supabaseAdmin: SupabaseClient | null = null;
let areListenersRegistered = false;
let cycleIdCounter = 0;

/**
 * Standardized, structured logger for the Shadow Worker.
 * Formats timestamps, instance IDs, cycle IDs, and payloads consistently.
 */
function logWorker(event: LogEvent, cycleId?: number, payload?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const logObj = {
    timestamp,
    workerInstanceId,
    cycleId: cycleId || undefined,
    event,
    payload
  };
  console.log(`[ShadowWorker] ${JSON.stringify(logObj)}`);
}

/**
 * Shared initialization helper for configuring Supabase and resolving worker mode.
 */
export async function initializeWorkerClient(): Promise<{ workerMode: WorkerMode; batchSize: number } | null> {
  // Configured mode checking: 'disabled' | 'shadow' | 'active'
  const rawMode = process.env.WORKER_MODE || (process.env.ENABLE_SHADOW_WORKER === 'true' ? 'shadow' : 'disabled');
  const workerMode = rawMode.toLowerCase() as WorkerMode;

  if (workerMode === 'disabled') {
    logWorker('WORKER_SUSPENDED', undefined, { reason: 'WORKER_MODE is disabled' });
    return null;
  }

  // Strictly enforce environment configuration with NO hardcoded fallback URLs
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    logWorker('DATABASE_CONNECTION_FAILED', undefined, {
      error: 'Missing required database configuration. Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be supplied.'
    });
    logWorker('WORKER_SUSPENDED', undefined, { reason: 'MISSING_ENV_CREDENTIALS' });
    return null;
  }

  // Initialize typed Supabase Client
  if (!supabaseAdmin) {
    try {
      supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logWorker('DATABASE_CONNECTION_FAILED', undefined, { error: errMsg });
      logWorker('WORKER_SUSPENDED', undefined, { reason: 'CLIENT_INITIALIZATION_ERROR' });
      return null;
    }
  }

  // Verify database connection & permissions prior to polling
  try {
    const { error } = await supabaseAdmin
      .from('notification_jobs')
      .select('notification_id')
      .limit(1);

    if (error) {
      logWorker('DATABASE_CONNECTION_FAILED', undefined, { error: error.message });
      logWorker('WORKER_SUSPENDED', undefined, { reason: 'PING_QUERY_FAILED' });
      return null;
    }

    // Extract host securely without exposing full URL credentials or path variables
    let hostname = 'unknown';
    try {
      hostname = new URL(supabaseUrl).hostname;
    } catch {
      hostname = 'invalid-url';
    }

    logWorker('DATABASE_CONNECTED', undefined, { host: hostname });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logWorker('DATABASE_CONNECTION_FAILED', undefined, { error: errMsg });
    logWorker('WORKER_SUSPENDED', undefined, { reason: 'PING_QUERY_CRASHED' });
    return null;
  }

  const batchSize = Number(process.env.SHADOW_WORKER_BATCH_SIZE) || 10;
  return { workerMode, batchSize };
}

/**
 * Executes a single complete cycle of the worker pipeline (One-Shot execution).
 */
export async function executeWorkerCycle() {
  const init = await initializeWorkerClient();
  if (!init) return;

  const { workerMode, batchSize } = init;
  const pollIntervalMs = Number(process.env.SHADOW_WORKER_POLL_INTERVAL_MS) || 5000;

  // Defend against concurrent cycle execution overlaps
  if (isCycleRunning) {
    logWorker('POLLING_OVERLAP_PREVENTED', undefined, { info: 'Prior polling cycle is still in progress.' });
    return;
  }

  isCycleRunning = true;
  cycleIdCounter += 1;
  const currentCycleId = cycleIdCounter;

  logWorker('POLLING_STARTED', currentCycleId, { pollIntervalMs, batchSize });

  try {
    if (!supabaseAdmin) throw new Error('Supabase client has been de-allocated.');

    // 1. Gather Queue Metrics (Purely Observational, No Mutating Transactions)
    // Note: Group-by/aggregated counts are not natively supported by Supabase JS client/PostgREST
    // without adding a Postgres view or custom RPC function. To keep the database strictly intact,
    // we query counts in parallel efficiently via Promise.all.
    const statuses = Object.values(JobStatus);
    const metricsPromises = statuses.map(async (status) => {
      const { count, error } = await supabaseAdmin!
        .from('notification_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('status', status);

      return { status, count: error ? null : (count || 0) };
    });

    const metricsResults = await Promise.all(metricsPromises);
    const metricsMap: Record<string, unknown> = {};
    for (const res of metricsResults) {
      metricsMap[res.status] = res.count;
    }

    logWorker('QUEUE_METRICS', currentCycleId, metricsMap);

    if (workerMode === 'active') {
      logWorker('CLAIM_STARTED', currentCycleId, { batchSize });

      const startTime = Date.now();
      const { data, error } = await supabaseAdmin.rpc('claim_notification_jobs', {
        p_worker_id: workerInstanceId,
        p_batch_size: batchSize
      });
      const durationMs = Date.now() - startTime;

      if (error) {
        logWorker('CLAIM_FAILED', currentCycleId, { error: error.message });
      } else if (data && data.length > 0) {
        const claimedJobs = data as Array<{
          notification_id: string;
          status: string;
          priority: number;
          created_at: string;
        }>;

        for (const job of claimedJobs) {
          logWorker('CLAIMED_JOB', currentCycleId, {
            notification_id: job.notification_id,
            status: job.status,
            priority: job.priority,
            created_at: job.created_at
          });
        }

        logWorker('CLAIMED_COUNT', currentCycleId, { count: claimedJobs.length });
        logWorker('CLAIM_FINISHED', currentCycleId, { 
          count: claimedJobs.length,
          jobsClaimed: claimedJobs.length,
          durationMs 
        });

        // Controlled Processing Pipeline (Microfase 1.3.4 - Dispatcher Mínimo de Transporte)
        const batchStartTime = Date.now();
        let processedJobs = 0;

        for (const job of claimedJobs) {
          const jobStartTime = Date.now();
          try {
            logWorker('PROCESSING_STARTED', currentCycleId, {
              notification_id: job.notification_id,
              priority: job.priority
            });

            // 1. Buscar a notificação correspondente em public.notifications utilizando notification_id
            const { data: notification, error: fetchError } = await supabaseAdmin!
              .from('notifications')
              .select('id')
              .eq('id', job.notification_id)
              .single();

            if (fetchError || !notification) {
              throw new Error(fetchError ? fetchError.message : `Notification with ID ${job.notification_id} not found.`);
            }

            // 2. Executar exatamente UMA chamada para send-push-notification utilizando a infraestrutura oficial
            logWorker('DISPATCH_STARTED', currentCycleId, {
              notificationId: job.notification_id
            });

            const dispatchStartTime = Date.now();
            const { data: invokeData, error: invokeError } = await supabaseAdmin!.functions.invoke('send-push-notification', {
              body: { notification_id: job.notification_id }
            });

            if (
              invokeError ||
              !invokeData ||
              invokeData.success !== true
            ) {
              throw new Error(
                invokeData?.error ??
                invokeError?.message ??
                "Unknown dispatch failure"
              );
            }

            const dispatchDurationMs = Date.now() - dispatchStartTime;

            logWorker('DISPATCH_FINISHED', currentCycleId, {
              notificationId: job.notification_id,
              durationMs: dispatchDurationMs
            });

            // 3. Finalização atômica do Job na Microfase 1.3.5
            const { data: updated, error: updateError } = await supabaseAdmin!.rpc('mark_notification_job_sent', {
              p_notification_id: job.notification_id
            });

            if (updateError) {
              throw updateError;
            }

            if (updated !== true) {
              throw new Error(
                "mark_notification_job_sent returned false"
              );
            }

            const processingDurationMs = Date.now() - jobStartTime;

            logWorker('JOB_COMPLETED', currentCycleId, {
              workerInstanceId,
              cycleId: currentCycleId,
              notificationId: job.notification_id,
              durationMs: processingDurationMs
            });

            logWorker('PROCESSING_FINISHED', currentCycleId, {
              notification_id: job.notification_id,
              processingDurationMs
            });

            processedJobs++;
          } catch (jobErr: unknown) {
            const errMsg = jobErr instanceof Error ? jobErr.message : String(jobErr);
            logWorker('DISPATCH_ERROR', currentCycleId, {
              notificationId: job.notification_id,
              error: errMsg
            });
            logWorker('JOB_PROCESSING_ERROR', currentCycleId, {
              notification_id: job.notification_id,
              error: errMsg
            });
          }
        }

        const batchProcessingDurationMs = Date.now() - batchStartTime;
        logWorker('BATCH_PROCESSING_FINISHED', currentCycleId, {
          processedJobs,
          batchProcessingDurationMs
        });
      } else {
        logWorker('NO_PENDING_JOBS', currentCycleId);
        logWorker('CLAIM_FINISHED', currentCycleId, { 
          count: 0,
          jobsClaimed: 0,
          durationMs 
        });
      }
    } else {
      // 2. Fetch Pending Jobs (Strictly Read-Only, No locks, No updates)
      const { data, error } = await supabaseAdmin
        .from('notification_jobs')
        .select('notification_id, status, priority, created_at')
        .eq('status', JobStatus.Pending)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(batchSize);

      if (error) {
        logWorker('POLLING_FAILED', currentCycleId, { error: error.message });
      } else if (data && data.length > 0) {
        // Map data to preserve strict typed format of record entries
        const mappedJobs = data.map((job) => ({
          notification_id: String(job.notification_id),
          status: String(job.status),
          priority: Number(job.priority),
          created_at: String(job.created_at)
        }));

        logWorker('JOBS_FOUND', currentCycleId, {
          count: mappedJobs.length,
          jobs: mappedJobs
        });
      } else {
        logWorker('NO_JOBS_FOUND', currentCycleId);
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logWorker('POLLING_ERROR', currentCycleId, { error: errMsg });
  } finally {
    isCycleRunning = false;
  }
}

/**
 * Starts the read-only Shadow Worker for validating queue infrastructure and observability.
 */
export async function startShadowWorker() {
  const init = await initializeWorkerClient();
  if (!init) return;

  logWorker('WORKER_STARTED', undefined, { mode: init.workerMode });

  isRunning = true;

  const pollIntervalMs = Number(process.env.SHADOW_WORKER_POLL_INTERVAL_MS) || 5000;

  /**
   * Main read-only cycle. Consolidates queue metrics and fetches pending jobs.
   */
  async function pollCycle() {
    if (!isRunning) return;

    await executeWorkerCycle();

    // Schedule next polling interval
    if (isRunning) {
      pollTimeout = setTimeout(pollCycle, pollIntervalMs);
    }
  }

  // Kick off the loop
  pollCycle();

  // Handle OS process termination gracefully
  const gracefulShutdown = () => {
    if (!isRunning) return;

    logWorker('WORKER_STOPPING', undefined, { reason: 'SIGINT_OR_SIGTERM_RECEIVED' });
    isRunning = false;

    if (pollTimeout) {
      clearTimeout(pollTimeout);
      pollTimeout = null;
    }

    logWorker('WORKER_STOPPED');
  };

  // Register listeners exactly once to prevent any leaks
  if (!areListenersRegistered) {
    process.once('SIGINT', gracefulShutdown);
    process.once('SIGTERM', gracefulShutdown);
    areListenersRegistered = true;
  }
}

// Support executing directly as a standalone process (e.g., via tsx)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('ShadowWorker.ts') ||
  process.argv[1].endsWith('ShadowWorker.js')
);
if (isMain) {
  startShadowWorker().catch((err) => {
    console.error('[ShadowWorker] Critical Bootstrap Error:', err);
  });
}
