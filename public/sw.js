// Minimal service worker — exists so Chrome/Android treats this as an
// installable app (shows a real "Install app" prompt, opens without
// browser chrome). Deliberately does NOT cache anything: this app is a
// live sales tool, always talking to the server, so serving stale data
// offline would be actively misleading. Every request just passes straight
// through to the network as normal.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request));
});
