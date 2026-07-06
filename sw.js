/* HMI Portion Reader — offline service worker.
   Caches the app shell + vendored OCR engine so it runs with zero internet
   after the first load. Bump CACHE to force a refresh on update. */
const CACHE = 'portion-reader-v5';   // bumped: v2 staged engine (auto-locate,
                                     // glyph-bank reader, log/portion tracking)
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './tess/tesseract.min.js',
  './tess/worker.min.js',
  './tess/tesseract-core-simd-lstm.wasm.js',
  './tess/tesseract-core-simd-lstm.wasm',
  './tess/tesseract-core-lstm.wasm.js',
  './tess/tesseract-core-lstm.wasm',
  './tess/eng.traineddata.gz'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
