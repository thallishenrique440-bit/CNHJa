/**
 * Utility functions for centralizing instructor rating, average calculation, and formatting.
 * Single Source of Truth for StudentHome, InstructorProfile, and Rating components.
 */

export interface ReviewMin {
  rating: number;
}

export interface RatingSummary {
  averageRating: number;      // Numeric representation, e.g. 4.7
  reviewsCount: number;       // Number of reviews
  formattedRating: string;    // E.g. "4.7" or "0.0", always 1 decimal place
  formattedReviewsCount: string; // E.g. "0 avaliações", "1 avaliação", "2 avaliações"
}

/**
 * Pluralization rule for reviews count.
 */
export function getFormattedReviewsCount(count: number): string {
  if (!count || count === 0) {
    return "0 avaliações";
  }
  return count === 1 ? "1 avaliação" : `${count} avaliações`;
}

/**
 * Calculates a unified rating summary from a collection of reviews.
 */
export function calculateInstructorRating(reviews: ReviewMin[] | null | undefined): RatingSummary {
  if (!reviews || reviews.length === 0) {
    return {
      averageRating: 0.0,
      reviewsCount: 0,
      formattedRating: "0.0",
      formattedReviewsCount: getFormattedReviewsCount(0)
    };
  }

  const reviewsCount = reviews.length;
  const totalRating = reviews.reduce((acc, r) => acc + r.rating, 0);
  const averageRating = totalRating / reviewsCount;
  
  const roundedRating = Math.round(averageRating * 10) / 10;
  const formattedRating = roundedRating.toFixed(1);

  // Pluralization rule
  const formattedReviewsCount = getFormattedReviewsCount(reviewsCount);

  return {
    averageRating: roundedRating,
    reviewsCount,
    formattedRating,
    formattedReviewsCount
  };
}
