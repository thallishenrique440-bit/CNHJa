import React, { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export const ProfileGuard: React.FC = () => {
  const { session, isProfileComplete, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const completeProfilePath = '/complete-profile';

  if (!isProfileComplete && session) {
    if (location.pathname !== completeProfilePath) {
      return <Navigate to={completeProfilePath} replace />;
    }
  }

  return <Outlet />;
};