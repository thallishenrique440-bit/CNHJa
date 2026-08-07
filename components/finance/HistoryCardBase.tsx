import React from 'react';
import { HistoryCardViewModel } from './HistoryCardViewModel';
import { HistoryCardHeader, getIntentStyles } from './subcomponents/HistoryCardHeader';
import { HistoryCardAmount } from './subcomponents/HistoryCardAmount';
import { HistoryCardStatus, HistoryCardStatusBadgeRender } from './subcomponents/HistoryCardStatus';
import { HistoryCardDrawer } from './subcomponents/HistoryCardDrawer';

export interface HistoryCardBaseProps {
  item: HistoryCardViewModel;
  isExpanded?: boolean;
  onToggleExpand?: (id: string) => void;
}

export const HistoryCardBase: React.FC<HistoryCardBaseProps> = ({
  item,
  isExpanded = false,
  onToggleExpand,
}) => {
  const handleClick = () => {
    if (item.details.isExpandable && onToggleExpand) {
      onToggleExpand(item.metadata.id);
    }
  };

  const headerStyles = getIntentStyles(item.header.intent);

  return (
    <div
      onClick={handleClick}
      className={`bg-white p-4 rounded-2xl shadow-sm border border-gray-100 border-l-4 ${headerStyles.border} flex flex-col transition-all hover:bg-gray-50 ${
        item.details.isExpandable ? 'cursor-pointer' : ''
      }`}
    >
      <div className="flex items-center justify-between w-full">
        <div>
          <HistoryCardHeader header={item.header} />
          <div className="ml-14">
            <HistoryCardStatus status={item.status} metadata={item.metadata} />
          </div>
        </div>

        <HistoryCardAmount amount={item.amount}>
          <HistoryCardStatusBadgeRender badge={item.status.badge} />
          {item.metadata.secondaryDateText && (
            <span className="text-[10px] text-gray-400 block mt-0.5">
              {item.metadata.secondaryDateText}
            </span>
          )}
        </HistoryCardAmount>
      </div>

      <HistoryCardDrawer
        details={item.details}
        lessons={item.lessons}
        isExpanded={isExpanded}
      />
    </div>
  );
};
