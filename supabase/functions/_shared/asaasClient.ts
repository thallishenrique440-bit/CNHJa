declare const Deno: any;

export interface AsaasFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  allowRetry?: boolean;
}

/**
 * Resilient HTTP client wrapper for Asaas API v3.
 * Features:
 * - AbortController timeout (default 15s)
 * - Exponential backoff retry for transient failures (429, 500, 502, 503, 504, network timeout)
 * - Idempotency & safety awareness (retries strictly disabled for POST /refund and non-GET requests unless explicitly requested)
 */
export async function asaasFetch(url: string, options: AsaasFetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = 15000,
    maxRetries = 3,
    backoffMs = 500,
    allowRetry,
    headers = {},
    ...fetchInit
  } = options;

  const envApiKey = (typeof Deno !== 'undefined' && Deno?.env?.get('ASAAS_API_KEY')) || (typeof process !== 'undefined' ? process.env.ASAAS_API_KEY : '') || '';
  const requestHeaders = new Headers(headers);

  if (!requestHeaders.has('access_token') && envApiKey) {
    requestHeaders.set('access_token', envApiKey);
  }
  if (!requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const method = (fetchInit.method || 'GET').toUpperCase();
  const urlLower = url.toLowerCase();
  const isRefundPost = method === 'POST' && (urlLower.includes('/refund') || urlLower.includes('/refunds'));

  // Retry safety check (Hierarchical Policy):
  // 1. POST /refund and POST /refunds operations strictly FORBID automatic retries (precedence over allowRetry).
  // 2. Otherwise, if allowRetry is explicitly provided, respect its boolean value.
  // 3. Default: GET requests allow retry; non-GET requests forbid retry.
  let isRetryAllowed: boolean;
  if (isRefundPost) {
    isRetryAllowed = false;
  } else if (allowRetry !== undefined) {
    isRetryAllowed = allowRetry;
  } else {
    isRetryAllowed = method === 'GET';
  }

  let attempt = 0;
  let delay = backoffMs;

  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...fetchInit,
        method,
        headers: requestHeaders,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Transient status codes that warrant retry
      const isTransientStatus = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;

      if (!res.ok && isTransientStatus && isRetryAllowed && attempt <= maxRetries) {
        const jitter = Math.floor(Math.random() * 200);
        console.warn(`[Asaas Client] Transient error HTTP ${res.status} on ${method} ${url}. Retrying attempt ${attempt}/${maxRetries} after ${delay + jitter}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay *= 2;
        continue;
      }

      return res;
    } catch (err: any) {
      clearTimeout(timer);

      const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
      const isNetworkError = err instanceof TypeError || isAbort || err?.message?.includes('network');

      if (isNetworkError && isRetryAllowed && attempt <= maxRetries) {
        const jitter = Math.floor(Math.random() * 200);
        const errType = isAbort ? `Timeout (${timeoutMs}ms)` : 'Network Error';
        console.warn(`[Asaas Client] ${errType} on ${method} ${url}. Retrying attempt ${attempt}/${maxRetries} after ${delay + jitter}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay *= 2;
        continue;
      }

      throw err;
    }
  }
}

export type AsaasRefundState = 'NONE' | 'PENDING' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'DENIED' | 'UNKNOWN';

/**
 * Helper to inspect Asaas paymentData payload and return a unified refund state:
 * NONE, PENDING, COMPLETED, DENIED, or UNKNOWN.
 */
export function getAsaasRefundState(paymentData: any): AsaasRefundState {
  if (!paymentData || typeof paymentData !== 'object') {
    return 'UNKNOWN';
  }

  const asaasStatus = (paymentData.status || '').toUpperCase();

  // 1. Top-level status check
  if (asaasStatus === 'REFUNDED') return 'COMPLETED';
  if (asaasStatus === 'PARTIALLY_REFUNDED') return 'PARTIALLY_COMPLETED';

  if (asaasStatus === 'REFUND_REQUESTED') {
    return 'PENDING';
  }

  // 2. Refunds array check
  // A missing/null refunds field is not evidence that no refund exists.
  // Only a known-complete refund listing may establish NONE.
  const hasRefundsField = Object.prototype.hasOwnProperty.call(paymentData, 'refunds');
  const refunds = Array.isArray(paymentData.refunds) ? paymentData.refunds : [];

  if (refunds.length > 0) {
    let hasCompleted = false;
    let hasPending = false;
    let hasDenied = false;

    for (const r of refunds) {
      if (!r) continue;
      const rStatus = (r.status || '').toUpperCase();

      if (['DONE', 'REFUNDED', 'COMPLETED'].includes(rStatus)) {
        hasCompleted = true;
      } else if ([
        'PENDING',
        'AWAITING_CRITICAL_ACTION_AUTHORIZATION',
        'IN_PROGRESS',
        'REFUND_REQUESTED',
        'WAITING_AUTHORIZATION'
      ].includes(rStatus)) {
        hasPending = true;
      } else if ([
        'DENIED',
        'REFUND_DENIED',
        'CANCELLED',
        'FAILED',
        'REJECTED'
      ].includes(rStatus)) {
        hasDenied = true;
      }
    }

    if (hasCompleted) return hasPending ? 'PARTIALLY_COMPLETED' : 'COMPLETED';
    if (hasPending) return 'PENDING';
    if (hasDenied) return 'DENIED';
  }

  // Empty arrays from payment payloads are not assumed complete. Callers must
  // use GET /payments/{id}/refunds and pass its complete result before NONE.
  if (hasRefundsField && Array.isArray(paymentData.refunds) && paymentData.refunds.length === 0
    && paymentData.refundsComplete === true) return 'NONE';

  return 'UNKNOWN';
}
