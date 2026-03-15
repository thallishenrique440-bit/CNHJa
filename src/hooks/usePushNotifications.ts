import { useEffect, useState, useCallback } from 'react';
import { getToken, onMessage } from 'firebase/messaging';
import { getMessagingInstance } from '../lib/firebase';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export function usePushNotifications() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [token, setToken] = useState<string | null>(null);
  // Estado para controlar se o navegador suporta e se a permissão já foi dada/negada
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

  // 2. Configura o listener de mensagens em foreground (apenas se já tiver permissão)
  useEffect(() => {
    if (!user || permissionStatus !== 'granted') return;

    let unsubscribe: (() => void) | undefined;

    const setupForegroundListener = async () => {
      try {
        const messaging = await getMessagingInstance();
        if (!messaging) return;

        unsubscribe = onMessage(messaging, (payload) => {
          console.log('Message received in foreground: ', payload);
          if (payload.notification) {
            addToast(payload.notification.title || 'Nova notificação', 'info');
          }
        });
      } catch (error) {
        console.error('Error setting up foreground listener:', error);
      }
    };

    setupForegroundListener();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [user, permissionStatus, addToast]);

  // 3. Função explícita para ser chamada pelo clique do usuário
  const requestPermissionAndGetToken = useCallback(async () => {
    if (!user || !isSupported) return null;

    try {
      const messaging = await getMessagingInstance();
      if (!messaging) {
        addToast('Notificações não suportadas neste navegador.', 'error');
        return null;
      }

      // Solicita permissão (DEVE ser ativado por um clique do usuário)
      const permission = await Notification.requestPermission();
      setPermissionStatus(permission);

      if (permission !== 'granted') {
        addToast('Permissão para notificações negada.', 'warning');
        return null;
      }

      // Registra o Service Worker
      let registration = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
      if (!registration) {
        registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      }

      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
      if (!vapidKey) {
        console.error('VITE_FIREBASE_VAPID_KEY is missing.');
        addToast('Erro de configuração do servidor (VAPID Key ausente).', 'error');
        return null;
      }

      // Obtém o token do FCM
      const currentToken = await getToken(messaging, { 
        vapidKey,
        serviceWorkerRegistration: registration
      });

      if (currentToken) {
        setToken(currentToken);
        
        // Salva no Supabase usando a RPC segura (bypassa RLS de conflito de device)
        const { error } = await supabase.rpc('register_fcm_token', {
          p_token: currentToken,
          p_device_type: 'web'
        });

        if (error) {
          console.error('Error saving FCM token via RPC:', error);
          addToast('Erro ao registrar dispositivo para notificações.', 'error');
        } else {
          addToast('Notificações ativadas com sucesso!', 'success');
        }
        
        return currentToken;
      } else {
        addToast('Não foi possível gerar o token de notificação.', 'error');
        return null;
      }
    } catch (error) {
      console.error('An error occurred while setting up push notifications: ', error);
      addToast('Erro ao configurar notificações.', 'error');
      return null;
    }
  }, [user, isSupported, addToast]);

  return { 
    token, 
    permissionStatus, 
    isSupported, 
    requestPermission: requestPermissionAndGetToken 
  };
}
