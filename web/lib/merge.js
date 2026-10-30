/* ==========================================================================
 * 氢导航 · 同步合并算法
 *
 * 纯数据逻辑，不接触 DOM。依赖注入 normalizeData / normalizeUrl / clone，
 * 便于表驱动测试“新增、修改、删除、墓碑、同 URL 去重、设置取新”。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createMergeModel(deps) {
    const normalizeData = deps.normalizeData;
    const normalizeUrl = deps.normalizeUrl;
    const clone = deps.clone;
    const now = deps.now;

    function linkIndexForMerge(doc) {
      const normalized = normalizeData(doc);
      const visible = new Map();
      const deleted = new Set();
      for (const group of normalized.groups) {
        for (const link of group.links) {
          const url = normalizeUrl(link.url);
          if (!url) continue;
          const key = url.replace(/\/+$/, '');
          if (link.deletedAt) {
            deleted.add(key);
            continue;
          }
          visible.set(key, { title: link.title || url, url, group: group.name });
        }
      }
      return { normalized, visible, deleted };
    }

    function buildMergeDiff(local, cloud) {
      const a = linkIndexForMerge(local);
      const b = linkIndexForMerge(cloud);
      const diff = {
        localOnly: [],
        cloudOnly: [],
        modified: [],
        locallyDeleted: [],
        cloudDeleted: [],
        localGroups: [],
        cloudGroups: [],
        settings: false,
      };
      for (const [key, link] of a.visible) {
        const other = b.visible.get(key);
        if (!other) {
          if (b.deleted.has(key)) diff.locallyDeleted.push(link);
          else diff.localOnly.push(link);
        } else if (other.title !== link.title || other.group !== link.group) {
          diff.modified.push({ local: link, cloud: other });
        }
      }
      for (const [key, link] of b.visible) {
        if (a.visible.has(key)) continue;
        if (a.deleted.has(key)) diff.cloudDeleted.push(link);
        else diff.cloudOnly.push(link);
      }
      const localGroups = new Set(a.normalized.groups.map((group) => group.name));
      const cloudGroups = new Set(b.normalized.groups.map((group) => group.name));
      diff.localGroups = [...localGroups].filter((name) => !cloudGroups.has(name));
      diff.cloudGroups = [...cloudGroups].filter((name) => !localGroups.has(name));
      const localSettings = a.normalized.settings;
      const cloudSettings = b.normalized.settings;
      diff.settings =
        localSettings.name !== cloudSettings.name ||
        localSettings.engine !== cloudSettings.engine ||
        JSON.stringify(localSettings.customEngines || []) !==
          JSON.stringify(cloudSettings.customEngines || []);
      return diff;
    }

    function newer(a, b) {
      return (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
    }

    function mergeSettings(a, b) {
      const chosen = newer(a, b);
      return {
        name: chosen.name,
        engine: chosen.engine,
        customEngines: chosen.customEngines || [],
        engineOrder: chosen.engineOrder || [],
        updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
      };
    }

    function mergeLink(localLink, cloudLink) {
      const deletedWinner = [localLink, cloudLink].find(
        (link) => link.deletedAt && link.deletedAt >= newer(localLink, cloudLink).updatedAt
      );
      if (deletedWinner) {
        return { ...deletedWinner, deletedAt: deletedWinner.deletedAt, title: deletedWinner.title || '' };
      }
      const winner = newer(localLink, cloudLink);
      return { ...winner, deletedAt: null };
    }

    function mergeDocuments(local, cloud) {
      const a = normalizeData(local);
      const b = normalizeData(cloud);

      const result = {
        version: 2,
        settings: mergeSettings(a.settings, b.settings),
        groups: [],
      };

      const order = [];
      const localById = new Map(a.groups.map((group) => [group.id, group]));
      const cloudById = new Map(b.groups.map((group) => [group.id, group]));

      a.groups.forEach((group) => order.push(group.id));
      b.groups.forEach((group) => {
        if (!localById.has(group.id)) order.push(group.id);
      });

      for (const id of order) {
        const localGroup = localById.get(id);
        const cloudGroup = cloudById.get(id);
        if (!localGroup || !cloudGroup) {
          result.groups.push(clone(localGroup || cloudGroup));
          continue;
        }
        result.groups.push(mergeGroup(localGroup, cloudGroup));
      }

      return result;
    }

    function mergeGroup(localGroup, cloudGroup) {
      const newerGroup = newer(localGroup, cloudGroup);
      const deleted = [localGroup, cloudGroup].find(
        (group) => group.deletedAt && group.deletedAt >= newerGroup.updatedAt
      );
      const base = deleted || newerGroup;

      const linkOrder = [];
      const localLinks = new Map(localGroup.links.map((link) => [link.id, link]));
      const cloudLinks = new Map(cloudGroup.links.map((link) => [link.id, link]));

      localGroup.links.forEach((link) => linkOrder.push(link.id));
      cloudGroup.links.forEach((link) => {
        if (!localLinks.has(link.id)) linkOrder.push(link.id);
      });

      const links = [];
      const seenUrls = new Map();

      for (const id of linkOrder) {
        const localLink = localLinks.get(id);
        const cloudLink = cloudLinks.get(id);
        const merged = localLink && cloudLink ? mergeLink(localLink, cloudLink) : clone(localLink || cloudLink);
        if (!merged) continue;

        if (!merged.deletedAt) {
          const key = merged.url;
          const existing = seenUrls.get(key);
          if (existing) {
            if ((merged.updatedAt || 0) > (existing.updatedAt || 0)) {
              existing.deletedAt = merged.updatedAt || now();
              existing.updatedAt = merged.updatedAt || now();
              const index = links.indexOf(existing);
              if (index !== -1) links[index] = merged;
              seenUrls.set(key, merged);
              continue;
            } else {
              merged.deletedAt = existing.updatedAt || now();
              merged.updatedAt = existing.updatedAt || now();
            }
          } else {
            seenUrls.set(key, merged);
          }
        }

        links.push(merged);
      }

      return {
        id: base.id,
        name: base.name,
        links,
        updatedAt: Math.max(localGroup.updatedAt || 0, cloudGroup.updatedAt || 0),
        deletedAt: deleted ? deleted.deletedAt : null,
      };
    }

    return {
      linkIndexForMerge,
      buildMergeDiff,
      newer,
      mergeSettings,
      mergeLink,
      mergeDocuments,
      mergeGroup,
    };
  }

  return { createMergeModel };
});
