import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { StudentBottomNav } from '../components/StudentBottomNav';
import { RatingBadge } from '../components/RatingBadge';
import { supabase } from '../lib/supabase';
import { CitySelect } from '../components/CitySelect';
import { useAuth } from '../contexts/AuthContext';
import { getLowestActiveCategoryPrice } from '../lib/instructorPricing';
import { calculateInstructorRating } from '../lib/instructorRating';

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
  meeting_point: string | null;
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

/**
 * Normalizes ALT codes by removing spaces, hyphens, and converting to uppercase.
 * Example: "ALT-1234" -> "ALT1234", "alt1234" -> "ALT1234", "Alt-1234" -> "ALT1234"
 */
export function normalizeAltCode(value: string): string {
  return value.trim().toUpperCase().replace(/[- ]/g, '');
}

/**
 * Applies an intelligent mask to the ALT code search, formatting inputs starting with 'A'/'AL'/'ALT'
 * automatically, forcing uppercase, inserting the hyphen, and limiting subsequent characters to digits.
 * Supports deletion/backspace seamlessly.
 */
export function applyAltMask(newValue: string, previousValue: string): string {
  if (!newValue) return '';

  const upper = newValue.toUpperCase();

  // Handle backspace/deletion of the hyphen or letters of ALT prefix gracefully
  if (previousValue === 'ALT-' && upper === 'ALT') {
    return 'ALT';
  }
  if (previousValue === 'ALT' && upper === 'AL') {
    return 'AL';
  }

  const trimmed = newValue.trim();
  const upperTrimmed = trimmed.toUpperCase();

  // If the user is typing the initial prefix "a", "al", "alt"
  if (upperTrimmed === 'A') {
    return 'A';
  }
  if (upperTrimmed === 'AL') {
    return 'AL';
  }
  if (upperTrimmed === 'ALT') {
    return 'ALT-';
  }

  // If it starts with 'ALT' or some variation, it is an ALT search
  if (upperTrimmed.startsWith('ALT')) {
    let rest = trimmed.substring(3);
    // Strip everything except numbers after 'ALT-'
    rest = rest.replace(/[^0-9]/g, '');
    return 'ALT-' + rest;
  }

  // If it's not an ALT prefix, return the original newValue
  return newValue;
}

interface SearchIntent {
  type: 'name' | 'alt_code';
  query: string;
  isAltPrefixOnly: boolean;
}

/**
 * Interprets the search query to determine if the user is searching by name,
 * or actively searching by an ALT code.
 */
