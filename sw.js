// 가계부 서비스 워커: 앱 화면을 기기에 저장해서 인터넷이 없어도 열리게 한다.
// 원칙 ① 앱 화면(index.html)은 "인터넷 먼저": 연결되면 항상 최신 버전, 끊기거나 느리면(3.5초) 저장해 둔 것
//      ② 서버(Apps Script)·구글 폰트 등 다른 주소의 요청은 절대 가로채지 않는다(동기화·인증이 그대로 동작)
//      ③ 같은 주소의 데이터(거래 등)는 서비스 워커가 아니라 앱이 직접 localStorage에 저장한다
const VERSION = 'v1-2026-10-21';
const CACHE = 'gaegyebu-' + VERSION;
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon.png'];
// index.html의 <script integrity=…>와 같은 주소·같은 버전(무결성 검증을 통과해야 하므로 CORS 응답을 그대로 저장)
const LIBS = [
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 하나가 실패해도(예: 아이콘을 아직 안 올림) 설치 자체는 계속한다
    await Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    await Promise.allSettled(LIBS.map((u) => c.add(new Request(u, { mode: 'cors', credentials: 'omit' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('gaegyebu-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const INDEX_KEY = './index.html';

async function networkFirstPage(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3500))
    ]);
    if (res && res.ok) cache.put(INDEX_KEY, res.clone()); // 어떤 주소로 열어도 같은 칸(index.html)에 최신본을 저장
    return res;
  } catch (err) {
    const hit = await cache.match(INDEX_KEY, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirstLib(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req.url, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // 서버로 보내는 저장(POST)은 건드리지 않음
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const isLib = LIBS.includes(url.href);
  if (!same && !isLib) return; // Apps Script, 구글 폰트 등은 그대로 통과
  if (isLib) { e.respondWith(cacheFirstLib(req)); return; }
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) { e.respondWith(networkFirstPage(req)); return; }
  e.respondWith(staleWhileRevalidate(req)); // 아이콘·manifest
});
