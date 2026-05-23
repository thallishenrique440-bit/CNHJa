importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyCj7CHQrvDGw2zPidXXOLTgsPN3XJSng2I",
  authDomain: "autoescoladobrasil.firebaseapp.com",
  projectId: "autoescoladobrasil",
  storageBucket: "autoescoladobrasil.firebasestorage.app",
  messagingSenderId: "898405109775",
  appId: "1:898405109775:web:92940f139fa0b625acd37a",
  measurementId: "G-KLSEZSHCLZ"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  // Manual showNotification is removed here to prevent duplicate render because 
  // Firebase SDK automatically renders notifications when the payload containing 'notification' is received in the background.
});

self.addEventListener('notificationclick', function(event) {
  console.log('[firebase-messaging-sw.js] Notification click Received.', event);
  event.notification.close();

  // If there's a URL in the data payload, open it
  const urlToOpen = event.notification.data?.url || '/';
  const targetUrl = new URL(urlToOpen, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Check if there is already a window/tab open with the target URL
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        // If so, just focus it.
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // If not, then open the target URL in a new window/tab.
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
