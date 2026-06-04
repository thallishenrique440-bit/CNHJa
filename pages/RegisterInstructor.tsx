import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { CitySelect, isValidCity } from '../components/CitySelect';
import { TermsModal } from '../components/TermsModal';
import { PrivacyModal } from '../components/PrivacyModal';
import { TERMS_VERSION, PRIVACY_VERSION, APP_CONFIG } from '../constants';
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
  const [isTermsModalOpen, setIsTermsModalOpen] = useState(false);
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Persist form data to sessionStorage to avoid loss when navigating to terms/privacy
  useEffect(() => {
    const savedData = sessionStorage.getItem('ab_instructor_register_data');
    if (savedData) {
      const data = JSON.parse(savedData);
      setName(data.name || '');
      setDetranCredential(data.detranCredential || '');
      setEmail(data.email || '');
      setWhatsapp(data.whatsapp || '');
      setCity(data.city || '');
    }
  }, []);

  useEffect(() => {
    const data = { name, detranCredential, email, whatsapp, city };
    sessionStorage.setItem('ab_instructor_register_data', JSON.stringify(data));
  }, [name, detranCredential, email, whatsapp, city]);

  // Check for terms/privacy acceptance from full page
  useEffect(() => {
    const termsAgreed = localStorage.getItem('ab_terms_agreed');
    const privacyAgreed = localStorage.getItem('ab_privacy_agreed');
    
    if (termsAgreed === 'true' || privacyAgreed === 'true') {
      setAcceptedTerms(true);
      if (termsAgreed) localStorage.removeItem('ab_terms_agreed');
      if (privacyAgreed) localStorage.removeItem('ab_privacy_agreed');
    }
  }, []);

  const isPasswordStrong = (pwd: string) => {
    const minLength = 8;
    const hasUpper = /[A-Z]/.test(pwd);
    const hasLower = /[a-z]/.test(pwd);
    const hasNumber = /[0-9]/.test(pwd);
    return pwd.length >= minLength && hasUpper && hasLower && hasNumber;
  };

  const handleRegister = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!name || !detranCredential || !email || !whatsapp || !city || !password || !confirmPassword) {
      addToast("Por favor, preencha todos os campos obrigatórios.", 'warning');
      return;
    }

    if (!isValidCity(city)) {
      addToast("Selecione uma cidade da lista.", 'warning');
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

    const signupData = {
      full_name: name,
      city: city,
      phone: whatsapp,
      whatsapp: whatsapp,
      credential: detranCredential,
      role: 'instructor',
      terms_accepted_at: new Date().toISOString(),
      privacy_accepted_at: new Date().toISOString()
    };

    console.log('RegisterInstructor: Initiating signup with metadata:', signupData);

    // SUPABASE SIGN UP
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: signupData
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
        navigate('/instructor/profile');
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
            src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/ChatGPT%20Image%203%20de%20jun.%20de%202026,%2011_51_42.png" 
            alt="CNHJá" 
            className="w-64 h-auto object-contain mb-8 drop-shadow-sm"
          />
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
              Seja um Instrutor
            </h1>
            <p className="text-gray-500 text-sm font-medium">
              Aumente sua renda e tenha flexibilidade total
            </p>
          </div>
        </div>

        <form onSubmit={handleRegister} className="flex flex-col space-y-8">
          
          {/* Dados Pessoais */}
          <div className="space-y-5">
            <div className="flex items-center space-x-2 px-1">
              <div className="w-1 h-4 bg-blue-600 rounded-full"></div>
              <h2 className="text-xs font-bold text-blue-600 uppercase tracking-widest">Dados Pessoais</h2>
            </div>
            
            <div className="space-y-4">
              <Input 
                label="Nome completo" 
                name="name"
                autoComplete="name"
                placeholder="Ex: Carlos Oliveira"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />

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
                  label="WhatsApp" 
                  type="tel" 
                  name="whatsapp"
                  autoComplete="tel"
                  placeholder="(11) 99999-9999"
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value.replace(/\D/g, '').slice(0, 11))}
                  inputMode="numeric"
                />
                <p className="text-[11px] text-gray-400 px-1 leading-tight">
                  Este número será visível para os alunos agendarem.
                </p>
              </div>
            </div>
          </div>

          {/* Dados Profissionais */}
          <div className="space-y-5">
            <div className="flex items-center space-x-2 px-1">
              <div className="w-1 h-4 bg-blue-600 rounded-full"></div>
              <h2 className="text-xs font-bold text-blue-600 uppercase tracking-widest">Profissional</h2>
            </div>

            <div className="space-y-4">
              <Input 
                label="Credencial do Instrutor" 
                name="credential"
                autoComplete="off"
                placeholder="Apenas números"
                value={detranCredential}
                onChange={(e) => setDetranCredential(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
              />

              <CitySelect 
                label="Cidade de atuação"
                value={city}
                onChange={setCity}
                placeholder="Onde você pretende dar aulas?"
              />
            </div>
          </div>

          {/* Segurança */}
          <div className="space-y-5">
            <div className="flex items-center space-x-2 px-1">
              <div className="w-1 h-4 bg-blue-600 rounded-full"></div>
              <h2 className="text-xs font-bold text-blue-600 uppercase tracking-widest">Segurança</h2>
            </div>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Input 
                  label="Senha" 
                  type="password" 
                  name="password"
                  autoComplete="new-password"
                  placeholder="Crie uma senha forte"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-[11px] text-gray-400 px-1 leading-tight">
                  Mínimo 8 caracteres, 1 maiúscula e 1 número.
                </p>
              </div>

              <Input 
                label="Confirmar senha" 
                type="password" 
                name="confirmPassword"
                autoComplete="new-password"
                placeholder="Repita sua senha"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-6 pt-2">
            <div className="flex items-start group">
              <div className="flex items-center h-6">
                <input
                  id="terms"
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="w-5 h-5 border-gray-300 rounded text-blue-600 focus:ring-blue-500 transition duration-150 ease-in-out cursor-pointer"
                />
              </div>
              <label htmlFor="terms" className="ml-3 text-sm text-gray-500 leading-snug select-none">
                Li e aceito os <button type="button" onClick={(e) => { e.preventDefault(); setIsTermsModalOpen(true); }} className="font-bold text-blue-600 hover:underline">Termos de Uso</button> e a <button type="button" onClick={(e) => { e.preventDefault(); setIsPrivacyModalOpen(true); }} className="font-bold text-blue-600 hover:underline">Política de Privacidade</button>
              </label>
            </div>

            <Button 
              fullWidth 
              type="submit" 
              disabled={loading || !acceptedTerms}
              className={`py-4 text-lg shadow-xl transition-all duration-300 ${
                !acceptedTerms 
                ? 'opacity-50 cursor-not-allowed grayscale' 
                : 'shadow-blue-200/50 hover:shadow-blue-300/50 transform hover:-translate-y-0.5'
              }`}
            >
              {loading ? 'Criando sua conta...' : 'Criar minha conta'}
            </Button>
          </div>

        </form>

        <div className="pt-4 flex justify-center">
          <button 
            onClick={() => navigate('/login')} 
            className="text-sm text-gray-500 font-medium hover:text-blue-600 py-2 px-4 transition-colors"
          >
            Já tem uma conta? <span className="text-blue-600 font-bold">Fazer login</span>
          </button>
        </div>

        <TermsModal 
          isOpen={isTermsModalOpen}
          onClose={() => setIsTermsModalOpen(false)}
          onAccept={() => setAcceptedTerms(true)}
        />

        <PrivacyModal 
          isOpen={isPrivacyModalOpen}
          onClose={() => setIsPrivacyModalOpen(false)}
          onAccept={() => setAcceptedTerms(true)}
        />
      </div>

      <div className="mt-8 text-center">
        <p className="text-[10px] text-gray-300 font-medium tracking-widest uppercase">
          © {APP_CONFIG.YEAR} {APP_CONFIG.NAME}
        </p>
      </div>

    </div>
  );
};