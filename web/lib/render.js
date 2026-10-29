/* ==========================================================================
 * 氢导航 · 分组 / 链接渲染
 *
 * 把首屏唯一的“分组列表”渲染路径从 app.js 抽出来，依赖注入 escapeHTML、
 * hostOf 等纯函数，方便 node:test 直接断言转义、批量选择与折叠状态。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createRenderer(deps) {
    const escapeHTML = deps.escapeHTML;
    const hostOf = deps.hostOf;
    const faviconOf = deps.faviconOf;
    const hueOf = deps.hueOf;
    const glyphOf = deps.glyphOf;
    const directFaviconOf = deps.directFaviconOf;
    const icons = deps.icons || {};
    const getPrefs = deps.getPrefs;
    const getState = deps.getState;

    function renderIcon(link) {
      const icon = (link.icon || '').trim();
      const hue = hueOf(hostOf(link.url) || link.title || link.url);
      const glyph = escapeHTML(glyphOf(link));

      if (icon && !/^https?:\/\//i.test(icon)) {
        return `<span class="glyph glyph--icon" style="--h:${hue}" aria-hidden="true">${escapeHTML(icon)}</span>`;
      }

      // 首字母色块始终先渲染，图标加载成功后再覆盖，避免慢速/失败请求留下空白方块。
      const source = icon || faviconOf(link.url);
      // 服务端代理不可出网时退回浏览器直连；正常情况下仍由同源代理缓存，
      // 不会把整份书签列表直接暴露给每个站点。
      const fallback = icon ? '' : directFaviconOf(link.url);
      const baseline = `<span class="glyph" style="--h:${hue}" aria-hidden="true">${glyph}</span>`;
      if (!source) return baseline;

      return `${baseline}<img class="favicon" src="${escapeHTML(source)}" data-fallback="${escapeHTML(
        fallback
      )}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
    }

    function renderLink(link) {
      if (link.deletedAt) return '';
      const prefs = getPrefs();
      const state = getState();
      const label = link.title || hostOf(link.url) || '未命名';
      const target = prefs.openInNewTab ? ' target="_blank" rel="noopener noreferrer"' : '';

      const batch = state.batchMode;
      const batchChecked = batch && state.batchSelected.has(link.id);
      return `<div class="link-row${batchChecked ? ' is-batch-selected' : ''}" data-batch-row="${escapeHTML(
        link.id
      )}">
        ${
          batch
            ? `<label class="batch-check"><input type="checkbox" data-batch-toggle="${escapeHTML(
                link.id
              )}" ${batchChecked ? 'checked' : ''} aria-label="选择 ${escapeHTML(label)}" /></label>`
            : ''
        }
        <a class="link" href="${escapeHTML(link.url)}"${target} data-link-id="${escapeHTML(link.id)}" title="${escapeHTML(link.url)}">
          <span class="link-icon">${renderIcon(link)}</span>
          <span class="link-title">${escapeHTML(label)}</span>
        </a>
        <button class="link-remove" type="button" data-action="delete-link" data-link-id="${escapeHTML(link.id)}" aria-label="删除 ${escapeHTML(label)}" title="删除">
          ${icons.x || ''}
        </button>
      </div>`;
    }

    function renderGroup(group) {
      if (group.deletedAt) return '';
      const prefs = getPrefs();
      const state = getState();
      const titleAttrs = state.editing ? ' role="button" tabindex="0" title="点击重命名分组"' : '';
      const actions = state.editing
        ? `<div class="group-actions">
            <button class="mini-btn" type="button" data-action="add-link" data-group-id="${escapeHTML(group.id)}" aria-label="在「${escapeHTML(group.name)}」中添加" title="添加">${icons.plus || ''}</button>
            <button class="mini-btn" type="button" data-action="delete-group" data-group-id="${escapeHTML(group.id)}" aria-label="删除分组「${escapeHTML(group.name)}」" title="删除分组">${icons.x || ''}</button>
          </div>`
        : '';

      const visibleLinks = group.links.filter((link) => !link.deletedAt);
      const links = visibleLinks.length
        ? group.links.map(renderLink).join('')
        : '<p class="group-empty">暂无链接</p>';
      const collapsed = !state.editing && Boolean(prefs.collapsedGroups && prefs.collapsedGroups[group.id]);

      return `<section class="group${collapsed ? ' is-collapsed' : ''}" data-group-id="${escapeHTML(
        group.id
      )}">
        <div class="group-head">
          <div class="group-title-wrap">
            <button class="mini-btn group-toggle" type="button" data-action="toggle-group" data-group-id="${escapeHTML(
              group.id
            )}" aria-expanded="${String(!collapsed)}" title="${collapsed ? '展开分组' : '收起分组'}" aria-label="${
              collapsed ? '展开' : '收起'
            }「${escapeHTML(group.name)}」">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${collapsed ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6'}"/></svg>
            </button>
            <h2 class="group-title"${titleAttrs}>${escapeHTML(group.name)}</h2>
          </div>
          ${actions}
        </div>
        <div class="links">${links}</div>
      </section>`;
    }

    function renderGroups(groups) {
      return groups
        .filter((group) => !group.deletedAt)
        .map(renderGroup)
        .join('');
    }

    return { renderIcon, renderLink, renderGroup, renderGroups };
  }

  return { createRenderer };
});
