import React from 'react';
import { HistoryCardAmountModel } from '../HistoryCardViewModel';
import { getIntentStyles } from './HistoryCardHeader';

export interface HistoryCardAmountProps {
  amount: HistoryCardAmountModel;
  children?: React.ReactNode;
}

export const HistoryCardAmount: React.FC<HistoryCardAmountProps> = ({ amount, children }) => {
  const styles = getIntentStyles(amount.intent);

  return (
    <div className="text-right shrink-0">
      {amount.label && (
        <span className="text-[10px] text-gray-400 font-medium block">
          {amount.label}
        </span>
      )}
      <span className={`block font-bold text-sm ${styles.text}`}>
        {amount.valueFormatted}
      </span>
      {children}
    </div>
  );
};
