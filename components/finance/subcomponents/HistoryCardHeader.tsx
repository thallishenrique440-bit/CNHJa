import React from 'react';
import { HistoryCardHeaderModel, FinancialIntent } from '../HistoryCardViewModel';

export interface HistoryCardHeaderProps {
  header: HistoryCardHeaderModel;
}

export const getIntentStyles = (intent: FinancialIntent) => {
  switch (intent) {
    case 'success':
      return {
        iconBg: 'bg-green-50 text-green-600',
        border: 'border-green-500',
        text: 'text-green-600',
      };
    case 'warning':
      return {
        iconBg: 'bg-yellow-50 text-yellow-600',
        border: 'border-amber-400',
        text: 'text-amber-600',
      };
    case 'danger':
      return {
        iconBg: 'bg-red-50 text-red-600',
        border: 'border-red-500',
        text: 'text-red-600',
      };
    case 'info':
      return {
        iconBg: 'bg-blue-50 text-blue-600',
        border: 'border-blue-400 border-dashed',
        text: 'text-blue-500',
      };
    case 'neutral':
    default:
      return {
        iconBg: 'bg-gray-50 text-gray-600',
        border: 'border-gray-200',
        text: 'text-gray-900',
      };
  }
};

export const HistoryCardHeader: React.FC<HistoryCardHeaderProps> = ({ header }) => {
  const styles = getIntentStyles(header.intent);

  return (
    <div className="flex items-center space-x-4">
      <div
        className={`w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 ${styles.iconBg}`}
      >
        {header.iconEmoji}
      </div>
      <div>
        <h3 className="font-semibold text-gray-900 text-sm leading-tight">
          {header.title}
        </h3>
        {header.subtitle && (
          <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-line leading-tight">
            {header.subtitle}
          </p>
        )}
      </div>
    </div>
  );
};
