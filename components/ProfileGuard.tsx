import React, { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export const ProfileGuard: React.FC = () => {
  const { session, isProfileComplete, loading, userRole } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // If profile status is still being fetched (null), we allow rendering to avoid blocking the app.
  // Once fetchProfile completes, if it's false, the user will be redirected.
  if (isProfileComplete === false && session) {
    const studentProfilePath = '/student/profile';
    const instructorProfilePath = '/instructor/profile';
    const targetPath = userRole === 'instructor' ? instructorProfilePath : studentProfilePath;

    if (location.pathname !== targetPath) {
      return <Navigate to={targetPath} replace />;
    }
  }

  return <Outlet />;
};