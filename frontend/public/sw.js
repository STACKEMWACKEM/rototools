const CACHE = "rototools-shell-v1";
self.addEventListener("install", (e) =>
  e.waitUntil(
    fetch("/shell-assets.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((paths) => caches.open(CACHE).then((c) => c.addAll(paths))),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    u.origin !== location.origin ||
    u.pathname.startsWith("/api/")
  )
    return;
  if (
    u.pathname === "/" ||
    u.pathname.startsWith("/assets/") ||
    ["/icon.svg", "/manifest.webmanifest"].includes(u.pathname)
  )
    e.respondWith(
      fetch(e.request)
        .then(async (r) => {
          if (r.ok) {
            const c = await caches.open(CACHE);
            await c.put(e.request, r.clone());
          }
          return r;
        })
        .catch(() => caches.match(e.request)),
    );
});
