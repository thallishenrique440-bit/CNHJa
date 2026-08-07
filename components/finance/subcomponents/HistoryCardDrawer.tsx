import React from 'react';
import { HistoryCardDetailsModel, HistoryCardLessonsModel } from '../HistoryCardViewModel';
import { HistoryCardLessons } from './HistoryCardLessons';
import { HistoryCardBreakdown } from './HistoryCardBreakdown';

export interface HistoryCardDrawerProps {
  details: HistoryCardDetailsModel;
  lessons: HistoryCardLessonsModel;
  isExpanded: boolean;
}

export const HistoryCardDrawer: React.FC<HistoryCardDrawerProps> = ({
  details,
  lessons,
  isExpanded,
}) => {
  if (!details.isExpandable) return null;

  return (
    <>
      <div className="flex items-center justify-center mt-2 text-[10px] text-gray-400 font-medium">
        {isExpanded
          ? details.expandToggleTextOpen || '▲ Ocultar detalhes'
          : details.expandToggleTextClosed || '▼ Ver detalhes'}
      </div>

      {isExpanded && (
        <div
          className="mt-3 pt-3 border-t border-gray-100 space-y-3 animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          {details.breakdownTitle && (
            <div className="text-xs font-semibold text-gray-700">
              {details.breakdownTitle}
            </div>
          )}

          <HistoryCardLessons lessons={lessons} />
          <HistoryCardBreakdown items={details.breakdownItems} />
        </div>
      )}
    </>
  );
};
