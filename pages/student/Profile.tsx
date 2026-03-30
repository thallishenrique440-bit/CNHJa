import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
  const { session, signOut } = useAuth();
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
    
    if (!phone || phone.length < 10) {
        addToast("Por favor, preencha um número de WhatsApp válido.", 'warning');
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
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        if (error) throw error;

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

  return (
    <div className="min-h-screen bg-white flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      <div className="px-6 pt-6 pb-4 border-b border-gray-100 sticky top-0 bg-white z-10">
        <h1 className="text-xl font-bold text-gray-900">Meu perfil</h1>
      </div>

      <div className="flex-1 px-6 py-6 space-y-8 overflow-y-auto">

        <section className="space-y-4">
          
          <div className="flex flex-col items-center mb-6">
            <div 
              className="relative group cursor-pointer" 
              onClick={handleImageClick}
            >
              <div className="w-24 h-24 rounded-full border-4 border-white shadow-md overflow-hidden bg-gray-100 flex items-center justify-center">
                {profileImage ? (
                  <img src={profileImage} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-4xl text-gray-400">👤</span>
                )}
              </div>
              
              <div className="absolute bottom-0 right-0 bg-blue-600 text-white p-2 rounded-full shadow-sm border-2 border-white">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
            </div>
            
            <p 
              className="text-xs text-blue-600 font-medium mt-3 cursor-pointer"
              onClick={handleImageClick}
            >
              Toque para adicionar sua foto
            </p>
            
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileChange} 
              accept="image/*" 
              className="hidden" 
            />
          </div>

          <Input 
            label="Nome completo" 
            value={name} 
            onChange={(e) => setName(e.target.value)}
            placeholder="Seu nome completo"
          />
          
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
        </section>

        <hr className="border-gray-100" />

        <section className="space-y-5">
          <h2 className="text-lg font-bold text-gray-900">Segurança pessoal</h2>
          
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
        </section>

        <hr className="border-gray-100" />

        <section className="space-y-5">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Informações para o instrutor</h2>
            <p className="text-xs text-gray-500 mt-1 leading-tight">
              Preencha apenas o essencial. Isso ajuda o instrutor a conhecer melhor seu perfil.
            </p>
          </div>

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
            <Button variant="primary" fullWidth onClick={handleSave} disabled={saving} className="py-2.5 text-sm">
              {saving ? 'Salvando...' : 'Salvar informações'}
            </Button>
          </div>
        </section>

        <hr className="border-gray-100" />

        <section className="pt-2">
          <Button variant="text" fullWidth onClick={handleLogout} className="text-red-600 hover:text-red-700 hover:bg-red-50">
            Sair da conta
          </Button>
        </section>

        <div className="py-6 text-center space-x-2">
          <button 
            onClick={() => setShowPrivacyModal(true)} 
            className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors"
          >
            Política de Privacidade
          </button>
          <span className="text-gray-300 text-xs">·</span>
          <button 
            onClick={() => setShowTermsModal(true)} 
            className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors"
          >
            Termos de Uso
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
            <strong>1. Coleta de Dados:</strong> Coletamos informações como nome, email e dados de pagamento para fornecer nossos serviços.
          </p>
          <p>
            <strong>2. Uso das Informações:</strong> Seus dados são usados para conectar você aos instrutores e processar pagamentos.
          </p>
          <p>
            <strong>3. Compartilhamento:</strong> Não vendemos seus dados a terceiros. Compartilhamos apenas o necessário com parceiros de pagamento.
          </p>
          <p>
            <strong>4. Segurança:</strong> Adotamos medidas de segurança para proteger suas informações contra acesso não autorizado.
          </p>
          <p className="text-xs text-gray-400 mt-4">
            Última atualização: Março de 2026.
          </p>
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
        </div>
      </Modal>

      <StudentBottomNav />
    </div>
  );
};