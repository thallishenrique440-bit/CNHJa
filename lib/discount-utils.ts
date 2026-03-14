import { supabase as defaultSupabase } from './supabase.js';
import { SupabaseClient } from '@supabase/supabase-js';

export interface DiscountRule {
  min_lessons: number;
  discount_percentage: number;
}

export async function getInstructorDiscounts(instructorId: string, client: SupabaseClient = defaultSupabase): Promise<DiscountRule[]> {
  const { data, error } = await client
    .from('instructor_discounts')
    .select('min_lessons, discount_percentage')
    .eq('instructor_id', instructorId)
    .order('min_lessons', { ascending: true });

  if (error) {
    console.error('Error fetching discounts:', error);
    return [];
  }

  return data || [];
}

export function calculateDiscount(
  lessonCount: number,
  totalBasePrice: number,
  discounts: DiscountRule[]
): {
  totalPrice: number;
  discountAmount: number;
  finalPrice: number;
  appliedDiscountPercentage: number;
} {
  // Sort discounts by min_lessons descending to find the best applicable discount first
  const sortedDiscounts = [...discounts].sort((a, b) => b.min_lessons - a.min_lessons);
  
  let appliedDiscountPercentage = 0;
  
  for (const rule of sortedDiscounts) {
    if (lessonCount >= rule.min_lessons) {
      appliedDiscountPercentage = rule.discount_percentage;
      break;
    }
  }

  const totalPrice = totalBasePrice;
  const discountAmount = Math.round((totalPrice * appliedDiscountPercentage) / 100);
  const finalPrice = totalPrice - discountAmount;

  return {
    totalPrice,
    discountAmount,
    finalPrice,
    appliedDiscountPercentage
  };
}
