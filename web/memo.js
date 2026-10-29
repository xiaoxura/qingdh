/* ==========================================================================
 * 氢导航 · 加密备忘录
 *
 * 数据始终以 v4 secret(kind='memo') 密文上传；服务端和管理员看不到内容。
 * 明文只在内存里，不写入 localStorage；退出登录 / 锁定后清空。
 * ========================================================================== */

(() => {
  'use strict';

  const MAX_MEMOS = 500;
  const MAX_BODY = 50000;
  const MAX_BUDGET_BYTES = 360 * 1024;
  const MAX_TITLE = 80;
  const MAX_TAGS = 8;
  const MAX_TAG = 20;
  // 空闲 1.6s 合并保存；持续输入时最多等 5s 就必须落一次盘。
  const SAVE_DEBOUNCE = 1600;
  const SAVE_MAX_WAIT = 5000;
  const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;
  const CHANNEL_NAME = 'qingdh-memo';
  const NOTIFIED_KEY = 'qingdh.memo.notified.v1';
  const REMINDER_CHECK_MS = 30000;
  const LOCAL_DB_NAME = 'qingdh.memo.local.v1';

  const deps = {
    escapeHTML: (value) => String(value),
    uid: () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
    formatTime: (value) => new Date(value).toLocaleString(),
    toast: () => {},
    confirm: async () => false,
    openAccountDialog: () => {},
    openSettings: () => {},
    currentUser: () => null,
    isEncrypted: () => false,
    hasDataKey: () => false,
    ensureDataKey: async () => false,
    onCount: () => {},
    onOpenChange: () => {},
  };

  const state = {
    open: false,
    loaded: false,
    loading: false,
    memos: [],
    selectedId: null,
    query: '',
    filter: 'all',
    activeTag: '',
    organizing: false,
    selectedIds: new Set(),
    batchBusy: false,
    accountKey: '',
    dirty: false,
    saving: false,
    pending: false,
    saveTimer: null,
    saveDeadline: 0,
    syncState: 'idle',
    mode: '',
    readingPane: false,
    captureDiscard: false,
    preview: false,
    budgetWarned: false,
    capacityWarned: false,
    // 生命周期代次：锁定/退出后，旧的异步加载或保存结果不得写回。
    epoch: 0,
  };

  let dom = null;
  let channel = null;

  function $(id) {
    return document.getElementById(id);
  }

  function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function init(nextDeps) {
    if (nextDeps) Object.assign(deps, nextDeps);

    dom = {
      view: $('memo-view'),
      close: $('memo-close'),
      newBtn: $('memo-new'),
      sync: $('memo-sync'),
      search: $('memo-search'),
      filter: $('memo-filter'),
      tagbar: $('memo-tagbar'),
      list: $('memo-list'),
      emptyList: $('memo-empty-list'),
      lockedNote: $('memo-locked-note'),
      empty: $('memo-empty'),
      editor: $('memo-editor'),
      back: $('memo-back'),
      title: $('memo-title'),
      meta: $('memo-meta'),
      body: $('memo-body'),
      tags: $('memo-tags'),
      tagInput: $('memo-tag-input'),
      pin: $('memo-pin'),
      archive: $('memo-archive'),
      remove: $('memo-delete'),
      saveState: $('memo-save-state'),
      capacity: $('memo-capacity'),
      previewToggle: $('memo-preview-toggle'),
      preview: $('memo-preview'),
      remind: $('memo-remind'),
      remindClear: $('memo-remind-clear'),
      backlinks: $('memo-backlinks'),
      exportMd: $('memo-export-md'),
      exportJson: $('memo-export-json'),
      captureDialog: $('memo-capture-dialog'),
      captureBody: $('memo-capture-body'),
      captureSave: $('memo-capture-save'),
    };
    if (!dom.view) return;

    initBatchUI();

    dom.close.addEventListener('click', close);
    dom.newBtn.addEventListener('click', () => {
      const memo = createMemo();
      if (memo) selectMemo(memo.id, { focusTitle: true });
    });

    dom.search.addEventListener('input', () => {
      state.query = dom.search.value.trim().toLowerCase();
      renderList();
    });
    dom.filter.addEventListener('change', () => {
      state.filter = dom.filter.value;
      renderList();
    });

    dom.list.addEventListener('click', (event) => {
      if (state.organizing) return;
      const item = event.target.closest('[data-memo-id]');
      if (!item) return;
      selectMemo(item.dataset.memoId);
    });
    dom.list.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-batch-memo-id]');
      if (!checkbox || !state.organizing || state.batchBusy || state.loading) return;
      if (checkbox.checked) state.selectedIds.add(checkbox.dataset.batchMemoId);
      else state.selectedIds.delete(checkbox.dataset.batchMemoId);
      checkbox.closest('.memo-item').classList.toggle('is-selected', checkbox.checked);
      renderBatchUI();
    });

    dom.tagbar.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-tag]');
      if (!chip) return;
      state.activeTag = state.activeTag === chip.dataset.tag ? '' : chip.dataset.tag;
      renderTagbar();
      renderList();
    });

    dom.back.addEventListener('click', () => {
      state.readingPane = false;
      document.body.classList.remove('memo-editing');
    });

    dom.title.addEventListener('input', onTitleInput);
    dom.body.addEventListener('input', onBodyInput);

    dom.tagInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
        event.preventDefault();
        addTag(dom.tagInput.value);
      } else if (event.key === 'Backspace' && !dom.tagInput.value) {
        const memo = currentMemo();
        if (memo && memo.tags.length) {
          memo.tags.pop();
          touch(memo);
        }
      }
    });

    dom.tags.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-tag]');
      if (!button) return;
      const memo = currentMemo();
      if (!memo) return;
      memo.tags = memo.tags.filter((tag) => tag !== button.dataset.removeTag);
      touch(memo);
    });

    dom.pin.addEventListener('click', () => {
      const memo = currentMemo();
      if (!memo) return;
      memo.pinned = !memo.pinned;
      touch(memo);
    });

    dom.archive.addEventListener('click', () => {
      const memo = currentMemo();
      if (!memo) return;
      memo.archived = !memo.archived;
      if (memo.archived) {
        deps.toast('已归档');
      }
      touch(memo);
    });

    dom.remove.addEventListener('click', () => removeMemo());

    dom.previewToggle.addEventListener('click', togglePreview);
    dom.preview.addEventListener('click', onPreviewClick);
    dom.remind.addEventListener('change', onRemindChange);
    dom.remindClear.addEventListener('click', clearReminder);
    dom.backlinks.addEventListener('click', (event) => {
      const button = event.target.closest('[data-memo-id]');
      if (button) selectMemo(button.dataset.memoId);
    });
    dom.exportMd.addEventListener('click', exportMarkdown);
    dom.exportJson.addEventListener('click', exportJSON);

    setInterval(checkReminders, REMINDER_CHECK_MS);

    dom.captureSave.addEventListener('click', () => {
      state.captureDiscard = false;
      saveCapture();
    });
    dom.captureDialog.addEventListener('close', () => {
      if (!state.captureDiscard) saveCapture({ closing: true });
      state.captureDiscard = false;
      dom.captureBody.value = '';
    });
    dom.captureDialog.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        state.captureDiscard = true;
        dom.captureDialog.close();
      });
    });
    dom.captureBody.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        saveCapture();
      }
    });

    setupChannel();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    });
    window.addEventListener('pagehide', flushPendingSave);
    renderLocked();
    setSyncState('idle');
  }

  function initBatchUI() {
    const toolbar = document.createElement('div');
    toolbar.className = 'memo-batch-toolbar';
    toolbar.innerHTML = `
      <button class="btn btn-small" type="button" data-batch-action="enter">整理</button>
      <div class="memo-batch-controls" hidden>
        <span class="memo-batch-count" role="status" aria-live="polite">已选 0 条</span>
        <button class="btn btn-small" type="button" data-batch-action="all" aria-pressed="false">全选当前筛选</button>
        <button class="btn btn-small" type="button" data-batch-action="cancel">退出</button>
      </div>
      <div class="memo-batch-actions" hidden>
        <button class="btn btn-small" type="button" data-batch-action="archive">归档</button>
        <button class="btn btn-small" type="button" data-batch-action="unarchive">取消归档</button>
        <button class="btn btn-small" type="button" data-batch-action="tag">添加标签</button>
        <button class="btn btn-small btn-quiet-danger" type="button" data-batch-action="delete">删除</button>
      </div>`;
    dom.tagbar.before(toolbar);
    dom.batchToolbar = toolbar;
    dom.batchEnter = toolbar.querySelector('[data-batch-action="enter"]');
    dom.search.parentElement.appendChild(dom.batchEnter);
    dom.batchEnter.addEventListener('click', enterBatchMode);
    dom.batchControls = toolbar.querySelector('.memo-batch-controls');
    dom.batchActions = toolbar.querySelector('.memo-batch-actions');
    dom.batchCount = toolbar.querySelector('.memo-batch-count');
    dom.batchAll = toolbar.querySelector('[data-batch-action="all"]');

    const dialog = document.createElement('dialog');
    dialog.className = 'memo-batch-dialog';
    dialog.setAttribute('aria-labelledby', 'memo-batch-dialog-title');
    dialog.innerHTML = `
      <form class="memo-batch-form" novalidate>
        <div class="dialog-head">
          <h2 id="memo-batch-dialog-title">批量添加标签</h2>
          <button class="icon-close" type="button" data-batch-close aria-label="关闭">×</button>
        </div>
        <div class="dialog-body">
          <label class="memo-batch-field" for="memo-batch-tag">标签</label>
          <input id="memo-batch-tag" type="text" maxlength="20" autocomplete="off" />
          <p class="memo-batch-error" role="alert" hidden></p>
          <p class="dialog-note">为已选备忘录添加同一个标签，已有标签不会重复添加。</p>
        </div>
        <div class="dialog-foot">
          <button class="btn" type="button" data-batch-close>取消</button>
          <button class="btn btn-primary" type="submit">添加标签</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    dom.batchDialog = dialog;
    dom.batchTag = dialog.querySelector('#memo-batch-tag');
    dom.batchError = dialog.querySelector('.memo-batch-error');
    dom.batchSubmit = dialog.querySelector('[type="submit"]');

    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-batch-action]');
      if (!button) return;
      const action = button.dataset.batchAction;
      if (action === 'enter') enterBatchMode();
      else if (action === 'cancel') exitBatchMode();
      else if (action === 'all') toggleFilteredSelection();
      else if (action === 'tag') openBatchTagDialog();
      else batchChange(action);
    });
    dialog.querySelectorAll('[data-batch-close]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!state.batchBusy) dialog.close();
      });
    });
    dialog.addEventListener('cancel', (event) => {
      if (state.batchBusy) event.preventDefault();
    });
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      batchChange('tag', dom.batchTag.value);
    });
    dialog.addEventListener('close', () => {
      dom.batchTag.value = '';
      showBatchError('');
      if (state.open && state.organizing) toolbar.querySelector('[data-batch-action="tag"]').focus();
    });
    renderBatchUI();
  }

  function currentAccountKey() {
    const user = deps.currentUser();
    return `${useLocalMode() ? 'local' : 'cloud'}:${user ? user.id : 'guest'}`;
  }

  function enterBatchMode() {
    if (!state.loaded || state.loading || state.accountKey !== currentAccountKey()) return;
    state.organizing = true;
    state.selectedIds.clear();
    state.readingPane = false;
    document.body.classList.remove('memo-editing');
    renderList();
    renderBatchUI();
    dom.batchAll.focus();
  }

  function exitBatchMode() {
    if (state.batchBusy) return;
    if (dom.batchDialog && dom.batchDialog.open) dom.batchDialog.close();
    state.organizing = false;
    state.selectedIds.clear();
    renderList();
    renderBatchUI();
    if (state.open) dom.batchEnter.focus();
  }

  function selectedMemos() {
    return visibleMemos().filter((memo) => state.selectedIds.has(memo.id));
  }

  function toggleFilteredSelection() {
    if (!state.organizing || state.batchBusy || state.loading) return;
    const ids = filteredMemos().map((memo) => memo.id);
    if (!ids.length) return;
    const allSelected = ids.every((id) => state.selectedIds.has(id));
    ids.forEach((id) => {
      if (allSelected) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
    });
    renderList();
    renderBatchUI();
    dom.batchAll.focus();
  }

  function renderBatchUI() {
    if (!dom || !dom.batchToolbar) return;
    const active = state.organizing && state.loaded;
    dom.batchEnter.hidden = active;
    dom.batchEnter.disabled = !state.loaded || state.loading;
    dom.batchControls.hidden = !active;
    dom.batchToolbar.hidden = !active;
    dom.batchActions.hidden = !active;
    dom.batchTag.disabled = state.batchBusy;
    dom.batchSubmit.disabled = state.batchBusy || state.loading;
    dom.editor.inert = state.batchBusy;
    dom.newBtn.disabled = state.batchBusy;
    dom.batchDialog.querySelectorAll('[data-batch-close]').forEach((button) => {
      button.disabled = state.batchBusy;
    });
    if (!active) return;
    const selected = selectedMemos().length;
    const filtered = filteredMemos();
    const allSelected = filtered.length > 0 && filtered.every((memo) => state.selectedIds.has(memo.id));
    dom.batchCount.textContent = `已选 ${selected} 条`;
    dom.batchAll.textContent = allSelected ? '取消全选当前筛选' : '全选当前筛选';
    dom.batchAll.setAttribute('aria-pressed', String(allSelected));
    dom.batchAll.disabled = state.batchBusy || state.loading || filtered.length === 0;
    dom.batchControls.querySelector('[data-batch-action="cancel"]').disabled = state.batchBusy;
    dom.batchActions.querySelectorAll('button').forEach((button) => {
      button.disabled = state.batchBusy || state.loading || selected === 0;
    });
    dom.list.querySelectorAll('[data-batch-memo-id]').forEach((checkbox) => {
      checkbox.disabled = state.batchBusy || state.loading;
    });
  }

  function showBatchError(message) {
    dom.batchError.textContent = message;
    dom.batchError.hidden = !message;
  }

  function openBatchTagDialog() {
    if (!state.organizing || !selectedMemos().length || state.batchBusy || state.loading) return;
    dom.batchTag.value = '';
    showBatchError('');
    dom.batchDialog.showModal();
    dom.batchTag.focus();
  }

  async function batchChange(action, rawTag = '') {
    if (!state.loaded || !state.organizing || state.batchBusy || state.accountKey !== currentAccountKey()) return;
    if (state.loading) {
      deps.toast('正在读取备忘录，请稍后重试');
      return;
    }
    let selected = selectedMemos();
    if (!selected.length) return;
    if (state.saving) {
      deps.toast('正在保存，请稍后重试');
      return;
    }
    const tag = String(rawTag || '').trim();
    if (action === 'tag') {
      if (!tag) {
        showBatchError('请输入标签');
        dom.batchTag.focus();
        return;
      }
      if (tag.length > MAX_TAG) {
        showBatchError(`标签最多 ${MAX_TAG} 字`);
        dom.batchTag.focus();
        return;
      }
      if (selected.some((memo) => !memo.tags.includes(tag) && memo.tags.length >= MAX_TAGS)) {
        showBatchError(`部分备忘录已有 ${MAX_TAGS} 个标签，请调整选择`);
        dom.batchTag.focus();
        return;
      }
    } else if (action === 'delete') {
      if (selected.some((memo) => memo.id === state.selectedId) && dom.tagInput.value.trim()) {
        deps.toast('当前编辑项有尚未添加的标签，请先处理后再删除');
        return;
      }
      const epoch = state.epoch;
      const accountKey = state.accountKey;
      const confirmed = await deps.confirm({
        title: '批量删除备忘录',
        message: `确定删除选中的 ${selected.length} 条备忘录吗？${selected.some((memo) => memo.id === state.selectedId) ? '其中包含当前正在编辑的备忘录。' : ''}${state.mode === 'local' ? '只删除本机备忘录。' : '删除会同步到其他设备。'}`,
        confirmText: `删除 ${selected.length} 条`,
      });
      if (!confirmed || epoch !== state.epoch || accountKey !== currentAccountKey() || !state.organizing) return;
      if (state.loading) {
        deps.toast('正在读取备忘录，请稍后重试');
        return;
      }
      selected = selectedMemos();
      if (!selected.length || state.saving) return;
    } else if (action !== 'archive' && action !== 'unarchive') {
      return;
    }

    const changed = selected.filter((memo) =>
      action === 'archive' ? !memo.archived
        : action === 'unarchive' ? memo.archived
          : action === 'tag' ? !memo.tags.includes(tag) : true
    );
    if (!changed.length) {
      if (action === 'tag') showBatchError('已选备忘录都已有该标签');
      else deps.toast('已选备忘录无需更改');
      return;
    }
    const ids = new Set(changed.map((memo) => memo.id));
    const timestamp = deps.now();
    const next = state.memos.map((memo) => {
      if (!ids.has(memo.id)) return memo;
      const copy = { ...memo, tags: [...memo.tags], updatedAt: timestamp };
      if (action === 'archive') copy.archived = true;
      else if (action === 'unarchive') copy.archived = false;
      else if (action === 'tag' && !copy.tags.includes(tag)) copy.tags.push(tag);
      else if (action === 'delete') {
        copy.deletedAt = timestamp;
        copy.title = '';
        copy.body = '';
        copy.tags = [];
      }
      return copy;
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, memos: pruneTombstones(next) })).length;
    if (bytes > MAX_BUDGET_BYTES) {
      const message = `备忘录总量超过 ${Math.round(MAX_BUDGET_BYTES / 1024)} KiB 存储上限`;
      if (action === 'tag') showBatchError(message);
      else deps.toast(message);
      return;
    }

    const epoch = state.epoch;
    const before = state.memos;
    const beforeById = new Map(before.filter((memo) => ids.has(memo.id)).map((memo) => [memo.id, memo]));
    const batchById = new Map(next.filter((memo) => ids.has(memo.id)).map((memo) => [memo.id, memo]));
    const beforeSelectedId = state.selectedId;
    const wasDirty = state.dirty;
    state.batchBusy = true;
    clearTimeout(state.saveTimer);
    state.memos = next;
    state.dirty = true;
    if (action === 'delete' && ids.has(state.selectedId)) {
      state.selectedId = null;
      state.readingPane = false;
      document.body.classList.remove('memo-editing');
    }
    renderAll();
    updateCount();
    renderBatchUI();
    await saveNow(0, { autoRetry: false });
    if (epoch !== state.epoch || state.accountKey !== currentAccountKey()) return;
    state.batchBusy = false;
    if (state.dirty || state.syncState === 'error' || state.syncState === 'locked') {
      clearTimeout(state.saveTimer);
      const hadPending = state.pending;
      state.pending = false;
      state.memos = state.memos.map((memo) =>
        memo === batchById.get(memo.id) ? beforeById.get(memo.id) : memo
      );
      state.selectedId = state.memos.some((memo) => memo.id === beforeSelectedId && !memo.deletedAt)
        ? beforeSelectedId : null;
      state.dirty = wasDirty || hadPending;
      if (state.dirty) scheduleSave();
      renderAll();
      updateCount();
      const message = '保存失败，批量修改已撤回，请稍后重试';
      if (action === 'tag') showBatchError(message);
      else deps.toast(message);
      renderBatchUI();
      return;
    }
    const applied = changed.filter((memo) => {
      const current = state.memos.find((item) => item.id === memo.id);
      if (!current) return false;
      if (action === 'archive') return current.archived === true && !current.deletedAt;
      if (action === 'unarchive') return current.archived === false && !current.deletedAt;
      if (action === 'tag') return current.tags.includes(tag) && !current.deletedAt;
      return Boolean(current.deletedAt);
    });
    const appliedIds = new Set(applied.map((memo) => memo.id));
    state.selectedIds.clear();
    if (applied.length < changed.length) {
      changed.forEach((memo) => {
        if (!appliedIds.has(memo.id)) state.selectedIds.add(memo.id);
      });
    } else if (action === 'tag' && dom.batchDialog.open) {
      dom.batchDialog.close();
    }
    renderAll();
    updateCount();
    renderBatchUI();
    if (applied.length < changed.length) {
      const message = `已处理 ${applied.length} 条；其余 ${changed.length - applied.length} 条已在其他设备更新，请检查后重试`;
      if (action === 'tag') showBatchError(message);
      else deps.toast(message);
    } else {
      deps.toast(`已${{ archive: '归档', unarchive: '取消归档', tag: '添加标签', delete: '删除' }[action]} ${changed.length} 条备忘录`);
    }
  }

  function setupChannel() {
    if (!('BroadcastChannel' in window)) return;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', () => {
        if (!state.open || state.dirty) return;
        refresh();
      });
    } catch (error) {
      channel = null;
    }
  }

  function broadcast() {
    if (!channel) return;
    try {
      channel.postMessage({ type: 'memo-changed' });
    } catch (error) {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ *
   * 数据
   * ------------------------------------------------------------------ */

  function asString(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const tags = [];
    for (const item of raw) {
      const tag = asString(item).trim().slice(0, MAX_TAG);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
    return tags;
  }

  function normalizeMemo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asString(raw.id).trim();
    if (!id) return null;

    const createdAt = asNumber(raw.createdAt, deps.now());
    const updatedAt = asNumber(raw.updatedAt, createdAt);
    const deletedAt = raw.deletedAt == null ? null : asNumber(raw.deletedAt, updatedAt);

    return {
      id,
      title: asString(raw.title).slice(0, MAX_TITLE),
      body: asString(raw.body).slice(0, MAX_BODY),
      tags: normalizeTags(raw.tags),
      pinned: raw.pinned === true,
      archived: raw.archived === true,
      format: raw.format === 'markdown' ? 'markdown' : 'plain',
      remindAt: raw.remindAt == null ? null : asNumber(raw.remindAt, 0) || null,
      createdAt,
      updatedAt,
      deletedAt,
    };
  }

  function normalizeDocument(plain) {
    const memos = Array.isArray(plain && plain.memos) ? plain.memos : [];
    const out = [];
    const seen = new Set();
    for (const raw of memos) {
      const memo = normalizeMemo(raw);
      if (!memo || seen.has(memo.id)) continue;
      seen.add(memo.id);
      out.push(memo);
    }
    return { version: 1, memos: pruneTombstones(out) };
  }

  function pruneTombstones(memos) {
    const cutoff = deps.now() - TOMBSTONE_TTL;
    return memos.filter((memo) => !memo.deletedAt || memo.deletedAt > cutoff);
  }

  let localDbPromise = null;

  function openLocalDB() {
    if (localDbPromise) return localDbPromise;
    localDbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(fail('local_unavailable', '当前浏览器不支持本机备忘录'));
        return;
      }
      const request = indexedDB.open(LOCAL_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || fail('local_unavailable', '无法打开本机备忘录'));
    });
    return localDbPromise;
  }

  function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbPut(db, store, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || fail('local_unavailable', '本机备忘录写入失败'));
    });
  }

  function idbDelete(db, store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function bytesToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function localCrypto() {
    if (!globalThis.crypto || !crypto.subtle) {
      throw fail('local_unavailable', '当前浏览器不支持本机加密存储');
    }
    return crypto.subtle;
  }

  async function getLocalKey() {
    const db = await openLocalDB();
    let key = await idbGet(db, 'keys', 'local');
    if (!key) {
      key = await (await localCrypto()).generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await idbPut(db, 'keys', 'local', key);
    }
    return key;
  }

  async function loadLocalDoc() {
    const db = await openLocalDB();
    const record = await idbGet(db, 'docs', 'memo');
    if (!record) return { version: 1, memos: [] };
    const key = await getLocalKey();
    const plain = await (await localCrypto()).decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
      key,
      base64ToBytes(record.data)
    );
    return normalizeDocument(JSON.parse(new TextDecoder().decode(plain)));
  }

  async function saveLocalDoc(doc) {
    const key = await getLocalKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await (await localCrypto()).encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(doc))
    );
    const db = await openLocalDB();
    await idbPut(db, 'docs', 'memo', {
      iv: bytesToBase64(iv),
      data: bytesToBase64(data),
      updatedAt: Date.now(),
    });
  }

  async function clearLocalDoc() {
    const db = await openLocalDB();
    await idbDelete(db, 'docs', 'memo');
  }

  function useLocalMode() {
    return !deps.currentUser() || !deps.isEncrypted();
  }

  async function loadLocal() {
    const epoch = state.epoch;
    state.loading = true;
    renderBatchUI();
    setSyncState('loading');
    try {
      const doc = await loadLocalDoc();
      if (epoch !== state.epoch) throw fail('stale', '账号已切换');
      state.mode = 'local';
      const accountKey = currentAccountKey();
      if (state.accountKey !== accountKey) {
        state.selectedIds.clear();
        state.selectedId = null;
        state.organizing = false;
        if (dom.batchDialog.open) dom.batchDialog.close();
      }
      state.accountKey = accountKey;
      state.memos = normalizeDocument(doc).memos;
      state.loaded = true;
      state.loading = false;
      renderBatchUI();
      setSyncState('local');
      updateCount();
      checkReminders();
      return { version: 1, memos: state.memos };
    } catch (error) {
      if (epoch !== state.epoch) throw fail('stale', '账号已切换');
      state.loading = false;
      renderBatchUI();
      setSyncState('error');
      throw error;
    }
  }

  async function load(options = {}) {
    return useLocalMode() ? loadLocal(options) : loadCloud(options);
  }

  async function loadCloud({ force = false } = {}) {
    if (!deps.isEncrypted()) throw fail('encryption_required', '需要先开启数据加密');
    const epoch = state.epoch;
    if (!deps.hasDataKey()) {
      const ok = await deps.ensureDataKey();
      if (!ok) throw fail('locked', '需要先解锁云端数据');
    }
    if (epoch !== state.epoch) throw fail('stale', '账号已切换');

    state.loading = true;
    renderBatchUI();
    setSyncState('loading');
    try {
      const plain = await QingdhSecrets.load('memo', { force });
      if (epoch !== state.epoch) throw fail('stale', '账号已切换');
      const doc = normalizeDocument(plain);
      state.mode = 'cloud';
      const accountKey = currentAccountKey();
      if (state.accountKey !== accountKey) {
        state.selectedIds.clear();
        state.selectedId = null;
        state.organizing = false;
        if (dom.batchDialog.open) dom.batchDialog.close();
      }
      state.accountKey = accountKey;
      state.memos = doc.memos;
      state.loaded = true;
      setSyncState('saved');

      // 登录并开启加密后，把本机备忘录合并到云端，成功后清除本机副本。
      const local = await loadLocalDoc().catch(() => null);
      if (local) {
        const localCount = local.memos.filter((memo) => !memo.deletedAt).length;
        if (localCount > 0) {
          state.memos = mergeDocuments(local.memos, doc.memos);
          state.dirty = true;
          await saveNow();
          if (!state.dirty) {
            await clearLocalDoc().catch(() => {});
            deps.toast(`已把本机 ${localCount} 条备忘录合并到加密云端`);
          }
        } else {
          await clearLocalDoc().catch(() => {});
        }
      }
      state.loading = false;
      renderBatchUI();
      updateCount();
      checkReminders();
      return { version: 1, memos: state.memos };
    } catch (error) {
      if (epoch !== state.epoch) throw fail('stale', '账号已切换');
      state.loading = false;
      renderBatchUI();
      setSyncState(error.code === 'locked' || error.code === 'auth' ? 'locked' : 'error');
      throw error;
    }
  }

  async function ensureReady() {
    const local = useLocalMode();
    const expected = local ? 'local' : 'cloud';
    const accountChanged = state.loaded && state.accountKey !== currentAccountKey();
    if (state.loaded && (state.mode !== expected || accountChanged)) {
      if (accountChanged) {
        state.epoch += 1;
        clearTimeout(state.saveTimer);
        state.dirty = false;
        state.saving = false;
        state.pending = false;
      } else if (state.dirty) {
        try {
          await saveNow();
        } catch (error) {
          // 旧模式的修改已经尽力保存；切换后仍可继续读取。
        }
      }
      state.loaded = false;
      state.memos = [];
      state.selectedId = null;
      state.mode = '';
      state.accountKey = '';
      state.selectedIds.clear();
      state.organizing = false;
    }
    try {
      if (!state.loaded) await load();
      return true;
    } catch (error) {
      if (error.code === 'stale') return false;
      if (local) {
        deps.toast(error.message || '读取本机备忘录失败');
      } else if (error.code === 'locked') {
        deps.toast('解锁云端数据后才能读取备忘录');
      } else if (error.code === 'offline') {
        setSyncState('offline');
        deps.toast('当前离线，备忘录暂时不可用');
      } else {
        deps.toast('读取备忘录失败，请稍后重试');
      }
      renderLocked(error.message);
      return false;
    }
  }

  function currentMemo() {
    if (!state.selectedId) return null;
    return state.memos.find((memo) => memo.id === state.selectedId) || null;
  }

  function visibleMemos() {
    return state.memos.filter((memo) => !memo.deletedAt);
  }

  function activeCount() {
    return visibleMemos().filter((memo) => !memo.archived).length;
  }

  function updateCount() {
    deps.onCount(activeCount());
    renderCapacity();
  }

  function touch(memo) {
    memo.updatedAt = deps.now();
    state.dirty = true;
    scheduleSave();
    renderList();
    renderEditorMeta();
    renderEditorActions();
    updateCount();
  }

  function createMemo({ title = '', body = '' } = {}) {
    if (activeCount() >= MAX_MEMOS) {
      deps.toast(`最多保存 ${MAX_MEMOS} 条备忘录`);
      return null;
    }
    const timestamp = deps.now();
    const memo = {
      id: deps.uid(),
      title: asString(title).slice(0, MAX_TITLE),
      body: asString(body).slice(0, MAX_BODY),
      tags: [],
      pinned: false,
      archived: false,
      format: 'markdown',
      remindAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    state.memos.unshift(memo);
    state.dirty = true;
    scheduleSave();
    updateCount();
    renderList();
    return memo;
  }

  function mergeDocuments(localMemos, cloudMemos) {
    const merged = new Map();
    for (const memo of cloudMemos) merged.set(memo.id, memo);
    for (const memo of localMemos) {
      const other = merged.get(memo.id);
      if (!other) {
        merged.set(memo.id, memo);
        continue;
      }
      const winner = (memo.updatedAt || 0) >= (other.updatedAt || 0) ? memo : other;
      merged.set(memo.id, winner);
    }
    return pruneTombstones(Array.from(merged.values()));
  }

  function scheduleSave(delay = SAVE_DEBOUNCE) {
    clearTimeout(state.saveTimer);
    let wait = delay;
    if (delay === SAVE_DEBOUNCE) {
      const current = deps.now();
      if (!state.saveDeadline) state.saveDeadline = current + SAVE_MAX_WAIT;
      wait = Math.max(0, Math.min(delay, state.saveDeadline - current));
    } else {
      state.saveDeadline = 0;
    }
    state.saveTimer = setTimeout(() => {
      state.saveDeadline = 0;
      saveNow().catch(() => {});
    }, wait);
  }

  // 关闭/切走页面时把防抖窗口内的编辑立即提交，避免“界面显示已保存、
  // 实际最后一次输入丢失”。keepalive 只适用于浏览器限制内的小请求。
  function flushPendingSave() {
    if (!state.loaded || !state.dirty) return Promise.resolve();
    clearTimeout(state.saveTimer);
    state.saveDeadline = 0;
    return saveNow(0, { autoRetry: false, keepalive: true }).catch(() => {});
  }

  async function saveNow(attempt = 0, { autoRetry = true, keepalive = false } = {}) {
    if (!state.loaded || !state.dirty) return;
    if (state.saving) {
      state.pending = true;
      return;
    }

    const epoch = state.epoch;
    const local = state.mode === 'local';
    state.saveDeadline = 0;
    state.saving = true;
    state.pending = false;
    state.dirty = false;
    setSyncState('saving');

    const snapshot = { version: 1, memos: pruneTombstones(state.memos) };
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    const keep = keepalive && bytes <= 60 * 1024;
    if (bytes > MAX_BUDGET_BYTES) {
      state.dirty = true;
      state.saving = false;
      setSyncState('error');
      if (!state.budgetWarned) {
        state.budgetWarned = true;
        deps.toast(`备忘录总量超过 ${Math.round(MAX_BUDGET_BYTES / 1024)} KiB 存储上限，请删除或精简后再保存`);
      }
      return;
    }
    state.budgetWarned = false;
    try {
      if (local) await saveLocalDoc(snapshot);
      else await QingdhSecrets.save('memo', snapshot, { keepalive: keep });
      if (epoch !== state.epoch) return;
      setSyncState(local ? 'local' : 'saved');
      state.lastSavedAt = deps.now();
      renderSaveState();
      broadcast();
    } catch (error) {
      if (epoch !== state.epoch) return;
      if (local) {
        state.dirty = true;
        state.saving = false;
        setSyncState('error');
        if (autoRetry) deps.toast('本机备忘录保存失败，稍后会重试');
        if (autoRetry) scheduleSave(3000);
        return;
      }
      if (error.code === 'conflict' && attempt < 2) {
        try {
          const cloud = await QingdhSecrets.load('memo', { force: true });
          const cloudDoc = normalizeDocument(cloud);
          state.memos = mergeDocuments(snapshot.memos, cloudDoc.memos);
          state.dirty = true;
          state.saving = false;
          setSyncState('saved');
          if (autoRetry) deps.toast('已自动合并另一台设备的修改');
          renderAll();
          await saveNow(attempt + 1, { autoRetry, keepalive });
          return;
        } catch (retryError) {
          state.dirty = true;
          state.saving = false;
          setSyncState(retryError.code === 'locked' ? 'locked' : 'error');
          if (autoRetry) scheduleSave(2000);
          return;
        }
      }
      if (error.code === 'locked' || error.code === 'auth') {
        state.dirty = true;
        state.saving = false;
        setSyncState('locked');
        return;
      }
      state.dirty = true;
      state.saving = false;
      setSyncState('error');
      if (autoRetry) scheduleSave(3000);
      return;
    }

    state.saving = false;
    if (state.pending) {
      state.pending = false;
      await saveNow(attempt, { autoRetry, keepalive });
    }
  }

  async function refresh() {
    if (!state.open || !state.loaded || state.dirty || state.saving || state.batchBusy) return;
    try {
      await load({ force: true });
      renderAll();
    } catch (error) {
      // 保持现有内容，状态栏已经提示。
    }
  }

  function lock() {
    state.epoch += 1;
    clearTimeout(state.saveTimer);
    state.memos = [];
    state.selectedId = null;
    state.selectedIds.clear();
    state.organizing = false;
    state.batchBusy = false;
    state.accountKey = '';
    state.loaded = false;
    state.loading = false;
    state.mode = '';
    state.dirty = false;
    state.saving = false;
    state.pending = false;
    state.query = '';
    state.activeTag = '';
    state.filter = 'all';
    state.readingPane = false;
    state.preview = false;
    state.budgetWarned = false;
    if (dom) {
      dom.title.value = '';
      dom.body.value = '';
      dom.tags.innerHTML = '';
      dom.list.innerHTML = '';
      dom.search.value = '';
      dom.filter.value = 'all';
      dom.emptyList.hidden = true;
      dom.editor.hidden = true;
      dom.empty.hidden = false;
      dom.tagInput.value = '';
      dom.preview.hidden = true;
      dom.body.hidden = false;
      dom.previewToggle.setAttribute('aria-pressed', 'false');
      dom.previewToggle.textContent = '预览';
      dom.backlinks.hidden = true;
      dom.remind.value = '';
      dom.remindClear.hidden = true;
      if (dom.captureDialog.open) dom.captureDialog.close();
      if (dom.batchDialog && dom.batchDialog.open) dom.batchDialog.close();
      renderBatchUI();
    }
    document.body.classList.remove('memo-open', 'memo-editing');
    if (dom && dom.view) dom.view.hidden = true;
    state.open = false;
    deps.onOpenChange(false);
    if (globalThis.QingdhSecrets) QingdhSecrets.forget('memo');
    updateCount();
  }

  /* ------------------------------------------------------------------ *
   * 视图
   * ------------------------------------------------------------------ */

  async function open() {
    if (state.open) return;

    state.open = true;
    document.body.classList.add('memo-open');
    dom.view.hidden = false;
    dom.lockedNote.hidden = true;
    deps.onOpenChange(true);

    const epoch = state.epoch;
    const ready = await ensureReady();
    if (!ready) return;
    if (epoch !== state.epoch || !state.open) return;

    const available = filteredMemos();
    if (!state.selectedId && available.length) {
      const first = available[0];
      state.selectedId = first.id;
    }
    renderAll();
    if (!available.length) dom.search.focus();
  }

  function close() {
    clearTimeout(state.saveTimer);
    if (state.dirty) saveNow().catch(() => {});
    state.organizing = false;
    state.selectedIds.clear();
    if (dom.batchDialog.open) dom.batchDialog.close();
    renderBatchUI();
    state.open = false;
    document.body.classList.remove('memo-open', 'memo-editing');
    dom.view.hidden = true;
    deps.onOpenChange(false);
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function renderLocked(message) {
    if (!dom) return;
    if (state.mode === 'local') {
      dom.lockedNote.innerHTML =
        '<strong>本机备忘录不可用</strong><p>' +
        deps.escapeHTML(message || '当前浏览器无法使用本机存储。') +
        '</p>';
    } else {
      dom.lockedNote.innerHTML =
        '<strong>暂时无法读取</strong><p>' +
        deps.escapeHTML(message || '请解锁云端数据后重试。') +
        '</p>';
    }
    dom.lockedNote.hidden = false;
    dom.emptyList.hidden = true;
    dom.list.innerHTML = '';
    state.selectedIds.clear();
    state.organizing = false;
    renderBatchUI();
  }

  // 搜索文本按 updatedAt 缓存：正文最多 50 KB，每次按键都重新 lower/拼接
  // 会在几百条备忘录时产生明显的分配和 GC 压力。索引只保留前 8 KB 正文，
  // 足够覆盖列表摘要和常见检索；更长的正文仍可完整打开编辑。
  const searchCache = new Map();
  const bodySearchCache = new Map();
  const SEARCH_BODY_LIMIT = 8 * 1024;

  function searchTextFor(memo) {
    const cached = searchCache.get(memo.id);
    if (cached && cached.updatedAt === memo.updatedAt) return cached.text;
    const body = asString(memo.body).slice(0, SEARCH_BODY_LIMIT);
    const text = `${memo.title || ''}\n${body}\n${memo.tags.join(' ')}`.toLowerCase();
    searchCache.set(memo.id, { updatedAt: memo.updatedAt, text });
    return text;
  }

  function bodySearchFor(memo) {
    const cached = bodySearchCache.get(memo.id);
    if (cached && cached.updatedAt === memo.updatedAt) return cached.text;
    const text = asString(memo.body).slice(0, SEARCH_BODY_LIMIT).toLowerCase();
    bodySearchCache.set(memo.id, { updatedAt: memo.updatedAt, text });
    return text;
  }

  function filteredMemos() {
    return visibleMemos()
      .filter((memo) => {
        if (state.filter === 'pinned' && !memo.pinned) return false;
        if (state.filter === 'archived' && !memo.archived) return false;
        if (state.filter === 'all' && memo.archived) return false;
        if (state.activeTag && !memo.tags.includes(state.activeTag)) return false;
        if (state.query && !searchTextFor(memo).includes(state.query)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  }

  function renderAll() {
    if (!state.loaded) return;
    dom.lockedNote.hidden = true;
    renderList();
    renderTagbar();
    renderEditor();
  }

  function renderList() {
    if (!dom) return;
    const items = filteredMemos();
    dom.list.setAttribute('role', state.organizing ? 'group' : 'list');
    dom.list.setAttribute('aria-label', state.organizing ? '选择备忘录' : '备忘录列表');
    dom.emptyList.hidden = items.length > 0 || !state.loaded;
    if (!state.loaded) {
      dom.list.innerHTML = '';
      renderBatchUI();
      return;
    }

    dom.list.innerHTML = items.map(memoItemHTML).join('');
    renderBatchUI();
  }

  function memoItemHTML(memo) {
    const title = memo.title || firstLine(memo.body) || '无标题';
    const snippet = memo.body.replace(/\s+/g, ' ').trim().slice(0, 120);
    const tags = memo.tags.map((tag) => `<span class="memo-item-tag">${deps.escapeHTML(tag)}</span>`).join('');
    return `<${state.organizing ? 'label' : 'button'} class="memo-item${state.organizing ? ' is-organizing' : ''}${!state.organizing && memo.id === state.selectedId ? ' is-active' : ''}${
      state.organizing && state.selectedIds.has(memo.id) ? ' is-selected' : ''
    }${
      memo.archived ? ' is-archived' : ''
    }" ${state.organizing ? '' : `type="button" aria-current="${memo.id === state.selectedId ? 'true' : 'false'}"`} data-memo-id="${deps.escapeHTML(memo.id)}">
      ${state.organizing ? `<input class="memo-batch-check" type="checkbox" data-batch-memo-id="${deps.escapeHTML(memo.id)}" aria-label="选择 ${deps.escapeHTML(title)}" ${state.selectedIds.has(memo.id) ? 'checked' : ''} ${state.batchBusy ? 'disabled' : ''} />` : ''}
      <span class="memo-item-content">
      <span class="memo-item-head">
        ${
          memo.pinned
            ? '<svg class="memo-pin" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 3l7 7-4 1-4 4-1 5-2-2-4 4-2-2 4-4-2-2 5-1 4-4z"/></svg>'
            : ''
        }
        <span class="memo-item-title">${deps.escapeHTML(title)}</span>
      </span>
      ${snippet ? `<span class="memo-item-snippet">${deps.escapeHTML(snippet)}</span>` : ''}
      <span class="memo-item-meta">
        <span>${deps.escapeHTML(deps.formatTime(memo.updatedAt))}</span>
        ${memo.archived ? '<span class="memo-item-tag">已归档</span>' : ''}
        ${tags}
      </span>
      </span>
    </${state.organizing ? 'label' : 'button'}>`;
  }

  // 正文/标题输入只替换当前列表项，避免每次按键重建整个列表（并保持滚动位置）。
  function updateListItem(memo) {
    if (!dom || !state.loaded) return;
    if (state.organizing) {
      renderList();
      return;
    }
    const item = Array.from(dom.list.children).find((element) => element.dataset.memoId === memo.id);
    if (!item) {
      renderList();
      return;
    }
    item.outerHTML = memoItemHTML(memo);
  }

  function renderTagbar() {
    if (!dom) return;
    const tags = new Set();
    visibleMemos().forEach((memo) => memo.tags.forEach((tag) => tags.add(tag)));
    const list = Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    if (!list.length) {
      dom.tagbar.hidden = true;
      dom.tagbar.innerHTML = '';
      return;
    }
    dom.tagbar.hidden = false;
    dom.tagbar.innerHTML = list
      .map(
        (tag) =>
          `<button class="memo-tag-filter${tag === state.activeTag ? ' is-active' : ''}" type="button" data-tag="${deps.escapeHTML(
            tag
          )}">${deps.escapeHTML(tag)}</button>`
      )
      .join('');
  }

  function firstLine(text) {
    const line = String(text || '').split('\n').find((item) => item.trim());
    return line ? line.trim().slice(0, 60) : '';
  }

  function renderEditor() {
    if (!dom) return;
    const memo = currentMemo();
    if (!memo) {
      dom.empty.hidden = false;
      dom.editor.hidden = true;
      return;
    }

    dom.empty.hidden = true;
    dom.editor.hidden = false;
    if (document.activeElement !== dom.title) dom.title.value = memo.title;
    if (document.activeElement !== dom.body) dom.body.value = memo.body;
    dom.body.maxLength = MAX_BODY;
    renderEditorMeta();
    renderEditorTags();
    renderEditorActions();
    renderReminder();
    renderPreviewState();
    renderBacklinks();
    renderSaveState();
  }

  function renderEditorMeta() {
    if (!dom) return;
    const memo = currentMemo();
    if (!memo) return;
    const parts = [`更新于 ${deps.formatTime(memo.updatedAt)}`, `${memo.body.length} / ${MAX_BODY} 字`];
    if (memo.remindAt) parts.push(`提醒 ${deps.formatTime(memo.remindAt)}`);
    dom.meta.textContent = parts.join(' · ');
  }

  function renderEditorTags() {
    const memo = currentMemo();
    if (!memo) return;
    dom.tags.innerHTML = memo.tags
      .map(
        (tag) =>
          `<span class="memo-tag">${deps.escapeHTML(tag)}<button type="button" data-remove-tag="${deps.escapeHTML(
            tag
          )}" aria-label="移除标签 ${deps.escapeHTML(tag)}">×</button></span>`
      )
      .join('');
  }

  function renderEditorActions() {
    const memo = currentMemo();
    if (!memo) return;
    dom.pin.setAttribute('aria-pressed', String(memo.pinned));
    dom.pin.textContent = memo.pinned ? '已置顶' : '置顶';
    dom.archive.setAttribute('aria-pressed', String(memo.archived));
    dom.archive.textContent = memo.archived ? '取消归档' : '归档';
  }

  function renderCapacity() {
    if (!dom || !dom.capacity) return;
    if (!state.loaded) {
      dom.capacity.textContent = '';
      return;
    }
    const snapshot = { version: 1, memos: pruneTombstones(state.memos) };
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    const limit = MAX_BUDGET_BYTES;
    const percent = bytes / limit;
    dom.capacity.textContent = `已用 ${(bytes / 1024).toFixed(1)} / ${Math.round(
      limit / 1024
    )} KiB`;
    dom.capacity.classList.toggle('is-warn', percent >= 0.8);
    dom.capacity.title =
      percent >= 0.8
        ? '备忘录接近存储上限，建议导出后清理部分内容'
        : '备忘录总容量（含标签、提醒和链接等元数据）';
    if (percent >= 0.85 && !state.capacityWarned) {
      state.capacityWarned = true;
      deps.toast(`备忘录已用 ${Math.round(percent * 100)}%，建议先导出再清理`);
    } else if (percent < 0.7) {
      state.capacityWarned = false;
    }
  }

  function renderSaveState() {
    if (!dom) return;
    const local = state.mode === 'local';
    const labels = {
      idle: '',
      loading: '',
      saving: local ? '保存中…' : '正在同步到云端…',
      saved: local ? '已保存到本机' : '已同步到云端',
      local: '已保存到本机',
      error: local ? '保存失败' : '同步失败',
      locked: '未解锁',
      offline: '离线',
    };
    dom.saveState.textContent = labels[state.syncState] || '';
    dom.saveState.title =
      state.syncState === 'local'
        ? '已加密保存在当前浏览器，不会上传'
        : state.syncState === 'saved'
          ? '已加密同步到云端'
          : '';
  }

  function setSyncState(next) {
    state.syncState = next;
    if (!dom) return;
    const local = state.mode === 'local';
    const labels = local
      ? {
          idle: '仅本机',
          loading: '读取本机…',
          saving: '保存到本机…',
          saved: '仅本机',
          local: '仅本机',
          error: '保存失败',
          locked: '未解锁',
          offline: '离线',
        }
      : {
          idle: '加密云端',
          loading: '读取中…',
          saving: '同步中…',
          saved: '云端已同步',
          local: '仅本机',
          error: '同步失败',
          locked: '未解锁',
          offline: '离线',
        };
    dom.sync.textContent = labels[next] || (local ? '仅本机' : '加密云端');
    dom.sync.title = local ? '仅保存在本机，不上传云端' : '加密同步到云端';
    dom.sync.dataset.state = next;
    renderSaveState();
  }

  function renderPreviewState() {
    const memo = currentMemo();
    if (!memo || !state.preview) {
      dom.preview.hidden = true;
      dom.body.hidden = false;
      dom.previewToggle.setAttribute('aria-pressed', 'false');
      dom.previewToggle.textContent = '预览';
      return;
    }
    dom.preview.hidden = false;
    dom.body.hidden = true;
    dom.previewToggle.setAttribute('aria-pressed', 'true');
    dom.previewToggle.textContent = '编辑';
    dom.preview.innerHTML = renderMarkdown(memo.body);
  }

  function togglePreview() {
    const memo = currentMemo();
    if (!memo) return;
    state.preview = !state.preview;
    renderPreviewState();
  }

  function onPreviewClick(event) {
    const box = event.target.closest('input[data-task-line]');
    if (!box) return;
    const memo = currentMemo();
    if (!memo) return;
    const lines = memo.body.split('\n');
    const index = Number(box.dataset.taskLine);
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) return;
    lines[index] = lines[index].replace(/^(\s*[-*]\s+\[)( |x|X)(\])/, (_match, head, _state, tail) => `${head}${box.checked ? 'x' : ' '}${tail}`);
    memo.body = lines.join('\n');
    memo.updatedAt = deps.now();
    dom.body.value = memo.body;
    state.dirty = true;
    scheduleSave();
    renderPreviewState();
    renderEditorMeta();
    renderList();
  }

  function inlineMarkdown(text) {
    let value = deps.escapeHTML(text);
    value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    value = value.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    value = value.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return value;
  }

  function renderMarkdown(source) {
    const lines = String(source || '').split('\n');
    const out = [];
    let listType = '';
    let inCode = false;
    const code = [];

    const closeList = () => {
      if (!listType) return;
      out.push(`</${listType}>`);
      listType = '';
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        closeList();
        if (inCode) {
          out.push(`<pre><code>${code.join('\n')}</code></pre>`);
          code.length = 0;
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(deps.escapeHTML(line));
        continue;
      }

      if (!line.trim()) {
        closeList();
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 5);
        out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      if (task) {
        if (listType !== 'ul') {
          closeList();
          out.push('<ul class="memo-task-list">');
          listType = 'ul';
        }
        const checked = task[1].toLowerCase() === 'x';
        out.push(
          `<li class="memo-task${checked ? ' is-done' : ''}"><label><input type="checkbox" data-task-line="${i}" ${
            checked ? 'checked' : ''
          } /><span>${inlineMarkdown(task[2])}</span></label></li>`
        );
        continue;
      }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (listType !== 'ul') {
          closeList();
          out.push('<ul>');
          listType = 'ul';
        }
        out.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
        continue;
      }

      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ordered) {
        if (listType !== 'ol') {
          closeList();
          out.push('<ol>');
          listType = 'ol';
        }
        out.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      if (/^>\s?/.test(line)) {
        closeList();
        out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`);
        continue;
      }

      closeList();
      out.push(`<p>${inlineMarkdown(line)}</p>`);
    }

    closeList();
    if (inCode) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    return out.join('');
  }

  function renderReminder() {
    const memo = currentMemo();
    if (!memo) return;
    dom.remind.value = memo.remindAt ? toLocalInput(memo.remindAt) : '';
    dom.remindClear.hidden = !memo.remindAt;
  }

  function toLocalInput(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  function onRemindChange() {
    const memo = currentMemo();
    if (!memo) return;
    const value = dom.remind.value;
    let timestamp = null;
    if (value) {
      const parsed = new Date(value).getTime();
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
    memo.remindAt = timestamp;
    touch(memo);
    requestNotificationPermission();
    deps.toast(timestamp ? `已设置提醒：${deps.formatTime(timestamp)}` : '已取消提醒');
  }

  function clearReminder() {
    const memo = currentMemo();
    if (!memo) return;
    memo.remindAt = null;
    touch(memo);
    deps.toast('已取消提醒');
  }

  function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    try {
      Notification.requestPermission().catch(() => {});
    } catch (error) {
      // 拒绝通知时安静降级为页内提示。
    }
  }

  function readNotified() {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (error) {
      return {};
    }
  }

  function writeNotified(map) {
    try {
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify(map));
    } catch (error) {
      // 隐私模式不可写时忽略，最多重复提醒。
    }
  }

  function checkReminders() {
    if (!state.loaded) return;
    const notified = readNotified();
    let changed = false;
    const now = deps.now();

    for (const memo of visibleMemos()) {
      if (!memo.remindAt || memo.remindAt > now) continue;
      const key = `${memo.id}:${memo.remindAt}`;
      if (notified[key]) continue;
      notified[key] = now;
      changed = true;
      const title = memo.title || firstLine(memo.body) || '备忘录提醒';
      deps.toast(`提醒：${title}`);
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('氢导航 · 备忘录提醒', { body: title, tag: memo.id });
        } catch (error) {
          // ignore
        }
      }
    }

    if (changed) {
      const valid = new Set(state.memos.map((memo) => memo.id));
      for (const key of Object.keys(notified)) {
        if (!valid.has(key.split(':')[0])) delete notified[key];
      }
      writeNotified(notified);
    }
  }

  function backlinksFor(memo) {
    if (!memo || !memo.title) return [];
    const needle = `[[${memo.title}]]`;
    return visibleMemos()
      .filter((other) => other.id !== memo.id && other.body.includes(needle))
      .map((other) => ({ id: other.id, title: other.title || firstLine(other.body) || '无标题' }));
  }

  function renderBacklinks() {
    const memo = currentMemo();
    const links = backlinksFor(memo);
    if (!links.length) {
      dom.backlinks.hidden = true;
      dom.backlinks.innerHTML = '';
      return;
    }
    dom.backlinks.hidden = false;
    dom.backlinks.innerHTML =
      '<span>反向链接</span>' +
      links
        .map(
          (item) =>
            `<button class="memo-backlink" type="button" data-memo-id="${deps.escapeHTML(item.id)}">${deps.escapeHTML(
              item.title
            )}</button>`
        )
        .join('');
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function stamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  async function exportJSON() {
    if (!state.loaded) {
      deps.toast('请先打开备忘录');
      return;
    }
    const confirmed = await deps.confirm({
      title: '导出备忘录',
      message: '导出的 JSON 是明文文件，请保存在安全的位置。',
      confirmText: '导出',
      danger: false,
    });
    if (!confirmed) return;
    const payload = { version: 1, exportedAt: deps.now(), memos: visibleMemos() };
    downloadFile(`qingdh-memos-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    deps.toast('已导出备忘录 JSON');
  }

  async function exportMarkdown() {
    if (!state.loaded) {
      deps.toast('请先打开备忘录');
      return;
    }
    const confirmed = await deps.confirm({
      title: '导出备忘录',
      message: '导出的 Markdown 是明文文件，请保存在安全的位置。',
      confirmText: '导出',
      danger: false,
    });
    if (!confirmed) return;

    const parts = ['# 氢导航 · 备忘录导出', '', `导出时间：${new Date().toLocaleString()}`, ''];
    for (const memo of visibleMemos()) {
      parts.push(`## ${memo.title || firstLine(memo.body) || '无标题'}`);
      if (memo.tags.length) parts.push(`标签：${memo.tags.map((tag) => `#${tag}`).join(' ')}`);
      if (memo.remindAt) parts.push(`提醒：${deps.formatTime(memo.remindAt)}`);
      parts.push('', memo.body, '');
    }
    downloadFile(`qingdh-memos-${stamp()}.md`, parts.join('\n'), 'text/markdown;charset=utf-8');
    deps.toast('已导出备忘录 Markdown');
  }

  function selectMemo(id, { focusTitle = false } = {}) {
    state.selectedId = id;
    state.readingPane = true;
    document.body.classList.add('memo-editing');
    renderList();
    renderEditor();
    if (focusTitle) {
      setTimeout(() => dom.title.focus(), 30);
    }
  }

  function onTitleInput() {
    const memo = currentMemo();
    if (!memo) return;
    memo.title = dom.title.value.slice(0, MAX_TITLE);
    memo.updatedAt = deps.now();
    state.dirty = true;
    scheduleSave();
    updateListItem(memo);
  }

  function onBodyInput() {
    const memo = currentMemo();
    if (!memo) return;
    if (dom.body.value.length > MAX_BODY) {
      dom.body.value = dom.body.value.slice(0, MAX_BODY);
      deps.toast(`单条正文最多 ${MAX_BODY} 字`);
    }
    memo.body = dom.body.value;
    memo.updatedAt = deps.now();
    state.dirty = true;
    scheduleSave();
    updateListItem(memo);
    renderEditorMeta();
  }

  function addTag(value) {
    const memo = currentMemo();
    if (!memo) return;
    const tag = String(value || '').trim().slice(0, MAX_TAG);
    dom.tagInput.value = '';
    if (!tag) return;
    if (memo.tags.includes(tag)) return;
    if (memo.tags.length >= MAX_TAGS) {
      deps.toast(`最多 ${MAX_TAGS} 个标签`);
      return;
    }
    memo.tags.push(tag);
    touch(memo);
    renderEditorTags();
    renderTagbar();
  }

  async function removeMemo() {
    const memo = currentMemo();
    if (!memo) return;
    const confirmed = await deps.confirm({
      title: '删除备忘录',
      message: `确定删除「${memo.title || firstLine(memo.body) || '无标题'}」吗？${state.mode === 'local' ? '只删除本机备忘录。' : '删除会同步到其他设备。'}`,
      confirmText: '删除',
    });
    if (!confirmed) return;

    memo.deletedAt = deps.now();
    memo.updatedAt = memo.deletedAt;
    memo.title = '';
    memo.body = '';
    memo.tags = [];
    state.selectedId = null;
    state.readingPane = false;
    document.body.classList.remove('memo-editing');
    state.dirty = true;
    scheduleSave();
    renderAll();
    renderEditor();
    updateCount();
    deps.toast('已删除');
  }

  async function quickCapture() {
    const epoch = state.epoch;
    if (!(await ensureReady())) return;
    if (epoch !== state.epoch) return;
    if (dom.captureDialog.open) {
      dom.captureBody.focus();
      return;
    }

    state.captureDiscard = false;
    dom.captureBody.value = '';
    dom.captureDialog.showModal();
    setTimeout(() => dom.captureBody.focus(), 30);
  }

  function saveCapture({ closing = false } = {}) {
    const text = dom.captureBody.value.trim();
    if (!text) return;
    const memo = createMemo({ body: text.slice(0, MAX_BODY) });
    if (!memo) return;
    state.selectedId = memo.id;
    if (!closing) {
      dom.captureBody.value = '';
      dom.captureDialog.close();
      deps.toast('已保存到备忘录');
    } else {
      deps.toast('已保存到备忘录');
    }
    saveNow().catch(() => {});
    if (state.open) renderAll();
  }

  async function saveText({ title = '', body = '', tags = [] } = {}) {
    const epoch = state.epoch;
    if (!state.open && !(await ensureReady())) return null;
    if (state.open && !state.loaded && !(await ensureReady())) return null;
    if (epoch !== state.epoch) return null;

    const text = String(body || '').slice(0, MAX_BODY);
    const memo = createMemo({ title, body: text });
    if (!memo) return null;
    if (Array.isArray(tags) && tags.length) memo.tags = normalizeTags(tags);

    state.dirty = true;
    scheduleSave(0);
    await saveNow();
    updateCount();
    if (state.open) renderAll();
    deps.toast('已保存到备忘录');
    return memo;
  }

  async function openAndCreate() {
    await open();
    if (!state.open || !state.loaded) return null;
    const memo = createMemo();
    if (memo) selectMemo(memo.id, { focusTitle: true });
    return memo;
  }

  async function openById(id) {
    await open();
    if (!state.open || !state.loaded) return;
    if (!state.memos.some((memo) => memo.id === id && !memo.deletedAt)) return;
    selectMemo(id);
  }

  function titles() {
    if (!state.loaded) return [];
    return visibleMemos()
      .filter((memo) => !memo.archived)
      .map((memo) => ({ id: memo.id, title: memo.title || firstLine(memo.body) || '无标题' }));
  }

  function searchEntries() {
    if (!state.loaded) return [];
    return visibleMemos()
      .filter((memo) => !memo.archived)
      .map((memo) => ({
        id: memo.id,
        title: memo.title || firstLine(memo.body) || '无标题',
        body: asString(memo.body).slice(0, SEARCH_BODY_LIMIT),
        bodyLower: bodySearchFor(memo),
        tags: Array.isArray(memo.tags) ? memo.tags : [],
        search: searchTextFor(memo),
      }));
  }

  globalThis.QingdhMemo = {
    init,
    open,
    saveText,
    openAndCreate,
    openById,
    titles,
    searchEntries,
    checkReminders,
    close,
    toggle,
    lock,
    refresh,
    flush: flushPendingSave,
    quickCapture,
    isOpen: () => state.open,
    count: () => activeCount(),
  };
})();
