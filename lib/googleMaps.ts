import { setOptions } from "@googlemaps/js-api-loader";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";

if (!apiKey) {
  console.error("[GoogleMapsConfig] CRITICAL: VITE_GOOGLE_MAPS_API_KEY is missing or empty. Google Maps will fail to load correctly.");
} else {
  console.log("[GoogleMapsConfig] Initializing Google Maps with API Key (prefix):", apiKey.substring(0, 5) + "...");
}

(setOptions as any)({
  apiKey: apiKey,
  version: "weekly",
});

export {};
