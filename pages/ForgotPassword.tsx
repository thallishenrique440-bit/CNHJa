import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

export const ForgotPassword: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!email) {
      addToast("Por favor, digite seu email.", 'warning');
      return;
    }

    setLoading(true);

    // We use window.location.origin to redirect back to the root.
    // The App.tsx listener will catch the PASSWORD_RECOVERY event and redirect to /update-password.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/update-password`,
    });

    setLoading(false);

    if (error) {
      addToast("Erro ao enviar email: " + error.message, 'error');
      return;
    }

    // Show success state
    setIsSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-white flex flex-col px-6 py-6 sm:max-w-md sm:mx-auto">
      
      {/* Back Button */}
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

      {/* Header Section */}
      <div className="flex flex-col items-center mb-8">
        <img 
          src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/ChatGPT%20Image%203%20de%20jun.%20de%202026,%2011_51_42.png" 
          alt="CNHJá" 
          className="w-48 h-auto object-contain mb-6"
        />
        <h1 className="text-2xl font-bold text-gray-900 text-center">
          Recuperar senha
        </h1>
      </div>

      {isSubmitted ? (
        // SUCCESS STATE
        <div className="flex-1 flex flex-col items-center justify-center space-y-6 animate-fade-in">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center text-3xl text-green-600 mb-2">
            ✉️
          </div>
          <div className="text-center space-y-2">
             <h3 className="font-bold text-gray-900 text-lg">Email enviado!</h3>
             <p className="text-gray-600 leading-relaxed px-4 text-sm">
               Verifique sua caixa de entrada (e spam) no endereço <strong>{email}</strong>. Clique no link para redefinir sua senha.
             </p>
          </div>
          <div className="w-full pt-4">
            <Button fullWidth onClick={() => navigate('/login')} variant="outline">
              Voltar para o login
            </Button>
          </div>
        </div>
      ) : (
        // FORM STATE
        <div className="flex-1 flex flex-col space-y-6">
          <p className="text-sm text-gray-500 text-center leading-relaxed">
            Digite o email cadastrado e enviaremos um link seguro para você redefinir sua senha.
          </p>

          <Input 
            label="Email cadastrado" 
            type="email" 
            placeholder="seu@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />

          <div className="pt-2">
            <Button fullWidth onClick={handleSubmit} disabled={loading || !email}>
              {loading ? 'Enviando...' : 'Enviar link de recuperação'}
            </Button>
          </div>
        </div>
      )}

    </div>
  );
};