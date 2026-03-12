import { initializeApp } from 'firebase/app';
import { getMessaging, isSupported } from 'firebase/messaging';
import firebaseConfig from '../firebase-applet-config.json';

export const app = initializeApp(firebaseConfig);

export const getMessagingInstance = async () => {
  try {
    const supported = await isSupported();
    if (supported) {
      return getMessaging(app);
    }
  } catch (e) {
    console.error("Firebase Messaging not supported", e);
  }
  return null;
};
