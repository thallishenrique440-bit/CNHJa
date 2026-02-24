import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { CitySelect } from '../components/CitySelect';
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
          setDefaultLocation(instructor.location_text || '');
          
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
        location_text: defaultLocation,
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
    <div className="min-h-screen bg-white flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      <div className="px-6 pt-6 pb-4 border-b border-gray-100 bg-white sticky top-0 z-10">
        <h1 className="text-xl font-bold text-gray-900 text-center">Meu Perfil</h1>
      </div>

      <div className="flex-1 px-6 py-6 space-y-8 overflow-y-auto">
        
        <section className="flex flex-col items-center space-y-4">
           <div className="relative group cursor-pointer" onClick={handleImageClick}>
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
           
           {/* Public ID Badge */}
           {publicId && (
              <div className="bg-gray-100 text-gray-600 px-3 py-1 rounded-full text-xs font-bold border border-gray-200">
                Meu ID: {publicId}
              </div>
           )}

           <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/*" className="hidden" />
           
           <div className="w-full space-y-3">
             <Input label="Nome completo" value={name} readOnly className="bg-gray-100 text-gray-500 border-transparent" />
             
             <Input 
                label="Número da credencial do instrutor" 
                placeholder="Digite apenas números"
                value={credential}
                onChange={(e) => setCredential(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
             />

             <CitySelect 
                label="Cidade / Região" 
                value={city} 
                onChange={setCity}
             />
             
             <div>
                <Input 
                  label="WhatsApp para contato (obrigatório)" 
                  placeholder="(11) 99999-9999"
                  type="tel"
                  value={formatPhone(whatsapp)}
                  onChange={(e) => setWhatsapp(e.target.value.replace(/\D/g, '').slice(0, 11))}
                  inputMode="numeric"
                />
             </div>
           </div>
        </section>

        <hr className="border-gray-100" />

        <section className="space-y-6">
           <div>
             <h2 className="text-lg font-bold text-gray-900 mb-4">Veículos e Categorias</h2>
             
             <div className="grid grid-cols-3 gap-3 mb-6">
               {['A', 'B', 'AB'].map((cat) => (
                 <button
                   key={cat}
                   onClick={() => setCategory(cat)}
                   className={`
                     py-2 rounded-xl text-sm font-bold border-2 transition-all duration-200
                     ${category === cat 
                        ? 'border-blue-600 bg-blue-50 text-blue-700' 
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                     }
                   `}
                 >
                   {cat}
                 </button>
               ))}
             </div>
           </div>

           {/* --- PRICING SECTION (NEW) --- */}
           <div className="space-y-6 animate-fade-in">
              <div className="flex items-center justify-between">
                 <label className="text-base font-semibold text-gray-900">Aulas noturnas</label>
                 <ToggleSwitch checked={nightLessonsEnabled} onChange={() => setNightLessonsEnabled(!nightLessonsEnabled)} />
              </div>

              {/* Category A Pricing */}
              {(category === 'A' || category === 'AB') && (
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-3">
                   <h3 className="font-bold text-gray-800 flex items-center">
                     <span className="text-xl mr-2">🏍️</span> Valores Moto (Cat. A)
                   </h3>
                   <div className="grid grid-cols-1 gap-3">
                      <Input 
                        label="Preço Aula Diurna (R$)" 
                        placeholder="R$ 0,00"
                        value={formatCurrency(pricesA.day)}
                        onChange={(e) => setPricesA(prev => ({ ...prev, day: e.target.value.replace(/\D/g, '') }))}
                        inputMode="numeric"
                      />
                      {nightLessonsEnabled && (
                        <Input 
                          label="Preço Aula Noturna (R$)" 
                          placeholder="R$ 0,00"
                          value={formatCurrency(pricesA.night)}
                          onChange={(e) => setPricesA(prev => ({ ...prev, night: e.target.value.replace(/\D/g, '') }))}
                          inputMode="numeric"
                        />
                      )}
                   </div>
                </div>
              )}

              {/* Category B Pricing */}
              {(category === 'B' || category === 'AB') && (
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-3">
                   <h3 className="font-bold text-gray-800 flex items-center">
                     <span className="text-xl mr-2">🚘</span> Valores Carro (Cat. B)
                   </h3>
                   <div className="grid grid-cols-1 gap-3">
                      <Input 
                        label="Preço Aula Diurna (R$)" 
                        placeholder="R$ 0,00"
                        value={formatCurrency(pricesB.day)}
                        onChange={(e) => setPricesB(prev => ({ ...prev, day: e.target.value.replace(/\D/g, '') }))}
                        inputMode="numeric"
                      />
                      {nightLessonsEnabled && (
                        <Input 
                          label="Preço Aula Noturna (R$)" 
                          placeholder="R$ 0,00"
                          value={formatCurrency(pricesB.night)}
                          onChange={(e) => setPricesB(prev => ({ ...prev, night: e.target.value.replace(/\D/g, '') }))}
                          inputMode="numeric"
                        />
                      )}
                   </div>
                </div>
              )}
           </div>

           {showCarOptions && (
             <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 animate-fade-in">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-gray-800 flex items-center">
                    <span className="text-xl mr-2">🚘</span> Carro
                  </h3>
                  <label className="flex items-center space-x-2 text-sm text-gray-600">
                    <input 
                      type="checkbox" 
                      checked={hasCar} 
                      onChange={(e) => setHasCar(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded" 
                    />
                    <span>Possuo veículo</span>
                  </label>
                </div>

                {hasCar && (
                  <div className="space-y-3">
                    <Input 
                      label="Modelo" 
                      placeholder="Ex: Fiat Mobi" 
                      value={carModel}
                      onChange={(e) => setCarModel(e.target.value)}
                    />
                    <div className="flex space-x-3">
                      <div className="w-1/2">
                         <Input 
                           label="Ano" 
                           placeholder="2022" 
                           type="number"
                           value={carYear}
                           onChange={(e) => setCarYear(e.target.value)}
                         />
                      </div>
                      <div className="w-1/2">
                        <label className="text-sm font-semibold text-gray-700 ml-1 mb-2 block">Câmbio</label>
                        <select 
                          className="w-full px-4 py-3.5 rounded-xl bg-white border border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500"
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

           {showBikeOptions && (
             <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 animate-fade-in">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-gray-800 flex items-center">
                    <span className="text-xl mr-2">🏍️</span> Moto
                  </h3>
                  <label className="flex items-center space-x-2 text-sm text-gray-600">
                    <input 
                      type="checkbox" 
                      checked={hasBike} 
                      onChange={(e) => setHasBike(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded" 
                    />
                    <span>Possuo veículo</span>
                  </label>
                </div>

                {hasBike && (
                  <div className="space-y-3">
                    <Input 
                      label="Modelo" 
                      placeholder="Ex: Honda CG 160" 
                      value={bikeModel}
                      onChange={(e) => setBikeModel(e.target.value)}
                    />
                    <div className="flex space-x-3">
                      <div className="w-1/2">
                         <Input 
                           label="Ano" 
                           placeholder="2023" 
                           type="number"
                           value={bikeYear}
                           onChange={(e) => setBikeYear(e.target.value)}
                         />
                      </div>
                      <div className="w-1/2">
                        <label className="text-sm font-semibold text-gray-700 ml-1 mb-2 block">Câmbio</label>
                        <select 
                          className="w-full px-4 py-3.5 rounded-xl bg-white border border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500"
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

        </section>

        <hr className="border-gray-100" />

        <section className="space-y-4">
            <h2 className="text-lg font-bold text-gray-900">Local de atendimento</h2>
            <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
               <p className="text-sm text-blue-800 mb-3">
                 Defina um ponto de encontro padrão (ex: Estação de Metrô, Shopping ou Praça).
               </p>
               <Input 
                  label="Ponto de encontro padrão" 
                  placeholder="Ex: Metrô Itaquera - Catracas"
                  value={defaultLocation}
                  onChange={(e) => setDefaultLocation(e.target.value)}
               />
            </div>
        </section>

        <div className="pt-4 pb-8">
           <Button fullWidth onClick={handleSave} disabled={saving}>
             {saving ? 'Salvando...' : 'Salvar Alterações'}
           </Button>
           <div className="mt-4 text-center">
             <button onClick={handleLogout} className="text-red-500 font-medium text-sm hover:text-red-600">
               Sair da conta
             </button>
           </div>
           
           {/* Futuramente será um link externo oficial */}
           <div className="mt-8 text-center space-x-2">
             <a href="#" className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors">
               Política de Privacidade
             </a>
             <span className="text-gray-300 text-xs">·</span>
             <a href="#" className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors">
               Termos de Uso
             </a>
           </div>
        </div>

      </div>

      <InstructorBottomNav />
    </div>
  );
};