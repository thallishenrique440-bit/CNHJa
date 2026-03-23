import React, { useState, useRef, useEffect } from 'react';
import { 
  MessageCircle, 
  IdCard, 
  GraduationCap, 
  DollarSign, 
  Car, 
  MapPin, 
  Camera, 
  Share2,
  Check,
  ChevronRight,
  LogOut,
  Navigation
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { CitySelect } from '../components/CitySelect';
import { GooglePlacesInput } from '../components/GooglePlacesInput';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export const InstructorProfile: React.FC = () => {
  const navigate = useNavigate();
  const { session, signOut } = useAuth();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Loading States
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Helper: Format raw string "10000" -> "R$ 100,00"
  const formatCurrency = (value: string | number) => {
    if (!value) return '';
    const number = Number(value) / 100;
    return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper: Format phone "11999999999" -> "(11) 99999-9999"
  const formatPhone = (value: string) => {
    if (!value) return '';
    const clean = value.replace(/\D/g, '');
    if (clean.length <= 2) return `(${clean}`;
    if (clean.length <= 7) return `(${clean.slice(0, 2)}) ${clean.slice(2)}`;
    return `(${clean.slice(0, 2)}) ${clean.slice(2, 7)}-${clean.slice(7, 11)}`;
  };

  // 1. Basic Data
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [credential, setCredential] = useState('');
  const [city, setCity] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [publicId, setPublicId] = useState(''); 

  // 2. Pricing (New Structure)
  const [pricesA, setPricesA] = useState({ day: '0', night: '0' });
  const [pricesB, setPricesB] = useState({ day: '0', night: '0' });
  
  // 3. Night Lessons
  const [nightLessonsEnabled, setNightLessonsEnabled] = useState(false);

  // 4. Categories
  const [category, setCategory] = useState('B'); 

  // 5. Vehicles (Selection Flags)
  const [hasCar, setHasCar] = useState(true);
  const [hasBike, setHasBike] = useState(false);

  // 5.1 Vehicle Details
  const [carId, setCarId] = useState<string | null>(null);
  const [carModel, setCarModel] = useState('');
  const [carYear, setCarYear] = useState('');
  const [carTransmission, setCarTransmission] = useState('manual');

  const [bikeId, setBikeId] = useState<string | null>(null);
  const [bikeModel, setBikeModel] = useState('');
  const [bikeYear, setBikeYear] = useState('');
  const [bikeTransmission, setBikeTransmission] = useState('manual');

  // 6. Location
  const [defaultLocation, setDefaultLocation] = useState('');
  const [meetingPointLat, setMeetingPointLat] = useState<number | null>(null);
  const [meetingPointLng, setMeetingPointLng] = useState<number | null>(null);
  const [meetingPointPlaceId, setMeetingPointPlaceId] = useState<string | null>(null);

  // --- FETCH DATA ---
  useEffect(() => {
    const loadData = async () => {
      if (!session?.user) return;
      
      try {
        setLoading(true);
        const userId = session.user.id;

        // 1. Fetch Profile (Base Info)
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single();

        if (profile) {
          setName(profile.full_name || '');
          setCity(profile.city || '');
          if (profile.avatar_url) {
            setProfileImage(profile.avatar_url);
          }
        }

        // 2. Fetch Instructor Details
        const { data: instructor } = await supabase
          .from('instructors')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (instructor) {
          setPublicId(instructor.public_id || '');
          setCredential(instructor.credential_number || '');
          setWhatsapp(instructor.whatsapp || '');
          setNightLessonsEnabled(instructor.has_night_lessons || false);
          setDefaultLocation(instructor.meeting_point || '');
          setMeetingPointLat(instructor.meeting_point_lat || null);
          setMeetingPointLng(instructor.meeting_point_lng || null);
          setMeetingPointPlaceId(instructor.meeting_point_place_id || null);
          
          if (instructor.categories && instructor.categories.length > 0) {
            const cats = instructor.categories;
            if (cats.includes('A') && cats.includes('B')) setCategory('AB');
            else if (cats.includes('A')) setCategory('A');
            else setCategory('B');
          }

          // 2.1 Fetch Category Prices
          const { data: catPrices } = await supabase
            .from('instructor_categories')
            .select('*')
            .eq('instructor_id', userId);

          if (catPrices && catPrices.length > 0) {
            const catA = catPrices.find(c => c.category === 'A');
            const catB = catPrices.find(c => c.category === 'B');

            if (catA) {
              setPricesA({
                day: String(catA.day_price || 0),
                night: String(catA.night_price || 0)
              });
            }
            if (catB) {
              setPricesB({
                day: String(catB.day_price || 0),
                night: String(catB.night_price || 0)
              });
            }
          } else {
            // Fallback: Populate from legacy base_price if new table is empty
            const legacyBase = String(instructor.base_price || 0);
            const legacyNight = String(instructor.night_price || 0);
            
            setPricesA({ day: legacyBase, night: legacyNight });
            setPricesB({ day: legacyBase, night: legacyNight });
          }

        } else {
          // Fallback metadata
          const meta = session.user.user_metadata;
          if (meta) {
            if (meta.whatsapp) setWhatsapp(meta.whatsapp);
            if (meta.credential) setCredential(meta.credential);
          }
        }

        // 3. Fetch Vehicles
        const { data: vehicles } = await supabase
          .from('instructor_vehicles')
          .select('*')
          .eq('instructor_id', userId);

        if (vehicles) {
          const car = vehicles.find(v => v.type === 'car');
          const bike = vehicles.find(v => v.type === 'bike');
          
          if (car) {
            setHasCar(true);
            setCarId(car.id);
            setCarModel(car.model || '');
            setCarYear(String(car.year || ''));
            setCarTransmission(car.transmission || 'manual');
          } else {
             setHasCar(true); 
          }

          if (bike) {
            setHasBike(true);
            setBikeId(bike.id);
            setBikeModel(bike.model || '');
            setBikeYear(String(bike.year || ''));
            setBikeTransmission(bike.transmission || 'manual');
          }
        }

      } catch (error) {
        console.error('Error loading profile:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [session]);

  const handleCopyProfileLink = () => {
    if (!publicId) return;
    const link = `${window.location.origin}/#/i/${publicId}`;
    navigator.clipboard.writeText(link).then(() => {
      addToast("Link do seu perfil copiado! Você pode compartilhar com seus alunos.", 'success');
    }).catch(() => {
      addToast("Erro ao copiar link.", 'error');
    });
  };

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && session?.user) {
      try {
        // Visual feedback immediately
        setProfileImage(URL.createObjectURL(file));
        setSaving(true); // Reuse saving state for upload indicator

        const fileExt = file.name.split('.').pop();
        // Updated Path Structure: avatars/{userId}/profile.{ext}
        // This matches the RLS policy: (storage.foldername(name))[1] = auth.uid()
        // Adding Date.now() bypasses browser caching on update
        const fileName = `profile-${Date.now()}.${fileExt}`;
        const filePath = `${session.user.id}/${fileName}`;

        // 1. Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, file, { upsert: true });

        if (uploadError) throw uploadError;

        // 2. Get Public URL
        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath);

        // 3. Update Profile Table with new URL
        const { error: dbError } = await supabase
          .from('profiles')
          .update({ avatar_url: publicUrl })
          .eq('id', session.user.id);

        if (dbError) throw dbError;

        // Ensure state is synced with public URL
        setProfileImage(publicUrl);
        addToast("Foto de perfil atualizada!", 'success');

      } catch (error: any) {
        console.error('Upload error:', error);
        addToast('Erro ao fazer upload da imagem: ' + error.message, 'error');
      } finally {
        setSaving(false);
      }
    }
  };

  const handleSave = async () => {
    if (!session?.user) return;
    if (!whatsapp || !credential) {
      addToast("WhatsApp e Credencial são obrigatórios.", 'warning');
      return;
    }

    setSaving(true);
    const userId = session.user.id;

    try {
      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          city: city, // Updating city with standardized value
        })
        .eq('id', userId);

      if (profileError) throw profileError;

      let catArray: string[] = [];
      if (category === 'AB') catArray = ['A', 'B'];
      else if (category === 'A') catArray = ['A'];
      else catArray = ['B'];

      // Derive Legacy Prices (Prefer B, then A)
      // This ensures older app versions still see a valid price
      const legacyBasePrice = catArray.includes('B') 
        ? parseInt(pricesB.day.replace(/\D/g, '') || '0') 
        : parseInt(pricesA.day.replace(/\D/g, '') || '0');
        
      const legacyNightPrice = catArray.includes('B')
        ? parseInt(pricesB.night.replace(/\D/g, '') || '0')
        : parseInt(pricesA.night.replace(/\D/g, '') || '0');

      const instructorData = {
        id: userId,
        credential_number: credential,
        whatsapp: whatsapp.replace(/\D/g, ''),
        base_price: legacyBasePrice,
        night_price: legacyNightPrice,
        has_night_lessons: nightLessonsEnabled,
        meeting_point: defaultLocation,
        meeting_point_lat: meetingPointLat,
        meeting_point_lng: meetingPointLng,
        meeting_point_place_id: meetingPointPlaceId,
        categories: catArray
      };

      const { error: instructorError } = await supabase
        .from('instructors')
        .upsert(instructorData);

      if (instructorError) throw instructorError;

      // --- UPSERT CATEGORY PRICES ---
      const categoriesToUpsert = [];

      if (catArray.includes('A')) {
        categoriesToUpsert.push({
          instructor_id: userId,
          category: 'A',
          day_price: parseInt(pricesA.day.replace(/\D/g, '') || '0'),
          night_price: parseInt(pricesA.night.replace(/\D/g, '') || '0')
        });
      }

      if (catArray.includes('B')) {
        categoriesToUpsert.push({
          instructor_id: userId,
          category: 'B',
          day_price: parseInt(pricesB.day.replace(/\D/g, '') || '0'),
          night_price: parseInt(pricesB.night.replace(/\D/g, '') || '0')
        });
      }

      if (categoriesToUpsert.length > 0) {
        const { error: catError } = await supabase
          .from('instructor_categories')
          .upsert(categoriesToUpsert, { onConflict: 'instructor_id,category' });
          
        if (catError) throw catError;
      }
      
      // Vehicles logic (simplified for brevity)
      if (hasCar) {
        await supabase.from('instructor_vehicles').upsert({
          id: carId || undefined,
          instructor_id: userId,
          type: 'car',
          model: carModel,
          year: parseInt(carYear) || 0,
          transmission: carTransmission
        });
      } else if (carId) {
        await supabase.from('instructor_vehicles').delete().eq('id', carId);
        setCarId(null);
      }

      if (hasBike) {
        await supabase.from('instructor_vehicles').upsert({
          id: bikeId || undefined,
          instructor_id: userId,
          type: 'bike',
          model: bikeModel,
          year: parseInt(bikeYear) || 0,
          transmission: bikeTransmission
        });
      } else if (bikeId) {
        await supabase.from('instructor_vehicles').delete().eq('id', bikeId);
        setBikeId(null);
      }

      addToast("Perfil salvo com sucesso!", 'success');

      localStorage.setItem('ab_instructor_preferences', JSON.stringify({
        nightLessonsEnabled,
        // Store legacy night price for local preference if needed
        nightPrice: legacyNightPrice 
      }));

    } catch (error: any) {
      console.error('Error saving:', error);
      addToast('Erro ao salvar perfil: ' + error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate('/welcome');
  };

  const ToggleSwitch = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
    <button 
      onClick={onChange}
      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${checked ? 'bg-blue-600' : 'bg-gray-200'}`}
      type="button"
    >
      <span 
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? 'translate-x-6' : 'translate-x-1'}`} 
      />
    </button>
  );

  const showCarOptions = category === 'B' || category === 'AB';
  const showBikeOptions = category === 'A' || category === 'AB';

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-white text-gray-500">Carregando perfil...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      {/* Header Minimalista */}
      <div className="px-6 pt-8 pb-6 bg-white border-b border-gray-100">
        <div className="flex flex-col items-center space-y-4">
          <div className="relative group cursor-pointer" onClick={handleImageClick}>
            <div className="w-28 h-28 rounded-full border-4 border-white shadow-lg overflow-hidden bg-gray-100 flex items-center justify-center ring-1 ring-blue-100">
              {profileImage ? (
                <img src={profileImage} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <IdCard className="w-12 h-12 text-gray-300" />
              )}
            </div>
            <div className="absolute bottom-1 right-1 bg-blue-600 text-white p-2 rounded-full shadow-md border-2 border-white">
              <Camera className="w-4 h-4" />
            </div>
          </div>
          
          <div className="w-full text-center px-4">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome completo"
              className="w-full text-2xl font-bold text-gray-900 text-center bg-transparent border-none focus:ring-0 focus:outline-none placeholder-gray-300 cursor-text"
            />
            {publicId && (
              <div className="mt-1 flex items-center justify-center space-x-2">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">ID: {publicId}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-6 space-y-6 overflow-y-auto">
        
        {/* Card de Divulgação */}
        <section className="bg-blue-50 border border-blue-100 rounded-2xl p-5 shadow-sm">
          <div className="flex items-start space-x-4">
            <div className="bg-blue-600 p-2.5 rounded-xl shadow-blue-200 shadow-lg">
              <Share2 className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <h3 className="text-base font-bold text-blue-900">Divulgue seu perfil</h3>
              <p className="text-sm text-blue-700 mt-1 leading-snug">
                Compartilhe seu perfil no WhatsApp e redes sociais para atrair mais alunos
              </p>
              <button 
                onClick={handleCopyProfileLink}
                className="mt-4 w-full bg-white text-blue-600 font-bold py-2.5 rounded-xl shadow-sm border border-blue-200 hover:bg-blue-50 transition-all flex items-center justify-center space-x-2"
              >
                <Share2 className="w-4 h-4" />
                <span>Compartilhar meu perfil</span>
              </button>
            </div>
          </div>
        </section>

        {/* Seção: Contato */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <MessageCircle className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Contato</h2>
          </div>
          <Input 
            label="WhatsApp de atendimento" 
            placeholder="(11) 99999-9999"
            type="tel"
            value={formatPhone(whatsapp)}
            onChange={(e) => setWhatsapp(e.target.value.replace(/\D/g, '').slice(0, 11))}
            inputMode="numeric"
            className="bg-white border-gray-200"
          />
          <p className="text-xs text-gray-400 mt-2 ml-1">
            Este número será usado pelos alunos para tirar dúvidas e agendar aulas.
          </p>
        </section>

        {/* Seção: Dados Profissionais */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <IdCard className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Dados profissionais</h2>
          </div>
          <div className="space-y-4">
            <Input 
              label="Sua credencial profissional" 
              placeholder="Digite apenas números"
              value={credential}
              onChange={(e) => setCredential(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className="bg-white border-gray-200"
            />
            <CitySelect 
              label="Cidade / Região de atuação" 
              value={city} 
              onChange={setCity}
            />
          </div>
        </section>

        {/* Seção: Categorias de Ensino */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <GraduationCap className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Categorias de ensino</h2>
          </div>
          
          <p className="text-sm text-gray-500 mb-4">Selecione as categorias que você ensina:</p>
          
          <div className="grid grid-cols-3 gap-3 mb-6">
            {['A', 'B', 'AB'].map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`
                  py-3 rounded-xl text-sm font-bold border-2 transition-all duration-200 flex flex-col items-center justify-center space-y-1
                  ${category === cat 
                    ? 'border-blue-600 bg-blue-50 text-blue-700 shadow-sm' 
                    : 'border-gray-100 bg-gray-50 text-gray-400 hover:border-gray-200'
                  }
                `}
              >
                <span className="text-lg">
                  {cat === 'A' ? '🏍️' : cat === 'B' ? '🚘' : '🏍️+🚘'}
                </span>
                <span>{cat}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-gray-900">Aulas noturnas</span>
              <span className="text-xs text-gray-500">Ative se você atende após as 18h</span>
            </div>
            <ToggleSwitch checked={nightLessonsEnabled} onChange={() => setNightLessonsEnabled(!nightLessonsEnabled)} />
          </div>
        </section>

        {/* Seção: Seus Preços */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <DollarSign className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Valores das aulas</h2>
          </div>

          <div className="space-y-6">
            {/* Category A Pricing */}
            {(category === 'A' || category === 'AB') && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2">
                  <span className="text-xl">🏍️</span>
                  <h3 className="font-bold text-gray-800">Moto (Cat. A)</h3>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  <div className="relative">
                    <Input 
                      label="Preço Aula Diurna" 
                      placeholder="0,00"
                      value={formatCurrency(pricesA.day).replace('R$', '').trim()}
                      onChange={(e) => setPricesA(prev => ({ ...prev, day: e.target.value.replace(/\D/g, '') }))}
                      inputMode="numeric"
                      className="pl-12 bg-white border-gray-200"
                    />
                    <span className="absolute left-4 top-[42px] text-gray-400 font-semibold">R$</span>
                  </div>
                  {nightLessonsEnabled && (
                    <div className="relative">
                      <Input 
                        label="Preço Aula Noturna" 
                        placeholder="0,00"
                        value={formatCurrency(pricesA.night).replace('R$', '').trim()}
                        onChange={(e) => setPricesA(prev => ({ ...prev, night: e.target.value.replace(/\D/g, '') }))}
                        inputMode="numeric"
                        className="pl-12 bg-white border-gray-200"
                      />
                      <span className="absolute left-4 top-[42px] text-gray-400 font-semibold">R$</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Divider if both categories */}
            {category === 'AB' && <hr className="border-gray-50" />}

            {/* Category B Pricing */}
            {(category === 'B' || category === 'AB') && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2">
                  <span className="text-xl">🚘</span>
                  <h3 className="font-bold text-gray-800">Carro (Cat. B)</h3>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  <div className="relative">
                    <Input 
                      label="Preço Aula Diurna" 
                      placeholder="0,00"
                      value={formatCurrency(pricesB.day).replace('R$', '').trim()}
                      onChange={(e) => setPricesB(prev => ({ ...prev, day: e.target.value.replace(/\D/g, '') }))}
                      inputMode="numeric"
                      className="pl-12 bg-white border-gray-200"
                    />
                    <span className="absolute left-4 top-[42px] text-gray-400 font-semibold">R$</span>
                  </div>
                  {nightLessonsEnabled && (
                    <div className="relative">
                      <Input 
                        label="Preço Aula Noturna" 
                        placeholder="0,00"
                        value={formatCurrency(pricesB.night).replace('R$', '').trim()}
                        onChange={(e) => setPricesB(prev => ({ ...prev, night: e.target.value.replace(/\D/g, '') }))}
                        inputMode="numeric"
                        className="pl-12 bg-white border-gray-200"
                      />
                      <span className="absolute left-4 top-[42px] text-gray-400 font-semibold">R$</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Seção: Veículos */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <Car className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Seus veículos</h2>
          </div>

          <div className="space-y-6">
            {showCarOptions && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="text-xl">🚘</span>
                    <h3 className="font-bold text-gray-800">Carro</h3>
                  </div>
                  <label className="flex items-center space-x-2 text-xs font-medium text-gray-500 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={hasCar} 
                      onChange={(e) => setHasCar(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500" 
                    />
                    <span>Tenho veículo próprio</span>
                  </label>
                </div>

                {hasCar && (
                  <div className="space-y-4 animate-fade-in">
                    <Input 
                      label="Modelo" 
                      placeholder="Ex: Fiat Mobi" 
                      value={carModel}
                      onChange={(e) => setCarModel(e.target.value)}
                      className="bg-white border-gray-200"
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <Input 
                        label="Ano" 
                        placeholder="2022" 
                        type="number"
                        value={carYear}
                        onChange={(e) => setCarYear(e.target.value)}
                        className="bg-white border-gray-200"
                      />
                      <div className="flex flex-col space-y-2">
                        <label className="text-sm font-semibold text-gray-700 ml-1">Câmbio</label>
                        <select 
                          className="w-full px-4 py-3.5 rounded-xl bg-white border border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                          value={carTransmission}
                          onChange={(e) => setCarTransmission(e.target.value)}
                        >
                          <option value="manual">Manual</option>
                          <option value="automatic">Automático</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {showCarOptions && showBikeOptions && <hr className="border-gray-50" />}

            {showBikeOptions && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="text-xl">🏍️</span>
                    <h3 className="font-bold text-gray-800">Moto</h3>
                  </div>
                  <label className="flex items-center space-x-2 text-xs font-medium text-gray-500 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={hasBike} 
                      onChange={(e) => setHasBike(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500" 
                    />
                    <span>Tenho veículo próprio</span>
                  </label>
                </div>

                {hasBike && (
                  <div className="space-y-4 animate-fade-in">
                    <Input 
                      label="Modelo" 
                      placeholder="Ex: Honda CG 160" 
                      value={bikeModel}
                      onChange={(e) => setBikeModel(e.target.value)}
                      className="bg-white border-gray-200"
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <Input 
                        label="Ano" 
                        placeholder="2023" 
                        type="number"
                        value={bikeYear}
                        onChange={(e) => setBikeYear(e.target.value)}
                        className="bg-white border-gray-200"
                      />
                      <div className="flex flex-col space-y-2">
                        <label className="text-sm font-semibold text-gray-700 ml-1">Câmbio</label>
                        <select 
                          className="w-full px-4 py-3.5 rounded-xl bg-white border border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                          value={bikeTransmission}
                          onChange={(e) => setBikeTransmission(e.target.value)}
                        >
                          <option value="manual">Manual</option>
                          <option value="automatic">Automático</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Seção: Ponto de Encontro */}
        <section className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center space-x-2 mb-5">
            <MapPin className="w-5 h-5 text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Ponto de encontro</h2>
          </div>
          <div className="space-y-4">
            <p className="text-sm text-gray-500 leading-relaxed">
              Onde você costuma encontrar seus alunos? (Ex: estação, praça, shopping...)
            </p>
            <GooglePlacesInput 
              label="Localização padrão" 
              placeholder="Ex: Metrô Itaquera - Catracas"
              value={defaultLocation}
              onChange={(val) => {
                setDefaultLocation(val);
                // If user types manually, clear coordinates
                setMeetingPointLat(null);
                setMeetingPointLng(null);
                setMeetingPointPlaceId(null);
              }}
              onAddressSelect={(address, lat, lng, placeId) => {
                setDefaultLocation(address);
                setMeetingPointLat(lat);
                setMeetingPointLng(lng);
                setMeetingPointPlaceId(placeId);
              }}
              className="bg-white border-gray-200"
            />
            {meetingPointLat && (
              <div className="flex items-center space-x-2 px-3 py-2 bg-green-50 rounded-lg border border-green-100 animate-fade-in">
                <Navigation className="w-4 h-4 text-green-600" />
                <span className="text-xs font-medium text-green-700">Localização GPS vinculada com sucesso!</span>
              </div>
            )}
          </div>
        </section>

        {/* Ações Finais */}
        <div className="pt-6 pb-12 space-y-6">
          <Button 
            fullWidth 
            onClick={handleSave} 
            disabled={saving}
            className="h-14 text-lg shadow-lg shadow-blue-100"
          >
            {saving ? 'Salvando...' : 'Salvar alterações'}
          </Button>
          
          <button 
            onClick={handleLogout} 
            className="w-full flex items-center justify-center space-x-2 text-red-500 font-semibold py-3 rounded-xl hover:bg-red-50 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>Sair da conta</span>
          </button>

          <div className="flex items-center justify-center space-x-3 text-xs text-gray-400">
            <a href="#" className="hover:text-gray-600 transition-colors">Política de Privacidade</a>
            <span className="w-1 h-1 bg-gray-300 rounded-full" />
            <a href="#" className="hover:text-gray-600 transition-colors">Termos de Uso</a>
          </div>
        </div>

      </div>

      <InstructorBottomNav />
      
      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/*" className="hidden" />
    </div>
  );
};