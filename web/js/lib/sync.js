/* ==========================================================================
 * 氢导航 · 同步引擎
 *
 * 本地修改标记、800ms 防抖上传、revision 冲突合并、云端拉取、会话失效降级。
 * 通过 create(deps) 注入存储、状态与 UI 回调，避免 app.js 继续膨胀。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(deps) {
    const {
      dom,
      prefs,
      sync,
      state,
      cryptoState,
      api,
      apiError,
      autoSyncAllowed,
      SYNC_DEBOUNCE,
      now,
      normalizeData,
      mergeDocuments,
      enforceLimits,
      countLinks,
      countGroups,
      persist,
      render,
      renderClock,
      saveSnapshot,
      showToast,
      writeSyncMeta,
      writeGuestDirty,
      updateSyncUI,
      updateSnapshotButton,
      decodePayload,
      payloadForUpload,
      ensureUnlockedForPush,
      putWorkspacePayload,
      syncScopedData,
      ensureDialogs,
      escapeHTML,
      buildMergeDiff,
      setStatus,
      broadcast,
      signOutLocally,
      openAccountDialog,
      getData,
      setData,
    } = deps;

  function markDirty() {
    if (sync.user) {
      sync.editSeq += 1;
      sync.dirty = true;
      writeSyncMeta();
      setStatus(sync.online ? 'dirty' : 'offline');
      scheduleSync();
    } else {
      sync.guestDirty = true;
      writeGuestDirty(true);
    }
  }

  function commitLocalChange() {
    persist();
    markDirty();
    broadcastChange();
    render();
    renderClock();
  }

  function broadcastChange() {
    broadcast({ type: 'data-changed', userId: sync.user ? sync.user.id : null });
  }

  function scheduleSync(delay = SYNC_DEBOUNCE) {
    if (!sync.user || prefs.autoSync === false) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => {
      syncNow();
    }, delay);
  }

  function workspaceETag(revision) {
    return revision == null ? null : `"w-${revision}"`;
  }

  // 加密账号在新标签页必须先拿到 envelope 才能解锁；只有已经知道文档是
  // 明文，或当前标签页已有 envelope 时，才允许用 revision 走 304。
  function workspacePullETag() {
    if (sync.revision == null) return null;
    if (sync.encrypted && !cryptoState.envelope) return null;
    return workspaceETag(sync.revision);
  }

  async function reconcile() {
    if (!sync.user || sync.inFlight) return;

    sync.inFlight = true;
    updateSyncUI();
    const sessionSeq = sync.sessionSeq;
    setStatus('syncing');
    try {
      const response = await api('/api/v1/workspace', { etag: workspacePullETag() });
      if (sessionSeq !== sync.sessionSeq) return;

      if (response.status === 304) {
        if (sync.dirty) {
          await pushWithRetries(sync.revision);
          return;
        }
        sync.lastSyncedAt = now();
        writeSyncMeta();
        setStatus('synced');
        return;
      }

    if (response.status === 401) {
      await handleAuthLost();
      return;
    }
    if (!response.ok) {
      setStatus(response.networkError || !sync.online ? 'offline' : 'error');
      return;
    }

    const revision = response.data.revision;

      if (revision === 0) {
        sync.revision = 0;
        await pushWithRetries(0);
        return;
      }

    // 有本地未推送修改时，冲突处理需要原始 envelope 自己解码一次；
    // 先解码再把明文传进去会触发“未加密”分支，破坏加密状态。
    if (sync.dirty) {
      if (sync.revision === revision) {
        await pushWithRetries(revision);
      } else {
        await resolveConflict(response.data.payload, revision);
      }
      return;
    }

    let cloud;
    try {
      cloud = await decodePayload(response.data.payload);
    } catch (error) {
      if (error && error.code === 'unlock_cancelled') {
        setStatus('paused');
        return;
      }
      setStatus('error');
      showToast('无法解密云端数据，请重试');
      return;
    }
    if (sessionSeq !== sync.sessionSeq) return;
    sync.cloudData = normalizeData(cloud);

    if (!sync.hasLocal) {
      adoptCloud(cloud, revision, { silent: false });
      return;
    }

    if (sync.revision !== revision) {
      adoptCloud(cloud, revision, { silent: false });
      return;
    }

      writeSyncMeta();
      setStatus('synced');
    } finally {
      sync.inFlight = false;
      updateSyncUI();
    }
  }

  async function pushWorkspace(baseRevision) {
    const sessionSeq = sync.sessionSeq;
    if (!(await ensureUnlockedForPush())) {
      if (sessionSeq !== sync.sessionSeq) return { stale: true };
      setStatus('paused');
      return { paused: true };
    }
    if (sessionSeq !== sync.sessionSeq) return { stale: true };

    const editSeq = sync.editSeq;
    const payload = await payloadForUpload();
    if (sessionSeq !== sync.sessionSeq) return { stale: true };
    const response = await putWorkspacePayload(payload, baseRevision);
    if (sessionSeq !== sync.sessionSeq) return { stale: true };

    if (response.ok) {
      if (cryptoState.enabled && QingdhCrypto.isEncrypted(payload)) {
        cryptoState.envelope = payload;
      }
      // 上传期间可能又发生了编辑；只有代次未变才允许清除 dirty。
      const pending = sync.editSeq !== editSeq;
      sync.revision = response.data.revision;
      sync.cloudData = syncScopedData();
      sync.dirty = pending;
      sync.hasLocal = true;
      sync.lastSyncedAt = now();
      writeSyncMeta();
      if (!pending) writeGuestDirty(false);
      if (pending) {
        setStatus(sync.online ? 'dirty' : 'offline');
        scheduleSync(0);
      } else {
        setStatus('synced');
      }
      persist();
      broadcastChange();
      return { ok: true, pending };
    }

    if (response.status === 401) {
      await handleAuthLost();
      return { auth: true };
    }
    if (response.status === 409 && response.data && response.data.current) {
      return { conflict: response.data.current };
    }
    if (response.networkError || !sync.online) {
      setStatus('offline');
      return { offline: true };
    }

    setStatus('error');
    showToast(apiError(response, '同步失败'));
    return { error: true };
  }

  async function pushWithRetries(baseRevision) {
    let base = baseRevision;
    const sessionSeq = sync.sessionSeq;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await pushWorkspace(base);
      if (result.stale) return;
      if (result.ok) {
        // pushWorkspace 内部已经安排了后续同步；这里只负责退出循环。
        return;
      }
      if (result.auth || result.offline || result.error) return;

      const current = result.conflict;
      let cloud;
      try {
        cloud = await decodePayload(current.payload);
      } catch (error) {
        if (error && error.code === 'unlock_cancelled') {
          setStatus('paused');
          return;
        }
        setStatus('error');
        showToast('无法解密云端数据，请重试');
        return;
      }

      sync.cloudData = normalizeData(cloud);
      const choice = await askMerge({
        local: getData(),
        cloud: normalizeData(cloud),
      });
      if (sessionSeq !== sync.sessionSeq) return;

      if (choice === 'merge') {
        const merged = mergeDocuments(getData(), normalizeData(cloud));
        setData(merged);
        const dropped = enforceLimits(merged);
        if (dropped > 0) showToast(`数据超过上限，已省略 ${dropped} 项`);
        persist();
        render();
        sync.dirty = true;
        base = current.revision;
        continue;
      }
      if (choice === 'cloud') {
        adoptCloud(cloud, current.revision, { silent: false });
        return;
      }
      if (choice === 'local') {
        base = current.revision;
        continue;
      }
      setStatus('paused');
      return;
    }
    setStatus('error');
    showToast('多次冲突，请稍后重试');
  }

  async function resolveConflict(cloudPayload, revision) {
    const sessionSeq = sync.sessionSeq;
    let plain;
    try {
      plain = await decodePayload(cloudPayload);
    } catch (error) {
      if (error && error.code === 'unlock_cancelled') {
        setStatus('paused');
        return;
      }
      setStatus('error');
      showToast('无法解密云端数据，请重试');
      return;
    }
    if (sessionSeq !== sync.sessionSeq) return;
    sync.cloudData = normalizeData(plain);

    const choice = await askMerge({
      local: getData(),
      cloud: normalizeData(plain),
    });
    if (sessionSeq !== sync.sessionSeq) return;

    if (choice === 'merge') {
      const merged = mergeDocuments(getData(), normalizeData(plain));
      setData(merged);
      const dropped = enforceLimits(merged);
      if (dropped > 0) showToast(`数据超过上限，已省略 ${dropped} 项`);
      persist();
      render();
      sync.dirty = true;
      await pushWithRetries(revision);
      return;
    }
    if (choice === 'cloud') {
      adoptCloud(plain, revision, { silent: false });
      return;
    }
    if (choice === 'local') {
      await pushWithRetries(revision);
      return;
    }
    setStatus('paused');
  }

  async function syncNow({ pullOnly = false, manual = false } = {}) {
    if (!sync.user || sync.inFlight) return;
    // 自动同步关闭后，focus/可见性/联网等事件触发的同步一律跳过；
    // 手动同步和用户主动操作（解锁、导出、开启加密等）仍然可用。
    if (!autoSyncAllowed(prefs, { manual })) return;
    sync.inFlight = true;
    const sessionSeq = sync.sessionSeq;
    updateSyncUI();

    try {
      if (sync.dirty && !pullOnly) {
        await pushWithRetries(sync.revision == null ? 0 : sync.revision);
        return;
      }

      setStatus('syncing');
      const response = await api('/api/v1/workspace', { etag: workspacePullETag() });
      if (sessionSeq !== sync.sessionSeq) return;
      if (response.status === 304) {
        sync.lastSyncedAt = now();
        writeSyncMeta();
        setStatus('synced');
        return;
      }
      if (response.status === 401) {
        await handleAuthLost();
        return;
      }
      if (!response.ok) {
        setStatus(response.networkError || !sync.online ? 'offline' : 'error');
        return;
      }

      const revision = response.data.revision;
      if (revision !== sync.revision) {
        if (sync.dirty) {
          await resolveConflict(response.data.payload, revision);
        } else {
          let cloud;
          try {
            cloud = await decodePayload(response.data.payload);
          } catch (error) {
            if (error && error.code === 'unlock_cancelled') {
              setStatus('paused');
              return;
            }
            setStatus('error');
            showToast('无法解密云端数据，请重试');
            return;
          }
          sync.cloudData = normalizeData(cloud);
          adoptCloud(cloud, revision, { silent: false });
        }
      } else {
        sync.lastSyncedAt = now();
        writeSyncMeta();
        setStatus('synced');
      }
    } finally {
      sync.inFlight = false;
      updateSyncUI();
    }
  }

  function adoptCloud(cloud, revision, { silent = false } = {}) {
    const current = getData();
    if (countLinks(current) > 0 || countGroups(current) > 0) saveSnapshot('before-cloud');
    const incoming = normalizeData(cloud);
    sync.cloudData = incoming;
    const next = normalizeData(incoming);
    if (prefs.syncScope.groups === false) next.groups = current.groups;
    if (prefs.syncScope.settings === false) next.settings = current.settings;
    setData(normalizeData(next));
    sync.revision = revision;
    sync.dirty = false;
    sync.hasLocal = true;
    sync.lastSyncedAt = now();
    persist();
    writeSyncMeta();
    writeGuestDirty(false);
    render();
    renderClock();
    updateSnapshotButton();
    setStatus('synced');
    broadcastChange();
    if (!silent) showToast('已从云端更新数据');
  }

  async function handleAuthLost() {
    // Keep the cached account data and its dirty flag, then fall back to guest
    // mode. Logging in again resumes from the cache.
    persist();
    writeSyncMeta();
    await signOutLocally({ clearVault: false });
    showToast('登录已过期，请重新登录', {
      actionLabel: '去登录',
      onAction: () => openAccountDialog(),
    });
  }

  /* ------------------------------------------------------------------ *
   * 合并
   * ------------------------------------------------------------------ */

  function mergeDiffList(items, formatter, limit = 3) {
    if (!items.length) return '';
    return `<li>${items.slice(0, limit).map(formatter).join('、')}${
      items.length > limit ? ` 等 ${items.length} 项` : ''
    }</li>`;
  }

  function renderMergeDiff(local, cloud) {
    const diff = buildMergeDiff(local, cloud);
    if (!dom.mergeDiff) return;
    const lines = [];
    if (diff.localOnly.length) {
      lines.push(`本地新增：${diff.localOnly.length} 项`);
    }
    if (diff.cloudOnly.length) {
      lines.push(`云端新增：${diff.cloudOnly.length} 项`);
    }
    if (diff.modified.length) {
      lines.push(`两边都有但内容不同：${diff.modified.length} 项`);
    }
    if (diff.locallyDeleted.length) {
      lines.push(`本地已删除、云端仍存在：${diff.locallyDeleted.length} 项`);
    }
    if (diff.cloudDeleted.length) {
      lines.push(`云端已删除、本地仍存在：${diff.cloudDeleted.length} 项`);
    }
    if (diff.localGroups.length) lines.push(`本地独有分组：${diff.localGroups.length} 个`);
    if (diff.cloudGroups.length) lines.push(`云端独有分组：${diff.cloudGroups.length} 个`);
    if (diff.settings) lines.push('站点设置不同');

    const details = [];
    details.push(
      mergeDiffList(diff.localOnly, (item) => escapeHTML(item.title), 3)
    );
    details.push(
      mergeDiffList(diff.cloudOnly, (item) => escapeHTML(item.title), 3)
    );
    details.push(
      mergeDiffList(
        diff.modified,
        (item) => `${escapeHTML(item.local.title)}（${escapeHTML(item.local.group)} → ${escapeHTML(
          item.cloud.group
        )}）`,
        2
      )
    );
    dom.mergeDiff.innerHTML = lines.length
      ? `<p class="merge-diff-summary">差异摘要</p><ul>${lines
          .map((line) => `<li>${line}</li>`)
          .join('')}</ul>${details.filter(Boolean).join('') ? `<ul class="merge-diff-detail">${details
          .filter(Boolean)
          .join('')}</ul>` : ''}`
      : '<p class="merge-diff-empty">两边内容基本一致，只是版本号不同。</p>';
  }

  function askMerge({ local, cloud }) {
    ensureDialogs();
    if (state.mergeResolver) settleMerge('later');

    const localLinks = new Set(
      normalizeData(local).groups.flatMap((group) =>
        group.links.filter((link) => !link.deletedAt).map((link) => link.url)
      )
    ).size;
    const cloudLinks = new Set(
      normalizeData(cloud).groups.flatMap((group) =>
        group.links.filter((link) => !link.deletedAt).map((link) => link.url)
      )
    ).size;
    dom.mergeMessage.textContent = `本地 ${localLinks} 个链接，云端 ${cloudLinks} 个链接。请先查看差异，再选择处理方式。`;
    renderMergeDiff(local, cloud);
    dom.mergeDialog.showModal();

    return new Promise((resolve) => {
      state.mergeResolver = resolve;
    });
  }

  function settleMerge(choice) {
    if (!state.mergeResolver) return;
    const resolve = state.mergeResolver;
    state.mergeResolver = null;
    if (dom.mergeDialog.open) dom.mergeDialog.close();
    resolve(choice);
  }

  /* ------------------------------------------------------------------ *
   * 快捷方式编辑
   * ------------------------------------------------------------------ */


    return {
      markDirty,
      commitLocalChange,
      broadcastChange,
      scheduleSync,
      reconcile,
      pushWithRetries,
      syncNow,
      adoptCloud,
      resolveConflict,
      handleAuthLost,
      askMerge,
      settleMerge,
      renderMergeDiff,
    };
  }

  return { create };
});
