import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Session } from '@supabase/supabase-js';
import { getToken } from 'firebase/messaging';
import { getMessagingInstance } from '../lib/firebase';

interface AuthContextType {
  session: Session | null;
  loading: boolean;
  userRole: 'student' | 'instructor' | null;
  isProfileComplete: boolean | null;
  isAsaasReady: boolean;
  isPaymentSetupComplete: boolean;
  serverTimeOffset: number;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  syncPushToken: (explicitSession?: Session | null) => Promise<void>;
}

// Helper for Supabase queries with timeout
const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('QUERY_TIMEOUT')), timeoutMs)
    ),
  ]);
};

const AuthContext = createContext<AuthContextType>({
  session: null,
  loading: true,
  userRole: null,
  isProfileComplete: null,
  isAsaasReady: true, // Default to true so it doesn't block notifications for students
  isPaymentSetupComplete: true,
  serverTimeOffset: 0,
  signOut: async () => {},
  refreshProfile: async () => {},
  syncPushToken: async (explicitSession?: Session | null) => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<'student' | 'instructor' | null>(null);
  const [isProfileComplete, setIsProfileComplete] = useState<boolean | null>(null);
  const [isPaymentSetupComplete, setIsPaymentSetupComplete] = useState(true);
  const isAsaasReady = isPaymentSetupComplete;
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0);
  const loadingFinalized = useRef(false);
  const lastFetchId = useRef(0);
  const lastPushSyncId = useRef(0);
  const lastSyncTimestamp = useRef(0);

  const syncPushToken = React.useCallback(async (explicitSession?: Session | null) => {
    const activeSession = explicitSession !== undefined ? explicitSession : session;
    console.log('[Push] Chamado syncPushToken... Permissão:', 'Notification' in window ? Notification.permission : 'not supported', 'user_id:', activeSession?.user?.id);
    // Only proceed if user is authenticated and permission is granted
    if (!activeSession?.user?.id || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    // Throttle: Avoid multiple syncs in a short interval (5 seconds)
    const now = Date.now();
    if (now - lastSyncTimestamp.current < 5000) {
      console.log('[Push] Sincronização ignorada (throttle)');
      return;
    }
    lastSyncTimestamp.current = now;

    const syncId = ++lastPushSyncId.current;
    console.log(`[Push] Início da sincronização do token (ID: ${syncId})`);

    const runSync = async (retryCount = 0) => {
      try {
        const messaging = await getMessagingInstance();
        if (!messaging) {
          console.warn('[Push] Firebase Messaging não suportado ou falhou ao inicializar');
          return;
        }

        if (!('serviceWorker' in navigator)) {
          console.error('[Push] Service Worker não suportado neste navegador');
          return;
        }

        // 1. Register Service Worker with timeout (only if not already registered)
        let registration = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
        
        if (!registration) {
          console.log('[Push] Registrando Service Worker...');
          registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        } else {
          console.log('[Push] Service Worker já registrado');
        }
        
        const readyRegistration = await withTimeout(
          navigator.serviceWorker.ready,
          10000 // 10s timeout for Service Worker to be ready
        ).catch(err => {
          console.error('[Push] Falha ou timeout no Service Worker ready:', err);
          throw err;
        });

        console.log('[Push] Service Worker Registrado e Pronto no escopo:', readyRegistration.scope);

        if (syncId !== lastPushSyncId.current) return;

        const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
        console.log('[Push] VAPID Key para getToken:', vapidKey);
        if (!vapidKey) {
          console.error('[Push] ERRO CRÍTICO: VITE_FIREBASE_VAPID_KEY ausente! Por favor, certifique-se de que a variável de ambiente VITE_FIREBASE_VAPID_KEY esteja configurada durante o build/runtime.');
          return;
        }

        // 2. Get FCM Token with retry logic
        console.log('[Push] Obtendo token FCM...');
        const currentToken = await getToken(messaging, { 
          vapidKey,
          serviceWorkerRegistration: readyRegistration
        });

        if (syncId !== lastPushSyncId.current) return;

        if (currentToken) {
          const maskedToken = currentToken.substring(0, 8) + '...' + currentToken.substring(currentToken.length - 8);
          console.log('[Push] Token FCM gerado com sucesso:', maskedToken);
          
          // 3. Save to Supabase via secure RPC
          console.log('[Push] Salvando token FCM no banco de dados...');
          const { error } = await supabase.rpc('register_fcm_token', {
            p_token: currentToken,
            p_device_type: 'web'
          });

          if (error) {
            console.error('[Push] Erro ao salvar token FCM no banco:', error);
            throw error;
          }
          
          console.log('[Push] Token FCM sincronizado com o banco de dados');
        } else {
          console.warn('[Push] getToken retornou null. Possíveis causas: bloqueio do navegador, problema com VAPID ou Service Worker não ativado corretamente.');
          throw new Error('TOKEN_NULL');
        }
      } catch (error) {
        if (syncId !== lastPushSyncId.current) return;
        
        console.error(`[Push] Erro na sincronização (Tentativa ${retryCount + 1}):`, error);
        
        // Simple retry logic (max 2 retries)
        if (retryCount < 2) {
          const delay = (retryCount + 1) * 3000;
          console.log(`[Push] Agendando nova tentativa em ${delay}ms...`);
          setTimeout(() => runSync(retryCount + 1), delay);
        }
      }
    };

    runSync();
  }, [session]);

  const fetchProfile = React.useCallback(async (userId: string) => {
    const fetchId = ++lastFetchId.current;

    // 1. Fetch Profile Completion (Independent)
    const fetchCompletion = async () => {
      try {
        const response = await withTimeout<any>(
          supabase
            .from('profiles')
            .select('is_profile_complete')
            .eq('id', userId)
            .single() as any,
          5000 // 5s timeout for DB query
        );
        
        const { data, error } = response;
        
        if (fetchId !== lastFetchId.current) return;

        if (error) {
          console.warn('[Auth] Erro ao buscar completude do perfil:', error.message);
          // If it's a "not found" error, it's likely incomplete
          if (error.code === 'PGRST116') {
            setIsProfileComplete(false);
          }
          // Otherwise (network/timeout), we keep it null to avoid incorrect redirection
        } else if (data) {
          setIsProfileComplete(data.is_profile_complete);
        }
      } catch (err) {
        if (fetchId !== lastFetchId.current) return;
        console.error('[Auth] Falha na query de perfil:', err);
        // Keep null on timeout/network error
      }
    };

    // 2. Fetch Payment Setup Status (Independent)
    const fetchPaymentStatus = async () => {
      try {
        const userResponse = await withTimeout<any>(supabase.auth.getUser() as any, 3000);
        
        if (fetchId !== lastFetchId.current) return;

        const role = userResponse.data.user?.user_metadata?.role;
        
        if (role === 'instructor') {
          const instructorResponse = await withTimeout<any>(
            supabase
              .from('instructors')
              .select('payouts_enabled, provider_name, provider_onboarding_completed, provider_status')
              .eq('id', userId)
              .single() as any,
            4000
          );
          
          if (fetchId !== lastFetchId.current) return;

          const { data: instructorData, error: instError } = instructorResponse;
          
          if (!instError && instructorData) {
            const statusUpper = (instructorData.provider_status || '').toUpperCase();
            const isApproved = instructorData.provider_onboarding_completed === true || 
              statusUpper === 'APPROVED' || 
              statusUpper === 'ACTIVE' ||
              statusUpper === 'APROVADO' ||
              statusUpper === 'ATIVO';
            setIsPaymentSetupComplete(isApproved);
          } else {
            setIsPaymentSetupComplete(false);
          }
        } else {
          setIsPaymentSetupComplete(true);
        }
      } catch (err) {
        if (fetchId !== lastFetchId.current) return;
        console.error('[Auth] Falha na query de status de pagamento:', err);
        // Default to true for students, false for instructors if unknown
      }
    };

    // Run both independently
    fetchCompletion();
    fetchPaymentStatus();
  }, []);

  const refreshProfile = React.useCallback(async () => {
    if (session?.user?.id) {
      await fetchProfile(session.user.id);
    }
  }, [session, fetchProfile]);

  useEffect(() => {
    let mounted = true;

    const finalizeLoading = () => {
      if (mounted && !loadingFinalized.current) {
        loadingFinalized.current = true;
        setLoading(false);
        if (failSafeTimer) clearTimeout(failSafeTimer);
      }
    };
    
    // 0. Fail-safe timeout (5 seconds)
    const failSafeTimer = setTimeout(() => {
      if (mounted && !loadingFinalized.current) {
        console.warn('[Auth] Fail-safe timeout reached. Forcing loading to stop.');
        finalizeLoading();
      }
    }, 5000);

    const initSession = async () => {
      try {
        // 1. Fetch server time (Non-blocking)
        const fetchServerTime = async () => {
          try {
            const t0 = Date.now();
            const { data: timeData, error: timeError } = await supabase.rpc('get_server_time');
            const t1 = Date.now();
            
            if (!timeError && timeData && mounted) {
              const serverTime = new Date(timeData).getTime();
              const rtt = t1 - t0;
              const estimatedServerTime = serverTime + (rtt / 2);
              const offset = estimatedServerTime - t1;
              setServerTimeOffset(offset);
            }
          } catch (e) {
            console.error('[Auth] Erro ao sincronizar tempo:', e);
          }
        };

        const timeSyncPromise = fetchServerTime();

        // 2. Check active session safely
        const { data, error } = await supabase.auth.getSession();
        
        if (error) {
          console.error('[Auth] Erro ao obter sessão:', error);
        }

        if (mounted) {
          if (data?.session) {
            setSession(data.session);
            const role = data.session.user?.user_metadata?.role;
            if (role) {
              setUserRole(role);
            }
            // CRITICAL: fetchProfile runs in background (non-blocking)
            // This ensures the app loads instantly even if DB is slow
            fetchProfile(data.session.user.id);
            
            // Sync Push Token if permission is already granted
            syncPushToken(data.session);
          } else {
            // No session, we can mark profile as "complete" (not applicable) or false
            setIsProfileComplete(false);
          }
        }
        
        // Finalize loading as soon as session is handled
        finalizeLoading();
        
        await timeSyncPromise;

      } catch (err) {
        console.error('[Auth] Falha crítica na inicialização:', err);
        finalizeLoading();
      }
    };

    initSession();

    // 3. Listen for changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (mounted) {
        setSession(session);
        if (session?.user) {
          const role = session.user.user_metadata?.role;
          if (role) {
            setUserRole(role);
          }
          // Reset profile completion status to null to avoid race conditions
          // This forces guards to wait for the new fetchProfile result
          setIsProfileComplete(null);
          
          // fetchProfile always runs in background (non-blocking)
          fetchProfile(session.user.id);
          
          // Sync Push Token if permission is already granted
          syncPushToken(session);
        } else {
          setUserRole(null);
          setIsProfileComplete(false);
        }
        
        // Finalize loading immediately on initial events
        if (!loadingFinalized.current) {
          finalizeLoading();
        }
      }
    });

    // 4. Proactively check session when app returns to foreground (Mobile/PWA)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Only trigger background check, never re-enable global loading state here
        supabase.auth.getSession();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      clearTimeout(failSafeTimer);
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    localStorage.clear(); // Clear legacy bridge
    setUserRole(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, loading, userRole, isProfileComplete, isAsaasReady, isPaymentSetupComplete, serverTimeOffset, signOut, refreshProfile, syncPushToken }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);