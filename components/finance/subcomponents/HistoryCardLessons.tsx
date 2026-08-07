import React from 'react';
import { HistoryCardLessonsModel } from '../HistoryCardViewModel';

export interface HistoryCardLessonsProps {
  lessons: HistoryCardLessonsModel;
}

export const HistoryCardLessons: React.FC<HistoryCardLessonsProps> = ({ lessons }) => {
  if (!lessons.items || lessons.items.length === 0) return null;

  return (
    <div className="space-y-1.5 bg-gray-50 p-2.5 rounded-xl border border-gray-100">
      {lessons.items.map((lesson, idx) => (
        <div
          key={lesson.id}
          className="flex justify-between text-[11px] text-gray-600"
        >
          <span>
            Aula {idx + 1}: {lesson.dateFormatted}
          </span>
          <span className="font-medium text-gray-500">
            {lesson.timeRangeFormatted}
          </span>
        </div>
      ))}
    </div>
  );
};
