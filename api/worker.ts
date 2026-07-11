import { executeWorkerCycle } from '../lib/ShadowWorker';
import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

// Custom types matching Vercel's Serverless Function signatures to eliminate all 'any' types
interface VercelRequest extends IncomingMessage {
  query: Partial<Record<string, string | string[]>>;
  body: unknown;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (body: unknown) => void;
}

// Generate an immutable unique instance ID for this container/module runtime
const workerInstanceId = `worker-oneshot-${crypto.randomBytes(3).toString('hex')}`;

// Concurrency tracking variables (per container instance)
let isApiRequestRunning = false;
let activeRequestId: string | null = null;

/**
 * Standardized, structured logger for the One-Shot Shadow Worker execution.
 * Formats timestamps, instance IDs, and events consistently following logWorker() pattern.
 */
function logWorker(
  event: 'WORKER_ONESHOT_STARTED' | 'WORKER_ONESHOT_FINISHED' | 'WORKER_ONESHOT_CONCURRENT_DETECTED',
  payload?: Record<string, unknown>
) {
  const timestamp = new Date().toISOString();
  const logObj = {
    timestamp,
    workerInstanceId,
    event,
    payload
  };
  console.log(`[ShadowWorker] ${JSON.stringify(logObj)}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Validate Method (GET or POST)
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Validate Authorization (CRON_SECRET) using the secure Bearer token pattern
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.error('[WorkerOneShot] Unauthorized attempt: Invalid or missing CRON_SECRET.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Generate a unique Request ID for this specific execution
  const requestId = `req-${crypto.randomBytes(3).toString('hex')}`;

  // 3. Concurrency Monitoring Telemetry (Does NOT block; adds visibility into overlaps)
  if (isApiRequestRunning) {
    logWorker('WORKER_ONESHOT_CONCURRENT_DETECTED', {
      info: 'A concurrent oneshot worker execution was detected on this instance.',
      requestId,
      activeRequestId
    });
  }

  // Set active request tracking state
  const previousIsApiRequestRunning = isApiRequestRunning;
  const previousActiveRequestId = activeRequestId;

  isApiRequestRunning = true;
  activeRequestId = requestId;

  try {
    // 4. Emit structured startup log
    logWorker('WORKER_ONESHOT_STARTED', { requestId });

    // 5. Run exactly ONE complete cycle of the worker pipeline
    await executeWorkerCycle();

    // 6. Emit structured completion log
    logWorker('WORKER_ONESHOT_FINISHED', { requestId });

    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[WorkerOneShot] Exception in oneshot execution:', err);
    return res.status(500).json({ success: false, error: errMsg });
  } finally {
    // Restore previous concurrency state values
    isApiRequestRunning = previousIsApiRequestRunning;
    activeRequestId = previousActiveRequestId;
  }
}

