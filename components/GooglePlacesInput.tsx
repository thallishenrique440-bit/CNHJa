import React, { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { importLibrary } from "@googlemaps/js-api-loader";

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
  const [inputElement, setInputElement] = useState<HTMLInputElement | null>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const isPlaceSelectedRef = useRef(false);

  useEffect(() => {
    console.log('[GooglePlacesInput] useEffect disparado');
    console.log('[GooglePlacesInput] Valor de inputElement:', inputElement);

    if (!inputElement) {
      console.log('[GooglePlacesInput] Abortando: inputElement ainda é nulo');
      return;
    }

    let listener: google.maps.MapsEventListener | null = null;

    console.log('[GooglePlacesInput] Chamando importLibrary("places")...');
    (importLibrary as any)("places").then((library: any) => {
      console.log('[GooglePlacesInput] importLibrary resolvido com sucesso');
      const { Autocomplete } = library as google.maps.PlacesLibrary;
      
      if (!inputElement || autocompleteRef.current) {
        console.log('[GooglePlacesInput] Abortando inicialização do Autocomplete: elemento ausente ou já inicializado');
        return;
      }

      console.log('[GooglePlacesInput] Inicializando instância do Autocomplete no DOM');
      // Initialize the autocomplete
      autocompleteRef.current = new Autocomplete(inputElement, {
        componentRestrictions: { country: "br" },
        fields: ["formatted_address", "geometry", "place_id"],
      });

      // Listener for place selection
      listener = autocompleteRef.current.addListener("place_changed", () => {
        const place = autocompleteRef.current?.getPlace();
        console.log('[GooglePlacesInput] Evento place_changed disparado:', place?.formatted_address);

        if (!place || !place.geometry || !place.geometry.location) return;

        const address = place.formatted_address || "";
        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        const placeId = place.place_id || "";

        isPlaceSelectedRef.current = true;
        onAddressSelect(address, lat, lng, placeId);
        onChange(address);
      });
    }).catch((err: any) => {
      console.error("[GooglePlacesInput] Erro CRÍTICO no importLibrary:", err);
    });

    // Cleanup listener on unmount
    return () => {
      if (listener) {
        google.maps.event.removeListener(listener);
      }
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
    };
  }, [inputElement]); // Run when input element is available

  // Sync external value to internal input state
  useEffect(() => {
    if (!inputElement) return;

    // Only sync if the input is NOT in focus
    if (document.activeElement !== inputElement) {
      if (value !== inputElement.value) {
        inputElement.value = value;
      }
      if (value) {
        isPlaceSelectedRef.current = true;
      }
    }
  }, [value, inputElement]);

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
          ref={setInputElement}
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
