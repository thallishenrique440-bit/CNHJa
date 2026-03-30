import React, { useState, useEffect, useRef, useMemo } from 'react';
import { citiesSP } from '../data/cities-sp';

interface CitySelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export const CitySelect: React.FC<CitySelectProps> = ({ 
  label, 
  value, 
  onChange, 
  placeholder = "Busque sua cidade (SP)...",
  className = "",
  disabled = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sync internal search term with external value
  // We use the parent's value directly as the input value to ensure single source of truth
  
  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Filter Logic - Memoized for performance
  const filteredCities = useMemo(() => {
    if (!value || value.length < 2) return []; // Show nothing until 2 chars typed to reduce noise
    
    const lowerTerm = value.toLowerCase();
    
    // Filter and limit to 50 results to prevent DOM lag on mobile
    return citiesSP
      .filter(city => city.label.toLowerCase().includes(lowerTerm))
      .slice(0, 50);
  }, [value]);

  const handleSelect = (cityValue: string) => {
    onChange(cityValue); // Update parent with the exact string from JSON
    setIsOpen(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
    if (!isOpen) setIsOpen(true);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setIsOpen(false);
  };

  const showDropdown = isOpen && value.length >= 2 && filteredCities.length > 0;

  return (
    <div className={`flex flex-col space-y-2 w-full text-left relative ${className}`} ref={wrapperRef}>
      {label && (
        <label className="text-sm font-semibold text-gray-700 ml-1">
          {label}
        </label>
      )}
      
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={() => {
            if (value.length >= 2) setIsOpen(true);
          }}
          disabled={disabled}
          placeholder={placeholder}
          name="city"
          autoComplete="address-level2"
          className="w-full px-4 py-3.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        
        {/* Icons (Clear or Search) */}
        <div className="absolute inset-y-0 right-0 flex items-center pr-3">
           {value && !disabled ? (
             <button 
               onClick={handleClear}
               className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-200 transition-colors"
               type="button"
             >
               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
               </svg>
             </button>
           ) : (
             <div className="pointer-events-none text-gray-400 p-1">
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
               </svg>
             </div>
           )}
        </div>
      </div>

      {/* Dropdown Results */}
      {showDropdown && (
        <div className="absolute z-50 top-[calc(100%+4px)] left-0 w-full max-h-60 overflow-y-auto bg-white border border-gray-100 rounded-xl shadow-xl ring-1 ring-black ring-opacity-5 custom-scrollbar">
           <ul className="py-1">
             {filteredCities.map((city) => (
               <li 
                 key={city.ibge}
                 onMouseDown={() => handleSelect(city.value)} // onMouseDown fires before onBlur
                 className="px-4 py-3 hover:bg-blue-50 cursor-pointer text-sm text-gray-700 transition-colors border-b border-gray-50 last:border-0 flex justify-between items-center group"
               >
                 <span>{city.label}</span>
                 {/* Visual indicator that this is the selected value if it matches perfectly */}
                 {value === city.value && (
                   <span className="text-blue-600 font-bold">✓</span>
                 )}
               </li>
             ))}
           </ul>
        </div>
      )}
      
      {/* "No results" State */}
      {isOpen && value.length >= 2 && filteredCities.length === 0 && (
        <div className="absolute z-50 top-[calc(100%+4px)] left-0 w-full bg-white border border-gray-100 rounded-xl shadow-xl p-4 text-center">
           <p className="text-sm text-gray-500">Nenhuma cidade encontrada.</p>
           <p className="text-xs text-gray-400 mt-1">Verifique a ortografia ou se é uma cidade de SP.</p>
        </div>
      )}
    </div>
  );
};
