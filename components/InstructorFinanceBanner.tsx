import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AlertCircle, ChevronRight, UserCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export const InstructorFinanceBanner: React.FC = () => {
  const { session, userRole, isProfileComplete, isPaymentSetupComplete } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [bannerType, setBannerType] = useState<'profile' | 'finance' | null>(null);

  useEffect(() => {
    if (userRole !== 'instructor' || !session?.user) {
      setBannerType(null);
      return;
    }

    // 1. Check Profile completeness first (Highest Priority)
    if (isProfileComplete === false) {
      // Don't show profile banner on the profile page itself to avoid redundancy
      if (location.pathname === '/instructor/profile') {
        setBannerType(null);
      } else {
        setBannerType('profile');
      }
      return;
    }

    // 2. Check Financial onboarding completeness (Second Priority)
    if (isProfileComplete === true && isPaymentSetupComplete === false) {
      // Don't show finance banner on the finance page itself to avoid redundancy
      if (location.pathname === '/instructor/finance') {
        setBannerType(null);
      } else {
        setBannerType('finance');
      }
      return;
    }

    // Default: both complete, show nothing
    setBannerType(null);
  }, [session, userRole, location.pathname, isProfileComplete, isPaymentSetupComplete]);

  if (!bannerType) return null;

  if (bannerType === 'profile') {
    return (
      <div 
        id="banner-profile-onboarding"
        onClick={() => navigate('/instructor/profile')}
        className="bg-indigo-50 border-b border-indigo-100 px-4 py-3 cursor-pointer hover:bg-indigo-100/85 transition-colors group sticky top-0 z-50"
      >
        <div className="max-w-md mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-100 p-1.5 rounded-full group-hover:bg-indigo-200 transition-colors shrink-0">
              <UserCheck className="w-4 h-4 text-indigo-700" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-indigo-900">Complete seu perfil profissional</span>
              <span className="text-[10px] text-indigo-700 leading-tight">
                Complete seu perfil para aparecer nas buscas dos alunos e transmitir mais confiança antes da primeira aula.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0 text-indigo-600 font-medium text-[10px]">
            <span>Completar perfil</span>
            <ChevronRight className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-600 transition-colors shrink-0" />
          </div>
        </div>
      </div>
    );
  }

  // bannerType === 'finance'
  return (
    <div 
      id="banner-finance-onboarding"
      onClick={() => navigate('/instructor/finance')}
      className="bg-yellow-50 border-b border-yellow-100 px-4 py-3 cursor-pointer hover:bg-yellow-100 transition-colors group sticky top-0 z-50"
    >
      <div className="max-w-md mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="bg-yellow-100 p-1.5 rounded-full group-hover:bg-yellow-200 transition-colors shrink-0">
            <AlertCircle className="w-4 h-4 text-yellow-700" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-yellow-900">Onboarding Financeiro Pendente</span>
            <span className="text-[10px] text-yellow-700 leading-tight">
              Complete a configuração da sua conta Asaas para habilitar seus recebimentos.
            </span>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-yellow-400 group-hover:text-yellow-600 transition-colors shrink-0 animate-pulse group-hover:animate-none" />
      </div>
    </div>
  );
};

