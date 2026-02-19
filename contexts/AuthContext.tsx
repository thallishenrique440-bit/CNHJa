import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Session } from '@supabase/supabase-js';

interface AuthContextType {
  session: Session | null;
  loading: boolean;
  userRole: 'student' | 'instructor' | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  loading: true,
  userRole: null,
  signOut: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<'student' | 'instructor' | null>(null);

  useEffect(() => {
    let mounted = true;

    const initSession = async () => {
      try {
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
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        setSession(session);
        if (session?.user?.user_metadata?.role) {
          setUserRole(session.user.user_metadata.role);
        } else {
          setUserRole(null);
        }
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    localStorage.clear(); // Clear legacy bridge
    setUserRole(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, loading, userRole, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);