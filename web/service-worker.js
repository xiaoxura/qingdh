/* ==========================================================================
 * 氢导航 · service worker
 *
 * 只缓存 app shell（HTML/CSS/JS/图标）。绝不缓存 /api/（尤其 secrets、
 * AI 与隐私响应），也不把解密后的数据写入 Cache Storage。
 * ========================================================================== */

'use strict';

// 每次发布前端资源时递增版本号；新版本安装后等待用户确认再接管。
const VERSION = '20261029-48';
const CACHE_NAME = `qingdh-shell-${VERSION}`;

// 导航缓存判定单独成模块，便于 node:test 覆盖（B5）。
importScripts(`/lib/sw-policy.js?v=${VERSION}`);
const SHELL_PATHS = [
  '/',
  '/index.html',
  '/boot.js',
  '/styles.css',
  '/search.css',
  '/memo-batch.css',
  '/select.css',
  '/lib/core.js',
  '/lib/store.js',
  '/lib/render.js',
  '/lib/data.js',
  '/lib/engines.js',
  '/lib/merge.js',
  '/lib/settings.js',
  '/lib/revisions.js',
  '/lib/dialog.js',
  '/lib/sw-policy.js',
  '/select.js',
  '/crypto.js',
  '/device-vault.js',
  '/secrets.js',
  '/app.js',
  '/manifest.webmanifest',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
];

// 资源 URL 带版本号，安装预缓存可以直接复用浏览器里已有的 immutable
// 响应，避免首访后 SW 再把整包下载一遍。HTML 保持无版本，供导航兜底。
const SHELL = SHELL_PATHS.map((path) =>
  path === '/' || path === '/index.html' ? path : `${path}?v=${VERSION}`
);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isCacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  // API、管理后台、邮件验证链接一律网络直连，避免缓存敏感响应。
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/admin')) return false;
  if (url.pathname.startsWith('/verify-email')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isCacheable(request)) return;

  if (request.mode === 'navigate') {
    const pathname = new URL(request.url).pathname;
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 只允许真实的 app shell 入口覆盖离线页；404 页面、/admin 和邮件
          // 确认页绝不能写进 shell 缓存。
          if (response.ok && self.QingdhSWPolicy.isShellNavigation(pathname)) {
            const copy = response.clone();
            const stored = caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
            event.waitUntil(stored.catch(() => {}));
          }
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 网络优先：避免 HTML 走网络、JS/CSS 命中旧缓存造成的版本错配。
  // 离线时再退回缓存，保证 app shell 仍可打开。
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          const stored = caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          event.waitUntil(stored.catch(() => {}));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        throw new Error('offline and not cached');
      })
  );
});
