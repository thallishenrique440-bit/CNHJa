import { useEffect, useState } from 'react';
import { getToken, onMessage } from 'firebase/messaging';
import { getMessagingInstance } from '../lib/firebase';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

export function usePushNotifications() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    let unsubscribe: (() => void) | undefined;

    const setupNotifications = async () => {
      try {
        const messaging = await getMessagingInstance();
        if (!messaging) {
          console.log('Firebase Messaging is not supported in this browser.');
          return;
        }

        // Request permission
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          // 1. Explicitly register Service Worker, avoiding duplicates
          let registration = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
          if (!registration) {
            registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
          }

          // 2. Get FCM token with VAPID key and SW registration
          const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
          if (!vapidKey) {
            console.warn('VITE_FIREBASE_VAPID_KEY is missing. Push notifications may fail on some browsers.');
          }

          const currentToken = await getToken(messaging, { 
            vapidKey,
            serviceWorkerRegistration: registration
          });

          if (currentToken) {
            setToken(currentToken);
            
            // 3. Save to Supabase using upsert
            const { error } = await supabase
              .from('fcm_tokens')
              .upsert({
                user_id: user.id,
                token: currentToken,
                device_type: 'web',
                last_used_at: new Date().toISOString()
              }, {
                onConflict: 'token'
              });

            if (error) {
              console.error('Error saving FCM token to Supabase:', error);
            }
          } else {
            console.log('No registration token available. Request permission to generate one.');
          }

          // Listen for foreground messages
          unsubscribe = onMessage(messaging, (payload) => {
            console.log('Message received in foreground: ', payload);
            if (payload.notification) {
              addToast(payload.notification.title || 'Nova notificação', 'info');
            }
          });
        }
      } catch (error) {
        console.error('An error occurred while setting up push notifications: ', error);
      }
    };

    setupNotifications();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [user, addToast]);

  return { token };
}
