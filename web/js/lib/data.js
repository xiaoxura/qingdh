/* ==========================================================================
 * 氢导航 · 导航数据模型（payload v2）
 *
 * 纯数据变换：默认数据、导入归一化、墓碑清理与计数。通过依赖注入使用
 * core.js 的 URL/id 工具，便于 node:test 直接覆盖而不依赖 DOM。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

  function createDataModel(deps) {
    const uid = deps.uid;
    const toTimestamp = deps.toTimestamp;
    const toTombstone = deps.toTombstone;
    const normalizeUrl = deps.normalizeUrl;
    const engines = deps.engines || [];
    const now = deps.now;

    function makeLink(title, url, icon = '') {
      const stamp = now();
      return { id: uid(), title, url, icon, updatedAt: stamp, deletedAt: null };
    }

    function makeGroup(name, links = []) {
      return { id: uid(), name, links, updatedAt: now(), deletedAt: null };
    }

    function createDefaultData() {
      return {
        version: 2,
        settings: { name: '', engine: 'bing', customEngines: [], engineOrder: [], updatedAt: now() },
        groups: [
          makeGroup('常用', [
            makeLink('GitHub', 'https://github.com'),
            makeLink('哔哩哔哩', 'https://www.bilibili.com'),
            makeLink('知乎', 'https://www.zhihu.com'),
            makeLink('少数派', 'https://sspai.com'),
          ]),
          makeGroup('开发', [
            makeLink('MDN Web Docs', 'https://developer.mozilla.org/zh-CN/'),
            makeLink('Stack Overflow', 'https://stackoverflow.com'),
            makeLink('npm', 'https://www.npmjs.com'),
            makeLink('Vercel', 'https://vercel.com'),
          ]),
          makeGroup('工具', [
            makeLink('DeepL 翻译', 'https://www.deepl.com/translator'),
            makeLink('TinyPNG', 'https://tinypng.com'),
            makeLink('Excalidraw', 'https://excalidraw.com'),
            makeLink('草料二维码', 'https://cli.im'),
          ]),
        ],
      };
    }

    function normalizeCustomEngines(raw) {
      if (!Array.isArray(raw)) return [];
      const ids = new Set(engines.map((engine) => engine.id));
      const bangs = new Set(engines.map((engine) => engine.bang));
      const out = [];
      for (const item of raw.slice(0, 20)) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim().slice(0, 20);
        const template = String(item.template || '').trim().slice(0, 500);
        if (!name || !template.includes('{query}') || !/^https?:\/\//i.test(template)) continue;
        let id = typeof item.id === 'string' && /^[a-z0-9-]{3,50}$/i.test(item.id) ? item.id : `c-${uid()}`;
        if (ids.has(id)) id = `c-${uid()}`;
        ids.add(id);
        let bang = String(item.bang || '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(0, 8);
        if (bang && bangs.has(bang)) bang = '';
        if (bang) bangs.add(bang);
        out.push({ id, name, template, bang });
      }
      return out;
    }

    function normalizeLink(raw) {
      if (!raw || typeof raw !== 'object') return null;

      const deletedAt = toTombstone(raw.deletedAt);
      const url = deletedAt ? String(raw.url || '') : normalizeUrl(raw.url, { allowShortHost: true });
      if (!deletedAt && !url) return null;

      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
        title: typeof raw.title === 'string' ? raw.title.slice(0, 40) : '',
        url,
        icon: typeof raw.icon === 'string' ? raw.icon.slice(0, 200) : '',
        updatedAt: toTimestamp(raw.updatedAt),
        deletedAt,
      };
    }

    function pruneTombstones(doc) {
      const cutoff = now() - TOMBSTONE_TTL;
      doc.groups = doc.groups.filter(
        (group) => !(group.deletedAt && group.deletedAt < cutoff)
      );
      doc.groups.forEach((group) => {
        group.links = group.links.filter(
          (link) => !(link.deletedAt && link.deletedAt < cutoff)
        );
      });
      return doc;
    }

    function normalizeData(input) {
      const raw = input && typeof input === 'object' ? input : {};
      const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
      const customEngines = normalizeCustomEngines(rawSettings.customEngines);
      const knownEngines = [...engines, ...customEngines];

      const settings = {
        name: typeof rawSettings.name === 'string' ? rawSettings.name.trim().slice(0, 12) : '',
        engine: knownEngines.some((engine) => engine.id === rawSettings.engine)
          ? rawSettings.engine
          : 'bing',
        customEngines,
        engineOrder: Array.isArray(rawSettings.engineOrder)
          ? rawSettings.engineOrder
              .filter((id) => typeof id === 'string' && knownEngines.some((engine) => engine.id === id))
              .slice(0, 50)
          : [],
        updatedAt: toTimestamp(rawSettings.updatedAt),
      };

      const seenGroups = new Set();
      const seenLinks = new Set();

      const groups = (Array.isArray(raw.groups) ? raw.groups : [])
        .filter((group) => group && typeof group === 'object')
        .map((group) => {
          let id = typeof group.id === 'string' && group.id ? group.id : uid();
          if (seenGroups.has(id)) id = uid();
          seenGroups.add(id);

          const links = (Array.isArray(group.links) ? group.links : [])
            .map(normalizeLink)
            .filter(Boolean)
            .map((link) => {
              if (seenLinks.has(link.id)) return { ...link, id: uid() };
              seenLinks.add(link.id);
              return link;
            });

          return {
            id,
            name:
              typeof group.name === 'string' && group.name.trim()
                ? group.name.trim().slice(0, 20)
                : '未命名分组',
            links,
            updatedAt: toTimestamp(group.updatedAt),
            deletedAt: toTombstone(group.deletedAt),
          };
        });

      const doc = { version: 2, settings, groups };
      pruneTombstones(doc);
      return doc;
    }

    function countLinks(doc) {
      if (!doc || !Array.isArray(doc.groups)) return 0;
      return doc.groups.reduce((total, group) => {
        if (group.deletedAt) return total;
        return total + (Array.isArray(group.links) ? group.links.filter((l) => !l.deletedAt).length : 0);
      }, 0);
    }

    function countGroups(doc) {
      if (!doc || !Array.isArray(doc.groups)) return 0;
      return doc.groups.filter((group) => !group.deletedAt).length;
    }

    return {
      TOMBSTONE_TTL,
      makeLink,
      makeGroup,
      createDefaultData,
      normalizeCustomEngines,
      normalizeLink,
      normalizeData,
      pruneTombstones,
      countLinks,
      countGroups,
    };
  }

  return { createDataModel, TOMBSTONE_TTL };
});
