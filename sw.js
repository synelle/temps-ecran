// Service worker minimal : met en cache la coquille de l'app (HTML/CSS/JS/icônes)
// pour un chargement instantané et un fonctionnement correct en PWA installée.
// Les appels Supabase (autre origine) ne sont jamais interceptés : les données
// restent toujours en direct.

const CACHE_NAME = "temps-ecran-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // On ne touche qu'aux requêtes de même origine (la coquille de l'app).
  // Tout le reste (Supabase, CDN) passe directement au réseau.
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;

  // Network-first : dès qu'il y a du réseau, on sert toujours la dernière
  // version (et on rafraîchit le cache) ; le cache ne sert que de secours
  // hors-ligne. Ça évite de rester bloqué sur une vieille version après une
  // mise à jour du site.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
