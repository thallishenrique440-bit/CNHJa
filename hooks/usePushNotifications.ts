import { useEffect, useState, useCallback } from 'react';
import { getToken, onMessage } from 'firebase/messaging';
import { getMessagingInstance } from '../lib/firebase';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export function usePushNotifications() {
  const { session } = useAuth();
  const user = session?.user;
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

  // Função auxiliar para buscar o token e salvar no banco (usada tanto no clique quanto na sincronização silenciosa)
  const fetchAndSaveToken = useCallback(async () => {
    if (!user) return null;
    try {
      const messaging = await getMessagingInstance();
      if (!messaging) return null;

      if (!('serviceWorker' in navigator)) {
        console.error('Service Worker is not supported in this browser.');
        return null;
      }

      await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const registration = await navigator.serviceWorker.ready;

      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
      if (!vapidKey) {
        console.error('VITE_FIREBASE_VAPID_KEY is missing.');
        return null;
      }

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
        }
        
        return currentToken;
      }
    } catch (error) {
      console.error('Error fetching/saving token:', error);
    }
    return null;
  }, [user]);

  // 2. Sincronização Silenciosa e Listener de Foreground (apenas se já tiver permissão)
  useEffect(() => {
    if (!user || permissionStatus !== 'granted') return;

    let unsubscribe: (() => void) | undefined;

    const setup = async () => {
      // Sincronização silenciosa: busca e atualiza o token no banco automaticamente
      await fetchAndSaveToken();

      // Configura o listener para mensagens com o app aberto
      try {
        const messaging = await getMessagingInstance();
        if (!messaging) return;

        unsubscribe = onMessage(messaging, (payload) => {
          console.log('Message received in foreground: ', payload);
          if (payload.notification) {
            addToast(payload.notification.title || 'Nova notificação', 'info');
            
            if (Notification.permission === 'granted') {
              navigator.serviceWorker.ready.then((registration) => {
                registration.showNotification(payload.notification.title || 'Nova notificação', {
                  body: payload.notification.body,
                  icon: '/icon-192x192.png',
                  data: payload.data
                });
              });
            }
          }
        });
      } catch (error) {
        console.error('Error setting up foreground listener:', error);
      }
    };

    setup();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [user, permissionStatus, fetchAndSaveToken, addToast]);

  // 3. Função explícita para ser chamada pelo clique do usuário no banner
  const requestPermissionAndGetToken = useCallback(async () => {
    if (!user || !isSupported) return null;

    try {
      // Solicita permissão (DEVE ser ativado por um clique do usuário)
      const permission = await Notification.requestPermission();
      setPermissionStatus(permission);

      if (permission !== 'granted') {
        addToast('Permissão para notificações negada.', 'warning');
        return null;
      }

      // Se permitiu, busca e salva o token
      const currentToken = await fetchAndSaveToken();
      
      if (currentToken) {
        addToast('Notificações ativadas com sucesso!', 'success');
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
  }, [user, isSupported, fetchAndSaveToken, addToast]);

  return { 
    token, 
    permissionStatus, 
    isSupported, 
    requestPermission: requestPermissionAndGetToken 
  };
}
