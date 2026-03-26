const CACHE_NAME = "lev-assistant-v1";
const ASSETS = ["/", "/manifest.json"];
self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
    self.skipWaiting();
});
self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
    self.clients.claim();
});
self.addEventListener("fetch", (event) => {
    if (event.request.url.includes("/api/")) return;
    event.respondWith(fetch(event.request).then((response) => {
          if (response.status === 200) { const clone = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)); }
          return response;
    }).catch(() => caches.match(event.request)));
});
self.addEventListener("push", (event) => {
    const data = event.data ? event.data.json() : { title: "Lev Assistant", body: "You have a new notification" };
    event.waitUntil(self.registration.showNotification(data.title || "Lev Assistant", { body: data.body || "Check your assistant", icon: "/icon-192.png", badge: "/icon-192.png", vibrate: [200, 100, 200], data: data }));
});
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => { if (clientList.length > 0) return clientList[0].focus(); return clients.openWindow("/"); }));
});
