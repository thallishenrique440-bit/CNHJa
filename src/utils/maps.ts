/**
 * Utility for generating map URLs for navigation.
 * Designed to be extensible for other map providers (Waze, Apple Maps, etc.)
 */

export interface MapLocationData {
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  placeId?: string | null;
}

/**
 * Generates a Google Maps URL based on the best available data.
 * Priority:
 * 1. Latitude/Longitude + Place ID (Most precise)
 * 2. Place ID only
 * 3. Address text (Fallback)
 */
export const getGoogleMapsUrl = (data: MapLocationData): string => {
  const { address, lat, lng, placeId } = data;

  // Base URL for Google Maps Search API (recommended for deep linking)
  const baseUrl = 'https://www.google.com/maps/search/?api=1';

  // Option 1: Lat/Lng + Place ID
  if (lat && lng && placeId) {
    const query = encodeURIComponent(`${lat},${lng}`);
    return `${baseUrl}&query=${query}&query_place_id=${encodeURIComponent(placeId)}`;
  }

  // Option 2: Lat/Lng only
  if (lat && lng) {
    return `${baseUrl}&query=${encodeURIComponent(`${lat},${lng}`)}`;
  }

  // Option 3: Place ID only
  if (placeId) {
    // Note: Google Search API requires a 'query' even with query_place_id.
    // If we only have placeId, we use it as the query too.
    return `${baseUrl}&query=${encodeURIComponent(placeId)}&query_place_id=${encodeURIComponent(placeId)}`;
  }

  // Option 4: Address text
  if (address && address.trim()) {
    return `${baseUrl}&query=${encodeURIComponent(address.trim())}`;
  }

  return '#';
};

/**
 * Future-proofing: Example of how to add Waze support
 */
export const getWazeUrl = (data: MapLocationData): string => {
  const { lat, lng, address } = data;
  
  if (lat && lng) {
    return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  }
  
  if (address) {
    return `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`;
  }
  
  return '#';
};
