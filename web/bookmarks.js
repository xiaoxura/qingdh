/* ==========================================================================
 * 氢导航 · 浏览器书签导入
 *
 * 解析 Netscape Bookmark HTML（Chrome / Edge / Firefox 导出格式），
 * 纯客户端完成：文件夹映射为分组，重复 URL 去重，默认只导入普通工作区。
 * ========================================================================== */

(() => {
  'use strict';

  const MAX_TITLE = 40;

  function normalizeURL(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    let candidate = value;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (!url.hostname) return '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function folderFor(anchor) {
    const parts = [];
    let list = anchor.closest('dl');
    while (list) {
      const previous = list.previousElementSibling;
      let heading = null;
      if (previous) {
        if (previous.tagName === 'H3') heading = previous;
        else if (previous.querySelector) heading = previous.querySelector('h3');
      }
      const name = heading && heading.textContent ? heading.textContent.trim() : '';
      if (name) parts.unshift(name);
      const parent = list.parentElement;
      list = parent ? parent.closest('dl') : null;
    }
    const path = parts.join(' / ').trim().slice(0, 200) || '导入的书签';
    const last = path.split(' / ').pop().trim() || path;
    return { path, name: last.slice(0, 20) || '导入的书签' };
  }

  function parse(text) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const groups = new Map();
    const seen = new Set();
    let total = 0;
    let duplicates = 0;

    for (const anchor of anchors) {
      const url = normalizeURL(anchor.getAttribute('href'));
      if (!url) continue;

      const key = url.replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);

      const title = (anchor.textContent || '').trim().slice(0, MAX_TITLE) || url;
      const folder = folderFor(anchor);
      if (!groups.has(folder.path)) {
        groups.set(folder.path, { name: folder.name, path: folder.path, links: [] });
      }
      groups.get(folder.path).links.push({ title, url });
      total += 1;
    }

    return {
      groups: Array.from(groups.values()),
      total,
      duplicates,
    };
  }

  globalThis.QingdhBookmarks = { parse, normalizeURL };
})();
