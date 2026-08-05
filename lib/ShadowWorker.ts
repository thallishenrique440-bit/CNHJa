import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  executeWorkerCycle,
  initializeWorkerClient,
  logWorker,
  WorkerMode,
  LogEvent,
  JobStatus
} from './notificationQueueProcessor.js';

export type { WorkerMode, LogEvent };
export {
  executeWorkerCycle,
  initializeWorkerClient,
  logWorker,
  JobStatus
};

let isRunning = false;
let pollTimeout: NodeJS.Timeout | null = null;
let supabaseAdmin: SupabaseClient | null = null;
let areListenersRegistered = false;

/**
 * Starts the read-only / active Shadow Worker loop for continuous background processing.
 */
export async function startShadowWorker() {
  if (isRunning) {
    console.log('[ShadowWorker] ShadowWorker já está em execução (instância ativa). Inicialização duplicada ignorada.');
    return;
  }

  const init = await initializeWorkerClient();
  if (!init) return;

  console.log(`[ShadowWorker] ShadowWorker iniciado (Modo: ${init.workerMode})`);
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

  // Start the background Auto Complete Lessons worker side-by-side
  startAutoCompleteLessonsWorker();

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

let isAutoCompleteRunning = false;

export async function runAutoCompleteLessons() {
  if (isAutoCompleteRunning) return;
  isAutoCompleteRunning = true;

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return;
    }

    if (!supabaseAdmin) {
      supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });
    }

    const { data: updatedCount, error } = await supabaseAdmin.rpc('auto_complete_lessons');

    if (error) {
      console.error('[AutoCompleteWorker] Error executing auto_complete_lessons RPC:', error);
    } else if (updatedCount && updatedCount > 0) {
      console.log(`[AutoCompleteWorker] Automatically completed ${updatedCount} lessons.`);
    }
  } catch (err) {
    console.error('[AutoCompleteWorker] Unhandled error in auto-complete worker:', err);
  } finally {
    isAutoCompleteRunning = false;
  }
}

export function startAutoCompleteLessonsWorker() {
  const intervalMs = 60000; // Check every 60 seconds
  
  // Run once immediately
  runAutoCompleteLessons();

  const intervalId = setInterval(runAutoCompleteLessons, intervalMs);
  return intervalId;
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
