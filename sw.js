'use strict';
/* Service Worker：全ファイルを端末にキャッシュして、オフラインでも動かす。
 * アプリのファイルを更新したら、下の CACHE の番号（v1 → v2 …）を必ず上げてください。 */
const CACHE = 'gohin-v3';
const FILES = [
  './', './index.html', './style.css', './app.js', './manifest.json',
  './vendor/tf.min.js', './vendor/firebase.js', './firebase-config.js', './cloud.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './model/model.json',
  './model/group1-shard1of4', './model/group1-shard2of4', './model/group1-shard3of4', './model/group1-shard4of4'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;          // Firebase などの通信には口出ししない
  if (url.pathname.endsWith('/firebase-config.js')) {  // 設定ファイルは、書き換えたらすぐ反映（オフラインなら保存済みを使う）
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() =>
      e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
