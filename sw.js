// READMYFASTA — service worker: permite usar la herramienta sin conexión tras la primera visita.
// Las librerías pesadas (vendor/) se sirven desde caché; el código propio se pide primero a la red
// para que las actualizaciones lleguen enseguida.
const VERSION = 'rmf-v2.4.2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/fonts/inter-latin-wght-normal.woff2', 'vendor/fonts/source-serif-4-latin-opsz-normal.woff2',
  'vendor/fonts/jetbrains-mono-latin-wght-normal.woff2',
  'src/css/styles.css', 'src/js/theme-boot.js', 'src/js/i18n.js', 'src/js/app.js', 'src/js/worker.js', 'src/py/core.py', 'src/py/fastq_extras.py',
  'vendor/chartjs/chart.umd.js', 'vendor/3dmol/3Dmol-min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; // biowasm.com no se toca
  const isVendor = url.pathname.includes('/vendor/');
  if (isVendor) {
    event.respondWith(caches.match(event.request).then(async (hit) => {
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(VERSION);
        await cache.put(event.request, response.clone());
      }
      return response;
    }));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && !url.pathname.includes('/data/')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
