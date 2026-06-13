import { citiesSP, CityOption } from '../data/cities-sp';

/**
 * Normalizes a string to Title Case, stripping extra spaces and handling
 * Brazilian prepositions (de, da, do, das, dos, e, em) appropriately.
 */
export function toTitleCase(str: string): string {
  if (!str) return '';
  
  const cleanStr = str.trim().replace(/\s+/g, ' ');
  const lowercaseWords = ['de', 'da', 'do', 'das', 'dos', 'e', 'em'];
  const words = cleanStr.split(' ');
  
  const mappedWords = words.map((word, index) => {
    const lowerWord = word.toLowerCase();
    
    // Always capitalize first and last word in the string
    if (lowercaseWords.includes(lowerWord) && index > 0 && index < words.length - 1) {
      return lowerWord;
    }
    
    // Handle hyphenated names (e.g., Santa-Bárbara)
    if (word.includes('-')) {
      return word
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('-');
    }
    
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
  
  return mappedWords.join(' ');
}

/**
 * Trims and converts an email string to lowercase.
 */
export function sanitizeEmail(email: string): string {
  if (!email) return '';
  return email.trim().toLowerCase();
}

/**
 * Normalizes a city string utilizing the official citiesSP list labels or values.
 * If no match is found, falls back to applying toTitleCase.
 */
export function normalizeCity(city: string): string {
  if (!city) return '';
  const trimmed = city.trim().toLowerCase();
  
  const found = citiesSP.find(
    (option: CityOption) => option.value.trim().toLowerCase() === trimmed || 
                            option.label.trim().toLowerCase() === trimmed
  );
  
  if (found) {
    return found.value;
  }
  
  return toTitleCase(city);
}
