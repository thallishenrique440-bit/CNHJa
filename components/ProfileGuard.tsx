import React, { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export const ProfileGuard: React.FC = () => {
  const { session, userRole } = useAuth();
  const location = useLocation();
  const { addToast } = useToast();
  
  const [loading, setLoading] = useState(true);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    const checkProfile = async () => {
      if (!session?.user) {
        setLoading(false);
        return;
      }

      try {
        if (userRole === 'student') {
          // Check if student has all required fields
          const { data, error } = await supabase
            .from('profiles')
            .select('full_name, phone, city, experience_level, cnh_process_type')
            .eq('id', session.user.id)
            .single();

          if (error) throw error;
          
          const isProfileComplete = !!(
            data?.full_name && 
            data?.phone && data.phone.length >= 10 && 
            data?.city && 
            data?.experience_level && 
            data?.cnh_process_type
          );

          setIsComplete(isProfileComplete);

        } else if (userRole === 'instructor') {
          // Check if instructor has essential data (whatsapp and price)
          // We check 'instructors' table for specific business rules
          const { data, error } = await supabase
            .from('instructors')
            .select('whatsapp, base_price')
            .eq('id', session.user.id)
            .single();

           // If row missing or fields missing
           if (error || !data || !data.whatsapp || !data.base_price) {
             setIsComplete(false);
           } else {
             setIsComplete(true);
           }
        } else {
          // Unknown role, pass through or handle elsewhere
          setIsComplete(true);
        }

      } catch (err) {
        console.error('Error checking profile integrity:', err);
        // On error, we default to allowing (or could block), let's block to be safe but usually better to fail open in prod if DB glitch
        // For this MVP, let's assume if we can't check, we block to prompt retry.
        setIsComplete(false);
      } finally {
        setLoading(false);
      }
    };

    checkProfile();
  }, [session, userRole, location.pathname]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Define the profile paths to avoid infinite redirect loops
  const studentProfilePath = '/student/profile';
  const instructorProfilePath = '/instructor/profile';

  if (!isComplete) {
    // If Student is incomplete
    if (userRole === 'student') {
      // If already on profile, allow it (so they can fix it)
      if (location.pathname === studentProfilePath) {
        return <Outlet />;
      }
      // Otherwise, redirect to profile with a warning
      return <Navigate to={studentProfilePath} state={{ 
        alertMessage: "Complete seu perfil para continuar." 
      }} replace />;
    }

    // If Instructor is incomplete
    if (userRole === 'instructor') {
      if (location.pathname === instructorProfilePath) {
        return <Outlet />;
      }
      return <Navigate to={instructorProfilePath} state={{ 
        alertMessage: "Complete seu perfil (WhatsApp e Preço Base) para acessar a agenda." 
      }} replace />;
    }
  }

  return <Outlet />;
};