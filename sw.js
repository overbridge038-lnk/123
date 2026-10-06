'use strict';
/* Service Worker：全ファイルを端末にキャッシュして、オフラインでも動かす。
 *  - model / vendor / icons（変わらない大きなファイル）… キャッシュ優先
 *  - それ以外（index.html, app.js, firebase-config.js など）… ネットが使えれば最新を取得、使えなければキャッシュ
 *  - 他のサイト（Firebase の通信など）には関与しない
 * アプリのファイルを更新したら、下の CACHE の番号（v3 → v4 …）を必ず上げてください。 */
const CACHE = 'gohin-v3';
const FILES = [
  './', './index.html', './style.css', './app.js', './cloud.js', './firebase-config.js', './manifest.json',
  './vendor/tf.min.js',
  './vendor/firebase/firebase-app-compat.js', './vendor/firebase/firebase-auth-compat.js', './vendor/firebase/firebase-firestore-compat.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './model/model.json',
  './model/group1-shard1of4', './model/group1-shard2of4', './model/group1-shard3of4', './model/group1-shard4of4'
];
const STATIC = /\/(model|vendor|icons)\//;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;           // Firebase など外部への通信はそのまま
  if (STATIC.test(url.pathname)) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
  } else {
    e.respondWith(networkFirst(req));
  }
});
