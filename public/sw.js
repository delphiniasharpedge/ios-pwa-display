/**
 * Service Worker - オフラインキャッシュ
 */

// Bump this when changing UI behavior so iOS PWA picks up updates.
const CACHE_NAME = 'ios-pwa-display-v13';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/voice/high-wattage-ja.wav',
];

// インストール時にキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// フェッチ時のキャッシュ戦略: Network First + Cache Fallback
self.addEventListener('fetch', (event) => {
  // WebSocket は除外
  if (event.request.url.startsWith('ws://') || event.request.url.startsWith('wss://')) {
    return;
  }

  // Always fetch latest config (do not cache) so tuning is easy.
  try {
    const url = new URL(event.request.url);
    if (url.pathname === '/config.json') {
      event.respondWith(fetch(event.request, { cache: 'no-store' }));
      return;
    }
  } catch {
    // ignore
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 成功したらキャッシュに保存
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // オフライン時はキャッシュから返す
        return caches.match(event.request);
      })
  );
});
