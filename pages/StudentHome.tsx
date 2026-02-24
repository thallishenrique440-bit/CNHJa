import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { StudentBottomNav } from '../components/StudentBottomNav';
import { RatingBadge } from '../components/RatingBadge';
import { supabase } from '../lib/supabase';
import { CitySelect } from '../components/CitySelect';

interface Vehicle {
  type: 'car' | 'bike';
  model: string;
  year: number;
}

interface Review {
  rating: number;
}

interface CategoryPrice {
  category: string;
  day_price: number;
}

interface Instructor {
  id: string;
  public_id: string | null;
  base_price: number;
  whatsapp: string | null;
  location_text: string | null;
  credential_number: string | null;
  categories: string[] | null;
  profiles: {
    full_name: string;
    city: string;
    avatar_url?: string;
  };
  instructor_vehicles: Vehicle[];
  reviews: Review[];
  instructor_categories: CategoryPrice[]; // New relation
}

export const StudentHome: React.FC = () => {
  const navigate = useNavigate();
  
  // Search state
  const [searchText, setSearchText] = useState(''); // Name or ID
  const [selectedCity, setSelectedCity] = useState(''); // From CitySelect
  
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<string[]>([]);

  // --- FETCH DATA ---
  useEffect(() => {
    fetchInstructors();
    loadFavorites();
  }, []);

  const fetchInstructors = async () => {
    setLoading(true);
    try {
      // 1. Query only "Active" instructors
      // Definition of Active: Has a base_price set (> 0) and has categories defined.
      const { data, error } = await supabase
        .from('instructors')
        .select(`
          id,
          public_id,
          base_price,
          whatsapp,
          location_text,
          categories,
          profiles!inner (
            full_name,
            city,
            avatar_url
          ),
          instructor_vehicles (
            type,
            model,
            year
          ),
          reviews (
            rating
          ),
          instructor_categories (
            category,
            day_price
          )
        `)
        .gt('base_price', 0)     // Only instructors who set a price
        .not('categories', 'is', null); // Only instructors who selected a category

      if (error) throw error;
      
      if (data) {
        setInstructors(data as any);
      }
    } catch (error) {
      console.error('Error fetching instructors:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadFavorites = () => {
    const saved = localStorage.getItem('ab_student_favorites');
    if (saved) setFavorites(JSON.parse(saved));
  };

  const toggleFavorite = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    let newFavs;
    if (favorites.includes(id)) {
      newFavs = favorites.filter(fav => fav !== id);
    } else {
      newFavs = [...favorites, id];
    }
    setFavorites(newFavs);
    localStorage.setItem('ab_student_favorites', JSON.stringify(newFavs));
  };

  // --- FILTERING LOGIC ---
  const filteredInstructors = instructors.filter((inst) => {
    // 1. City Match (Exact String Match)
    // We rely on CitySelect standardization "City - UF"
    if (selectedCity) {
        if (inst.profiles.city !== selectedCity) {
            return false;
        }
    }

    const term = searchText.trim();
    if (!term) return true;
    
    // 2. Search by Public ID (EXACT MATCH required by validation rules)
    if (term.toUpperCase().startsWith('ALT-')) {
      return inst.public_id?.toUpperCase() === term.toUpperCase();
    }

    // 3. Search by Name (Partial, Case-Insensitive)
    const nameMatch = inst.profiles.full_name?.toLowerCase().includes(term.toLowerCase());
    return nameMatch;
  });

  // Helper to format currency
  const formatCurrency = (val: number) => {
    return (val / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // Helper to get Category Label
  const getCategoryLabel = (cats: string[] | null) => {
    if (!cats || cats.length === 0) return 'Cat. Indefinida';
    // Sort to ensure consistent order (A/B) and join with slash
    const sortedCats = [...cats].sort(); 
    return `Categoria ${sortedCats.join('/')}`;
  };

  // Helper to get Lowest Price (Starting Price)
  const getLowestPrice = (inst: Instructor) => {
    // 1. Try to find lowest price from new table
    if (inst.instructor_categories && inst.instructor_categories.length > 0) {
      const prices = inst.instructor_categories.map(c => c.day_price).filter(p => p > 0);
      if (prices.length > 0) {
        return Math.min(...prices);
      }
    }
    // 2. Fallback to legacy base_price
    return inst.base_price;
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-24 sm:max-w-md sm:mx-auto relative">
      
      {/* Header */}
      <div className="bg-white px-6 pt-6 pb-4 sticky top-0 z-10 border-b border-gray-100 shadow-sm">
        <h1 className="text-xl font-bold text-gray-900 mb-4">Encontrar instrutores</h1>
        
        {/* Search Inputs Stack */}
        <div className="space-y-3">
            
            {/* City Autocomplete */}
            <CitySelect 
               value={selectedCity}
               onChange={setSelectedCity}
               placeholder="Filtrar por cidade (Opcional)"
               className="z-50" // High Z-Index for dropdown
            />

            {/* Name/ID Search */}
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                </div>
                <input
                    type="text"
                    className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl leading-5 bg-gray-50 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 transition duration-150 ease-in-out"
                    placeholder="Nome ou Código (ex: ALT-1234)"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                />
            </div>
        </div>

      </div>

      {/* Instructor List */}
      <div className="px-4 py-4 space-y-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 space-y-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <span className="text-gray-400 text-sm">Buscando instrutores...</span>
          </div>
        ) : filteredInstructors.length === 0 ? (
          <div className="text-center py-12 px-6">
            <div className="text-5xl mb-3 grayscale opacity-30">🔍</div>
            <p className="text-gray-600 font-semibold text-lg">Nenhum instrutor encontrado</p>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
               {selectedCity 
                 ? `Não encontramos instrutores ativos em "${selectedCity}".` 
                 : "Tente mudar os filtros de busca."}
            </p>
            {selectedCity && (
                <button 
                  onClick={() => setSelectedCity('')}
                  className="mt-4 text-blue-600 font-medium text-sm hover:underline"
                >
                  Limpar filtro de cidade
                </button>
            )}
          </div>
        ) : (
          filteredInstructors.map((inst) => {
            const isFavorite = favorites.includes(inst.id);
            const hasCar = inst.instructor_vehicles.some(v => v.type === 'car');
            const hasBike = inst.instructor_vehicles.some(v => v.type === 'bike');
            const carDetails = inst.instructor_vehicles.find(v => v.type === 'car');
            const bikeDetails = inst.instructor_vehicles.find(v => v.type === 'bike');

            // --- REAL RATING CALCULATION ---
            const reviews = inst.reviews || [];
            const reviewsCount = reviews.length;
            const totalRating = reviews.reduce((acc, r) => acc + r.rating, 0);
            const avgRating = reviewsCount > 0 ? (totalRating / reviewsCount) : 0;

            const lowestPrice = getLowestPrice(inst);

            return (
              <div key={inst.id} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col space-y-3 relative overflow-hidden transition-all hover:shadow-md active:scale-[0.99]">
                
                {/* 
                   STRUCTURAL FIX: 
                   Replaced absolute positioning with a Flex Header Row to prevent overlapping.
                */}
                <div className="flex justify-between items-center w-full mb-1">
                   {/* ID Badge */}
                   <div className="flex-shrink-0">
                      {inst.public_id ? (
                        <div className="bg-blue-50 text-blue-600 text-[10px] font-bold px-2.5 py-1 rounded-full border border-blue-100">
                          ID: {inst.public_id}
                        </div>
                      ) : (
                        <div className="h-6"></div> // Spacer to maintain layout height if no ID
                      )}
                   </div>

                   {/* Heart Icon */}
                   <button
                      onClick={(e) => toggleFavorite(inst.id, e)}
                      className="p-2 rounded-full hover:bg-gray-50 border border-transparent hover:border-gray-100 transition-all focus:outline-none -mr-2 -mt-2"
                    >
                      <svg
                        className={`w-6 h-6 ${isFavorite ? 'text-red-500 fill-current' : 'text-gray-300'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                    </button>
                </div>

                {/* 1. Header: Avatar + Info Block */}
                <div className="flex justify-between items-start">
                  
                  {/* Avatar Placeholder */}
                  <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-2xl border border-gray-50 flex-shrink-0 mr-3 text-gray-400 overflow-hidden">
                    {inst.profiles.avatar_url ? (
                        <img src={inst.profiles.avatar_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                        "👤"
                    )}
                  </div>
                  
                  {/* Info Block */}
                  <div className="flex-1 min-w-0 pt-0.5">
                    <div className="flex justify-between items-start">
                      <h3 className="font-bold text-gray-900 text-lg leading-tight truncate">
                        {inst.profiles.full_name}
                      </h3>
                    </div>

                    {/* City */}
                    <p className="text-xs text-gray-500 mt-0.5 leading-none">
                      {inst.profiles.city || 'Cidade não informada'}
                    </p>

                    {/* Category & Rating */}
                    <div className="flex items-center text-sm text-gray-500 mt-2 space-x-2">
                      <span className="font-medium text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border border-gray-200">
                        {getCategoryLabel(inst.categories)}
                      </span>
                      
                      {/* Rating Component */}
                      <RatingBadge rating={avgRating} count={reviewsCount} variant="compact" />
                    </div>
                  </div>
                </div>

                {/* 2. Vehicles */}
                {(hasCar || hasBike) && (
                  <div className="flex flex-wrap gap-2">
                    {hasCar && (
                      <span className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-600 text-[10px] font-medium border border-gray-100">
                        {carDetails ? `🚘 ${carDetails.model}` : '🚘 Carro'}
                      </span>
                    )}
                    {hasBike && (
                      <span className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-600 text-[10px] font-medium border border-gray-100">
                        {bikeDetails ? `🏍 ${bikeDetails.model}` : '🏍 Moto'}
                      </span>
                    )}
                  </div>
                )}
                
                {/* 3. Location Text */}
                {inst.location_text && (
                  <div className="flex items-start text-gray-600">
                    <span className="mr-1.5 mt-0.5 text-xs">📍</span>
                    <span className="line-clamp-1 text-xs">{inst.location_text}</span>
                  </div>
                )}

                {/* Divider */}
                <div className="border-t border-gray-50 my-1"></div>

                {/* 4. Price & Action */}
                <div className="flex items-end justify-end">
                  {/* Price & CTA */}
                  <div className="flex flex-col items-end">
                     <div className="flex items-baseline mb-1">
                        <span className="text-[10px] uppercase font-bold text-gray-400 mr-1">Aula a partir de</span>
                        <span className="text-lg font-bold text-blue-600">{formatCurrency(lowestPrice)}</span>
                     </div>
                     <Button 
                        variant="primary" 
                        onClick={() => navigate(`/student/instructor/${inst.id}`)}
                        className="py-2 px-6 text-sm h-9 min-h-0 shadow-sm shadow-blue-100"
                      >
                        Ver agenda
                      </Button>
                  </div>
                </div>

              </div>
            );
          })
        )}
      </div>

      <StudentBottomNav />
    </div>
  );
};