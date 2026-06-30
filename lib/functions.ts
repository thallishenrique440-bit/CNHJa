import { supabase } from './supabase';

export type SecureFunctionResponse<T = any> = {
  data: T | null;
  error: any;
};

/**
 * Wrapper for Supabase Edge Functions that ensures a valid session exists before the call.
 * This prevents "zombie session" errors in mobile/PWA environments.
 */
export async function invokeSecureFunction<T = any>(
  functionName: string,
  options?: {
    body?: any;
    headers?: Record<string, string>;
    method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  }
): Promise<SecureFunctionResponse<T>> {
  try {
    // 1. Ensure we have a valid session. 
    // getSession() automatically refreshes the token if it's expired but the refresh token is valid.
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !session) {
      console.error('[SecureFunction] Session validation failed:', sessionError);
      return { data: null, error: new Error('SESSION_EXPIRED') };
    }

    // 2. Invoke the function with the guaranteed valid session
    const { data, error } = await supabase.functions.invoke(functionName, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (error) {
      let customMessage = '';
      if (error.context && typeof error.context.clone === 'function') {
        try {
          const clonedContext = error.context.clone();
          const errorBody = await clonedContext.json();
          customMessage = errorBody.error || errorBody.message || '';
        } catch {
          try {
            const clonedContext = error.context.clone();
            customMessage = await clonedContext.text();
          } catch {}
        }
      }
      if (customMessage) {
        return { data: null, error: new Error(customMessage) };
      }
    }

    return { data, error };
  } catch (err) {
    console.error(`[SecureFunction] Unexpected error invoking ${functionName}:`, err);
    return { data: null, error: err };
  }
}
