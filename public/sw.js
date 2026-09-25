// Service worker: shows ONLY the generic text the server sends.
// No sender, no message content — ever.
self.addEventListener('push', event => {
  let title = 'Chat Boy AI', body = 'You have a new notification';
  try {
    const d = event.data && event.data.json();
    if (d.title) title = d.title;
    if (d.body) body = d.body;
  } catch {}
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'chat-boy-msg',
      renotify: true,
    })
  );
});

// Opening from a notification lands on the DECOY screen, locked.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if (c.url === self.registration.scope) return c.focus();
      return clients.openWindow('/');
    })
  );
});
