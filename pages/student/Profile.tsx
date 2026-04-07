import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { 
  Camera, 
  Pencil, 
  IdCard, 
  MessageCircle, 
  GraduationCap, 
  Shield, 
  LogOut,
  ChevronRight,
  User,
  Phone
} from 'lucide-react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { CitySelect } from '../../components/CitySelect';
import { Modal } from '../../components/Modal';
import { StudentBottomNav } from '../../components/StudentBottomNav';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';

export const StudentProfile: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, signOut, refreshProfile, isProfileComplete } = useAuth();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [profileImage, setProfileImage] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState(''); // NEW STATE
  const [city, setCity] = useState('');
  
  const [trustedContact, setTrustedContact] = useState('');
  const [defaultMessage, setDefaultMessage] = useState('');
  
  const [experience, setExperience] = useState('');
  const [cnhProcess, setCnhProcess] = useState('');
  
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);

  const experienceOptions = [
    { value: 'never', label: 'Nunca dirigi' },
    { value: 'few', label: 'Já dirigi poucas vezes' },
    { value: 'frequent', label: 'Já dirijo com frequência' },
  ];

  const cnhOptions = [
    { value: 'first', label: 'Primeira habilitação' },
    { value: 'rehab', label: 'Reabilitação' },
    { value: 'addition', label: 'Adição de categoria' },
    { value: 'recycle', label: 'Reciclagem' },
  ];

  // Handle Redirect Alerts (from ProfileGuard)
  useEffect(() => {
    const state = location.state as { alertMessage?: string } | null;
    if (state?.alertMessage) {
        addToast(state.alertMessage, 'warning');
        // Clear state to avoid showing it on refresh (though React Router handles this mostly)
        window.history.replaceState({}, document.title);
    }
  }, [location, addToast]);

  useEffect(() => {
    const loadData = async () => {
      if (!session?.user) return;
      
      try {
        setLoading(true);
        const userId = session.user.id;

        // Fetch all data from 'profiles' table
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single();

        if (profile) {
          setName(profile.full_name || '');
          setEmail(profile.email || session.user.email || ''); 
          setCity(profile.city || '');
          setPhone(profile.phone || ''); // Load Phone
          
          if (profile.avatar_url) {
            setProfileImage(profile.avatar_url);
          }

          setTrustedContact(profile.trusted_contact || '');
          setDefaultMessage(profile.security_message || 'Estou em aula agora e compartilho minha localização.');
          setExperience(profile.experience_level || '');
          setCnhProcess(profile.cnh_process_type || '');
        }

      } catch (error) {
        console.error('Error loading student profile:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [session]);

  const handleSave = async () => {
    if (!session?.user) return;
    
    if (!name || !phone || phone.length < 10 || !city || !experience || !cnhProcess) {
        addToast("Por favor, preencha todos os campos obrigatórios para continuar.", 'warning');
        return;
    }

    setSaving(true);
    const userId = session.user.id;

    try {
        const { error } = await supabase
          .from('profiles')
          .update({
            full_name: name,
            phone: phone,
            city: city,
            trusted_contact: trustedContact,
            security_message: defaultMessage,
            experience_level: experience,
            cnh_process_type: cnhProcess,
            is_profile_complete: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        if (error) throw error;

        await refreshProfile();

        addToast("Informações salvas com sucesso!", 'success');
    } catch (error: any) {
        console.error('Error saving:', error);
        addToast('Erro ao salvar: ' + error.message, 'error');
    } finally {
        setSaving(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/welcome');
  };

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && session?.user) {
      try {
        setProfileImage(URL.createObjectURL(file));
        setSaving(true); 

        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `${session.user.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, file, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath);

        // Update profile with new avatar URL
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ avatar_url: publicUrl })
          .eq('id', session.user.id);

        if (updateError) throw updateError;

        setProfileImage(publicUrl);
        addToast("Foto atualizada!", 'success');

      } catch (error: any) {
        console.error('Upload error:', error);
        addToast('Erro ao fazer upload da imagem: ' + error.message, 'error');
      } finally {
        setSaving(false);
      }
    }
  };

  if (loading) {
      return <div className="min-h-screen flex items-center justify-center bg-white text-gray-500">Carregando perfil...</div>;
  }

  // --- ONBOARDING VIEW (INCOMPLETE PROFILE) ---
  if (!isProfileComplete) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden">
          {/* Header */}
          <div className="bg-blue-600 px-6 py-10 text-center relative">
            <div className="absolute top-4 right-4">
              <button 
                onClick={handleLogout}
                className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors text-white"
                title="Sair"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
            <div className="inline-flex items-center justify-center w-20 h-20 bg-white/20 rounded-full mb-4 backdrop-blur-sm">
              <User className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Complete seu perfil</h1>
            <p className="text-blue-100 mt-2 text-sm">
              Falta pouco! Precisamos de apenas alguns dados para você começar.
            </p>
          </div>

          {/* Form */}
          <div className="p-6 space-y-6">
            <div className="space-y-4">
              <Input 
                label="Nome completo"
                placeholder="Como você quer ser chamado?"
                value={name}
                onChange={(e) => setName(e.target.value)}
                icon={<User className="w-4 h-4 text-gray-400" />}
              />

              <Input 
                label="WhatsApp"
                type="tel"
                placeholder="(11) 99999-9999"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                icon={<Phone className="w-4 h-4 text-gray-400" />}
                inputMode="numeric"
              />

              <CitySelect 
                label="Cidade"
                value={city}
                onChange={setCity}
                placeholder="Onde você está?"
              />
            </div>

            <div className="pt-4">
              <Button 
                variant="primary" 
                fullWidth 
                onClick={handleSave} 
                disabled={saving}
                className="py-4 text-base font-bold shadow-lg shadow-blue-100"
              >
                {saving ? 'Salvando...' : 'Finalizar cadastro'}
              </Button>
            </div>

            <p className="text-center text-xs text-gray-400 px-4">
              Ao continuar, você concorda com nossos Termos de Uso e Política de Privacidade.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // --- FULL PROFILE VIEW (COMPLETE PROFILE) ---
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      {/* Header Minimalista (Copiado do Instrutor) */}
      <div className="px-6 pt-8 pb-6 bg-white border-b border-gray-100 relative">
        <div className="flex flex-col items-center space-y-4">
          <div className="relative group cursor-pointer" onClick={handleImageClick}>
            <div className="w-28 h-28 rounded-full border-4 border-white shadow-lg overflow-hidden bg-gray-100 flex items-center justify-center ring-1 ring-blue-100">
              {profileImage ? (
                <img src={profileImage} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <span className="text-4xl text-gray-300">👤</span>
              )}
            </div>
            <div className="absolute bottom-1 right-1 bg-blue-600 text-white p-2 rounded-full shadow-md border-2 border-white">
              <Camera className="w-4 h-4" />
            </div>
          </div>
          
          <div className="w-full text-center px-4 group relative">
            <span className="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-1 block">Perfil</span>
            <div className="flex items-center justify-center space-x-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome completo"
                className="w-full text-2xl font-bold text-gray-900 text-center bg-transparent border-none focus:ring-0 focus:outline-none placeholder-gray-300 cursor-text hover:bg-gray-50 rounded-lg transition-colors p-1"
              />
              <div className="transition-opacity absolute right-4 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none">
                <Pencil className="w-4 h-4" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-6 space-y-6 overflow-y-auto">

        {/* Seção: Dados Pessoais */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <IdCard className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Dados pessoais</h2>
          </div>
          
          <div className="space-y-4">
            <Input 
              label="Email" 
              value={email} 
              readOnly 
              className="bg-gray-50 text-gray-500 border-transparent"
            />

            {/* Phone Input */}
            <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
               <Input 
                  label="Seu WhatsApp (Obrigatório)" 
                  type="tel"
                  placeholder="(11) 99999-9999"
                  value={phone} 
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                  className="bg-white border-blue-200 focus:ring-blue-500"
                  inputMode="numeric"
              />
              <p className="text-xs text-blue-700 mt-2 leading-tight">
                  É através deste número que os instrutores entrarão em contato para combinar as aulas.
              </p>
            </div>
            
            <CitySelect 
               label="Cidade"
               value={city}
               onChange={setCity}
               placeholder="Busque sua cidade (ex: São Paulo)"
            />
          </div>
        </section>

        {/* Seção: Segurança Pessoal */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <Shield className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Segurança pessoal</h2>
          </div>
          
          <div className="space-y-5">
            <div>
              <Input 
                label="Contato de confiança (Opcional)" 
                placeholder="Ex: (11) 99999-9999"
                value={trustedContact} 
                onChange={(e) => setTrustedContact(e.target.value)}
              />
              <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                Este contato pode receber sua localização em tempo real durante uma aula, caso você solicite.
              </p>
            </div>

            <div className="flex flex-col space-y-2 w-full text-left">
              <label className="text-sm font-semibold text-gray-700 ml-1">
                Mensagem padrão
              </label>
              <textarea
                className="w-full px-4 py-3.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all duration-200 resize-none h-24"
                placeholder="Ex: Estou em aula agora e compartilho minha localização."
                maxLength={120}
                value={defaultMessage}
                onChange={(e) => setDefaultMessage(e.target.value)}
              />
              <div className="flex justify-between items-start px-1">
                <p className="text-xs text-gray-500 leading-relaxed pr-4">
                  Esta mensagem será enviada junto com sua localização quando você compartilhar durante uma aula.
                </p>
                <span className="text-[10px] text-gray-400 whitespace-nowrap mt-0.5">
                  {defaultMessage.length}/120
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Seção: Informações para o Instrutor */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <GraduationCap className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Informações para o instrutor</h2>
          </div>

          <div className="space-y-5">
            <p className="text-xs text-gray-500 leading-tight">
              Preencha apenas o essencial. Isso ajuda o instrutor a conhecer melhor seu perfil.
            </p>

            <Select 
              label="Experiência ao volante" 
              options={experienceOptions}
              value={experience}
              onChange={(e) => setExperience(e.target.value)}
            />

            <Select 
              label="Tipo de processo na CNH" 
              options={cnhOptions}
              value={cnhProcess}
              onChange={(e) => setCnhProcess(e.target.value)}
            />

            <div className="pt-2">
              <Button variant="primary" fullWidth onClick={handleSave} disabled={saving} className="py-3.5 text-sm shadow-sm">
                {saving ? 'Salvando...' : 'Salvar informações'}
              </Button>
            </div>
          </div>
        </section>

        <section className="pt-2">
          <Button 
            variant="text" 
            fullWidth 
            onClick={handleLogout} 
            className="text-red-600 hover:text-red-700 hover:bg-red-50 flex items-center justify-center space-x-2"
          >
            <LogOut className="w-4 h-4" />
            <span>Sair da conta</span>
          </Button>
        </section>

        <div className="py-6 text-center space-x-4">
          <button 
            onClick={() => setShowPrivacyModal(true)} 
            className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors"
          >
            Privacidade
          </button>
          <span className="text-gray-200 text-xs">|</span>
          <button 
            onClick={() => setShowTermsModal(true)} 
            className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors"
          >
            Termos
          </button>
        </div>

      </div>

      <Modal
        isOpen={showPrivacyModal}
        onClose={() => setShowPrivacyModal(false)}
        title="Política de Privacidade"
        footer={
          <Button fullWidth variant="outline" onClick={() => setShowPrivacyModal(false)} className="text-sm py-2.5">
            Fechar
          </Button>
        }
      >
        <div className="text-sm text-gray-600 space-y-4">
          <p>
            <strong>1. Coleta de Dados:</strong> Coletamos dados como nome, e-mail, WhatsApp e cidade para criar seu perfil e permitir agendamentos seguros.
          </p>
          <p>
            <strong>2. Uso das Informações:</strong> Seus dados são usados para conectar você aos instrutores, processar pagamentos e melhorar sua experiência.
          </p>
          <p>
            <strong>3. Compartilhamento:</strong> Compartilhamos seu WhatsApp com o instrutor somente após a confirmação da aula para facilitar a comunicação.
          </p>
          <p>
            <strong>4. Pagamentos:</strong> Usamos a Stripe para pagamentos seguros. Não armazenamos os dados do seu cartão em nossos sistemas.
          </p>
          <p>
            <strong>5. Seus Direitos:</strong> Você tem total controle sobre seus dados e pode acessar, corrigir ou excluir suas informações a qualquer momento.
          </p>
          <p className="text-xs text-gray-400 mt-4">
            Última atualização: Abril de 2026.
          </p>
          <div className="pt-4 flex justify-center">
            <Link 
              to="/privacy" 
              className="text-blue-600 font-bold hover:underline flex items-center gap-1.5"
            >
              Ver versão completa da Política de Privacidade
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </Link>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showTermsModal}
        onClose={() => setShowTermsModal(false)}
        title="Termos de Uso"
        footer={
          <Button fullWidth variant="outline" onClick={() => setShowTermsModal(false)} className="text-sm py-2.5">
            Fechar
          </Button>
        }
      >
        <div className="text-sm text-gray-600 space-y-4">
          <p>
            <strong>1. Aceitação:</strong> Ao usar o app, você concorda com estes termos.
          </p>
          <p>
            <strong>2. Responsabilidades:</strong> O aluno é responsável pela pontualidade e respeito às normas de trânsito durante as aulas.
          </p>
          <p>
            <strong>3. Pagamentos:</strong> Os pagamentos são processados via plataforma. Reembolsos dependem da política de cancelamento.
          </p>
          <p>
            <strong>4. Cancelamento:</strong> Cancelamentos devem seguir a política de antecedência mínima de 24 horas.
          </p>
          <p className="text-xs text-gray-400 mt-4">
            Última atualização: Março de 2026.
          </p>
          <div className="pt-4 flex justify-center">
            <Link 
              to="/terms" 
              className="text-blue-600 font-bold hover:underline flex items-center gap-1.5"
            >
              Ver versão completa dos Termos de Uso
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </Link>
          </div>
        </div>
      </Modal>

      <StudentBottomNav />
    </div>
  );
};