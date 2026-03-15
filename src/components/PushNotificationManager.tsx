import React, { useState } from 'react';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { Bell, X } from 'lucide-react';

export const PushNotificationManager: React.FC = () => {
  const { permissionStatus, isSupported, requestPermission } = usePushNotifications();
  const [dismissed, setDismissed] = useState(false);

  // Não mostra nada se não suportar, se já deu permissão, se negou, ou se o usuário fechou o banner
  if (!isSupported || permissionStatus !== 'default' || dismissed) {
    return null;
  }

  return (
    <div className="bg-indigo-600 text-white px-4 py-3 shadow-md flex items-center justify-between sticky top-0 z-50">
      <div className="flex items-center space-x-3">
        <Bell className="h-5 w-5 animate-bounce" />
        <p className="text-sm font-medium">
          Ative as notificações para ser avisado sobre suas aulas!
        </p>
      </div>
      <div className="flex items-center space-x-4">
        <button
          onClick={() => requestPermission()}
          className="bg-white text-indigo-600 px-3 py-1.5 rounded-md text-sm font-bold hover:bg-indigo-50 transition-colors"
        >
          Ativar
        </button>
        <button 
          onClick={() => setDismissed(true)}
          className="text-indigo-200 hover:text-white transition-colors p-1"
          aria-label="Fechar"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
};
