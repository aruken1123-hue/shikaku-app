// Service Worker: 圏外でも動くように画面と問題データを端末に保存する
// VERSION は js/version.js の APP_VERSION と必ず同じにする（tests/version.test.mjs で検査）
const VERSION = '0.1.3';
const APP_CACHE = `shikaku-app-${VERSION}`;

// 問題データ（data/）を足したら、ここにも必ず足す（tests/data.test.mjs で検査）
const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/version.js',
  'js/pwa.js',
  'js/store.js',
  'js/db.js',
  'js/progress.js',
  'js/quiz.js',
  'js/stats.js',
  'js/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/index.json',
  'data/takken/exam.json',
  'data/takken/q-kenri.json',
  'data/takken/q-gyouhou.json',
  'data/takken/q-seigen.json',
  'data/takken/q-zei.json',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' でブラウザのHTTPキャッシュを通さずに取る（GitHub Pages は10分キャッシュするため、
  // そのままだと新しい版の保存先に古いJSが入ることがある）
  event.waitUntil(caches.open(APP_CACHE)
    .then((c) => c.addAll(APP_FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('shikaku-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

const NETWORK_TIMEOUT_MS = 3000; // 電波が弱いとき、これ以上は待たずに保存済みを使う

// 問題データ: 最新を優先。圏外や電波が弱い（3秒以上かかる）ときは保存済みを返し、裏で取り続ける
async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) return cache.put(req, res.clone()).then(() => res);
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout'));
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') return first;
  } catch { /* 圏外 */ }
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || network; // 保存が無ければ待ち続けるしかない
}

// 画面のファイル: 版ごとに保存したものを使う
async function cacheFirst(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) event.waitUntil(cache.put(req, res.clone()));
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) event.respondWith(networkFirst(event));
  else event.respondWith(cacheFirst(event));
});
