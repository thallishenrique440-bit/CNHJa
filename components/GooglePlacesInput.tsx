import React, { useEffect, useRef } from 'react';
import { MapPin } from 'lucide-react';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const isPlaceSelectedRef = useRef(false);

  useEffect(() => {
    if (!inputRef.current || !window.google || autocompleteRef.current) return;

    // Initialize the autocomplete
    autocompleteRef.current = new google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "br" },
      fields: ["formatted_address", "geometry", "place_id"],
    });

    // Listener for place selection
    const listener = autocompleteRef.current.addListener("place_changed", () => {
      const place = autocompleteRef.current?.getPlace();

      if (!place || !place.geometry || !place.geometry.location) return;

      const address = place.formatted_address || "";
      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const placeId = place.place_id || "";

      isPlaceSelectedRef.current = true;
      onAddressSelect(address, lat, lng, placeId);
      onChange(address);
    });

    // Cleanup listener on unmount
    return () => {
      if (listener) {
        google.maps.event.removeListener(listener);
      }
    };
  }, []); // Run only once

  // Sync external value to internal input state
  useEffect(() => {
    if (inputRef.current && value !== inputRef.current.value) {
      inputRef.current.value = value;
    }
    if (value) {
      isPlaceSelectedRef.current = true;
    }
  }, [value]);

  return (
    <div className={`flex flex-col space-y-2 relative ${className}`}>
      {label && (
        <label className="text-sm font-semibold text-gray-700 ml-1">
          {label}
        </label>
      )}
      <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
          <MapPin className="w-5 h-5" />
        </div>
        <input
          ref={inputRef}
          defaultValue={value}
          onChange={(e) => {
            isPlaceSelectedRef.current = false;
            onChange(e.target.value);
          }}
          onBlur={() => {
            if (!isPlaceSelectedRef.current) {
              onAddressSelect("", 0, 0, "");
            }
          }}
          placeholder={placeholder}
          className="w-full pl-12 pr-4 py-3.5 rounded-xl bg-white border border-gray-200 text-gray-900 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all disabled:bg-gray-50 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
};
