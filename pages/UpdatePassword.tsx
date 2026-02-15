import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

export const UpdatePassword: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // Security check: If loaded directly without a session (recovery token), redirect to login
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        navigate('/login');
      }
    });
  }, [navigate]);

  const isPasswordStrong = (pwd: string) => {
    const minLength = 8;
    const hasUpper = /[A-Z]/.test(pwd);
    const hasLower = /[a-z]/.test(pwd);
    const hasNumber = /[0-9]/.test(pwd);
    return pwd.length >= minLength && hasUpper && hasLower && hasNumber;
  };

  const handleUpdate = async () => {
    if (!password || !confirmPassword) {
      addToast("Preencha todos os campos.", 'warning');
      return;
    }

    if (password !== confirmPassword) {
      addToast("As senhas não conferem.", 'warning');
      return;
    }

    if (!isPasswordStrong(password)) {
      addToast("A senha deve ter no mínimo 8 caracteres, contendo maiúscula, minúscula e número.", 'warning');
      return;
    }

    setLoading(true);

    const { data, error } = await supabase.auth.updateUser({
      password: password
    });

    setLoading(false);

    if (error) {
      addToast("Erro ao atualizar senha: " + error.message, 'error');
      return;
    }

    addToast("Senha atualizada com sucesso!", 'success');
    
    // Redirect based on role
    const role = data.user?.user_metadata?.role;
    if (role === 'student') {
        navigate('/student/home');
    } else if (role === 'instructor') {
        navigate('/instructor/agenda');
    } else {
        navigate('/login');
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col px-6 py-6 sm:max-w-md sm:mx-auto">
      
      <div className="flex flex-col items-center mb-8 mt-10">
        <h1 className="text-2xl font-bold text-gray-900 text-center">
          Redefinir Senha
        </h1>
        <p className="text-sm text-gray-500 mt-2 text-center">
            Crie uma nova senha para acessar sua conta.
        </p>
      </div>

      <div className="flex-1 flex flex-col space-y-6">
        
        <div className="space-y-1">
          <Input 
            label="Nova Senha" 
            type="password" 
            placeholder="Digite sua nova senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-[10px] text-gray-400 px-1">
            Mínimo 8 caracteres, 1 maiúscula, 1 minúscula e 1 número.
          </p>
        </div>

        <Input 
          label="Confirmar Nova Senha" 
          type="password" 
          placeholder="Repita a nova senha"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />

        <div className="pt-4">
          <Button fullWidth onClick={handleUpdate} disabled={loading}>
            {loading ? 'Atualizando...' : 'Salvar nova senha'}
          </Button>
        </div>

      </div>
    </div>
  );
};