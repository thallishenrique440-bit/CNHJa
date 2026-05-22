import { useEffect, useState, useCallback } from 'react';
import { onMessage } from 'firebase/messaging';
import { getMessagingInstance } from '../lib/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export function usePushNotifications() {
  const { session, syncPushToken } = useAuth();
  const user = session?.user;
  const { addToast } = useToast();
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission>('default');
  const [isSupported, setIsSupported] = useState<boolean>(true);

  // 1. Verifica o suporte e o status atual da permissão ao carregar
  useEffect(() => {
    if (!('Notification' in window)) {
      setIsSupported(false);
      return;
    }
    setPermissionStatus(Notification.permission);
  }, []);

  // 2. Listener de Foreground (apenas se já tiver permissão)
  useEffect(() => {
    if (!user || permissionStatus !== 'granted') return;

    let unsubscribe: (() => void) | undefined;

    const setup = async () => {
      // Configura o listener para mensagens com o app aberto
      try {
        const messaging = await getMessagingInstance();
        if (!messaging) return;

        unsubscribe = onMessage(messaging, (payload) => {
          console.log('[Push] Mensagem recebida em foreground: ', payload);
          const notification = payload.notification;
          if (notification) {
            addToast(notification.title || 'Nova notificação', 'info');
            
            if (Notification.permission === 'granted') {
              navigator.serviceWorker.ready.then((registration) => {
                registration.showNotification(notification.title || 'Nova notificação', {
                  body: notification.body,
                  icon: '/android-chrome-192x192.png',
                  data: payload.data
                });
              });
            }
          }
        });
      } catch (error) {
        console.error('[Push] Erro ao configurar listener de foreground:', error);
      }
    };

    setup();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [user, permissionStatus, addToast]);

  // 3. Função explícita para ser chamada pelo clique do usuário no banner
  const requestPermissionAndGetToken = useCallback(async () => {
    if (!user || !isSupported) return null;

    try {
      // Solicita permissão (DEVE ser ativado por um clique do usuário)
      console.log('[Push] Solicitando permissão de notificação...');
      const permission = await Notification.requestPermission();
      setPermissionStatus(permission);

      if (permission !== 'granted') {
        addToast('Permissão para notificações negada.', 'warning');
        return null;
      }

      // Se permitiu, dispara a sincronização no AuthContext
      console.log('[Push] Permissão concedida, disparando sincronização...');
      await syncPushToken();
      
      addToast('Notificações ativadas com sucesso!', 'success');
      return true;
    } catch (error) {
      console.error('[Push] Erro ao configurar notificações:', error);
      addToast('Erro ao configurar notificações.', 'error');
      return null;
    }
  }, [user, isSupported, syncPushToken, addToast]);

  return { 
    permissionStatus, 
    isSupported, 
    requestPermission: requestPermissionAndGetToken 
  };
}
