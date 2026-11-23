// Service worker : l'appli s'ouvre même sans réseau ; les tuiles de carte vues sont gardées en cache.
const VERSION = 'reperes-3m-v21';
const COQUILLE = ['./', 'index.html', 'style.css', 'app.js', 'stockage.js', 'firebase-config.js', 'data/reperes-lot2.js', 'data/photos-ign.js', 'data/fiches-ign.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo-siragusa.png'];
const TUILES = 'tuiles-v1', MAX_TUILES = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== TUILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase (données, photos, auth) : jamais intercepté
  if (/googleapis\.com|firebaseio|firebasestorage|identitytoolkit|securetoken/.test(url.host)) return;

  // Tuiles de carte : cache d'abord, réseau sinon
  if (url.host === 'data.geopf.fr' || url.host === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TUILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok && !url.pathname.endsWith('.pdf')) { c.put(req, r.clone()); purger(c); }
        return r;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }

  // Fichiers de l'appli et bibliothèques (Leaflet, Firebase) : réseau d'abord, cache si hors ligne
  if (url.origin === location.origin || url.host === 'unpkg.com' || url.host === 'www.gstatic.com') {
    // no-cache : toujours revalider auprès du serveur (sinon le cache HTTP de GitHub garde l'ancienne version ~10 min)
    e.respondWith(fetch(req, url.origin === location.origin ? { cache: 'no-cache' } : {}).then(r => {
      if (r.ok) { const copie = r.clone(); caches.open(VERSION).then(c => c.put(req, copie)); }
      return r;
    }).catch(() => caches.match(req).then(h => h || caches.match('index.html'))));
  }
});

let purgeEnCours = false;
async function purger(c) {
  if (purgeEnCours) return; purgeEnCours = true;
  try { const ks = await c.keys(); for (let i = 0; i < ks.length - MAX_TUILES; i++) await c.delete(ks[i]); } finally { purgeEnCours = false; }
}
