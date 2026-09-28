// Service worker: shows the server's title/body with the app icon + buzz.
// Sender name only (Daddy/Mommy/Aisha) — never message content (E2E: the
// server can't read messages, so quotes in notifications are impossible).
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let title = 'Chat Boy AI', body = 'You have a new notification';
    try {
      const d = event.data && event.data.json();
      if (d && d.title) title = String(d.title).slice(0, 60);
      if (d && d.body) body = String(d.body).slice(0, 120);
    } catch {}
    // Already looking at the chat? Don't buzz — the message is on screen.
    // (The server usually skips lookers already; this covers the race.)
    try {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some(w => w.focused)) return;
    } catch {}
    try {
      const cur = (typeof navigator.getAppBadge === 'function') ? await navigator.getAppBadge() : 0;
      await navigator.setAppBadge(cur + 1);
    } catch {}
    try {
      await self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [100, 50, 100],
        renotify: true,
        data: { url: '/' }
      });
    } catch {
      try { await self.registration.showNotification(title, { body }); } catch {} // bare fallback — never Chrome's generic line
    }
  })());
});

// Opening from a notification lands on the DECOY screen, locked.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    try { await navigator.clearAppBadge(); } catch {}
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) if (c.url === self.registration.scope) return c.focus();
    return clients.openWindow('/');
  })());
});
