import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { APP_CONFIG } from '../constants';

export const Login: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!email || !password) {
      addToast("Preencha email e senha.", 'warning');
      return;
    }

    setLoading(true);
    
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      addToast("Erro ao entrar: " + error.message, 'error');
      return;
    }

    if (data.user) {
      // Legacy Bridge
      const role = data.user.user_metadata.role;
      localStorage.setItem('ab_user_type', role);
      
      if (role === 'student') {
        navigate('/student/home');
      } else if (role === 'instructor') {
        navigate('/instructor/agenda');
      } else {
        addToast("Erro: Tipo de usuário desconhecido.", 'error');
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50/50 via-white to-white flex flex-col px-6 py-10 sm:justify-center items-center">
      
      <div className="w-full max-w-md flex justify-start mb-6">
        <button 
          onClick={() => navigate(-1)} 
          className="p-2 -ml-2 text-gray-400 hover:text-blue-600 rounded-full hover:bg-blue-50 transition-all duration-200 group"
        >
          <svg className="w-6 h-6 transform group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="w-full max-w-md bg-white sm:rounded-3xl sm:shadow-2xl sm:shadow-blue-100/50 sm:border sm:border-gray-100 p-2 sm:p-8 space-y-8">
        
        <div className="flex flex-col items-center">
          <img 
            src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/logo%20oficial.png" 
            alt="Autoescola do Brasil" 
            className="w-64 h-auto object-contain mb-8 drop-shadow-sm"
          />
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
              Entrar na conta
            </h1>
            <p className="text-gray-500 text-sm font-medium">
              Bem-vindo de volta! Continue sua jornada.
            </p>
          </div>
        </div>

        <form onSubmit={handleLogin} className="flex flex-col space-y-8">
          
          <div className="space-y-4">
            <Input 
              label="Email" 
              type="email" 
              name="email"
              autoComplete="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <div className="space-y-1.5">
              <Input 
                label="Senha" 
                type="password" 
                name="password"
                autoComplete="current-password"
                placeholder="Digite sua senha"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="flex justify-end pr-1">
                <button 
                  type="button"
                  onClick={() => navigate('/forgot-password')}
                  className="text-sm font-bold text-blue-600 hover:text-blue-700 hover:underline transition-colors"
                >
                  Esqueci minha senha
                </button>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <Button 
              fullWidth 
              type="submit" 
              disabled={loading}
              className="py-4 text-lg shadow-xl shadow-blue-200/50 hover:shadow-blue-300/50 transform hover:-translate-y-0.5 transition-all duration-300"
            >
              {loading ? 'Entrando na conta...' : 'Entrar na conta'}
            </Button>
          </div>

        </form>

        <div className="pt-4 flex justify-center">
          <button 
            onClick={() => navigate('/welcome')} 
            className="text-sm text-gray-500 font-medium hover:text-blue-600 py-2 px-4 transition-colors"
          >
            Ainda não tem cadastro? <span className="text-blue-600 font-bold">Criar conta</span>
          </button>
        </div>

      </div>

      <div className="mt-8 text-center">
        <p className="text-[10px] text-gray-300 font-medium tracking-widest uppercase">
          © {APP_CONFIG.YEAR} {APP_CONFIG.NAME}
        </p>
      </div>

    </div>
  );
};