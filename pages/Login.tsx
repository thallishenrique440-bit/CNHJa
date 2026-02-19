import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

export const Login: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
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
    <div className="min-h-screen bg-white flex flex-col px-6 py-6 sm:max-w-md sm:mx-auto">
      
      <div className="w-full flex justify-start mb-2">
        <button 
          onClick={() => navigate(-1)} 
          className="p-2 -ml-2 text-gray-600 hover:text-gray-900 rounded-full hover:bg-gray-100 transition-colors"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="flex flex-col items-center mb-8">
        <img 
          src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/logo%20oficial.png" 
          alt="Autoescola do Brasil" 
          className="w-56 h-auto object-contain mb-6"
        />
        <h1 className="text-2xl font-bold text-gray-900">
          Entrar na conta
        </h1>
      </div>

      <div className="flex-1 flex flex-col space-y-6">
        
        <Input 
          label="Email" 
          type="email" 
          placeholder="seu@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <div className="space-y-2">
          <Input 
            label="Senha" 
            type="password" 
            placeholder="Digite sua senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex justify-end pr-1">
            <button 
              onClick={() => navigate('/forgot-password')}
              className="text-sm font-medium text-blue-600 hover:text-blue-700 p-1"
            >
              Esqueci minha senha
            </button>
          </div>
        </div>

        <div className="pt-2">
          <Button fullWidth onClick={handleLogin} disabled={loading}>
            {loading ? 'Entrando...' : 'Entrar'}
          </Button>
        </div>

      </div>

      <div className="mt-auto mb-6 flex justify-center">
        <button 
          onClick={() => navigate('/welcome')} 
          className="text-base text-gray-600 font-medium hover:text-gray-900 py-3 px-4"
        >
          Ainda não tenho cadastro
        </button>
      </div>

    </div>
  );
};