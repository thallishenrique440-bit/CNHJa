/**
 * Utility functions for instructor category normalization and price calculation.
 * Centralizes the business logic to ensure consistency between StudentHome and InstructorProfile views.
 */

export interface CategoryPriceMin {
  category: string;
  day_price: number;
}

/**
 * Normalizes instructor categories from various legacy or list formats into a clean string array.
 * Examples of handled formats:
 * - ['A', 'B'] -> ['A', 'B']
 * - "AB" -> ['A', 'B']
 * - "A, B" -> ['A', 'B']
 * - "A" -> ['A']
 * - null/undefined -> []
 */
export function normalizeCategories(categoriesInput: string[] | string | null | undefined): string[] {
  if (!categoriesInput) return [];
  
  const active: string[] = [];
  const addCategory = (val: string) => {
    const clean = val.trim().toUpperCase();
    if (clean === 'AB') {
      if (!active.includes('A')) active.push('A');
      if (!active.includes('B')) active.push('B');
    } else if (clean) {
      if (!active.includes(clean)) active.push(clean);
    }
  };

  if (Array.isArray(categoriesInput)) {
    categoriesInput.forEach(c => {
      if (!c) return;
      if (c.includes(',')) {
        c.split(',').forEach(sub => addCategory(sub));
      } else if (c.length > 1) {
        c.split('').forEach(char => addCategory(char));
      } else {
        addCategory(c);
      }
    });
  } else if (typeof categoriesInput === 'string') {
    if (categoriesInput.includes(',')) {
      categoriesInput.split(',').forEach(sub => addCategory(sub));
    } else if (categoriesInput.length > 1) {
      categoriesInput.split('').forEach(char => addCategory(char));
    } else {
      addCategory(categoriesInput);
    }
  }

  return active;
}

/**
 * Calculates the lowest active category price (starting price) for an instructor.
 * It filters prices to only consider categories that are actually active/offered by the instructor,
 * ignoring disabled category prices and inactive categories.
 */
export function getLowestActiveCategoryPrice(
  categoriesInput: string[] | string | null | undefined,
  categoryPrices: CategoryPriceMin[] | null | undefined,
  fallbackPrice: number
): number {
  const activeCats = normalizeCategories(categoriesInput);

  if (categoryPrices && categoryPrices.length > 0) {
    const activePrices = categoryPrices
      .filter(c => activeCats.includes(c.category.toUpperCase()))
      .map(c => c.day_price)
      .filter(p => p > 0);

    if (activePrices.length > 0) {
      return Math.min(...activePrices);
    }
  }

  return fallbackPrice;
}
