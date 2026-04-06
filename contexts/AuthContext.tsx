import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Session } from '@supabase/supabase-js';

interface AuthContextType {
  session: Session | null;
  loading: boolean;
  userRole: 'student' | 'instructor' | null;
  isProfileComplete: boolean;
  isStripeConnected: boolean;
  serverTimeOffset: number;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  loading: true,
  userRole: null,
  isProfileComplete: false,
  isStripeConnected: true, // Default to true so it doesn't block notifications for students
  serverTimeOffset: 0,
  signOut: async () => {},
  refreshProfile: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<'student' | 'instructor' | null>(null);
  const [isProfileComplete, setIsProfileComplete] = useState(false);
  const [isStripeConnected, setIsStripeConnected] = useState(true);
  const [serverTimeOffset, setServerTimeOffset] = useState<number>(0);
  const loadingFinalized = useRef(false);

  const fetchProfile = React.useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_profile_complete')
        .eq('id', userId)
        .single();
      
      if (error) {
        console.warn('[Auth] Perfil não encontrado ou erro:', error.message);
        setIsProfileComplete(false); // Fallback: treat as incomplete
      } else if (data) {
        setIsProfileComplete(data.is_profile_complete);
      } else {
        setIsProfileComplete(false);
      }

      // If instructor, fetch stripe status
      const { data: userData } = await supabase.auth.getUser();
      const role = userData.user?.user_metadata?.role;
      
      if (role === 'instructor') {
        const { data: instructorData, error: instError } = await supabase
          .from('instructors')
          .select('payouts_enabled')
          .eq('id', userId)
          .single();
        
        if (!instError && instructorData) {
          setIsStripeConnected(instructorData.payouts_enabled === true);
        } else {
          setIsStripeConnected(false); // Fallback for instructors
        }
      } else {
        setIsStripeConnected(true);
      }
    } catch (err) {
      console.error('[Auth] Erro ao buscar perfil:', err);
      setIsProfileComplete(false); // Safe fallback
    }
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
    
    // 0. Fail-safe timeout (8 seconds)
    const failSafeTimer = setTimeout(() => {
      if (mounted && !loadingFinalized.current) {
        console.warn('[Auth] Fail-safe timeout reached. Forcing loading to stop.');
        finalizeLoading();
      }
    }, 8000);

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
            // CRITICAL: Await profile fetch before releasing loading state
            // This prevents ProfileGuard from redirecting prematurely
            await fetchProfile(data.session.user.id);
          }
        }
        
        await timeSyncPromise;

      } catch (err) {
        console.error('[Auth] Falha crítica na inicialização:', err);
      } finally {
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
          // Await profile fetch if we are still in the initial loading phase
          if (!loadingFinalized.current) {
            await fetchProfile(session.user.id);
          } else {
            fetchProfile(session.user.id);
          }
        } else {
          setUserRole(null);
          setIsProfileComplete(false);
        }
        
        // Only finalize loading on initial events or specific auth changes
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
    <AuthContext.Provider value={{ session, loading, userRole, isProfileComplete, isStripeConnected, serverTimeOffset, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);