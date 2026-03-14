import React from 'react';
import { usePushNotifications } from '../hooks/usePushNotifications';

export const PushNotificationManager: React.FC = () => {
  usePushNotifications();
  return null; // This component doesn't render anything, it just manages the push token lifecycle
};
