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

  // 在总预算内尽量平均地给每个分组分配名额：先找到一个“人人保底”的份额，
  // 剩余名额再按分组顺序（调用方排好序）各加一，避免前面的分组吃光预算。
  function fairQuotas(counts, budget) {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total <= budget) return counts.slice();
    if (budget <= 0) return counts.map(() => 0);

    let low = 0;
    let high = Math.max(...counts);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const used = counts.reduce((sum, count) => sum + Math.min(count, mid), 0);
      if (used <= budget) low = mid;
      else high = mid - 1;
    }

    const quotas = counts.map((count) => Math.min(count, low));
    let remaining = budget - quotas.reduce((sum, quota) => sum + quota, 0);
    for (let i = 0; i < counts.length && remaining > 0; i++) {
      if (quotas[i] < counts[i]) {
        quotas[i] += 1;
        remaining -= 1;
      }
    }
    return quotas;
  }

  // 与服务端限额保持一致：分组超限时先丢墓碑、再丢最旧的分组；链接超限时
  // 先丢墓碑链接，再按“每组公平配额”保留较新的链接，并保持原有显示顺序。
  // 直接修改传入的文档，返回丢弃数量。
  function enforceLimits(doc, options = {}) {
    if (!doc || !Array.isArray(doc.groups)) return 0;
    const maxGroups = Number.isFinite(options.maxGroups) ? options.maxGroups : 50;
    const maxLinks = Number.isFinite(options.maxLinks) ? options.maxLinks : 500;
    let dropped = 0;

    if (doc.groups.length > maxGroups) {
      const byNewest = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      const live = doc.groups.filter((group) => !group.deletedAt).sort(byNewest);
      const tombstoned = doc.groups.filter((group) => group.deletedAt).sort(byNewest);
      // 墓碑优先丢：只有名额还有剩余时才保留墓碑。
      const keep = new Set(
        [...live, ...tombstoned].slice(0, Math.max(0, maxGroups)).map((group) => group.id)
      );
      dropped += doc.groups.length - keep.size;
      doc.groups = doc.groups.filter((group) => keep.has(group.id));
    }

    const liveGroups = doc.groups.filter((group) => !group.deletedAt);
    const totalLinks = liveGroups.reduce(
      (sum, group) => sum + (Array.isArray(group.links) ? group.links.length : 0),
      0
    );
    if (totalLinks <= maxLinks) return dropped;

    let excess = totalLinks - maxLinks;

    // 墓碑优先丢：从最旧的墓碑开始删，只删到刚好回到限额。
    const tombstones = [];
    liveGroups.forEach((group) => {
      (Array.isArray(group.links) ? group.links : []).forEach((link) => {
        if (link && link.deletedAt) tombstones.push(link);
      });
    });
    tombstones.sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
    const droppedTombstones = new Set(tombstones.slice(0, excess));
    if (droppedTombstones.size) {
      liveGroups.forEach((group) => {
        group.links = (group.links || []).filter((link) => !droppedTombstones.has(link));
      });
      excess -= droppedTombstones.size;
      dropped += droppedTombstones.size;
    }
    if (excess <= 0) return dropped;

    const groups = liveGroups
      .filter((group) => (group.links || []).some((link) => !link.deletedAt))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    if (!groups.length) return dropped;

    const counts = groups.map(
      (group) => group.links.filter((link) => !link.deletedAt).length
    );
    const quotas = fairQuotas(counts, counts.reduce((sum, count) => sum + count, 0) - excess);

    groups.forEach((group, index) => {
      const newest = new Set(
        group.links
          .filter((link) => !link.deletedAt)
          .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
          .slice(0, quotas[index])
          .map((link) => link.id)
      );
      const kept = group.links.filter((link) => !link.deletedAt && newest.has(link.id));
      dropped += group.links.length - kept.length;
      group.links = kept;
    });

    return dropped;
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
    fairQuotas,
    enforceLimits,
  };
});
