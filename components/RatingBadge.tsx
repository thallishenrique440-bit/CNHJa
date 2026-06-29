import React from 'react';
import { getFormattedReviewsCount } from '../lib/instructorRating';

interface RatingBadgeProps {
  rating: number | string;
  count: number;
  variant?: 'compact' | 'profile';
  className?: string;
}

export const RatingBadge: React.FC<RatingBadgeProps> = ({ 
  rating, 
  count, 
  variant = 'compact',
  className = ''
}) => {
  // Scenario 1: New Instructor (0 reviews)
  if (!count || count === 0) {
    if (variant === 'profile') {
      return (
        <div className={`flex flex-col items-center justify-center ${className}`}>
           <div className="flex items-center text-gray-400 mb-0.5">
              <span className="text-xl">✨</span>
           </div>
           <span className="text-[10px] text-gray-500 text-center leading-none font-medium">
              Novo Instrutor
           </span>
        </div>
      );
    }
    
    // Compact Variant (StudentHome)
    return (
      <div className={`flex items-center bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200 ${className}`}>
         <span className="text-[10px] mr-1">✨</span>
         <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide leading-none">Novo</span>
      </div>
    );
  }

  // Scenario 2: Rated Instructor
  // The rating is passed pre-formatted from the helper as a Single Source of Truth
  const displayRating = rating;

  if (variant === 'profile') {
    return (
      <div className={`flex flex-col items-center justify-center ${className}`}>
        <div className="flex items-center text-yellow-500 mb-0.5">
          <span className="text-xs">★</span>
          <span className="font-bold text-gray-900 ml-1 text-base">{displayRating}</span>
        </div>
        <span className="text-[10px] text-gray-500 text-center leading-none underline decoration-gray-300 underline-offset-2">
          ({getFormattedReviewsCount(count)})
        </span>
      </div>
    );
  }

  // Compact Variant (StudentHome)
  return (
    <div className={`flex items-center ${className}`}>
       <span className="text-yellow-400 text-sm mr-0.5">★</span>
       <span className="font-bold text-gray-700 text-xs">{displayRating}</span>
       <span className="text-gray-400 text-[10px] ml-1">({count})</span>
    </div>
  );
};