import React from 'react';
import { HistoryCardStatusModel, HistoryCardMetadataModel } from '../HistoryCardViewModel';
import { getIntentStyles } from './HistoryCardHeader';

export interface HistoryCardStatusProps {
  status: HistoryCardStatusModel;
  metadata?: HistoryCardMetadataModel;
}

export const HistoryCardStatusBadgeRender: React.FC<{
  badge?: HistoryCardStatusModel['badge'];
}> = ({ badge }) => {
  if (!badge) return null;
  const { label, variant } = badge;

  switch (variant) {
    case 'pending':
      return (
        <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-bold">
          {label}
        </span>
      );
    case 'in_progress':
      return (
        <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">
          {label}
        </span>
      );
    case 'completed':
      return (
        <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold">
          {label}
        </span>
      );
    case 'failed':
    case 'refunded':
      return (
        <span className="text-[9px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">
          {label}
        </span>
      );
    case 'transferred':
      return (
        <span className="text-[9px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded font-bold">
          {label}
        </span>
      );
    default:
      return (
        <span className="text-[9px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-bold">
          {label}
        </span>
      );
  }
};

export const HistoryCardStatus: React.FC<HistoryCardStatusProps> = ({ status, metadata }) => {
  return (
    <>
      {status.installmentStatusText && (
        <p className="text-[10px] text-gray-400 mt-0.5">
          {status.installmentStatusText}
        </p>
      )}
      {metadata?.primaryDateLabel && (
        <p className="text-[10px] text-gray-400 mt-0.5">
          {metadata.primaryDateLabel}
        </p>
      )}
      {status.appointmentStatus && (
        <p
          className={`text-[9px] font-bold uppercase mt-1 ${
            getIntentStyles(status.appointmentStatus.intent).text
          }`}
        >
          {status.appointmentStatus.text}
        </p>
      )}
    </>
  );
};
