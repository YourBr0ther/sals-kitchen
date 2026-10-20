// Sal's Kitchen service worker.
// Pages always come from the network (they depend on who's signed in); if the network is
// gone, show the offline page. Build assets, icons, and fonts are cached because their
// URLs change whenever their contents do. Nothing under /api is ever cached.

// the page registers /sw.js?v=<build id>, so every deploy installs a new worker and cache
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `sal-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sal-") && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  /^\/icon[\w-]*\.(png|svg)$/.test(url.pathname) ||
  url.hostname === "fonts.gstatic.com";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // icons keep their names across deploys: answer from cache, refresh in the background
  if (url.origin === self.location.origin && /^\/icon[\w-]*\.(png|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        }),
      ),
    );
    return;
  }

  if (isStatic(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// Reminders from the server. The payload is { title, body, url, tag } (see lib/push.ts).
self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || "Sal's Kitchen", {
      body: msg.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: msg.tag || undefined,
      data: { url: msg.url || "/" },
    }),
  );
});

// Tapping a reminder brings the app forward on the right tab, or opens it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (!win) return self.clients.openWindow(target);
      // focus first, while the tap still counts as the person's own action
      return win.focus().then((w) => {
        if (w.url === target) return w;
        // navigate() only works on pages this worker controls; otherwise open a fresh window
        return w
          .navigate(target)
          .then((nav) => nav || self.clients.openWindow(target))
          .catch(() => self.clients.openWindow(target));
      });
    }),
  );
});
