import React, { useEffect, useRef } from 'react';
import usePlacesAutocomplete, {
  getGeocode,
  getLatLng,
} from 'use-places-autocomplete';
import { MapPin, Loader2 } from 'lucide-react';

interface GooglePlacesInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onAddressSelect: (address: string, lat: number, lng: number, placeId: string) => void;
  placeholder?: string;
  className?: string;
}

export const GooglePlacesInput: React.FC<GooglePlacesInputProps> = ({
  label,
  value,
  onChange,
  onAddressSelect,
  placeholder = "Digite o ponto de encontro",
  className = ""
}) => {
  const {
    ready,
    value: inputValue,
    suggestions: { status, data },
    setValue,
    clearSuggestions,
  } = usePlacesAutocomplete({
    requestOptions: {
      componentRestrictions: { country: "br" }, // Restrict to Brazil
    },
    debounce: 300,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const isTypingRef = useRef(false);

  // Sync external value to internal state
  useEffect(() => {
    if (!isTypingRef.current && value !== inputValue) {
      setValue(value, false);
    }
  }, [value, inputValue, setValue]);

  // Handle clicking outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        clearSuggestions();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [clearSuggestions]);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    isTypingRef.current = true;
    setValue(e.target.value);
    onChange(e.target.value);
  };

  const handleSelect = async (suggestion: google.maps.places.AutocompletePrediction) => {
    isTypingRef.current = false;
    const { description, place_id } = suggestion;
    setValue(description, false);
    clearSuggestions();
    onChange(description);

    try {
      const results = await getGeocode({ placeId: place_id });
      const { lat, lng } = await getLatLng(results[0]);
      onAddressSelect(description, lat, lng, place_id);
    } catch (error) {
      console.error("Error fetching geocode:", error);
    }
  };

  return (
    <div className={`flex flex-col space-y-2 relative ${className}`} ref={containerRef}>
      {label && (
        <label className="text-sm font-semibold text-gray-700 ml-1">
          {label}
        </label>
      )}
      <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
          {!ready ? <Loader2 className="w-5 h-5 animate-spin" /> : <MapPin className="w-5 h-5" />}
        </div>
        <input
          value={inputValue}
          onChange={handleInput}
          onBlur={() => {
            isTypingRef.current = false;
          }}
          disabled={!ready}
          placeholder={placeholder}
          className="w-full pl-12 pr-4 py-3.5 rounded-xl bg-white border border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all disabled:bg-gray-50 disabled:cursor-not-allowed"
        />
      </div>

      {status === "OK" && (
        <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-100 rounded-xl shadow-xl overflow-hidden max-h-60 overflow-y-auto">
          {data.map((suggestion) => (
            <li
              key={suggestion.place_id}
              onClick={() => handleSelect(suggestion)}
              className="px-4 py-3 hover:bg-blue-50 cursor-pointer flex items-start space-x-3 transition-colors border-b border-gray-50 last:border-0"
            >
              <MapPin className="w-4 h-4 text-gray-400 mt-1 flex-shrink-0" />
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-900">
                  {suggestion.structured_formatting.main_text}
                </span>
                <span className="text-xs text-gray-500">
                  {suggestion.structured_formatting.secondary_text}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
