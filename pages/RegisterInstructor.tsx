import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { CitySelect } from '../components/CitySelect';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

export const RegisterInstructor: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [name, setName] = useState('');
  const [detranCredential, setDetranCredential] = useState('');
  const [email, setEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [city, setCity] = useState(''); 
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);

  const isPasswordStrong = (pwd: string) => {
    const minLength = 8;
    const hasUpper = /[A-Z]/.test(pwd);
    const hasLower = /[a-z]/.test(pwd);
    const hasNumber = /[0-9]/.test(pwd);
    return pwd.length >= minLength && hasUpper && hasLower && hasNumber;
  };

  const handleRegister = async () => {
    if (!name || !detranCredential || !email || !whatsapp || !city || !password || !confirmPassword) {
      addToast("Por favor, preencha todos os campos obrigatórios.", 'warning');
      return;
    }

    if (!/^\d+$/.test(detranCredential)) {
      addToast("A credencial deve conter somente números.", 'warning');
      return;
    }

    if (!whatsapp || whatsapp.length < 10 || whatsapp.length > 11) {
      addToast("Informe um número de WhatsApp válido com DDD.", 'warning');
      return;
    }

    if (!isPasswordStrong(password)) {
      addToast("A senha deve ter no mínimo 8 caracteres, contendo maiúscula, minúscula e número.", 'warning');
      return;
    }

    if (password !== confirmPassword) {
      addToast("As senhas não conferem.", 'warning');
      return;
    }

    if (!acceptedTerms) {
      addToast("Você precisa aceitar os termos de uso.", 'warning');
      return;
    }

    setLoading(true);

    // SUPABASE SIGN UP
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
          city: city, // Standardized via CitySelect
          phone: whatsapp,
          whatsapp: whatsapp,
          credential: detranCredential,
          role: 'instructor'
        }
      }
    });

    setLoading(false);

    if (error) {
      addToast("Erro ao criar conta: " + error.message, 'error');
      return;
    }

    if (data.user) {
      localStorage.setItem('ab_instructor_data', JSON.stringify({
        name,
        detranCredential,
        whatsapp,
        city
      }));
      localStorage.setItem('ab_user_type', 'instructor');

      if (data.user.identities?.length === 0) {
        addToast("Este email já está em uso.", 'error');
      } else if (!data.session) {
        addToast("Cadastro realizado! Verifique seu email para confirmar a conta.", 'success');
        navigate('/login');
      } else {
        navigate('/instructor/agenda');
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
        <h1 className="text-2xl font-bold text-gray-900 text-center">
          Criar conta como instrutor
        </h1>
      </div>

      <div className="flex-1 flex flex-col space-y-5">
        
        <Input 
          label="Nome completo" 
          placeholder="Digite seu nome completo"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Input 
          label="Número da credencial do instrutor" 
          placeholder="Digite apenas números"
          value={detranCredential}
          onChange={(e) => setDetranCredential(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
        />

        <Input 
          label="Email" 
          type="email" 
          placeholder="seu@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <Input 
          label="WhatsApp para contato (obrigatório)" 
          type="tel" 
          placeholder="Ex: 11999999999"
          value={whatsapp}
          onChange={(e) => setWhatsapp(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
        />

        <CitySelect 
          label="Cidade de atuação"
          value={city}
          onChange={setCity}
          placeholder="Busque sua cidade (ex: São Paulo)"
        />

        <div className="space-y-1">
          <Input 
            label="Senha" 
            type="password" 
            placeholder="Crie uma senha forte"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-[10px] text-gray-400 px-1">
            Mínimo 8 caracteres, 1 maiúscula, 1 minúscula e 1 número.
          </p>
        </div>

        <Input 
          label="Confirmar senha" 
          type="password" 
          placeholder="Repita sua senha"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />

        <div className="flex items-start pt-2">
          <div className="flex items-center h-5">
            <input
              id="terms"
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              className="w-5 h-5 border-gray-300 rounded text-blue-600 focus:ring-blue-500 transition duration-150 ease-in-out"
            />
          </div>
          <label htmlFor="terms" className="ml-3 text-sm text-gray-600 leading-tight">
            Li e aceito os <span className="font-semibold text-blue-600">Termos de Uso</span> e a <span className="font-semibold text-blue-600">Política de Privacidade</span>
          </label>
        </div>

        <div className="pt-4">
          <Button fullWidth onClick={handleRegister} disabled={loading}>
            {loading ? 'Criando conta...' : 'Criar conta'}
          </Button>
        </div>

      </div>

      <div className="mt-8 mb-6 flex justify-center">
        <button 
          onClick={() => navigate('/login')} 
          className="text-base text-gray-600 font-medium hover:text-gray-900 py-3 px-4"
        >
          Já tenho cadastro
        </button>
      </div>

    </div>
  );
};