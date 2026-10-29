/* ==========================================================================
 * 氢导航 · 纯函数核心
 *
 * 以原生 UMD 形式同时供浏览器（classic script，零构建）和 node:test 使用。
 * 这里只放不依赖 DOM 的逻辑，方便单测覆盖 URL 校验、转义和图标地址。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
  }

  function uid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function toTimestamp(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function toTombstone(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function isValidHostname(hostname, allowShortHost = false) {
    const host = hostname.replace(/\.$/, '');
    if (!host) return false;
    if (/%|\s/.test(host)) return false;
    if (host === 'localhost') return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true;

    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    const domain = new RegExp(`^(${label}\\.)+[a-z0-9-]{2,63}$`, 'i');
    if (domain.test(host)) return true;

    return allowShortHost ? new RegExp(`^${label}$`, 'i').test(host) : false;
  }

  function normalizeUrl(value, { allowShortHost = false } = {}) {
    let input = String(value == null ? '' : value).trim();
    if (!input) return '';

    if (/^localhost(:\d+)?(\/|$)/i.test(input)) {
      input = `http://${input}`;
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) {
      input = `https://${input}`;
    }

    try {
      const url = new URL(input);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (url.username || url.password) return '';
      if (!isValidHostname(url.hostname, allowShortHost)) return '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function isURL(value) {
    if (/^https?:\/\//i.test(value)) return true;
    if (/\s/.test(value)) return false;
    if (/^localhost(:\d+)?(\/\S*)?$/i.test(value)) return true;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(value);
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (error) {
      return '';
    }
  }

  // Favicons go through the same-origin proxy, so a homepage with many links
  // does not leak the whole bookmark list to each third-party site.
  function faviconOf(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return `/api/favicon?u=${encodeURIComponent(parsed.origin)}`;
    } catch (error) {
      return '';
    }
  }

  return {
    ESCAPE_MAP,
    escapeHTML,
    uid,
    toTimestamp,
    toTombstone,
    isValidHostname,
    normalizeUrl,
    isURL,
    hostOf,
    faviconOf,
  };
});
