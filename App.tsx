import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { Welcome } from './pages/Welcome';
import { Terms } from './pages/Terms';
import { Privacy } from './pages/Privacy';
import { RegisterStudent } from './pages/RegisterStudent';
import { RegisterInstructor } from './pages/RegisterInstructor';
import { Login } from './pages/Login';
import { ForgotPassword } from './pages/ForgotPassword';
import { UpdatePassword } from './pages/UpdatePassword';
import { InstructorShortLink } from './pages/InstructorShortLink';
import { InstructorProfile } from './pages/InstructorProfile';
import { InstructorAgenda } from './pages/InstructorAgenda';
import { InstructorDiscounts } from './pages/InstructorDiscounts';
import { InstructorFinance } from './pages/InstructorFinance';
import { StudentHome } from './pages/StudentHome';
import { StudentLessons } from './pages/student/Lessons';
import { StudentInstructorProfile } from './pages/student/InstructorProfile';
import { StudentFinance } from './pages/student/Finance';
import { StudentProfile } from './pages/student/Profile';
import { PaymentPage } from './pages/student/PaymentPage';
import { supabase } from './lib/supabase';
import { ProfileGuard } from './components/ProfileGuard';
import { PushNotificationManager } from './components/PushNotificationManager';

import { InstructorStripeBanner } from './components/InstructorStripeBanner';

// --- GUARDS ---

const LoadingScreen = () => (
  <div className="min-h-screen flex flex-col items-center justify-center bg-white space-y-4">
    <img 
      src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/logo%20oficial.png" 
      alt="Autoescola do Brasil" 
      className="h-16 w-auto object-contain animate-pulse" 
      onError={(e) => {
        // Fallback if image fails
        e.currentTarget.style.display = 'none';
      }}
    />
    <p className="text-gray-400 text-sm font-medium animate-pulse">Carregando...</p>
  </div>
);

const AuthGuard: React.FC<{ allowedRole: string | 'any' }> = ({ allowedRole }) => {
  const { session, userRole, loading, isStripeConnected } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingScreen />;
  }

  // 1. Not authenticated
  if (!session) {
    return <Navigate to="/welcome" replace />;
  }

  // 2. Authenticated but accessing wrong role area
  if (allowedRole !== 'any' && userRole && userRole !== allowedRole) {
    return <Navigate to={userRole === 'student' ? '/student/home' : '/instructor/agenda'} replace />;
  }

  // Determine if Stripe banner is showing (or would show)
  const isInstructor = userRole === 'instructor';
  const isFinancePage = location.pathname === '/instructor/finance';
  const stripeBannerShowing = isInstructor && !isStripeConnected && !isFinancePage;

  return (
    <>
      <PushNotificationManager disabled={stripeBannerShowing} />
      <Outlet />
    </>
  );
};

const InstructorLayout: React.FC = () => {
  return (
    <>
      <InstructorStripeBanner />
      <Outlet />
    </>
  );
};

const PublicGuard: React.FC = () => {
  const { session, userRole, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  if (session && userRole) {
    if (userRole === 'student') return <Navigate to="/student/home" replace />;
    if (userRole === 'instructor') return <Navigate to="/instructor/agenda" replace />;
  }

  return <Outlet />;
};

// Component to handle Auth Events (like Password Recovery)
const AuthListener: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        navigate('/update-password');
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [navigate]);

  return null;
};

const AppRoutes: React.FC = () => {
  return (
    <>
      <AuthListener />
      <Routes>
        
        {/* Short Link Resolver - Public Access */}
        <Route path="/i/:publicId" element={<InstructorShortLink />} />

        {/* PUBLIC ROUTES */}
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route element={<PublicGuard />}>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/register-student" element={<RegisterStudent />} />
          <Route path="/register-instructor" element={<RegisterInstructor />} />
          
          <Route path="/" element={<Navigate to="/welcome" replace />} />
        </Route>

        {/* RECOVERY ROUTE (Accessible when authenticated via recovery link) */}
        <Route path="/update-password" element={<UpdatePassword />} />

        {/* INSTRUCTOR ROUTES */}
        <Route element={<AuthGuard allowedRole="instructor" />}>
           <Route element={<ProfileGuard />}>
              <Route element={<InstructorLayout />}>
                <Route path="/instructor/profile" element={<InstructorProfile />} />
                <Route path="/instructor/agenda" element={<InstructorAgenda />} />
                <Route path="/instructor/discounts" element={<InstructorDiscounts />} />
                <Route path="/instructor/finance" element={<InstructorFinance />} />
              </Route>
           </Route>
        </Route>

        {/* STUDENT ROUTES */}
        <Route element={<AuthGuard allowedRole="student" />}>
           <Route element={<ProfileGuard />}>
              <Route path="/student/home" element={<StudentHome />} />
              <Route path="/student/lessons" element={<StudentLessons />} />
              <Route path="/student/finance" element={<StudentFinance />} /> 
              <Route path="/student/profile" element={<StudentProfile />} />
              <Route path="/student/payment" element={<PaymentPage />} />
           </Route>
        </Route>

        {/* SHARED ROUTES (Accessible by both roles) */}
        <Route element={<AuthGuard allowedRole="any" />}>
           <Route element={<ProfileGuard />}>
              <Route path="/student/instructor/:id" element={<StudentInstructorProfile />} />
           </Route>
        </Route>
        
        {/* Fallback */}
        <Route path="*" element={<Navigate to="/welcome" replace />} />

      </Routes>
    </>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
};

export default App;