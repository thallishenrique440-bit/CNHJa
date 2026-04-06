import React, { createContext, useContext, useEffect, useState } from 'react';
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

  const fetchProfile = React.useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_profile_complete')
        .eq('id', userId)
        .single();
      
      if (!error && data) {
        setIsProfileComplete(data.is_profile_complete);
      }

      // If instructor, fetch stripe status
      const { data: userData } = await supabase.auth.getUser();
      const role = userData.user?.user_metadata?.role;
      
      if (role === 'instructor') {
        const { data: instructorData } = await supabase
          .from('instructors')
          .select('payouts_enabled')
          .eq('id', userId)
          .single();
        
        if (instructorData) {
          setIsStripeConnected(instructorData.payouts_enabled === true);
        }
      } else {
        setIsStripeConnected(true);
      }
    } catch (err) {
      console.error('[Auth] Erro ao buscar perfil:', err);
    }
  }, []);

  const refreshProfile = React.useCallback(async () => {
    if (session?.user?.id) {
      await fetchProfile(session.user.id);
    }
  }, [session, fetchProfile]);

  useEffect(() => {
    let mounted = true;

    const initSession = async () => {
      try {
        // 0. Fetch server time to calculate offset
        const t0 = Date.now();
        const { data: timeData, error: timeError } = await supabase.rpc('get_server_time');
        const t1 = Date.now();
        
        if (!timeError && timeData) {
          const serverTime = new Date(timeData).getTime();
          const rtt = t1 - t0;
          const estimatedServerTime = serverTime + (rtt / 2);
          const offset = estimatedServerTime - t1;
          if (mounted) setServerTimeOffset(offset);
        }

        // 1. Check active session safely
        const { data, error } = await supabase.auth.getSession();
        
        if (error) {
          console.error('[Auth] Erro ao obter sessão:', error);
        }

        if (mounted) {
          if (data?.session) {
            setSession(data.session);
            if (data.session.user?.user_metadata?.role) {
              setUserRole(data.session.user.user_metadata.role);
            }
            await fetchProfile(data.session.user.id);
          }
          setLoading(false);
        }
      } catch (err) {
        console.error('[Auth] Falha crítica na inicialização:', err);
        if (mounted) setLoading(false); // Ensure loading stops even on crash
      }
    };

    initSession();

    // 2. Listen for changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (mounted) {
        setSession(session);
        if (session?.user) {
          if (session.user.user_metadata?.role) {
            setUserRole(session.user.user_metadata.role);
          }
          await fetchProfile(session.user.id);
        } else {
          setUserRole(null);
          setIsProfileComplete(false);
        }
        setLoading(false);
      }
    });

    // 3. Proactively check session when app returns to foreground (Mobile/PWA)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[Auth] App returned to foreground, checking session...');
        supabase.auth.getSession();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
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