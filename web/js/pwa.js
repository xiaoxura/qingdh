/* ==========================================================================
 * 氢导航 · PWA
 *
 * 只注册 app shell 的 service worker；安装更新后提示刷新，不静默换掉当前页面。
 * 非 HTTPS（localhost 除外）不注册，避免在局域网 HTTP 下产生误导。
 * ========================================================================== */

(() => {
  'use strict';

  const deps = { toast: () => {} };
  let registration = null;
  let prompted = false;

  function init(nextDeps) {
    if (nextDeps) Object.assign(deps, nextDeps);
    register();
  }

  function supported() {
    if (!('serviceWorker' in navigator)) return false;
    if (location.protocol === 'https:') return true;
    return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  }

  async function register() {
    if (!supported()) return;
    try {
      registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      if (registration.waiting) promptUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) promptUpdate();
        });
      });
    } catch (error) {
      // 注册失败不影响正常使用。
    }
  }

  function promptUpdate() {
    if (prompted) return;
    prompted = true;
    deps.toast('有新版本可用', {
      actionLabel: '刷新',
      duration: 15000,
      onAction: () => {
        if (registration && registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        setTimeout(() => location.reload(), 120);
      },
    });
  }

  globalThis.QingdhPWA = { init, supported };
})();
