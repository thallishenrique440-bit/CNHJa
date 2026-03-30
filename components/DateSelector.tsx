import React, { useEffect, useRef, useMemo } from 'react';

interface DateSelectorProps {
  selectedDate: Date;
  onDateSelect: (date: Date) => void;
  daysBefore?: number;
  daysAfter?: number;
}

export const DateSelector: React.FC<DateSelectorProps> = ({
  selectedDate,
  onDateSelect,
  daysBefore = 7,
  daysAfter = 30
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Generate the list of days based on the requested range
  const days = useMemo(() => {
    const items: Date[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    start.setDate(today.getDate() - daysBefore);

    for (let i = 0; i <= (daysBefore + daysAfter); i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      items.push(d);
    }
    return items;
  }, [daysBefore, daysAfter]);

  // Center the selected day on mount or when the date changes
  useEffect(() => {
    const timer = setTimeout(() => {
      const activeElement = scrollRef.current?.querySelector('[data-active="true"]');
      if (activeElement) {
        activeElement.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest'
        });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedDate]);

  const getDayName = (date: Date) => {
    return new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(date).replace('.', '');
  };

  const isSameDay = (d1: Date, d2: Date) => {
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  };

  const today = new Date();

  return (
    <div className="relative bg-white">
      <div 
        ref={scrollRef}
        className="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide py-3 px-4"
        style={{ 
          scrollBehavior: 'smooth', 
          WebkitOverflowScrolling: 'touch',
          msOverflowStyle: 'none',
          scrollbarWidth: 'none'
        }}
      >
        {days.map((date, index) => {
          const isSelected = isSameDay(date, selectedDate);
          const isToday = isSameDay(date, today);

          return (
            <div
              key={index}
              data-active={isSelected}
              onClick={() => onDateSelect(date)}
              className={`
                flex flex-col items-center justify-center min-w-[48px] snap-center cursor-pointer transition-all duration-200 flex-shrink-0
                ${isSelected ? 'scale-110' : 'opacity-60 hover:opacity-100'}
              `}
            >
              <span className={`text-[10px] font-medium uppercase tracking-tighter mb-1 ${isSelected ? 'text-blue-600 font-bold' : 'text-gray-500'}`}>
                {getDayName(date)}
              </span>
              <div className={`
                w-9 h-9 flex items-center justify-center rounded-full transition-colors
                ${isSelected ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-900'}
              `}>
                <span className="text-sm font-bold">
                  {date.getDate()}
                </span>
              </div>
              <div className="h-1 mt-1">
                {isToday && !isSelected && (
                  <div className="w-1 h-1 rounded-full bg-blue-600" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
