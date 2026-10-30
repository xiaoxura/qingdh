/* ==========================================================================
 * 氢导航 · 历史版本预览与恢复
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhRevisions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(deps) {
    const {
      dom,
      state,
      sync,
      cryptoState,
      api,
      apiError,
      ensureDialogs,
      escapeHTML,
      formatTime,
      normalizeData,
      stampAll,
      saveSnapshot,
      commitLocalChange,
      syncNow,
      askConfirm,
      showToast,
      promptUnlock,
      readCachedDataKey,
      setData,
    } = deps;

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  }

  function summarizeRevision(payload) {
    const doc = normalizeData(payload);
    const groups = doc.groups.filter((group) => !group.deletedAt);
    const links = groups.reduce(
      (total, group) => total + group.links.filter((link) => !link.deletedAt).length,
      0
    );
    return { groups, links };
  }

  // 预览/恢复历史版本时不能修改当前 cryptoState：当前文档可能已经关闭加密，
  // 而历史版本仍是 v3。这里只借用当前的 dataKey / 设备记忆或临时询问密码。
  async function decodeHistoricalPayload(payload) {
    if (!payload || Number(payload.version) !== 3) return payload;
    if (!globalThis.QingdhCrypto) throw new Error('当前环境不支持解密，请使用 HTTPS 或 localhost');
    const cached = cryptoState.dataKeyRaw || readCachedDataKey();
    if (cached) {
      try {
        return await QingdhCrypto.unlockWithKey(payload, cached);
      } catch (error) {
        // 继续尝试临时输入密码。
      }
    }
    const opened = await promptUnlock(payload, { temporary: true });
    if (!opened) {
      const error = new Error('已取消解锁历史版本');
      error.code = 'unlock_cancelled';
      throw error;
    }
    return opened.payload;
  }

  function renderRevisionPreview(revision, payload) {
    const summary = summarizeRevision(payload);
    dom.revisionPreview.hidden = false;
    dom.revisionPreviewTitle.textContent = `版本 ${revision.revision} · ${formatTime(revision.createdAt)} · ${formatBytes(revision.size)}`;
    dom.revisionPreviewBody.textContent = `${summary.groups.length} 个分组 · ${summary.links} 条链接`;
    dom.revisionPreviewGroups.innerHTML = summary.groups
      .slice(0, 20)
      .map((group) => `<span class="revision-chip">${escapeHTML(group.name)}</span>`)
      .join('');
  }

  function renderRevisions() {
    if (!dom.revisionsList) return;
    if (!state.revisions.length) {
      dom.revisionsList.innerHTML = '<p class="group-empty">还没有历史版本；完成一次同步后就会出现。</p>';
      return;
    }
    dom.revisionsList.innerHTML = state.revisions
      .map(
        (item) => `<div class="sync-item">
          <span class="sync-item-copy">
            <strong>版本 ${item.revision}</strong>
            <small>${escapeHTML(formatTime(item.createdAt))} · ${escapeHTML(formatBytes(item.size))}</small>
          </span>
          <button class="btn btn-small" type="button" data-revision-preview="${item.revision}">预览</button>
          <button class="btn btn-small" type="button" data-revision-restore="${item.revision}">恢复</button>
        </div>`
      )
      .join('');
  }

  function showRevisionsError(message) {
    dom.revisionsError.textContent = message;
    dom.revisionsError.hidden = false;
  }

  async function loadRevisions() {
    dom.revisionsError.hidden = true;
    const response = await api('/api/v1/workspace/revisions');
    if (!response.ok) {
      showRevisionsError(apiError(response, '无法读取历史版本'));
      return;
    }
    state.revisions = (response.data && response.data.revisions) || [];
    renderRevisions();
  }

  async function openRevisionsDialog() {
    ensureDialogs();
    if (!sync.user) {
      showToast('登录后才能查看云端历史版本');
      return;
    }
    state.revisions = [];
    dom.revisionsList.innerHTML = '<p class="group-empty">加载中…</p>';
    dom.revisionPreview.hidden = true;
    dom.revisionsError.hidden = true;
    dom.revisionsDialog.showModal();
    await loadRevisions();
  }

  async function fetchRevision(revision) {
    const response = await api('/api/v1/workspace/revisions/' + encodeURIComponent(revision));
    if (!response.ok) {
      throw new Error(apiError(response, '无法读取这个历史版本'));
    }
    return response.data;
  }

  async function previewRevision(revision) {
    dom.revisionsError.hidden = true;
    try {
      const item = await fetchRevision(revision);
      const payload = await decodeHistoricalPayload(item.payload);
      const known = state.revisions.find((entry) => entry.revision === Number(revision)) || item;
      renderRevisionPreview(known, payload);
    } catch (error) {
      if (error && error.code === 'unlock_cancelled') return;
      showRevisionsError((error && error.message) || '预览失败');
    }
  }

  async function restoreRevision(revision) {
    dom.revisionsError.hidden = true;
    const confirmed = await askConfirm({
      title: '恢复历史版本',
      message: `确定恢复到版本 ${revision}？恢复前会先在本机保存一份当前数据快照，然后用当前 revision 上传。`,
      confirmText: '恢复',
    });
    if (!confirmed) return;

    try {
      const item = await fetchRevision(revision);
      const payload = await decodeHistoricalPayload(item.payload);
      const restored = stampAll(normalizeData(payload));
      saveSnapshot('before-restore');
      setData(restored);
      commitLocalChange();
      await syncNow({ manual: true });
      if (sync.status === 'error' || sync.status === 'paused') {
        showRevisionsError('已应用到本机，但上传没有完成；请查看同步状态后重试');
      } else {
        showToast(`已恢复版本 ${revision}`);
      }
      await loadRevisions();
    } catch (error) {
      if (error && error.code === 'unlock_cancelled') return;
      showRevisionsError((error && error.message) || '恢复失败');
    }
  }


    return { openRevisionsDialog, previewRevision, restoreRevision, loadRevisions };
  }

  return { create };
});
