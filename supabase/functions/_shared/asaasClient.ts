export interface AsaasFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

/**
 * Resilient HTTP client wrapper for Asaas API v3.
 * Features:
 * - AbortController timeout (default 15s)
 * - Exponential backoff retry for transient failures (429, 500, 502, 503, 504, network timeout)
 * - Idempotency & safety awareness
 */
export async function asaasFetch(url: string, options: AsaasFetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = 15000,
    maxRetries = 3,
    backoffMs = 500,
    headers = {},
    ...fetchInit
  } = options;

  const apiKey = Deno.env.get('ASAAS_API_KEY') || '';
  const requestHeaders = new Headers(headers);

  if (!requestHeaders.has('access_token') && apiKey) {
    requestHeaders.set('access_token', apiKey);
  }
  if (!requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const method = (fetchInit.method || 'GET').toUpperCase();

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

      if (!res.ok && isTransientStatus && attempt <= maxRetries) {
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

      if (isNetworkError && attempt <= maxRetries) {
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
