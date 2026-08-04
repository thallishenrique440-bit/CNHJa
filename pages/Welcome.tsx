import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '../components/Button';
import { APP_CONFIG } from '../constants';

export const Welcome: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50/80 via-white to-white flex flex-col px-6 py-6 sm:max-w-md sm:mx-auto relative overflow-hidden">
      
      {/* Decorative Background Blobs */}
      <div className="absolute top-[-10%] right-[-20%] w-72 h-72 bg-blue-100 rounded-full mix-blend-multiply filter blur-3xl opacity-40 animate-fade-in"></div>
      <div className="absolute top-[20%] left-[-20%] w-72 h-72 bg-yellow-50 rounded-full mix-blend-multiply filter blur-3xl opacity-60 animate-fade-in"></div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col items-center justify-center relative z-10 -mt-6">
        
        {/* Logo */}
        <div className="w-full max-w-[480px] mb-3 transform hover:scale-105 transition-transform duration-500">
          <img 
            src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/ChatGPT%20Image%203%20de%20jun.%20de%202026,%2011_51_42.png" 
            alt="CNHJá" 
            className="w-full h-auto object-contain drop-shadow-sm"
          />
        </div>

        {/* Value Proposition */}
        <div className="text-center space-y-3 max-w-xs mx-auto animate-fade-in mb-4">
          <h2 className="text-3xl font-extrabold text-gray-900 leading-tight">
            Sua CNH <br/> 
            <span className="text-blue-600">sem complicações</span>
          </h2>
          <p className="text-gray-500 text-sm leading-relaxed">
            Conectando você aos melhores instrutores independentes da sua região.
          </p>
        </div>
      </div>

      {/* Bottom Actions Area */}
      <div className="w-full space-y-5 pb-6 pt-4 relative z-10 animate-fade-in">
        <div className="space-y-3">
          <Button 
            variant="primary" 
            fullWidth 
            onClick={() => navigate('/register-student', { state: { from: location.state?.from } })}
            className="py-4 text-lg font-bold shadow-lg shadow-blue-200/50"
          >
            Quero tirar minha CNH
          </Button>
          
          <Button 
            variant="outline" 
            fullWidth 
            onClick={() => navigate('/register-instructor', { state: { from: location.state?.from } })}
            className="py-4 text-lg font-semibold bg-white/60 backdrop-blur-sm border-blue-200 text-blue-700 hover:bg-blue-50"
          >
            Sou instrutor
          </Button>
        </div>

        <div className="pt-2 flex justify-center">
          <button 
            onClick={() => navigate('/login', { state: { from: location.state?.from } })}
            className="group inline-flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            <span>Já possui uma conta?</span>
            <span className="rounded-full border border-blue-200 bg-white text-blue-600 font-semibold px-3 py-1 text-sm group-hover:bg-blue-50 group-hover:border-blue-300 transition-colors duration-200">
              Entrar
            </span>
          </button>
        </div>
        
        <div className="text-center">
           <p className="text-[10px] text-gray-300 font-medium tracking-wide">
             © {APP_CONFIG.YEAR} {APP_CONFIG.NAME}
           </p>
        </div>
      </div>
      
    </div>
  );
};