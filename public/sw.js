// Service worker: makes repeat opens instant (and the lobby shows even while the server wakes up).
const V = "__V__";
const CACHE = "sheriff-" + V;
const CORE = ["/", `/style.css?v=${V}`, `/app.js?v=${V}`, `/rooms/office.jpg?v=${V}`, `/rooms/office_fg.png?v=${V}`, `/c/layout.json?v=${V}`,
  ...["sheriff", "papillon", "dobie"].map((c) => `/c/${c}/avatar.jpg?v=${V}`)];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("sheriff-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (/^\/(rt|healthz|parent|sw\.js)/.test(u.pathname)) return;           // live / private: always network
  if (req.mode === "navigate" || u.pathname === "/" || u.pathname === "/index.html") {
    // stale-while-revalidate: show the cached lobby at once (even if the server is still waking up)
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match("/");
      const net = fetch(req).then((r) => { if (r.ok) c.put("/", r.clone()); return r; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response("Нет связи", { status: 503 });
    }));
    return;
  }
  if (u.searchParams.has("v")) {
    // versioned static asset: cache-first, kept until the next version
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r;
    }));
  }
});
