import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export const InstructorStripeBanner: React.FC = () => {
  const { session, userRole, isPaymentSetupComplete } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (userRole !== 'instructor' || !session?.user) {
      setShowBanner(false);
      return;
    }

    // Don't show banner on the finance page itself to avoid redundancy
    if (location.pathname === '/instructor/finance') {
      setShowBanner(false);
      return;
    }

    setShowBanner(!isPaymentSetupComplete);
  }, [session, userRole, location.pathname, isPaymentSetupComplete]);

  if (!showBanner) return null;

  return (
    <div 
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
            <span className="text-[10px] text-yellow-700 leading-tight">Complete a configuração da sua conta Asaas para habilitar seus recebimentos.</span>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-yellow-400 group-hover:text-yellow-600 transition-colors shrink-0" />
      </div>
    </div>
  );
};
