import React from 'react';
import { HistoryCardBreakdownItem } from '../HistoryCardViewModel';
import { getIntentStyles } from './HistoryCardHeader';

export interface HistoryCardBreakdownProps {
  items?: HistoryCardBreakdownItem[];
}

export const HistoryCardBreakdown: React.FC<HistoryCardBreakdownProps> = ({ items }) => {
  if (!items || items.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-y-2 text-[11px]">
      {items.map((row, idx) => {
        let valueColor = 'text-gray-700 font-medium';
        if (row.intent) {
          valueColor = `${getIntentStyles(row.intent).text} font-medium`;
        }
        if (row.isHighlight) {
          valueColor = row.intent ? `${getIntentStyles(row.intent).text} font-bold` : 'text-green-600 font-bold';
        }

        return (
          <React.Fragment key={idx}>
            <div className={`text-gray-400 ${row.isBold ? 'font-bold' : ''}`}>
              {row.label}
            </div>
            <div
              className={`text-right ${
                row.isMono ? 'font-mono text-gray-500' : valueColor
              }`}
            >
              {row.valueFormatted}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