export function parseSearchIntent(text: string): SearchIntent {
  const trimmed = text.trim();
  if (!trimmed) {
    return { type: 'name', query: '', isAltPrefixOnly: false };
  }

  const upper = trimmed.toUpperCase();

  // Pattern: ALT (or ALT-) followed by at least one digit
  const altWithDigitsRegex = /^ALT[- ]*\d+/;
  if (altWithDigitsRegex.test(upper)) {
    const normalized = normalizeAltCode(trimmed);
    return { type: 'alt_code', query: normalized, isAltPrefixOnly: false };
  }

  // Pattern: typing "ALT" or "ALT-" prefix (without digits yet)
  const altInProgressRegex = /^ALT[- ]*$/;
  if (altInProgressRegex.test(upper)) {
    return { type: 'name', query: trimmed.toLowerCase(), isAltPrefixOnly: true };
  }

  return { type: 'name', query: trimmed.toLowerCase(), isAltPrefixOnly: false };
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
      loadStudentCity();
    }
  }, [session?.user?.id]);

  const loadStudentCity = async () => {
    if (!session?.user?.id) return;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('city')
        .eq('id', session.user.id)
        .single();
        
      if (error) throw error;
      
      if (data?.city) {
        setSelectedCity(data.city);
      }
    } catch (error) {
      console.error('Error loading student city:', error);
    }
  };

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
          meeting_point,
          categories,
          credential_number,
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
        // Enforce professional profile completeness rule (Etapa A)
        // Decoupling visibility from the payouts_enabled field
        const completeInstructors = (data as any[]).filter(inst => {
          // 1. Basic profile valid (profiles exists and has full_name and city fill)
          const hasBasicProfile = inst.profiles && 
            typeof inst.profiles.full_name === 'string' && inst.profiles.full_name.trim() !== '' &&
            typeof inst.profiles.city === 'string' && inst.profiles.city.trim() !== '';

          // 2. Whatsapp preenchido
          const hasWhatsapp = inst.whatsapp && typeof inst.whatsapp === 'string' && inst.whatsapp.trim() !== '';

          // 3. Credencial preenchida
          const hasCredential = inst.credential_number && typeof inst.credential_number === 'string' && inst.credential_number.trim() !== '';

          // 4. Preço configurado (base_price > 0, or has category prices > 0)
          const hasBasePrice = inst.base_price && inst.base_price > 0;
          const hasCategoryPrices = inst.instructor_categories && inst.instructor_categories.some((c: any) => c.day_price > 0);
          const hasPrice = hasBasePrice || hasCategoryPrices;

          // 5. Categoria configurada (has legacy categories or category relation)
          const hasBaseCategories = inst.categories && inst.categories.length > 0;
          const hasCategoryRelation = inst.instructor_categories && inst.instructor_categories.length > 0;
          const hasCategory = hasBaseCategories || hasCategoryRelation;

          // 6. Pelo menos um veículo cadastrado
          const hasVehicle = inst.instructor_vehicles && inst.instructor_vehicles.length > 0;

          return hasBasicProfile && hasWhatsapp && hasCredential && hasPrice && hasCategory && hasVehicle;
        });

        setInstructors(completeInstructors);
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
  const textFilteredInstructors = (() => {
    const term = searchText.trim();
    if (!term) return instructors;

    const intent = parseSearchIntent(searchText);

    if (intent.type === 'alt_code') {
      return instructors.filter((inst) => {
        if (!inst.public_id) return false;
        const normalizedId = normalizeAltCode(inst.public_id);
        return normalizedId.startsWith(intent.query);
      });
    }

    // Normal name search or ALT prefix in progress
    const nameMatches = instructors.filter((inst) => {
      if (!intent.query) return true;
      return inst.profiles.full_name?.toLowerCase().includes(intent.query);
    });

    if (intent.isAltPrefixOnly) {
      // If the user typed exactly "ALT" (or "ALT-", etc.) and there are names starting with/including "ALT" (e.g. Altair)
      // return those matches. If there are no such names, keep the ENTIRE list visible.
      return nameMatches.length > 0 ? nameMatches : instructors;
    }

    return nameMatches;
  })();

  const cityFilteredInstructors = textFilteredInstructors.filter((inst) => {
    if (!selectedCity) return true;
    return inst.profiles.city === selectedCity;
  });

  // Fallback: If a city is selected but there are NO instructors in that city at all
  const cityHasInstructors = selectedCity 
    ? instructors.some(inst => inst.profiles.city === selectedCity)
    : true;

  const isFallback = selectedCity !== '' && !cityHasInstructors;
  const finalInstructors = isFallback ? textFilteredInstructors : cityFilteredInstructors;

  const sortedInstructors = [...finalInstructors].sort((a, b) => {
    const isAFav = favorites.includes(a.id);
    const isBFav = favorites.includes(b.id);
    
    // 1. Favorites always first
    if (isAFav && !isBFav) return -1;
    if (!isAFav && isBFav) return 1;
    
    // 2. If in fallback mode, prioritize by rating and review count
    if (isFallback) {
      const aSummary = calculateInstructorRating(a.reviews);
      const bSummary = calculateInstructorRating(b.reviews);
      
      if (aSummary.averageRating !== bSummary.averageRating) {
        return bSummary.averageRating - aSummary.averageRating;
      }
      return bSummary.reviewsCount - aSummary.reviewsCount;
    }
    
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
    return getLowestActiveCategoryPrice(inst.categories, inst.instructor_categories, inst.base_price || 0);
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
                    onChange={(e) => setSearchText(applyAltMask(e.target.value, searchText))}
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
        ) : sortedInstructors.length === 0 ? (
          <div className="text-center py-12 px-6">
            <div className="text-5xl mb-3 grayscale opacity-30">🔍</div>
            <p className="text-gray-600 font-semibold text-lg">Nenhum instrutor encontrado</p>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
               Tente mudar os filtros de busca.
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
          <>
            {isFallback && (
              <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4 mb-2 text-center">
                <p className="text-yellow-800 font-medium text-sm">Ainda não temos instrutores na sua região</p>
                <p className="text-yellow-600 text-xs mt-1">Mostrando instrutores de outras cidades</p>
              </div>
            )}
            {sortedInstructors.map((inst) => {
            const isFavorite = favorites.includes(inst.id);
            const hasCar = inst.instructor_vehicles.some(v => v.type === 'car');
            const hasBike = inst.instructor_vehicles.some(v => v.type === 'bike');
            const carDetails = inst.instructor_vehicles.find(v => v.type === 'car');
            const bikeDetails = inst.instructor_vehicles.find(v => v.type === 'bike');

            // --- REAL RATING CALCULATION ---
            const { formattedRating, reviewsCount } = calculateInstructorRating(inst.reviews);

            const lowestPrice = getLowestPrice(inst);

            return (
              <div 
                key={inst.id} 
                onClick={() => navigate(`/student/instructor/${inst.id}`, { state: { fromApp: true } })}
                className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col relative overflow-hidden transition-all hover:shadow-md active:scale-[0.99] cursor-pointer"
              >
                
                {/* Top Row: Avatar, Name & Verification, Rating, City, Price */}
                <div className="flex justify-between items-start w-full">
                  <div className="flex items-center flex-1 min-w-0">
                    {/* Avatar */}
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-xl border border-gray-50 flex-shrink-0 mr-3 text-gray-400 overflow-hidden">
                      {inst.profiles.avatar_url ? (
                          <img src={inst.profiles.avatar_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                          "👤"
                      )}
                    </div>
                    
                    {/* Info */}
                    <div className="flex flex-col min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-bold text-gray-900 text-base leading-tight truncate">
                          {inst.profiles.full_name}
                        </h3>
                        {inst.credential_number && inst.credential_number !== 'N/A' && (
                          <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
                      <div className="flex items-center text-xs text-gray-500 mt-1 space-x-2">
                        {reviewsCount > 0 && (
                          <>
                            <RatingBadge rating={formattedRating} count={reviewsCount} variant="compact" />
                            <span className="text-gray-300">•</span>
                          </>
                        )}
                        <span className="truncate">{inst.profiles.city || 'Cidade não informada'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Price & Favorite */}
                  <div className="flex flex-col items-end flex-shrink-0 ml-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(inst.id, e); }}
                      className="p-1.5 rounded-full hover:bg-gray-50 transition-all focus:outline-none -mr-1.5 mb-1"
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
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">A partir de</span>
                      <span className="text-lg font-bold text-blue-600 leading-none mt-0.5">{formatCurrency(lowestPrice)}</span>
                    </div>
                  </div>
                </div>

                {/* Bottom Row: Tags (Category & Vehicles) */}
                <div className="flex flex-wrap gap-1.5 mt-4">
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

              </div>
            );
          })}
          </>
        )}
      </div>

      <StudentBottomNav />
    </div>
  );
};