import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { StudentBottomNav } from '../components/StudentBottomNav';
import { RatingBadge } from '../components/RatingBadge';
import { supabase } from '../lib/supabase';
import { CitySelect } from '../components/CitySelect';
import { useAuth } from '../contexts/AuthContext';

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
  const { session } = useAuth();
  
  // Search state
  const [searchText, setSearchText] = useState(''); // Name or ID
  const [selectedCity, setSelectedCity] = useState(''); // From CitySelect
  
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<string[]>([]);

  // --- FETCH DATA ---
  useEffect(() => {
    fetchInstructors();
  }, []);

  useEffect(() => {
    if (session?.user?.id) {
      loadFavorites();
    }
  }, [session?.user?.id]);

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

  const loadFavorites = async () => {
    if (!session?.user?.id) return;
    try {
      const { data, error } = await supabase
        .from('student_favorites')
        .select('instructor_id')
        .eq('student_id', session.user.id);
        
      if (error) throw error;
      
      if (data) {
        setFavorites(data.map(fav => fav.instructor_id));
      }
    } catch (error) {
      console.error('Error loading favorites:', error);
    }
  };

  const toggleFavorite = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!session?.user?.id) return;

    const isCurrentlyFavorite = favorites.includes(id);
    
    // Optimistic UI update
    let newFavs;
    if (isCurrentlyFavorite) {
      newFavs = favorites.filter(fav => fav !== id);
    } else {
      newFavs = [...favorites, id];
    }
    setFavorites(newFavs);
    
    // Database update
    try {
      if (isCurrentlyFavorite) {
        const { error } = await supabase
          .from('student_favorites')
          .delete()
          .eq('student_id', session.user.id)
          .eq('instructor_id', id);
          
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('student_favorites')
          .insert({
            student_id: session.user.id,
            instructor_id: id
          });
          
        if (error) throw error;
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
      // Revert optimistic update on error
      loadFavorites();
    }
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
  }).sort((a, b) => {
    const isAFav = favorites.includes(a.id);
    const isBFav = favorites.includes(b.id);
    
    if (isAFav && !isBFav) return -1;
    if (!isAFav && isBFav) return 1;
    return 0;
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
              <div 
                key={inst.id} 
                onClick={() => navigate(`/student/instructor/${inst.id}`)}
                className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col relative overflow-hidden transition-all hover:shadow-md active:scale-[0.99] cursor-pointer"
              >
                
                {/* Top Row: Avatar, Name, Price, Favorite */}
                <div className="flex justify-between items-start w-full">
                  <div className="flex items-start flex-1 min-w-0">
                    {/* Avatar */}
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-xl border border-gray-50 flex-shrink-0 mr-3 text-gray-400 overflow-hidden">
                      {inst.profiles.avatar_url ? (
                          <img src={inst.profiles.avatar_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                          "👤"
                      )}
                    </div>
                    
                    {/* Name & ID */}
                    <div className="flex flex-col min-w-0 pr-2 pt-0.5">
                      <h3 className="font-bold text-gray-900 text-base leading-tight truncate">
                        {inst.profiles.full_name}
                      </h3>
                      {inst.public_id && (
                        <span className="text-[10px] text-gray-400 font-medium mt-0.5">
                          ID: {inst.public_id}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Price & Favorite */}
                  <div className="flex flex-col items-end flex-shrink-0 ml-2">
                    <div className="flex items-center mb-1">
                      <span className="text-sm font-bold text-blue-600">{formatCurrency(lowestPrice)}</span>
                    </div>
                    <button
                      onClick={(e) => toggleFavorite(inst.id, e)}
                      className="p-1.5 rounded-full hover:bg-gray-50 transition-all focus:outline-none -mr-1.5"
                    >
                      <svg
                        className={`w-5 h-5 ${isFavorite ? 'text-red-500 fill-current' : 'text-gray-300'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Middle Row: Rating & Location */}
                <div className="flex items-center text-xs text-gray-500 mt-3 space-x-3">
                  <RatingBadge rating={avgRating} count={reviewsCount} variant="compact" />
                  
                  <div className="flex items-center text-gray-500 truncate">
                    <svg className="w-3.5 h-3.5 mr-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span className="truncate">{inst.profiles.city || 'Cidade não informada'}</span>
                  </div>
                </div>

                {/* Bottom Row: Tags (Category & Vehicles) */}
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <span className="inline-flex items-center px-2 py-1 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold uppercase tracking-wide">
                    {getCategoryLabel(inst.categories)}
                  </span>
                  
                  {hasCar && (
                    <span className="inline-flex items-center px-2 py-1 rounded bg-gray-50 text-gray-600 text-[10px] font-medium border border-gray-100">
                      {carDetails ? `🚘 ${carDetails.model}` : '🚘 Carro'}
                    </span>
                  )}
                  {hasBike && (
                    <span className="inline-flex items-center px-2 py-1 rounded bg-gray-50 text-gray-600 text-[10px] font-medium border border-gray-100">
                      {bikeDetails ? `🏍 ${bikeDetails.model}` : '🏍 Moto'}
                    </span>
                  )}
                </div>

                {/* Location Text (Optional, if different from city) */}
                {inst.location_text && (
                  <div className="mt-2 text-[10px] text-gray-400 truncate">
                    Ponto de encontro: {inst.location_text}
                  </div>
                )}

                {/* Action Button */}
                <div className="mt-4 pt-3 border-t border-gray-50">
                  <div className="w-full text-center text-sm font-semibold text-blue-600">
                    Ver agenda e perfil
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