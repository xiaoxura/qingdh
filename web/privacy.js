/* ==========================================================================
 * 氢导航 · 隐私空间
 *
 * 独立密码 + 独立 dataKey，整份隐私工作区（私密分组/链接 + 私密备忘录）
 * 以 v4 secret(kind='privacy', keySource='password') 加密上传。
 * 不使用 Device Vault；每次进入都验证密码，锁定后清空 DOM 与内存密钥。
 * ========================================================================== */

(() => {
  'use strict';

  const DEFAULT_SHORTCUT = 'Alt+Shift+P';
  const MAX_GROUPS = 50;
  const MAX_LINKS = 500;
  const MAX_MEMOS = 300;
  const MAX_NAME = 20;
  const MAX_TITLE = 80;
  const MAX_URL = 2048;
  const MAX_BODY = 20000;
  const SAVE_DEBOUNCE = 500;
  const IDLE_LOCK_MS = 3 * 60 * 1000;
  const HIDDEN_LOCK_MS = 30 * 1000;
  const RESERVED_SHORTCUTS = ['Alt+S', 'Control+K', 'Meta+K', 'Control+Shift+M', 'Meta+Shift+M', '/'];

  const deps = {
    api: async () => ({ ok: false, status: 0, data: null, networkError: true }),
    toast: () => {},
    confirm: async () => false,
    escapeHTML: (value) => String(value),
    uid: () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => Date.now(),
    formatTime: (value) => new Date(value).toLocaleString(),
    currentUser: () => null,
    openAccountDialog: () => {},
    normalizeURL: (value) => value,
    closeMemo: () => {},
    getShortcut: () => DEFAULT_SHORTCUT,
    setShortcut: () => {},
  };

  const state = {
    revision: 0,
    envelope: null,
    dataKey: null,
    payload: null,
    unlocked: false,
    viewOpen: false,
    mode: 'unlock',
    pendingSetup: null,
    pendingRecovery: '',
    saveTimer: null,
    savePromise: null,
    saveError: false,
    epoch: 0,
    editSeq: 0,
    savedSeq: 0,
    idleTimer: null,
    hiddenTimer: null,
    lastActivity: 0,
    selectedMemoId: null,
    tab: 'links',
    shortcut: DEFAULT_SHORTCUT,
    copied: false,
    saving: false,
    pendingSave: false,
  };

  let dom = null;

  function $(id) {
    return document.getElementById(id);
  }

  function init(nextDeps) {
    if (nextDeps) Object.assign(deps, nextDeps);

    dom = {
      view: $('privacy-view'),
      lock: $('privacy-lock'),
      status: $('privacy-status'),
      tabs: Array.from(document.querySelectorAll('[data-privacy-tab]')),
      linksPanel: $('privacy-links-panel'),
      memosPanel: $('privacy-memos-panel'),
      addGroup: $('privacy-add-group'),
      groupForm: $('privacy-group-form'),
      groupName: $('privacy-group-name'),
      groupCancel: $('privacy-group-cancel'),
      groups: $('privacy-groups'),
      linksEmpty: $('privacy-links-empty'),
      memoNew: $('privacy-memo-new'),
      memoList: $('privacy-memo-list'),
      memoListEmpty: $('privacy-memo-list-empty'),
      memoEmpty: $('privacy-memo-empty'),
      memoEditor: $('privacy-memo-editor'),
      memoTitle: $('privacy-memo-title'),
      memoBody: $('privacy-memo-body'),
      memoMeta: $('privacy-memo-meta'),
      memoDelete: $('privacy-memo-delete'),
      lockDialog: $('privacy-lock-dialog'),
      lockForm: $('privacy-lock-form'),
      lockTitle: $('privacy-lock-title'),
      lockMessage: $('privacy-lock-message'),
      passwordField: $('privacy-password-field'),
      password: $('privacy-password'),
      password2Field: $('privacy-password2-field'),
      password2: $('privacy-password2'),
      recoveryToggleLine: $('privacy-recovery-toggle-line'),
      recoveryToggle: $('privacy-recovery-toggle'),
      recoveryField: $('privacy-recovery-field'),
      recovery: $('privacy-recovery'),
      lockNote: $('privacy-lock-note'),
      lockError: $('privacy-lock-error'),
      forgot: $('privacy-forgot'),
      submit: $('privacy-submit'),
      cancel: $('privacy-cancel'),
      recoveryDialog: $('privacy-recovery-dialog'),
      recoveryCode: $('privacy-recovery-code'),
      recoveryCopy: $('privacy-recovery-copy'),
      recoveryDownload: $('privacy-recovery-download'),
      recoveryConfirm: $('privacy-recovery-confirm'),
      recoveryContinue: $('privacy-recovery-continue'),
      recoveryError: $('privacy-recovery-error'),
      shortcutInput: $('privacy-shortcut'),
      shortcutHint: $('privacy-shortcut-hint'),
      settingsState: $('privacy-settings-state'),
      settingsOpen: $('privacy-open-settings'),
      shortcutReset: $('privacy-shortcut-reset'),
    };
    if (!dom.view) return;

    state.shortcut = normalizeShortcut(deps.getShortcut()) || DEFAULT_SHORTCUT;
    dom.shortcutInput.value = state.shortcut;

    dom.lock.addEventListener('click', () => lock('manual'));
    dom.tabs.forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.privacyTab)));

    dom.addGroup.addEventListener('click', () => {
      dom.groupForm.hidden = false;
      dom.groupName.focus();
    });
    dom.groupCancel.addEventListener('click', () => {
      dom.groupForm.hidden = true;
      dom.groupName.value = '';
    });
    dom.groupForm.addEventListener('submit', (event) => {
      event.preventDefault();
      addGroup(dom.groupName.value);
    });

    dom.groups.addEventListener('click', onGroupsClick);
    dom.groups.addEventListener('submit', onLinkSubmit);

    dom.memoNew.addEventListener('click', () => createMemo());
    dom.memoList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-privacy-memo]');
      if (item) selectMemo(item.dataset.privacyMemo);
    });
    dom.memoTitle.addEventListener('input', onMemoInput);
    dom.memoBody.addEventListener('input', onMemoInput);
    dom.memoDelete.addEventListener('click', deleteMemo);

    dom.lockForm.addEventListener('submit', onSubmit);
    dom.recoveryToggle.addEventListener('change', () => {
      dom.recoveryField.hidden = !dom.recoveryToggle.checked;
      dom.lockError.hidden = true;
      setTimeout(() => (dom.recoveryToggle.checked ? dom.recovery : dom.password).focus(), 20);
    });
    dom.forgot.addEventListener('click', () => {
      setMode('reset');
      dom.password.focus();
    });
    dom.recoveryDialog.addEventListener('close', () => {
      if (!state.pendingSetup) return;
      // 创建流程必须保存恢复码；关闭对话框即取消创建。
      state.pendingSetup = null;
      state.pendingRecovery = '';
      deps.toast('已取消创建隐私空间');
    });

    dom.recoveryConfirm.addEventListener('change', () => {
      dom.recoveryContinue.disabled = false;
      if (dom.recoveryConfirm.checked) dom.recoveryError.hidden = true;
    });
    dom.recoveryCopy.addEventListener('click', () => {
      copyText(dom.recoveryCode.textContent, '恢复码已复制');
    });
    dom.recoveryDownload.addEventListener('click', downloadRecovery);
    dom.recoveryContinue.addEventListener('click', finishCreation);

    dom.shortcutInput.addEventListener('keydown', onShortcutKeydown);
    dom.shortcutInput.addEventListener('focus', () => dom.shortcutInput.select());
    dom.shortcutReset.addEventListener('click', () => {
      applyShortcut(DEFAULT_SHORTCUT);
    });
    dom.settingsOpen.addEventListener('click', () => {
      const hub = $('hub-dialog');
      if (hub && hub.open) hub.close();
      requestOpen();
    });

    document.addEventListener('keydown', onGlobalKeydown, true);
    ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, onActivity, true));
    document.addEventListener('mousemove', onActivity, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', () => {
      // 页面即将离开时先尽力提交未保存的编辑；真正的锁定由隐藏超时或
      // pageshow(bfcache) 负责，避免在异步加密完成前清掉密钥。
      if (state.unlocked && state.dirty) {
        let keepalive = false;
        try {
          keepalive = new TextEncoder().encode(JSON.stringify(state.payload)).length <= 60 * 1024;
        } catch (error) {
          keepalive = false;
        }
        save(0, { keepalive, autoRetry: false }).catch(() => {});
      }
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && state.unlocked) lock('pagehide', { silent: true });
    });

    setStatus('');
  }

  /* ------------------------------------------------------------------ *
   * 数据模型
   * ------------------------------------------------------------------ */

  function asString(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function emptyPayload() {
    return { version: 1, groups: [], memos: [] };
  }

  function normalizeLink(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asString(raw.id).trim();
    const url = asString(raw.url).trim().slice(0, MAX_URL);
    if (!id || !url) return null;
    const updatedAt = num(raw.updatedAt, deps.now());
    return {
      id,
      title: asString(raw.title).slice(0, 40),
      url,
      updatedAt,
      deletedAt: raw.deletedAt == null ? null : num(raw.deletedAt, updatedAt),
    };
  }

  function normalizeGroup(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asString(raw.id).trim();
    if (!id) return null;
    const links = [];
    const seen = new Set();
    for (const item of Array.isArray(raw.links) ? raw.links : []) {
      const link = normalizeLink(item);
      if (!link || seen.has(link.id)) continue;
      seen.add(link.id);
      links.push(link);
    }
    const updatedAt = num(raw.updatedAt, deps.now());
    return {
      id,
      name: asString(raw.name).trim().slice(0, MAX_NAME) || '私密分组',
      links,
      updatedAt,
      deletedAt: raw.deletedAt == null ? null : num(raw.deletedAt, updatedAt),
    };
  }

  function normalizeMemo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asString(raw.id).trim();
    if (!id) return null;
    const createdAt = num(raw.createdAt, deps.now());
    const updatedAt = num(raw.updatedAt, createdAt);
    return {
      id,
      title: asString(raw.title).slice(0, MAX_TITLE),
      body: asString(raw.body).slice(0, MAX_BODY),
      createdAt,
      updatedAt,
      deletedAt: raw.deletedAt == null ? null : num(raw.deletedAt, updatedAt),
    };
  }

  function normalizePayload(raw) {
    const payload = emptyPayload();
    const seenGroups = new Set();
    for (const item of Array.isArray(raw && raw.groups) ? raw.groups : []) {
      const group = normalizeGroup(item);
      if (!group || seenGroups.has(group.id)) continue;
      seenGroups.add(group.id);
      payload.groups.push(group);
    }
    const seenMemos = new Set();
    for (const item of Array.isArray(raw && raw.memos) ? raw.memos : []) {
      const memo = normalizeMemo(item);
      if (!memo || seenMemos.has(memo.id)) continue;
      seenMemos.add(memo.id);
      payload.memos.push(memo);
    }
    payload.groups = payload.groups.slice(0, MAX_GROUPS);
    payload.memos = payload.memos.slice(0, MAX_MEMOS);
    return payload;
  }

  function visibleGroups() {
    if (!state.payload) return [];
    return state.payload.groups.filter((group) => !group.deletedAt);
  }

  function visibleMemos() {
    if (!state.payload) return [];
    return state.payload.memos.filter((memo) => !memo.deletedAt);
  }

  function mergePayload(local, cloud) {
    const merged = emptyPayload();
    const localGroups = new Map(local.groups.map((group) => [group.id, group]));
    const cloudGroups = new Map(cloud.groups.map((group) => [group.id, group]));
    const order = [];
    local.groups.forEach((group) => order.push(group.id));
    cloud.groups.forEach((group) => {
      if (!localGroups.has(group.id)) order.push(group.id);
    });
    for (const id of order) {
      const a = localGroups.get(id);
      const b = cloudGroups.get(id);
      if (!a || !b) {
        merged.groups.push(a || b);
        continue;
      }
      const base = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
      const linkOrder = [];
      const aLinks = new Map(a.links.map((link) => [link.id, link]));
      const bLinks = new Map(b.links.map((link) => [link.id, link]));
      a.links.forEach((link) => linkOrder.push(link.id));
      b.links.forEach((link) => {
        if (!aLinks.has(link.id)) linkOrder.push(link.id);
      });
      const links = [];
      for (const linkId of linkOrder) {
        const left = aLinks.get(linkId);
        const right = bLinks.get(linkId);
        if (!left || !right) {
          links.push(left || right);
          continue;
        }
        links.push((left.updatedAt || 0) >= (right.updatedAt || 0) ? left : right);
      }
      merged.groups.push({
        id: base.id,
        name: base.name,
        updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
        deletedAt: base.deletedAt || null,
        links,
      });
    }

    const memos = new Map();
    cloud.memos.forEach((memo) => memos.set(memo.id, memo));
    local.memos.forEach((memo) => {
      const other = memos.get(memo.id);
      if (!other) {
        memos.set(memo.id, memo);
        return;
      }
      memos.set(memo.id, (memo.updatedAt || 0) >= (other.updatedAt || 0) ? memo : other);
    });
    merged.memos = Array.from(memos.values());
    return merged;
  }

  /* ------------------------------------------------------------------ *
   * 同步
   * ------------------------------------------------------------------ */

  function setStatus(text) {
    if (dom && dom.status) dom.status.textContent = text || '';
  }

  async function fetchEnvelope() {
    const response = await deps.api('/api/v1/secrets/privacy');
    if (response.status === 401) {
      deps.toast('登录已过期，请重新登录');
      deps.openAccountDialog();
      throw new Error('登录已过期');
    }
    if (!response.ok) throw new Error('无法读取隐私空间');

    state.revision = Number(response.data && response.data.revision) || 0;
    state.envelope = (response.data && response.data.payload) || null;
    return state.envelope;
  }

  async function putEnvelope(envelope, baseRevision, expectedEpoch = null, keepalive = false) {
    const response = await deps.api('/api/v1/secrets/privacy', {
      method: 'PUT',
      body: { baseRevision, payload: envelope },
      keepalive,
    });
    if (expectedEpoch != null && expectedEpoch !== state.epoch) return null;
    if (response.status === 401) {
      lock('auth', { silent: true });
      deps.toast('登录已过期，隐私空间已锁定');
      deps.openAccountDialog();
      throw new Error('登录已过期');
    }
    if (response.status === 409) {
      const error = new Error('conflict');
      error.code = 'conflict';
      error.current = (response.data && response.data.current) || null;
      throw error;
    }
    if (!response.ok) {
      throw new Error((response.data && response.data.error && response.data.error.message) || '保存隐私空间失败');
    }
    state.revision = response.data.revision;
    state.envelope = envelope;
    return response.data;
  }

  function save(attempt = 0, { keepalive = false, autoRetry = true } = {}) {
    if (!state.unlocked || !state.dataKey || !state.envelope) return Promise.resolve();
    if (state.savePromise) {
      state.pendingSave = true;
      return state.savePromise;
    }
    if (!state.dirty) return Promise.resolve();

    const run = runSave(attempt, { keepalive, autoRetry }).finally(() => {
      state.savePromise = null;
      state.saving = false;
    });
    state.savePromise = run;

    return run.then(async () => {
      if (state.pendingSave && state.dirty && state.unlocked) {
        state.pendingSave = false;
        await save(attempt, { keepalive, autoRetry });
      }
    });
  }

  async function runSave(attempt = 0, { keepalive = false, autoRetry = true } = {}) {
    const epoch = state.epoch;
    const token = state.editSeq;
    state.saving = true;
    state.saveError = false;
    setStatus('保存中…');

    try {
      const envelope = await QingdhCrypto.sealPrivacy(state.envelope, state.dataKey, state.payload);
      if (epoch !== state.epoch) return;
      await putEnvelope(envelope, state.revision, epoch, keepalive);
      if (epoch !== state.epoch) return;

      // 上传期间可能又发生了编辑：只有编辑代次一致才算真正保存完整。
      state.savedSeq = Math.max(state.savedSeq, token);
      state.dirty = state.editSeq > state.savedSeq;
      if (state.dirty) {
        state.pendingSave = true;
        setStatus('保存中…');
      } else {
        setStatus('已保存');
      }
    } catch (error) {
      if (epoch !== state.epoch) return;

      if (error.code === 'conflict' && attempt < 2) {
        try {
          const current = error.current;
          if (current && current.payload) {
            const cloud = await QingdhCrypto.openPrivacyWithKey(current.payload, state.dataKey);
            if (epoch !== state.epoch) return;
            state.payload = mergePayload(state.payload, normalizePayload(cloud));
            state.envelope = current.payload;
            state.revision = current.revision;
            state.dirty = true;
            state.editSeq += 1;
            renderAll();
          }
          await runSave(attempt + 1, { keepalive, autoRetry });
          return;
        } catch (mergeError) {
          // 合并失败走通用错误路径，保留 dirty 等待重试。
        }
      }

      state.dirty = true;
      state.pendingSave = true;
      state.saveError = true;
      setStatus('保存失败');
      if (autoRetry) {
        deps.toast('隐私空间保存失败，稍后会重试');
        setTimeout(() => {
          if (state.unlocked) save().catch(() => {});
        }, 3000);
      }
    }
  }

  function scheduleSave() {
    if (!state.unlocked) return;
    state.editSeq += 1;
    state.dirty = true;
    state.saveError = false;
    setStatus('未保存…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      save().catch(() => {});
    }, SAVE_DEBOUNCE);
  }

  /* ------------------------------------------------------------------ *
   * 锁屏 / 创建
   * ------------------------------------------------------------------ */

  function normalizeShortcut(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return '';
    const key = parts[parts.length - 1];
    if (key.length > 1 && !['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
    return parts.join('+');
  }

  function comboFromEvent(event) {
    const key = event.key;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    return parts.join('+');
  }

  function onGlobalKeydown(event) {
    if (!state.shortcut) return;
    if (comboFromEvent(event) !== state.shortcut) return;
    if (event.target && isTypingTarget(event.target)) return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.viewOpen) {
      dom.view.querySelector('button, [href], input, textarea')?.focus();
    } else {
      requestOpen();
    }
  }

  function isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function onActivity() {
    if (!state.unlocked) return;
    const now = Date.now();
    if (now - state.lastActivity < 5000) return;
    state.lastActivity = now;
    resetIdleTimer();
  }

  function resetIdleTimer() {
    clearTimeout(state.idleTimer);
    if (!state.unlocked) return;
    state.idleTimer = setTimeout(() => lock('idle'), IDLE_LOCK_MS);
  }

  function onVisibilityChange() {
    if (!state.unlocked) return;
    if (document.visibilityState === 'hidden') {
      if (state.dirty) save(0, { autoRetry: false }).catch(() => {});
      clearTimeout(state.hiddenTimer);
      state.hiddenTimer = setTimeout(() => {
        if (document.visibilityState === 'hidden') lock('hidden');
      }, HIDDEN_LOCK_MS);
    } else {
      clearTimeout(state.hiddenTimer);
      resetIdleTimer();
    }
  }

  async function requestOpen() {
    if (!deps.currentUser()) {
      deps.toast('登录后才能使用隐私空间');
      deps.openAccountDialog();
      return;
    }
    if (state.unlocked && state.payload) {
      openView();
      return;
    }

    const epoch = state.epoch;
    try {
      await fetchEnvelope();
    } catch (error) {
      deps.toast(error.message || '无法读取隐私空间');
      return;
    }
    if (epoch !== state.epoch || !deps.currentUser()) return;
    openLockDialog(state.envelope ? 'unlock' : 'create');
  }

  function openLockDialog(mode) {
    state.mode = mode;
    setMode(mode);
    dom.lockForm.reset();
    dom.lockError.hidden = true;
    dom.recoveryField.hidden = true;
    dom.submit.disabled = false;
    dom.lockDialog.showModal();
    setTimeout(() => dom.password.focus(), 30);
  }

  function setMode(mode) {
    state.mode = mode;
    const create = mode === 'create';
    const reset = mode === 'reset';
    dom.lockTitle.textContent = create ? '创建隐私空间' : reset ? '重置隐私密码' : '隐私空间';
    dom.lockMessage.textContent = create
      ? '隐私空间使用独立密码和独立密钥，与普通数据完全分开。请设置一个只有你知道的密码。'
      : reset
        ? '输入创建时保存的恢复码，并设置新的隐私密码。恢复码本身不会改变。'
        : '输入隐私密码。每次进入都需要验证，密码不会保存到本机 vault。';
    dom.passwordField.hidden = false;
    dom.password2Field.hidden = !(create || reset);
    dom.recoveryToggleLine.hidden = create || reset;
    dom.recoveryToggle.checked = false;
    dom.recoveryField.hidden = true;
    dom.lockNote.hidden = create;
    dom.forgot.hidden = create || reset;
    dom.submit.textContent = create ? '创建' : reset ? '重置密码' : '解锁';
    if (reset) {
      dom.recoveryField.hidden = false;
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    dom.lockError.hidden = true;
    const epoch = state.epoch;
    const password = dom.password.value;
    const confirm = dom.password2.value;

    if (state.mode === 'reset') {
      const code = dom.recovery.value.trim();
      if (!code) return showLockError('请输入恢复码');
      if (password.length < 8) return showLockError('新密码至少 8 位');
      if (password !== confirm) return showLockError('两次输入的新密码不一致');
      dom.submit.disabled = true;
      try {
        const updated = await QingdhCrypto.rewrapPrivacyWithRecovery(state.envelope, code, password);
        if (epoch !== state.epoch) return;
        await putEnvelope(updated, state.revision, epoch);
        if (epoch !== state.epoch) return;
        dom.lockDialog.close();
        deps.toast('隐私密码已重置，请用新密码进入');
        setMode('unlock');
        dom.lockForm.reset();
      } catch (error) {
        showLockError(error && error.code === 'unlock_failed' ? '恢复码不正确' : error.message || '重置失败');
      } finally {
        dom.submit.disabled = false;
      }
      return;
    }

    if (password.length < 8) return showLockError('隐私密码至少 8 位');
    dom.submit.disabled = true;

    try {
      if (state.mode === 'create') {
        if (password !== confirm) {
          showLockError('两次输入的密码不一致');
          return;
        }
        const setup = await QingdhCrypto.setupPrivacy(password, emptyPayload());
        if (epoch !== state.epoch) return;
        state.pendingSetup = setup;
        state.pendingRecovery = setup.recoveryCode;
        dom.lockDialog.close();
        showRecoveryCode(setup.recoveryCode);
        return;
      }

      const useRecovery = dom.recoveryToggle.checked;
      const secret = useRecovery ? dom.recovery.value.trim() : password;
      if (!secret) {
        showLockError(useRecovery ? '请输入恢复码' : '请输入隐私密码');
        return;
      }
      const opened = useRecovery
        ? await QingdhCrypto.unlockPrivacyWithRecovery(state.envelope, secret)
        : await QingdhCrypto.unlockPrivacy(state.envelope, password);
      if (epoch !== state.epoch) {
        // 解密期间已经退出/锁定：不把密钥和明文写回内存。
        opened.dataKeyRaw.fill(0);
        return;
      }

      state.dataKey = opened.dataKeyRaw;
      state.payload = normalizePayload(opened.payload);
      state.unlocked = true;
      dom.lockDialog.close();
      openView();
      deps.toast('隐私空间已解锁');
    } catch (error) {
      showLockError(
        error && error.code === 'unlock_failed'
          ? dom.recoveryToggle.checked
            ? '恢复码不正确'
            : '隐私密码不正确'
          : error.message || '操作失败'
      );
    } finally {
      dom.submit.disabled = false;
    }
  }

  function showLockError(message) {
    dom.lockError.textContent = message;
    dom.lockError.hidden = false;
    dom.submit.disabled = false;
  }

  function showRecoveryCode(code) {
    dom.recoveryCode.textContent = QingdhCrypto.formatRecoveryCode(code);
    dom.recoveryConfirm.checked = false;
    dom.recoveryContinue.disabled = false;
    dom.recoveryError.hidden = true;
    dom.recoveryDialog.showModal();
  }

  async function finishCreation() {
    if (!state.pendingSetup) return;
    if (!dom.recoveryConfirm.checked) {
      dom.recoveryError.textContent = '请先勾选“我已把恢复码保存在离线、安全的地方”';
      dom.recoveryError.hidden = false;
      dom.recoveryConfirm.focus();
      return;
    }

    const epoch = state.epoch;
    dom.recoveryContinue.disabled = true;
    try {
      await putEnvelope(state.pendingSetup.envelope, 0, epoch);
      if (epoch !== state.epoch) return;
      state.dataKey = state.pendingSetup.dataKeyRaw;
      state.payload = emptyPayload();
      state.unlocked = true;
      state.pendingSetup = null;
      state.pendingRecovery = '';
      dom.recoveryDialog.close();
      openView();
      deps.toast('隐私空间已创建');
    } catch (error) {
      if (error.code === 'conflict') {
        dom.recoveryError.textContent = '隐私空间已在其他设备创建，请关闭后用密码进入';
      } else {
        dom.recoveryError.textContent = error.message || '创建失败';
      }
      dom.recoveryError.hidden = false;
    } finally {
      dom.recoveryContinue.disabled = false;
    }
  }

  function copyText(text, message) {
    if (!text) return;
    state.copied = true;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => deps.toast(message || '已复制'),
        () => deps.toast('复制失败，请手动选择')
      );
    } else {
      deps.toast('请手动选择复制');
    }
  }

  function downloadRecovery() {
    const code = dom.recoveryCode.textContent;
    if (!code) return;
    const text = [
      '氢导航 · 隐私空间恢复码',
      '',
      code,
      '',
      '忘记隐私密码时，用这个恢复码重置密码。',
      '它不能解锁普通工作区；普通数据有独立的加密密码。',
      '请离线保存，不要发给任何人。',
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'qingdh-privacy-recovery.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    state.copied = true;
  }

  /* ------------------------------------------------------------------ *
   * 视图
   * ------------------------------------------------------------------ */

  function openView() {
    if (!state.unlocked) return;
    deps.closeMemo();
    state.viewOpen = true;
    document.body.classList.add('privacy-open');
    dom.view.hidden = false;
    setTab(state.tab);
    renderAll();
    resetIdleTimer();
  }

  async function lock(reason = 'manual', { silent = false } = {}) {
    clearTimeout(state.idleTimer);
    clearTimeout(state.hiddenTimer);
    clearTimeout(state.saveTimer);

    // 手动锁定前等待在途保存，并提交期间新增的编辑；最多 5 轮。
    // 空闲/隐藏/退出锁定优先立即清除，未完成的请求结果会因 epoch 变化被丢弃。
    if (reason === 'manual' && state.unlocked) {
      for (let i = 0; i < 5; i++) {
        if (state.savePromise) {
          await state.savePromise.catch(() => {});
        } else if (state.dirty) {
          await save().catch(() => {});
        } else {
          break;
        }
        if (state.saveError) break;
      }
    }

    state.epoch += 1;
    const wasUnlocked = state.unlocked;

    state.unlocked = false;
    state.dataKey = null;
    state.payload = null;
    state.viewOpen = false;
    state.selectedMemoId = null;
    state.dirty = false;
    state.pendingSave = false;
    state.saveError = false;
    state.editSeq = 0;
    state.savedSeq = 0;
    state.pendingSetup = null;
    state.pendingRecovery = '';
    if (reason === 'logout') {
      state.envelope = null;
      state.revision = 0;
    }

    if (state.copied) {
      state.copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText('').catch(() => {});
      }
    }

    document.body.classList.remove('privacy-open');
    if (dom) {
      clearDom();
      dom.view.hidden = true;
      if (dom.lockDialog.open) dom.lockDialog.close();
      if (dom.recoveryDialog.open) dom.recoveryDialog.close();
    }

    if (wasUnlocked && !silent && (reason === 'idle' || reason === 'hidden')) {
      deps.toast('隐私空间已自动锁定');
    }
  }

  function clearDom() {
    dom.groups.innerHTML = '';
    dom.groupForm.hidden = true;
    dom.groupName.value = '';
    dom.linksEmpty.hidden = true;
    dom.memoList.innerHTML = '';
    dom.memoListEmpty.hidden = true;
    dom.memoEditor.hidden = true;
    dom.memoEmpty.hidden = false;
    dom.memoTitle.value = '';
    dom.memoBody.value = '';
    dom.memoMeta.textContent = '';
    dom.status.textContent = '';
  }

  function setTab(tab) {
    state.tab = tab === 'memos' ? 'memos' : 'links';
    dom.tabs.forEach((button) => {
      const active = button.dataset.privacyTab === state.tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    dom.linksPanel.hidden = state.tab !== 'links';
    dom.memosPanel.hidden = state.tab !== 'memos';
    renderAll();
  }

  function renderAll() {
    if (!state.unlocked) return;
    renderGroups();
    renderMemos();
  }

  function renderGroups() {
    const groups = visibleGroups();
    dom.linksEmpty.hidden = groups.length > 0;
    dom.groups.innerHTML = groups
      .map((group) => {
        const links = group.links.filter((link) => !link.deletedAt);
        const linkRows = links.length
          ? links
              .map(
                (link) => `<div class="privacy-link-row">
                  <a href="${deps.escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${deps.escapeHTML(
                    link.title || link.url
                  )}</a>
                  <button class="mini-btn" type="button" data-action="delete-link" data-group-id="${deps.escapeHTML(
                    group.id
                  )}" data-link-id="${deps.escapeHTML(link.id)}" aria-label="删除链接" title="删除">×</button>
                </div>`
              )
              .join('')
          : '<p class="privacy-group-empty">暂无链接</p>';

        return `<section class="privacy-group" data-group-id="${deps.escapeHTML(group.id)}">
          <header class="privacy-group-head">
            <h3>${deps.escapeHTML(group.name)}</h3>
            <button class="mini-btn" type="button" data-action="delete-group" data-group-id="${deps.escapeHTML(
              group.id
            )}" aria-label="删除分组" title="删除分组">×</button>
          </header>
          <div class="privacy-group-links">${linkRows}</div>
          <form class="privacy-link-form" data-privacy-link-form="${deps.escapeHTML(group.id)}" hidden>
            <input type="text" data-field="title" maxlength="40" placeholder="名称" autocomplete="off" />
            <input type="text" data-field="url" maxlength="2048" placeholder="https://example.com" autocomplete="off" spellcheck="false" />
            <button class="btn btn-small btn-primary" type="submit">添加</button>
            <button class="btn btn-small" type="button" data-action="cancel-link">取消</button>
          </form>
          <button class="btn btn-small privacy-add-link" type="button" data-action="add-link" data-group-id="${deps.escapeHTML(
            group.id
          )}">+ 添加链接</button>
        </section>`;
      })
      .join('');
  }

  function onGroupsClick(event) {
    const action = event.target.closest('[data-action]');
    if (action) {
      const type = action.dataset.action;
      if (type === 'add-link') {
        const groupId = action.dataset.groupId;
        const form = dom.groups.querySelector(`[data-privacy-link-form="${cssEscape(groupId)}"]`);
        if (form) {
          form.hidden = false;
          form.querySelector('[data-field="title"]').focus();
        }
        return;
      }
      if (type === 'cancel-link') {
        const form = action.closest('form');
        if (form) form.hidden = true;
        return;
      }
      if (type === 'delete-link') {
        deleteLink(action.dataset.groupId, action.dataset.linkId);
        return;
      }
      if (type === 'delete-group') {
        deleteGroup(action.dataset.groupId);
      }
    }
  }

  function onLinkSubmit(event) {
    const form = event.target.closest('[data-privacy-link-form]');
    if (!form) return;
    event.preventDefault();
    const groupId = form.dataset.privacyLinkForm;
    const group = state.payload.groups.find((item) => item.id === groupId && !item.deletedAt);
    if (!group) return;

    const title = form.querySelector('[data-field="title"]').value.trim().slice(0, 40);
    const rawUrl = form.querySelector('[data-field="url"]').value.trim();
    const url = deps.normalizeURL(rawUrl);
    if (!url || !/^https?:\/\//i.test(url)) {
      deps.toast('请输入有效的 http(s) 网址');
      return;
    }
    if (group.links.length >= MAX_LINKS) {
      deps.toast(`每个分组最多 ${MAX_LINKS} 个链接`);
      return;
    }

    group.links.push({
      id: deps.uid(),
      title: title || url,
      url,
      updatedAt: deps.now(),
      deletedAt: null,
    });
    group.updatedAt = deps.now();
    scheduleSave();
    renderGroups();
  }

  function addGroup(name) {
    const trimmed = String(name || '').trim().slice(0, MAX_NAME);
    if (!trimmed) {
      deps.toast('请输入分组名称');
      return;
    }
    if (visibleGroups().length >= MAX_GROUPS) {
      deps.toast(`最多 ${MAX_GROUPS} 个私密分组`);
      return;
    }
    state.payload.groups.push({
      id: deps.uid(),
      name: trimmed,
      links: [],
      updatedAt: deps.now(),
      deletedAt: null,
    });
    dom.groupForm.hidden = true;
    dom.groupName.value = '';
    scheduleSave();
    renderGroups();
  }

  async function deleteGroup(groupId) {
    const group = state.payload.groups.find((item) => item.id === groupId && !item.deletedAt);
    if (!group) return;
    const confirmed = await deps.confirm({
      title: '删除私密分组',
      message: `确定删除「${group.name}」及其中 ${group.links.length} 个链接吗？`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    group.deletedAt = deps.now();
    group.updatedAt = group.deletedAt;
    markGroupLinksDeleted(group.links);
    scheduleSave();
    renderGroups();
    deps.toast('私密分组已删除');
  }

  function markGroupLinksDeleted(links) {
    for (const link of links) {
      link.deletedAt = deps.now();
      link.updatedAt = link.deletedAt;
      link.url = '';
      link.title = '';
    }
  }

  async function deleteLink(groupId, linkId) {
    const group = state.payload.groups.find((item) => item.id === groupId && !item.deletedAt);
    if (!group) return;
    const link = group.links.find((item) => item.id === linkId && !item.deletedAt);
    if (!link) return;
    const confirmed = await deps.confirm({
      title: '删除私密链接',
      message: `确定删除「${link.title || link.url}」吗？`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    link.deletedAt = deps.now();
    link.updatedAt = link.deletedAt;
    link.url = '';
    link.title = '';
    group.updatedAt = link.updatedAt;
    scheduleSave();
    renderGroups();
    deps.toast('私密链接已删除');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /* ---------------------------- 私密备忘录 ---------------------------- */

  function currentMemo() {
    if (!state.selectedMemoId) return null;
    return state.payload.memos.find((memo) => memo.id === state.selectedMemoId && !memo.deletedAt) || null;
  }

  function renderMemos() {
    const memos = visibleMemos().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    dom.memoListEmpty.hidden = memos.length > 0;
    dom.memoList.innerHTML = memos
      .map((memo) => {
        const title = memo.title || firstLine(memo.body) || '无标题';
        return `<button class="privacy-memo-item${memo.id === state.selectedMemoId ? ' is-active' : ''}" type="button" aria-current="${memo.id === state.selectedMemoId ? 'true' : 'false'}" data-privacy-memo="${deps.escapeHTML(memo.id)}">
          <span class="privacy-memo-item-title">${deps.escapeHTML(title)}</span>
          <span class="privacy-memo-item-meta">${deps.escapeHTML(deps.formatTime(memo.updatedAt))}</span>
        </button>`;
      })
      .join('');
    renderMemoEditor();
  }

  function renderMemoEditor() {
    const memo = currentMemo();
    if (!memo) {
      dom.memoEmpty.hidden = false;
      dom.memoEditor.hidden = true;
      return;
    }
    dom.memoEmpty.hidden = true;
    dom.memoEditor.hidden = false;
    if (document.activeElement !== dom.memoTitle) dom.memoTitle.value = memo.title;
    if (document.activeElement !== dom.memoBody) dom.memoBody.value = memo.body;
    dom.memoMeta.textContent = `更新于 ${deps.formatTime(memo.updatedAt)} · ${memo.body.length} / ${MAX_BODY} 字`;
  }

  function firstLine(text) {
    const line = String(text || '').split('\n').find((item) => item.trim());
    return line ? line.trim().slice(0, 60) : '';
  }

  function createMemo() {
    if (visibleMemos().length >= MAX_MEMOS) {
      deps.toast(`最多 ${MAX_MEMOS} 条私密备忘录`);
      return;
    }
    const timestamp = deps.now();
    const memo = {
      id: deps.uid(),
      title: '',
      body: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    state.payload.memos.unshift(memo);
    state.selectedMemoId = memo.id;
    scheduleSave();
    renderMemos();
    setTimeout(() => dom.memoTitle.focus(), 30);
  }

  function selectMemo(id) {
    state.selectedMemoId = id;
    renderMemos();
  }

  function onMemoInput() {
    const memo = currentMemo();
    if (!memo) return;
    if (dom.memoBody.value.length > MAX_BODY) {
      dom.memoBody.value = dom.memoBody.value.slice(0, MAX_BODY);
    }
    memo.title = dom.memoTitle.value.slice(0, MAX_TITLE);
    memo.body = dom.memoBody.value;
    memo.updatedAt = deps.now();
    scheduleSave();
    renderMemoEditor();
    const items = visibleMemos().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    dom.memoList.innerHTML = items
      .map((item) => {
        const title = item.title || firstLine(item.body) || '无标题';
        return `<button class="privacy-memo-item${item.id === state.selectedMemoId ? ' is-active' : ''}" type="button" aria-current="${item.id === state.selectedMemoId ? 'true' : 'false'}" data-privacy-memo="${deps.escapeHTML(item.id)}">
          <span class="privacy-memo-item-title">${deps.escapeHTML(title)}</span>
          <span class="privacy-memo-item-meta">${deps.escapeHTML(deps.formatTime(item.updatedAt))}</span>
        </button>`;
      })
      .join('');
  }

  async function deleteMemo() {
    const memo = currentMemo();
    if (!memo) return;
    const confirmed = await deps.confirm({
      title: '删除私密备忘录',
      message: '删除后会在同步到其他设备时一起消失，确定吗？',
      confirmText: '删除',
    });
    if (!confirmed) return;
    memo.deletedAt = deps.now();
    memo.updatedAt = memo.deletedAt;
    memo.title = '';
    memo.body = '';
    state.selectedMemoId = null;
    scheduleSave();
    renderMemos();
    deps.toast('私密备忘录已删除');
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function onShortcutKeydown(event) {
    event.preventDefault();
    event.stopPropagation();
    const combo = comboFromEvent(event);
    if (!combo) return;

    const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
    if (!hasModifier) {
      deps.toast('快捷键至少需要 Alt、Ctrl 或 ⌘');
      return;
    }
    if (RESERVED_SHORTCUTS.includes(combo)) {
      deps.toast('这个组合已被其他功能占用，请换一个');
      return;
    }
    applyShortcut(combo);
  }

  function applyShortcut(combo) {
    state.shortcut = combo;
    dom.shortcutInput.value = combo;
    deps.setShortcut(combo);
    dom.shortcutHint.textContent = `当前快捷键：${combo}。点击上方输入框后按下新组合键即可修改。`;
    deps.toast(`隐私空间快捷键已改为 ${combo}`);
  }

  async function refreshSettings() {
    if (!dom) return;
    state.shortcut = normalizeShortcut(deps.getShortcut()) || DEFAULT_SHORTCUT;
    dom.shortcutInput.value = state.shortcut;
    dom.shortcutHint.textContent = `当前快捷键：${state.shortcut}。点击上方输入框后按下新组合键即可修改。`;
    dom.settingsState.value = '读取中…';
    if (!deps.currentUser()) {
      dom.settingsState.value = '需登录';
      return;
    }
    try {
      const response = await deps.api('/api/v1/secrets/privacy');
      if (!response.ok) {
        dom.settingsState.value = '未知';
        return;
      }
      dom.settingsState.value = response.data && response.data.payload ? '已创建' : '未创建';
    } catch (error) {
      dom.settingsState.value = '未知';
    }
  }

  globalThis.QingdhPrivacy = {
    init,
    requestOpen,
    lock,
    refreshSettings,
    isUnlocked: () => state.unlocked,
    isOpen: () => state.viewOpen,
  };
})();
