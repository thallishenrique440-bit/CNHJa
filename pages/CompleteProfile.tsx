import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, User, Phone } from 'lucide-react';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { CitySelect } from '../components/CitySelect';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export const CompleteProfile: React.FC = () => {
  const navigate = useNavigate();
  const { session, signOut, refreshProfile, userRole } = useAuth();
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');

  useEffect(() => {
    const loadData = async () => {
      if (!session?.user) return;
      
      try {
        setLoading(true);
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, phone, city')
          .eq('id', session.user.id)
          .single();

        if (profile) {
          setName(profile.full_name || '');
          setPhone(profile.phone || '');
          setCity(profile.city || '');
        }
      } catch (error) {
        console.error('Error loading profile:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [session]);

  const handleSave = async () => {
    if (!session?.user) return;
    
    if (!name.trim() || !phone.trim() || phone.length < 10 || !city.trim()) {
        addToast("Por favor, preencha todos os campos obrigatórios corretamente.", 'warning');
        return;
    }

    setSaving(true);

    try {
        const { error } = await supabase
          .from('profiles')
          .update({
            full_name: name.trim(),
            phone: phone.trim(),
            city: city.trim(),
            updated_at: new Date().toISOString()
          })
          .eq('id', session.user.id);

        if (error) throw error;

        // Refresh profile in context to update isProfileComplete
        await refreshProfile();
        
        addToast("Perfil completado com sucesso!", 'success');
        
        // Redirect based on role
        if (userRole === 'student') {
          navigate('/student/home');
        } else {
          navigate('/instructor/agenda');
        }
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

  if (loading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-white">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      );
  }

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
};
