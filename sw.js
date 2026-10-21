// sw.js — 線上版離線快取（只在 https 註冊；下載版用 file:// 開啟時不會啟用）。
// 網路優先：有網路時永遠拿最新程式（安全修正能立即生效），斷網才用快取。
// 向網路要檔案一律繞過瀏覽器 HTTP 快取（GitHub Pages 給 max-age=600），否則部署後 10 分鐘內仍拿到舊程式，
// 各檔過期時間不同還會新舊混用（2026-10-21 #21 上線後實際發生；scripts/online-browser-check.mjs 有回歸檢查）。
// 只快取本站的靜態程式檔，不碰使用者資料（資料在 localStorage／IndexedDB，與快取無關）。
// PRECACHE 要和 index.html 載入的檔案一致，tests/core.test.mjs 會檢查。
const CACHE = 'moneypath-static-v1';
const PRECACHE = [
  './',
  './index.html',
  './shared/style.css',
  './shared/frame-guard.js',
  './shared/reference-data.js',
  './shared/config.js',
  './shared/snapshots.js',
  './shared/validation.js',
  './shared/planning.js',
  './shared/money.js',
  './shared/io.js',
  './shared/app.js',
  './shared/sw-register.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('moneypath-static-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request.url, { cache: 'no-cache' })
    .then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
