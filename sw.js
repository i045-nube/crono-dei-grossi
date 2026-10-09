// Funzionamento senza internet: al primo avvio salva tutti i file dell'app; poi li serve dal telefono.
// A ogni nuova versione pubblicata cambiare VERSION, così i telefoni scaricano i file aggiornati.
const VERSION = 'crono-v3';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/base.css', 'css/acciaio.css', 'css/acciaio-v2.css', 'css/app.css', 'js/app.js',
  'assets/Factoria-W00-Black.ttf', 'assets/logo-dark-800.png', 'assets/icona-180.png', 'assets/icona-192.png', 'assets/icona-512.png', 'assets/icona-maskable-512.png',
  'audio/voci.json', 'audio/boom.m4a', 'audio/silenzio.m4a',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const voci = await (await fetch('audio/voci.json', { cache: 'no-cache' })).json();
    await cache.addAll([...FILES, ...voci.start, ...voci.finish]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // Safari chiede i file dell'elemento <audio> a pezzi (Range): una risposta intera dalla cache può non suonare
  if (e.request.headers.has('range')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
