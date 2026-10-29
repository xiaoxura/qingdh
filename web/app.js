/* ==========================================================================
 * 氢导航 — 交互
 * 纯原生 JS，无依赖。游客数据保存在本地，登录后与云端同步。
 * ========================================================================== */

(() => {
  'use strict';

  // Pure helpers live in lib/core.js and are unit-tested separately.
  // The classic-script UMD wrapper keeps the no-build workflow intact.
  const core = globalThis.QingdhCore;
  if (!core) throw new Error('QingdhCore is not loaded');
  const { escapeHTML, uid, toTimestamp, toTombstone, normalizeUrl, isURL, hostOf, faviconOf } = core;

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  const ASSET_VERSION = (() => {
    try {
      const src = document.currentScript && document.currentScript.src;
      return src ? new URL(src).searchParams.get('v') || '' : '';
    } catch (error) {
      return '';
    }
  })();
  const LEGACY_DATA_KEY = 'qingdh.data.v1';
  const GUEST_KEY = 'qingdh.data.v1:guest';
  const USER_KEY_PREFIX = 'qingdh.data.v1:user:';
  const PREFS_KEY = 'qingdh.prefs.v1';
  const SYNC_KEY_PREFIX = 'qingdh.sync.v1:user:';
  const GUEST_DIRTY_KEY = 'qingdh.guest-dirty.v1';
  const SNAPSHOT_KEY = 'qingdh.backup.v1';
  const BROADCAST_CHANNEL = 'qingdh';

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const SEASONS = ['default', 'spring', 'summer', 'autumn', 'winter'];
  const SIDEBAR_MODES = ['expanded', 'collapsed', 'hidden'];
  const SIDEBAR_SIDES = ['left', 'right'];
  const CLOCK_STYLES = ['editorial', 'minimal'];
  const HOUR_CYCLES = ['auto', 'h23', 'h12'];
  const GUEST_AVATAR_SVG =
    '<svg class="avatar-guest" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4" /><circle cx="12" cy="10" r="3" /><path d="M6.8 18.6c.9-2.5 2.8-3.8 5.2-3.8s4.3 1.3 5.2 3.8" /></svg>';

  function setAccountAvatar(element, user) {
    if (!element) return;
    if (!user) {
      element.innerHTML = GUEST_AVATAR_SVG;
      delete element.dataset.avatar;
      return;
    }

    const avatars = globalThis.QingdhAvatars;
    if (!avatars || !Array.isArray(avatars.library) || !avatars.library.length) {
      // 头像库加载失败时退回个人中心图标，不显示文字首字母。
      element.innerHTML = GUEST_AVATAR_SVG;
      delete element.dataset.avatar;
      return;
    }

    const index = avatars.indexFor(user);
    element.innerHTML = avatars.library[index];
    element.dataset.avatar = String(index);
  }

  const MAX_GROUPS = 50;
  const MAX_LINKS = 500;
  const SYNC_DEBOUNCE = 800;
  const VERIFY_TOKEN_PARAM = 'verify';
  const RESET_TOKEN_PARAM = 'reset_token';

  const SEARCH_HISTORY_KEY = 'qingdh.search-history.v1';
  const SEARCH_HISTORY_MAX = 80;

  const ENGINES = [
    {
      id: 'bing',
      name: 'Bing',
      bang: 'b',
      build: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    },
    {
      id: 'google',
      name: 'Google',
      bang: 'g',
      build: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    },
    {
      id: 'baidu',
      name: '百度',
      bang: 'bd',
      build: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    },
    {
      id: 'duckduckgo',
      name: 'DuckDuckGo',
      bang: 'd',
      build: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    },
    {
      id: 'metaso',
      name: '秘塔',
      bang: 'mt',
      build: (query) => `https://metaso.cn/?q=${encodeURIComponent(query)}`,
    },
  ];

  function normalizeCustomEngines(raw) {
    if (!Array.isArray(raw)) return [];
    const ids = new Set(ENGINES.map((engine) => engine.id));
    const bangs = new Set(ENGINES.map((engine) => engine.bang));
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

  function allEngines() {
    const custom = data && data.settings && Array.isArray(data.settings.customEngines)
      ? data.settings.customEngines
      : [];
    const all = [...ENGINES, ...custom];
    const order = data && data.settings && Array.isArray(data.settings.engineOrder)
      ? data.settings.engineOrder
      : [];
    if (!order.length) return all;
    const byId = new Map(all.map((engine) => [engine.id, engine]));
    const ordered = order.map((id) => byId.get(id)).filter(Boolean);
    const seen = new Set(ordered.map((engine) => engine.id));
    for (const engine of all) if (!seen.has(engine.id)) ordered.push(engine);
    return ordered;
  }

  function engineBuild(engine) {
    if (engine.template) {
      return (query) => engine.template.replaceAll('{query}', encodeURIComponent(query));
    }
    return engine.build;
  }

  const ICON_PLUS =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_X =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  const STATUS_SHORT = {
    guest: '本地保存',
    synced: '已同步',
    syncing: '同步中',
    dirty: '待同步',
    offline: '离线',
    paused: '待合并',
    error: '同步失败',
    auth: '登录已过期',
  };

  const STATUS_TEXT = {
    guest: '数据保存在本地',
    synced: '已同步',
    syncing: '同步中…',
    dirty: '有本地修改待同步',
    offline: '离线，修改已保存在本地',
    paused: '等待选择合并方式',
    error: '同步失败，稍后重试',
    auth: '登录已过期，请重新登录',
  };

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const dom = {
    clock: $('#clock'),
    today: $('#today'),
    greeting: $('#greeting'),

    sidebar: $('#sidebar'),
    brand: $('#brand-link'),
    sidebarCollapse: $('#sidebar-collapse'),
    sidebarHide: $('#sidebar-hide'),
    sidebarReveal: $('#sidebar-reveal'),
    sidebarOpen: $('#sidebar-open'),
    sidebarScrim: $('#sidebar-scrim'),
    homeNav: $('#home-nav'),
    memoNav: $('#memo-nav'),
    memoCount: $('#memo-count'),
    historyNav: $('#history-nav'),
    historyDialog: $('#history-dialog'),
    historyList: $('#history-list'),
    historySearch: $('#history-search'),
    historyKinds: $$('[data-history-kind]'),
    historyCount: $('#history-count'),
    historyClear: $('#history-clear'),

    searchForm: $('#search-form'),
    searchInput: $('#search-input'),
    engine: $('#engine'),
    engineBtn: $('#engine-btn'),
    engineName: $('#engine-name'),
    engineMenu: $('#engine-menu'),

    groups: $('#groups'),
    addLinkBtn: $('#add-link-btn'),
    addGroupBtn: $('#add-group-btn'),
    batchBtn: $('#batch-btn'),
    batchBar: $('#batch-bar'),
    batchCount: $('#batch-count'),
    batchTarget: $('#batch-target'),
    batchMove: $('#batch-move'),
    batchDuplicates: $('#batch-duplicates'),
    batchDelete: $('#batch-delete'),
    batchCancel: $('#batch-cancel'),

    themeBtn: $('#theme-btn'),
    themeLabel: $('#theme-label'),
    editBtn: $('#edit-btn'),
    settingsBtn: $('#settings-btn'),
    accountBtn: $('#account-btn'),
    accountLabel: $('#account-label'),
    accountAvatarMini: $('#account-avatar-mini'),
    syncBadge: $('#sync-badge'),
    syncBadgeText: $('#sync-badge-text'),

    linkDialog: $('#link-dialog'),
    linkForm: $('#link-form'),
    linkDialogTitle: $('#link-dialog-title'),
    linkTitle: $('#link-title'),
    linkUrl: $('#link-url'),
    linkUrlError: $('#link-url-error'),
    linkIcon: $('#link-icon'),
    linkGroup: $('#link-group'),
    linkGroupName: $('#link-group-name'),
    linkSubmit: $('#link-submit'),

    groupDialog: $('#group-dialog'),
    groupForm: $('#group-form'),
    groupDialogTitle: $('#group-dialog-title'),
    groupName: $('#group-name'),

    hubDialog: $('#hub-dialog'),
    hubTabs: $$('[data-hub-tab]'),
    hubCategory: $('#hub-category'),
    hubPanels: $$('[data-hub-panel]'),
    hubPanelTitle: $('#hub-panel-title'),
    hubPanelDesc: $('#hub-panel-desc'),
    hubBody: $('#hub-body'),
    hubFootNote: $('#hub-foot-note'),
    aiConfigSave: $('#ai-config-save'),
    aiConfigOpen: $('#ai-config-open'),
    setName: $('#set-name'),
    setDensity: $('#set-density'),
    setEngine: $('#set-engine'),
    engineConfigList: $('#engine-config-list'),
    aiEngineConfigList: $('#ai-engine-config-list'),
    engineAddOpen: $('#engine-add-open'),
    engineAddDialog: $('#engine-add-dialog'),
    engineNewName: $('#engine-new-name'),
    engineNewBang: $('#engine-new-bang'),
    engineNewUrl: $('#engine-new-url'),
    engineAddBtn: $('#engine-add-btn'),
    engineAddError: $('#engine-add-error'),
    setOpen: $('#set-open'),
    setTheme: $('#set-theme'),
    setClock: $('#set-clock'),
    setHour: $('#set-hour'),
    setSeconds: $('#set-seconds'),
    setSidebar: $('#set-sidebar'),
    setSidebarSide: $('#set-sidebar-side'),
    setSidebarHover: $('#set-sidebar-hover'),
    seasonPicker: $('#season-picker'),
    exportBtn: $('#export-btn'),
    importBtn: $('#import-btn'),
    importFile: $('#import-file'),
    jsonImportDialog: $('#json-import-dialog'),
    jsonImportSource: $('#json-import-source'),
    jsonImportSummary: $('#json-import-summary'),
    jsonImportError: $('#json-import-error'),
    jsonImportOk: $('#json-import-ok'),
    importBookmarksBtn: $('#import-bookmarks-btn'),
    bookmarksFile: $('#bookmarks-file'),
    bookmarkImportDialog: $('#bookmark-import-dialog'),
    bookmarkImportList: $('#bookmark-import-list'),
    bookmarkImportSummary: $('#bookmark-import-summary'),
    bookmarkImportOk: $('#bookmark-import-ok'),
    restoreSnapshotBtn: $('#restore-snapshot-btn'),
    resetBtn: $('#reset-btn'),

    accountGuest: $('#account-guest'),
    accountUser: $('#account-user'),
    accountAvatar: $('#account-avatar'),
    accountEmail: $('#account-email'),
    accountMeta: $('#account-meta'),
    accountSecurityOpen: $('#account-security-open'),
    authNote: $('#auth-note'),

    loginForm: $('#login-form'),
    loginEmail: $('#login-email'),
    loginPassword: $('#login-password'),
    loginError: $('#login-error'),
    loginSubmit: $('#login-submit'),
    forgotLink: $('#forgot-link'),
    resendLink: $('#resend-link'),

    registerForm: $('#register-form'),
    registerEmail: $('#register-email'),
    registerPassword: $('#register-password'),
    registerPassword2: $('#register-password2'),
    registerError: $('#register-error'),
    registerSubmit: $('#register-submit'),

    forgotForm: $('#forgot-form'),
    forgotEmail: $('#forgot-email'),
    forgotError: $('#forgot-error'),
    forgotSubmit: $('#forgot-submit'),
    forgotBack: $('#forgot-back'),

    syncText: $('#sync-text'),
    syncDot: $('#sync-dot'),
    syncNowBtn: $('#sync-now'),
    syncPanel: $('[data-hub-panel="sync"]'),
    syncGuestPanel: $('#sync-guest-panel'),
    syncManagerPanel: $('#sync-manager-panel'),
    syncCloudTotal: $('#sync-cloud-total'),
    syncLocalTotal: $('#sync-local-total'),
    syncPageState: $('#sync-page-state'),
    syncItemList: $('#sync-item-list'),
    syncAutoToggle: $('#sync-auto-toggle'),
    syncPageNow: $('#sync-page-now'),
    encryptionState: $('#encryption-state'),
    encryptionPanel: $('#encryption-panel'),
    encryptionHint: $('#encryption-hint'),
    encryptionEnable: $('#encryption-enable'),
    encryptionUnlock: $('#encryption-unlock'),
    encryptionChange: $('#encryption-change'),
    encryptDialog: $('#encrypt-dialog'),
    encryptForm: $('#encrypt-form'),
    encryptPassword: $('#encrypt-password'),
    encryptPassword2: $('#encrypt-password2'),
    encryptError: $('#encrypt-error'),
    encryptSubmit: $('#encrypt-submit'),
    recoveryDialog: $('#recovery-dialog'),
    recoveryCode: $('#recovery-code'),
    recoveryCopy: $('#recovery-copy'),
    recoveryDownload: $('#recovery-download'),
    recoveryConfirm: $('#recovery-confirm'),
    recoveryContinue: $('#recovery-continue'),
    recoveryError: $('#recovery-error'),
    unlockDialog: $('#unlock-dialog'),
    unlockForm: $('#unlock-form'),
    unlockMessage: $('#unlock-message'),
    unlockPassword: $('#unlock-password'),
    unlockRecoveryToggle: $('#unlock-recovery-toggle'),
    unlockRecoveryField: $('#unlock-recovery-field'),
    unlockRecovery: $('#unlock-recovery'),
    unlockRemember: $('#unlock-remember'),
    unlockRememberLine: $('#unlock-remember-line'),
    unlockRememberNote: $('#unlock-remember-note'),
    unlockError: $('#unlock-error'),
    unlockSubmit: $('#unlock-submit'),
    unlockLater: $('#unlock-later'),
    deviceState: $('#device-state'),
    deviceHint: $('#device-hint'),
    deviceForget: $('#device-forget'),
    passkeyState: $('#passkey-state'),
    passkeyHint: $('#passkey-hint'),
    passkeyEnable: $('#passkey-enable'),
    passkeyRemove: $('#passkey-remove'),
    passkeyDialog: $('#passkey-dialog'),
    passkeyError: $('#passkey-error'),
    passkeyVerify: $('#passkey-verify'),
    passkeyUsePassword: $('#passkey-use-password'),
    changeEncryptionDialog: $('#change-encryption-dialog'),
    changeEncryptionForm: $('#change-encryption-form'),
    changeEncryptionOld: $('#change-encryption-old'),
    changeEncryptionOldField: $('#change-encryption-old-field'),
    changeEncryptionRecoveryToggle: $('#change-encryption-recovery-toggle'),
    changeEncryptionRecoveryField: $('#change-encryption-recovery-field'),
    changeEncryptionRecovery: $('#change-encryption-recovery'),
    changeEncryptionNew: $('#change-encryption-new'),
    changeEncryptionNew2: $('#change-encryption-new2'),
    changeEncryptionError: $('#change-encryption-error'),
    changeEncryptionSubmit: $('#change-encryption-submit'),
    decryptFileDialog: $('#decrypt-file-dialog'),
    decryptFileForm: $('#decrypt-file-form'),
    decryptFilePassword: $('#decrypt-file-password'),
    decryptFileRecoveryToggle: $('#decrypt-file-recovery-toggle'),
    decryptFileRecoveryField: $('#decrypt-file-recovery-field'),
    decryptFileRecovery: $('#decrypt-file-recovery'),
    decryptFileError: $('#decrypt-file-error'),
    decryptFileSubmit: $('#decrypt-file-submit'),
    decryptFileCancel: $('#decrypt-file-cancel'),
    sessionsBlock: $('#sessions-block'),
    sessionsList: $('#sessions-list'),
    adminLink: $('#admin-link'),
    exportCloudBtn: $('#export-cloud'),
    logoutAllBtn: $('#logout-all'),
    logoutBtn: $('#logout'),
    deleteAccountBtn: $('#delete-account'),

    mergeDialog: $('#merge-dialog'),
    mergeTitle: $('#merge-title'),
    mergeMessage: $('#merge-message'),
    mergeDiff: $('#merge-diff'),

    resetDialog: $('#reset-dialog'),
    resetForm: $('#reset-form'),
    resetPassword: $('#reset-password'),
    resetPassword2: $('#reset-password2'),
    resetError: $('#reset-error'),
    resetSubmit: $('#reset-submit'),

    deleteDialog: $('#delete-dialog'),
    deleteForm: $('#delete-form'),
    deletePassword: $('#delete-password'),
    deleteError: $('#delete-error'),
    deleteSubmit: $('#delete-submit'),

    confirmDialog: $('#confirm-dialog'),
    confirmTitle: $('#confirm-title'),
    confirmMessage: $('#confirm-message'),
    confirmOk: $('#confirm-ok'),
    confirmCancel: $('#confirm-cancel'),

    toast: $('#toast'),
    toastMessage: $('#toast-message'),
    toastAction: $('#toast-action'),
  };

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    editing: false,
    linkEditId: null,
    groupEditId: null,
    engineMenuOpen: false,
    groupHighlightTimer: null,
    bookmarkImport: null,
    jsonImport: null,
    jsonImportSeq: 0,
    historyKind: 'all',
    historyRows: [],
    batchMode: false,
    batchSelected: new Set(),
    authView: 'login',
    pendingEmail: '',
    resetToken: '',
    mergeResolver: null,
    openLoginAfterInit: false,
    drawerOpen: false,
    drawerReturnFocus: null,
    hoverCollapsed: false,
  };

  const cryptoState = {
    enabled: false,
    unlocked: false,
    envelope: null,
    dataKeyRaw: null,
    pendingSetup: null,
    unlockResolver: null,
    fileDecryptResolver: null,
    fileDecryptEnvelope: null,
    vaultRemembered: false,
    vaultEnvelopeId: null,
    passkeyRegistered: false,
    passkeyResolver: null,
  };

  const sync = {
    user: null,
    revision: null,
    dirty: false,
    hasLocal: false,
    lastSyncedAt: null,
    status: 'guest',
    inFlight: false,
    timer: null,
    online: navigator.onLine !== false,
    // 编辑代次与会话代次：用于避免“请求成功时覆盖请求期间的新编辑”和
    // “账号切换后旧请求回写状态”。
    editSeq: 0,
    sessionSeq: 0,
    cloudData: null,
  };

  let prefs = loadPrefs();
  let data = createDefaultData();
  let confirmResolver = null;
  let toastTimer = null;
  let toastHideTimer = null;
  let toastActionHandler = null;
  let channel = null;
  let applyingRemote = false;
  let clockTimer = null;
  let clockFormat = null;
  let clockFormatKey = '';
  let clockMinuteKey = '';
  let mobileQuery = null;

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function now() {
    return Date.now();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      showToast('保存失败：浏览器本地存储不可用或已满');
      console.warn('保存失败', error);
      return false;
    }
  }

  function removeKey(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // ignore
    }
  }

  function hueOf(value) {
    let hash = 0;
    for (const char of String(value)) {
      hash = (hash * 31 + char.codePointAt(0)) % 360;
    }
    return hash;
  }

  function glyphOf(link) {
    const source = (link.title || hostOf(link.url) || '?').trim();
    const first = Array.from(source)[0] || '?';
    return /[a-z]/i.test(first) ? first.toUpperCase() : first;
  }

  function isDialogOpen() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  function isTypingTarget(target) {
    return (
      target instanceof Element &&
      Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    );
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /* ------------------------------------------------------------------ *
   * 数据模型（payload v2）
   * ------------------------------------------------------------------ */

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

  function normalizeData(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const customEngines = normalizeCustomEngines(rawSettings.customEngines);
    const knownEngines = [...ENGINES, ...customEngines];

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

  const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

  // 墓碑保留 30 天：超过后从本地文档里移除，避免数据无限增长。
  function pruneTombstones(doc) {
    const cutoff = Date.now() - TOMBSTONE_TTL;
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

  // 与服务端限额保持一致；超出时优先丢弃墓碑，再丢弃较早的项目。
  function enforceLimits(doc) {
    let dropped = 0;

    if (doc.groups.length > MAX_GROUPS) {
      const sorted = [...doc.groups].sort(
        (a, b) =>
          (a.deletedAt ? 1 : 0) - (b.deletedAt ? 1 : 0) || (a.updatedAt || 0) - (b.updatedAt || 0)
      );
      const keep = new Set(sorted.slice(0, MAX_GROUPS).map((group) => group.id));
      dropped += doc.groups.length - MAX_GROUPS;
      doc.groups = doc.groups.filter((group) => keep.has(group.id));
    }

    let total = 0;
    doc.groups.forEach((group) => {
      if (group.deletedAt) return;
      const sorted = [...group.links].sort(
        (a, b) =>
          (a.deletedAt ? 1 : 0) - (b.deletedAt ? 1 : 0) || (a.updatedAt || 0) - (b.updatedAt || 0)
      );
      const kept = [];
      sorted.forEach((link) => {
        if (total < MAX_LINKS) {
          kept.push(link);
          total++;
        } else {
          dropped++;
        }
      });
      kept.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      group.links = kept;
    });

    return dropped;
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

  function stampAll(doc) {
    const stamp = now();
    doc.settings.updatedAt = stamp;
    doc.groups.forEach((group) => {
      group.updatedAt = stamp;
      group.links.forEach((link) => {
        link.updatedAt = stamp;
      });
    });
    return doc;
  }

  /* ------------------------------------------------------------------ *
   * 存储
   * ------------------------------------------------------------------ */

  function currentKey() {
    return sync.user ? USER_KEY_PREFIX + sync.user.id : GUEST_KEY;
  }

  function syncMetaKey() {
    return sync.user ? SYNC_KEY_PREFIX + sync.user.id : '';
  }

  function persist() {
    writeJSON(currentKey(), data);
  }

  function readGuestDirty() {
    try {
      return localStorage.getItem(GUEST_DIRTY_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function writeGuestDirty(value) {
    try {
      if (value) localStorage.setItem(GUEST_DIRTY_KEY, '1');
      else localStorage.removeItem(GUEST_DIRTY_KEY);
    } catch (error) {
      // ignore
    }
  }

  function writeSyncMeta() {
    if (!sync.user) return;
    writeJSON(syncMetaKey(), {
      revision: sync.revision,
      lastSyncedAt: sync.lastSyncedAt,
      dirty: sync.dirty,
    });
  }

  function readSyncMeta() {
    if (!sync.user) return null;
    return readJSON(syncMetaKey());
  }

  function saveSnapshot(reason) {
    if (reason !== 'before-import' && countLinks(data) === 0 && countGroups(data) === 0) return true;
    return writeJSON(SNAPSHOT_KEY, { owner: currentKey(), at: now(), reason, data: clone(data) });
  }

  function readSnapshot() {
    const snapshot = readJSON(SNAPSHOT_KEY);
    if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.groups)) {
      return { status: 'missing', snapshot: null };
    }
    if (typeof snapshot.owner !== 'string' || !snapshot.owner) {
      return { status: 'legacy', snapshot: null };
    }
    if (snapshot.owner !== currentKey()) {
      return { status: 'other', snapshot: null };
    }
    return { status: 'ready', snapshot };
  }

  function updateSnapshotButton() {
    const result = readSnapshot();
    dom.restoreSnapshotBtn.hidden = result.status !== 'ready' && result.status !== 'legacy';
    dom.restoreSnapshotBtn.disabled = result.status === 'legacy';
    dom.restoreSnapshotBtn.textContent = result.status === 'legacy' ? '旧备份无法恢复' : '恢复备份';
    dom.restoreSnapshotBtn.title = result.status === 'legacy'
      ? '旧备份缺少账号归属，无法安全恢复'
      : '';
  }

  /* ------------------------------------------------------------------ *
   * 数据加载 / 迁移
   * ------------------------------------------------------------------ */

  function migrateLegacyStorage() {
    const legacy = readJSON(LEGACY_DATA_KEY);
    if (legacy && !readJSON(GUEST_KEY)) {
      const migrated = normalizeData(legacy);
      writeJSON(GUEST_KEY, migrated);

      const legacySettings = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
      if (typeof legacySettings.openInNewTab === 'boolean' && prefs.openInNewTabSource !== 'prefs') {
        prefs.openInNewTab = legacySettings.openInNewTab;
      }
      const wasModified = countLinks(legacy) > 0 || countGroups(legacy) > 0;
      if (wasModified) writeGuestDirty(true);
      savePrefs();
    }
    if (legacy) removeKey(LEGACY_DATA_KEY);
  }

  function loadPrefs() {
    const stored = readJSON(PREFS_KEY);
    const legacy = readJSON(LEGACY_DATA_KEY);
    const legacySettings = legacy && legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};

    const prefs = {
      theme: stored && ['auto', 'light', 'dark'].includes(stored.theme) ? stored.theme : 'auto',
      density: stored && stored.density === 'compact' ? 'compact' : 'comfortable',
      collapsedGroups:
        stored && stored.collapsedGroups && typeof stored.collapsedGroups === 'object' && !Array.isArray(stored.collapsedGroups)
          ? stored.collapsedGroups
          : {},
      season: stored && SEASONS.includes(stored.season) ? stored.season : 'default',
      openInNewTab:
        stored && typeof stored.openInNewTab === 'boolean'
          ? stored.openInNewTab
          : Boolean(legacySettings.openInNewTab),
      sidebar: stored && SIDEBAR_MODES.includes(stored.sidebar) ? stored.sidebar : 'expanded',
      sidebarSide: stored && SIDEBAR_SIDES.includes(stored.sidebarSide) ? stored.sidebarSide : 'left',
      sidebarRestore:
        stored && ['expanded', 'collapsed'].includes(stored.sidebarRestore)
          ? stored.sidebarRestore
          : stored && ['expanded', 'collapsed'].includes(stored.sidebar)
            ? stored.sidebar
            : 'expanded',
      sidebarAutoCollapse: Boolean(stored && stored.sidebarAutoCollapse === true),
      clockStyle: stored && CLOCK_STYLES.includes(stored.clockStyle) ? stored.clockStyle : 'editorial',
      showSeconds: Boolean(stored && stored.showSeconds === true),
      hourCycle: stored && HOUR_CYCLES.includes(stored.hourCycle) ? stored.hourCycle : 'auto',
      privacyShortcut:
        stored && typeof stored.privacyShortcut === 'string' && stored.privacyShortcut.trim()
          ? stored.privacyShortcut.trim()
          : 'Alt+Shift+P',
      autoSync: !stored || stored.autoSync !== false,
      syncScope: {
        groups: !stored || !stored.syncScope || stored.syncScope.groups !== false,
        settings: !stored || !stored.syncScope || stored.syncScope.settings !== false,
      },
    };
    if (!stored && ['auto', 'light', 'dark'].includes(legacySettings.theme)) {
      prefs.theme = legacySettings.theme;
    }
    prefs.openInNewTabSource = stored && typeof stored.openInNewTab === 'boolean' ? 'prefs' : 'legacy';
    return prefs;
  }

  function savePrefs() {
    const payload = {
      theme: prefs.theme,
      density: prefs.density,
      collapsedGroups: prefs.collapsedGroups,
      season: prefs.season,
      openInNewTab: prefs.openInNewTab,
      sidebar: prefs.sidebar,
      sidebarSide: prefs.sidebarSide,
      sidebarRestore: prefs.sidebarRestore,
      sidebarAutoCollapse: prefs.sidebarAutoCollapse,
      clockStyle: prefs.clockStyle,
      showSeconds: prefs.showSeconds,
      hourCycle: prefs.hourCycle,
      privacyShortcut: prefs.privacyShortcut,
      autoSync: prefs.autoSync,
      syncScope: prefs.syncScope,
    };
    if (!writeJSON(PREFS_KEY, payload)) return;
    prefs.openInNewTabSource = 'prefs';
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function directFaviconOf(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return `${parsed.origin}/favicon.ico`;
    } catch (error) {
      return '';
    }
  }

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
        ${ICON_X}
      </button>
    </div>`;
  }

  function renderGroup(group) {
    if (group.deletedAt) return '';
    const titleAttrs = state.editing ? ' role="button" tabindex="0" title="点击重命名分组"' : '';
    const actions = state.editing
      ? `<div class="group-actions">
          <button class="mini-btn" type="button" data-action="add-link" data-group-id="${escapeHTML(group.id)}" aria-label="在「${escapeHTML(group.name)}」中添加" title="添加">${ICON_PLUS}</button>
          <button class="mini-btn" type="button" data-action="delete-group" data-group-id="${escapeHTML(group.id)}" aria-label="删除分组「${escapeHTML(group.name)}」" title="删除分组">${ICON_X}</button>
        </div>`
      : '';

    const visibleLinks = group.links.filter((link) => !link.deletedAt);
    const links = visibleLinks.length
      ? group.links.map(renderLink).join('')
      : '<p class="group-empty">暂无链接</p>';
    const collapsed = !state.editing && Boolean(prefs.collapsedGroups[group.id]);

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

  function hydrateIcons() {
    $$('img.favicon', dom.groups).forEach((img) => {
      const reveal = () => {
        if (!img.isConnected) return;
        img.classList.add('is-loaded');
        const glyph = img.parentElement && img.parentElement.querySelector('.glyph');
        if (glyph) glyph.hidden = true;
      };
      const drop = () => {
        if (!img.isConnected) return;
        const fallback = img.dataset.fallback;
        if (fallback) {
          // 代理失败时只对当前这一枚图标直连一次；再失败才保留首字母。
          img.removeAttribute('data-fallback');
          img.classList.remove('is-loaded');
          img.src = fallback;
          return;
        }
        img.remove();
      };

      img.addEventListener('load', reveal);
      img.addEventListener('error', drop);

      if (img.complete) {
        if (img.naturalWidth > 0) reveal();
        else drop();
      }
    });
  }

  function render() {
    const visibleGroups = data.groups.filter((group) => !group.deletedAt);
    dom.groups.innerHTML = visibleGroups.length
      ? visibleGroups.map(renderGroup).join('')
      : '<p class="empty">还没有快捷方式，点击下方按钮添加一个吧</p>';

    dom.addGroupBtn.hidden = !state.editing;
    hydrateIcons();
  }

  /* ------------------------------------------------------------------ *
   * 时间 / 问候
   * ------------------------------------------------------------------ */

  function greetingFor(hour) {
    if (hour < 5) return '夜深了';
    if (hour < 9) return '早上好';
    if (hour < 12) return '上午好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    if (hour < 23) return '晚上好';
    return '夜深了';
  }

  function formatDateLine(date) {
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 星期${WEEKDAYS[date.getDay()]}`;
  }

  function clockFormatter() {
    const key = `${prefs.hourCycle}|${prefs.showSeconds ? 's' : 'm'}`;
    if (clockFormat && clockFormatKey === key) return clockFormat;

    const options = { hour: '2-digit', minute: '2-digit' };
    if (prefs.showSeconds) options.second = '2-digit';
    if (prefs.hourCycle === 'h23') options.hour12 = false;
    else if (prefs.hourCycle === 'h12') options.hour12 = true;

    try {
      clockFormat = new Intl.DateTimeFormat(undefined, options);
    } catch (error) {
      clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    clockFormatKey = key;
    return clockFormat;
  }

  function seasonForDate(date = new Date()) {
    const month = date.getMonth();
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'autumn';
    return 'winter';
  }

  function clockSeasonFor(date = new Date()) {
    // 手动选定四季时跟随选择；默认主题下按当前月份自动切换。
    const chosen = SEASONS.includes(prefs.season) ? prefs.season : 'default';
    return chosen === 'default' ? seasonForDate(date) : chosen;
  }

  function renderClock() {
    const date = new Date();
    const text = clockFormatter().format(date);
    const season = clockSeasonFor(date);
    const root = document.documentElement;

    if (root.dataset.clockSeason !== season) root.dataset.clockSeason = season;

    const minuteKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
    const minuteChanged = clockMinuteKey !== minuteKey;
    clockMinuteKey = minuteKey;

    if (dom.clock.textContent !== text) {
      dom.clock.textContent = text;
      // 仅在分钟变化时播放一次轻微过渡；显示秒时不每秒钟闪一下。
      if (minuteChanged) {
        dom.clock.classList.remove('is-ticking');
        void dom.clock.offsetWidth;
        dom.clock.classList.add('is-ticking');
      }
    }

    const iso = date.toISOString();
    if (dom.clock.getAttribute('datetime') !== iso) dom.clock.setAttribute('datetime', iso);

    const dateText = formatDateLine(date);
    if (dom.today.textContent !== dateText) dom.today.textContent = dateText;

    const greeting = data.settings.name
      ? `${greetingFor(date.getHours())}，${data.settings.name}`
      : greetingFor(date.getHours());
    if (dom.greeting.textContent !== greeting) dom.greeting.textContent = greeting;
  }

  // 无秒时钟只需在分钟边界唤醒；显示秒时按秒对齐，避免无意义的每秒重绘。
  function scheduleClock() {
    clearTimeout(clockTimer);
    const interval = prefs.showSeconds ? 1000 : 60000;
    const delay = interval - (Date.now() % interval) + 20;
    clockTimer = setTimeout(() => {
      renderClock();
      scheduleClock();
    }, delay);
  }

  function restartClock() {
    renderClock();
    scheduleClock();
  }

  /* ------------------------------------------------------------------ *
   * 侧栏
   * ------------------------------------------------------------------ */

  function isMobileLayout() {
    return Boolean(mobileQuery && mobileQuery.matches);
  }

  function sidebarMode() {
    if (isMobileLayout()) return 'expanded';
    const mode = SIDEBAR_MODES.includes(prefs.sidebar) ? prefs.sidebar : 'expanded';
    if (mode === 'expanded' && state.hoverCollapsed) return 'collapsed';
    return mode;
  }

  function applySidebar() {
    const root = document.documentElement;
    const mode = sidebarMode();

    root.dataset.sidebarSide = prefs.sidebarSide === 'right' ? 'right' : 'left';
    root.dataset.sidebar = mode;

    if (isMobileLayout()) {
      const open = state.drawerOpen;
      root.dataset.drawer = open ? 'open' : 'closed';
      dom.sidebarScrim.hidden = !open;
      dom.sidebar.inert = !open;
      if (open) dom.sidebar.removeAttribute('aria-hidden');
      else dom.sidebar.setAttribute('aria-hidden', 'true');
      dom.sidebarOpen.inert = open;
      dom.sidebarCollapse.setAttribute('aria-label', '关闭侧栏');
      dom.sidebarCollapse.title = '关闭侧栏';
      dom.sidebarCollapse.setAttribute('aria-expanded', String(open));
      dom.brand.removeAttribute('role');
      dom.brand.removeAttribute('aria-label');
      dom.brand.removeAttribute('aria-expanded');
      dom.brand.title = '氢导航';
    } else {
      delete root.dataset.drawer;
      dom.sidebarScrim.hidden = true;
      dom.sidebar.inert = false;
      dom.sidebar.removeAttribute('aria-hidden');
      const collapsed = mode === 'collapsed';
      dom.sidebarCollapse.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
      dom.sidebarCollapse.title = collapsed ? '展开侧栏 (Alt+S)' : '收起侧栏 (Alt+S)';
      dom.sidebarCollapse.setAttribute('aria-expanded', String(!collapsed && mode !== 'hidden'));

      if (collapsed) {
        // 收起后 Logo 本身就是展开入口：悬停显示箭头，点击展开。
        dom.brand.setAttribute('role', 'button');
        dom.brand.setAttribute('aria-label', '展开侧栏');
        dom.brand.setAttribute('aria-expanded', 'false');
        dom.brand.title = '展开侧栏 (Alt+S)';
      } else {
        dom.brand.removeAttribute('role');
        dom.brand.removeAttribute('aria-label');
        dom.brand.removeAttribute('aria-expanded');
        dom.brand.title = '氢导航';
      }
    }

    const hidden = mode === 'hidden';
    dom.sidebarReveal.hidden = !hidden || isMobileLayout();
    dom.sidebarHide.hidden = isMobileLayout();
    syncSettingsSidebarUI();
  }

  function syncSettingsSidebarUI() {
    if (!dom.setSidebar) return;
    dom.setSidebar.value = SIDEBAR_MODES.includes(prefs.sidebar) ? prefs.sidebar : 'expanded';
    dom.setSidebarSide.value = prefs.sidebarSide === 'right' ? 'right' : 'left';
    dom.setSidebarHover.checked = prefs.sidebarAutoCollapse;
    if (globalThis.QingdhSelect) {
      QingdhSelect.sync(dom.setSidebar);
      QingdhSelect.sync(dom.setSidebarSide);
      QingdhSelect.sync(dom.setClock);
      QingdhSelect.sync(dom.setHour);
    }
  }

  function setSidebarMode(mode, { persist = true } = {}) {
    if (!SIDEBAR_MODES.includes(mode)) return;
    if (isMobileLayout()) {
      if (mode === 'hidden') closeDrawer();
      else openDrawer();
      if (persist) {
        if (mode === 'hidden' && (prefs.sidebar === 'expanded' || prefs.sidebar === 'collapsed')) {
          prefs.sidebarRestore = prefs.sidebar;
        } else if (mode !== 'hidden') {
          prefs.sidebarRestore = mode;
        }
        prefs.sidebar = mode;
        savePrefs();
      }
      return;
    }
    state.hoverCollapsed = false;
    if (persist) {
      if (mode === 'hidden' && (prefs.sidebar === 'expanded' || prefs.sidebar === 'collapsed')) {
        // 记录隐藏前的可见状态，下次从隐藏唤出时保持原样。
        prefs.sidebarRestore = prefs.sidebar;
      } else if (mode !== 'hidden') {
        prefs.sidebarRestore = mode;
      }
      prefs.sidebar = mode;
      savePrefs();
    }
    applySidebar();
  }

  function restoreSidebarMode() {
    return prefs.sidebarRestore === 'collapsed' ? 'collapsed' : 'expanded';
  }

  function toggleSidebar() {
    if (isMobileLayout()) {
      if (state.drawerOpen) closeDrawer();
      else openDrawer();
      return;
    }
    const mode = sidebarMode();
    if (mode === 'hidden') {
      setSidebarMode(restoreSidebarMode());
      return;
    }
    setSidebarMode(mode === 'expanded' ? 'collapsed' : 'expanded');
  }

  function focusableInSidebar() {
    return $$('a[href], button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])', dom.sidebar).filter(
      (element) => element.offsetParent !== null || element === document.activeElement
    );
  }

  function openDrawer() {
    if (state.drawerOpen) return;
    state.drawerOpen = true;
    state.drawerReturnFocus = document.activeElement;
    applySidebar();
    const first = focusableInSidebar()[0];
    if (first) setTimeout(() => first.focus(), 30);
  }

  function closeDrawer({ restoreFocus = true } = {}) {
    if (!state.drawerOpen) return;
    state.drawerOpen = false;
    applySidebar();
    const target = state.drawerReturnFocus;
    state.drawerReturnFocus = null;
    if (restoreFocus && target && typeof target.focus === 'function') target.focus();
  }

  function trapDrawerFocus(event) {
    if (!state.drawerOpen || event.key !== 'Tab') return;
    const items = focusableInSidebar();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function applyClockPrefs() {
    const style = CLOCK_STYLES.includes(prefs.clockStyle) ? prefs.clockStyle : 'editorial';
    const cycle = HOUR_CYCLES.includes(prefs.hourCycle) ? prefs.hourCycle : 'auto';
    document.documentElement.dataset.clock = style;
    document.documentElement.dataset.hourCycle = cycle;
    clockFormat = null;
    clockFormatKey = '';
  }

  /* ------------------------------------------------------------------ *
   * 主题
   * ------------------------------------------------------------------ */

  function resolveTheme() {
    if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = resolveTheme();
    const season = SEASONS.includes(prefs.season) ? prefs.season : 'default';
    const root = document.documentElement;

    root.dataset.theme = theme;
    root.dataset.season = season;
    root.dataset.clockSeason = clockSeasonFor(new Date());

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const background = getComputedStyle(root).getPropertyValue('--bg').trim();
      meta.setAttribute('content', background || (theme === 'dark' ? '#0e1014' : '#f5f6f8'));
    }

    const label = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    dom.themeBtn.setAttribute('aria-label', label);
    dom.themeBtn.title = label;
    dom.themeLabel.textContent = theme === 'dark' ? '浅色' : '深色';
  }

  function applyDensity() {
    document.documentElement.dataset.density =
      prefs.density === 'compact' ? 'compact' : 'comfortable';
  }

  /* ------------------------------------------------------------------ *
   * 搜索引擎
   * ------------------------------------------------------------------ */

  function currentEngine() {
    return allEngines().find((engine) => engine.id === data.settings.engine) || ENGINES[0];
  }

  function buildEngineMenu() {
    dom.engineMenu.innerHTML = allEngines().map(
      (engine) =>
        `<button class="engine-option" type="button" role="option" data-engine="${engine.id}" aria-selected="false">
          <span>${escapeHTML(engine.name)}</span>
          ${engine.bang ? `<kbd>!${escapeHTML(engine.bang)}</kbd>` : ''}
        </button>`
    ).join('');
    updateEngineUI();
  }

  function updateEngineUI() {
    const engine = currentEngine();
    dom.engineName.textContent = engine.name;
    dom.engineBtn.setAttribute('aria-label', `选择搜索引擎，当前 ${engine.name}`);

    $$('.engine-option', dom.engineMenu).forEach((option) => {
      const selected = option.dataset.engine === engine.id;
      option.setAttribute('aria-selected', String(selected));
      option.tabIndex = selected ? 0 : -1;
    });
    if (globalThis.QingdhAI) QingdhAI.refreshModeLabel();
  }

  function engineHost(engine) {
    try {
      return new URL(engineBuild(engine)('q')).hostname.replace(/^www\./, '');
    } catch (error) {
      return '';
    }
  }

  function refreshEngineSelect() {
    if (!dom.setEngine) return;
    dom.setEngine.innerHTML = allEngines()
      .map((engine) => `<option value="${engine.id}">${escapeHTML(engine.name)}</option>`)
      .join('');
    if (dom.setDensity) dom.setDensity.value = prefs.density;
    dom.setEngine.value = data.settings.engine;
    if (globalThis.QingdhSelect) QingdhSelect.sync(dom.setEngine);
  }

  function renderEngineSettings() {
    if (!dom.engineConfigList) return;
    const selected = currentEngine().id;
    dom.engineConfigList.innerHTML = allEngines().map((engine) => {
      const active = engine.id === selected;
      const custom = Boolean(engine.template);
      return `<div class="engine-config-item${active ? ' is-default' : ''}" draggable="true" data-engine-id="${engine.id}">
        <span class="engine-drag-handle" aria-hidden="true" title="拖动排序">⠿</span>
        <div class="engine-config-copy">
          <span class="engine-config-name">${escapeHTML(engine.name)}</span>
          <span class="engine-config-host">${escapeHTML(engineHost(engine))}</span>
        </div>
        ${engine.bang ? `<kbd>!${escapeHTML(engine.bang)}</kbd>` : ''}
        ${
          active
            ? '<span class="engine-default-badge">默认</span>'
            : `<button class="btn btn-small" type="button" data-engine-default="${engine.id}">设为默认</button>`
        }
        ${
          custom
            ? `<button class="btn btn-small btn-quiet-danger" type="button" data-engine-remove="${engine.id}" aria-label="删除 ${escapeHTML(engine.name)}">删除</button>`
            : ''
        }
      </div>`;
    }).join('');
    renderAIEngineSettings();
  }

  function renderAIEngineSettings() {
    if (!dom.aiEngineConfigList) return;
    const providers = globalThis.QingdhAI && QingdhAI.providerSummaries
      ? QingdhAI.providerSummaries()
      : [];
    if (!providers.length) {
      dom.aiEngineConfigList.innerHTML =
        '<p class="engine-section-hint">登录并开启加密后，可在这里查看 AI 搜索供应商。</p>';
      return;
    }
    dom.aiEngineConfigList.innerHTML = providers
      .map((provider) => {
        const status = !provider.enabled
          ? '未启用'
          : provider.hasKey
            ? '已配置'
            : provider.mode === 'web'
              ? '网页型'
              : '未配置 Key';
        const mode =
          provider.mode === 'proxy' ? '服务端代理' : provider.mode === 'direct' ? '浏览器直连' : '网页';
        return `<div class="engine-config-item ai-engine-config-item" data-ai-config-row="${escapeHTML(
          provider.id
        )}">
          <span class="engine-ai-badge" aria-hidden="true">AI</span>
          <div class="engine-config-copy">
            <span class="engine-config-name">${escapeHTML(provider.label)}</span>
            <span class="engine-config-host">${mode} · ${status}</span>
          </div>
          <button class="btn btn-small" type="button" data-ai-config-open="${escapeHTML(
            provider.id
          )}">AI 配置</button>
        </div>`;
      })
      .join('');
  }

  function setDefaultEngine(id) {
    if (!allEngines().some((engine) => engine.id === id)) return;
    data.settings.engine = id;
    data.settings.updatedAt = now();
    commitLocalChange();
    updateEngineUI();
    syncSettingsUI();
  }

  function showEngineAddError(message) {
    dom.engineAddError.textContent = message;
    dom.engineAddError.hidden = false;
  }

  function addCustomEngine() {
    const name = dom.engineNewName.value.trim().slice(0, 20);
    const template = dom.engineNewUrl.value.trim().slice(0, 500);
    const bang = dom.engineNewBang.value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8);

    if (!name) {
      showEngineAddError('请填写搜索引擎名称');
      return;
    }
    if (!template.includes('{query}')) {
      showEngineAddError('搜索地址模板必须包含 {query}');
      return;
    }
    if (!/^https?:\/\//i.test(template)) {
      showEngineAddError('搜索地址模板必须以 http:// 或 https:// 开头');
      return;
    }
    try {
      new URL(template.replace('{query}', 'test'));
    } catch (error) {
      showEngineAddError('搜索地址模板格式不正确');
      return;
    }
    if ((data.settings.customEngines || []).length >= 20) {
      showEngineAddError('最多添加 20 个自定义搜索引擎');
      return;
    }
    if (bang && allEngines().some((engine) => engine.bang === bang)) {
      showEngineAddError(`快捷前缀 !${bang} 已被使用`);
      return;
    }

    const customId = `c-${uid()}`;
    data.settings.customEngines = [
      ...(data.settings.customEngines || []),
      { id: customId, name, template, bang },
    ];
    if (Array.isArray(data.settings.engineOrder) && data.settings.engineOrder.length) {
      data.settings.engineOrder = [...data.settings.engineOrder, customId];
    }
    data.settings.updatedAt = now();
    commitLocalChange();
    refreshEngineSelect();
    buildEngineMenu();
    renderEngineSettings();
    dom.engineNewName.value = '';
    dom.engineNewBang.value = '';
    dom.engineNewUrl.value = '';
    dom.engineAddError.hidden = true;
    if (dom.engineAddDialog && dom.engineAddDialog.open) dom.engineAddDialog.close();
    showToast(`已添加搜索引擎：${name}`);
  }

  async function removeCustomEngine(id) {
    const engine = allEngines().find((item) => item.id === id && item.template);
    if (!engine) return;
    const confirmed = await askConfirm({
      title: '删除搜索引擎',
      message: `确定删除「${engine.name}」？该操作会同步到其他设备。`,
      confirmText: '删除',
    });
    if (!confirmed) return;

    data.settings.customEngines = (data.settings.customEngines || []).filter((item) => item.id !== id);
    data.settings.engineOrder = (data.settings.engineOrder || []).filter((engineId) => engineId !== id);
    if (data.settings.engine === id) data.settings.engine = 'bing';
    data.settings.updatedAt = now();
    commitLocalChange();
    refreshEngineSelect();
    buildEngineMenu();
    updateEngineUI();
    renderEngineSettings();
    showToast(`已删除搜索引擎：${engine.name}`);
  }

  let engineDragId = null;

  function moveEngineOrder(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId) return;
    const ids = allEngines().map((engine) => engine.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    data.settings.engineOrder = ids;
    data.settings.updatedAt = now();
    commitLocalChange();
    buildEngineMenu();
    refreshEngineSelect();
    renderEngineSettings();
    showToast('搜索引擎顺序已更新');
  }

  function setEngineMenu(open) {
    state.engineMenuOpen = open;
    dom.engineMenu.hidden = !open;
    dom.engineBtn.setAttribute('aria-expanded', String(open));

    if (open) {
      const selected = $('.engine-option[aria-selected="true"]', dom.engineMenu);
      (selected || $('.engine-option', dom.engineMenu))?.focus();
    }
  }

  function selectEngine(id) {
    if (!ENGINES.some((engine) => engine.id === id)) return;
    data.settings.engine = id;
    data.settings.updatedAt = now();
    commitLocalChange();
    updateEngineUI();
    syncSettingsUI();
    setEngineMenu(false);
    dom.searchInput.focus();
  }

  /* ------------------------------------------------------------------ *
   * 搜索
   * ------------------------------------------------------------------ */

  function navigate(url) {
    if (prefs.openInNewTab) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } else {
      window.location.assign(url);
    }
  }

  function normalizeHistorySources(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (source) =>
          source &&
          typeof source.url === 'string' &&
          /^https?:\/\//i.test(source.url.trim())
      )
      .slice(0, 8)
      .map((source) => ({
        title: String(source.title || source.url).slice(0, 200),
        url: String(source.url).slice(0, 1000),
        snippet: String(source.snippet || '').slice(0, 400),
      }));
  }

  let searchHistoryCache = null;

  function readSearchHistory({ fresh = false } = {}) {
    if (!fresh && searchHistoryCache) return searchHistoryCache;
    try {
      const raw = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      searchHistoryCache = raw
        .filter((item) => item && typeof item.query === 'string' && item.query.trim())
        .map((item) => {
          const kind = item.kind === 'ai' ? 'ai' : 'web';
          if (kind === 'web' && typeof item.engineId !== 'string') return null;
          return {
            kind,
            query: item.query.slice(0, 500),
            at: Number(item.at) || Date.now(),
            engineId: kind === 'web' ? String(item.engineId || '').slice(0, 50) : '',
            engineName: kind === 'web' ? String(item.engineName || item.engineId).slice(0, 40) : '',
            providerId: kind === 'ai' ? String(item.providerId || '').slice(0, 50) : '',
            providerLabel: kind === 'ai' ? String(item.providerLabel || item.providerId || 'AI').slice(0, 40) : '',
            answer: kind === 'ai' ? String(item.answer || '').slice(0, 4000) : '',
            sources: kind === 'ai' ? normalizeHistorySources(item.sources) : [],
          };
        })
        .filter(Boolean)
        .slice(0, SEARCH_HISTORY_MAX);
      return searchHistoryCache;
    } catch (error) {
      searchHistoryCache = [];
      return searchHistoryCache;
    }
  }

  function writeSearchHistory(items) {
    const next = items.slice(0, SEARCH_HISTORY_MAX);
    searchHistoryCache = next;
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    } catch (error) {
      // 搜索历史是本地便利功能，存储失败不影响搜索。
    }
  }

  function recordSearch(query, engine) {
    const text = String(query || '').trim().slice(0, 500);
    if (!text || !engine) return;
    const items = readSearchHistory().filter(
      (item) => !(item.kind === 'web' && item.query === text && item.engineId === engine.id)
    );
    items.unshift({
      kind: 'web',
      query: text,
      engineId: engine.id,
      engineName: engine.name,
      at: Date.now(),
      providerId: '',
      providerLabel: '',
      answer: '',
      sources: [],
    });
    writeSearchHistory(items);
    if (dom.historyDialog && dom.historyDialog.open) renderSearchHistory();
  }

  function recordAIHistory(payload) {
    const text = String((payload && payload.query) || '').trim().slice(0, 500);
    const providerId = String((payload && payload.providerId) || '').slice(0, 50);
    if (!text || !providerId) return;
    const previous = readSearchHistory().find(
      (item) => item.kind === 'ai' && item.query === text && item.providerId === providerId
    );
    const answer = String((payload && payload.answer) || (previous && previous.answer) || '').slice(0, 4000);
    const sources =
      payload && Array.isArray(payload.sources) && payload.sources.length
        ? normalizeHistorySources(payload.sources)
        : previous && previous.sources
          ? previous.sources
          : [];
    const items = readSearchHistory().filter(
      (item) => !(item.kind === 'ai' && item.query === text && item.providerId === providerId)
    );
    items.unshift({
      kind: 'ai',
      query: text,
      providerId,
      providerLabel: String((payload && payload.providerLabel) || (previous && previous.providerLabel) || providerId).slice(0, 40),
      answer,
      sources,
      at: Date.now(),
      engineId: '',
      engineName: '',
    });
    writeSearchHistory(items);
    if (dom.historyDialog && dom.historyDialog.open) renderSearchHistory();
  }

  function getAIHistorySnapshot(query, providerId) {
    return (
      readSearchHistory().find(
        (item) => item.kind === 'ai' && item.query === query && (!providerId || item.providerId === providerId)
      ) || null
    );
  }

  function historyTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return `${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
  }

  function renderSearchHistory() {
    if (!dom.historyList || !dom.historyDialog) return;
    const items = readSearchHistory();
    const query = dom.historySearch.value.trim().toLocaleLowerCase();
    const filtered = items.filter((item) =>
        (state.historyKind === 'all' || item.kind === state.historyKind) &&
        (!query || [item.query, item.engineName, item.providerLabel]
          .some((value) => String(value || '').toLocaleLowerCase().includes(query)))
      );
    state.historyRows = filtered;
    if (dom.historyCount) {
      dom.historyCount.textContent = filtered.length === items.length
        ? `共 ${items.length} 条`
        : `显示 ${filtered.length} / ${items.length} 条`;
    }
    if (dom.historyClear) dom.historyClear.disabled = items.length === 0;
    if (!items.length) {
      dom.historyList.innerHTML =
        '<div class="history-empty"><strong>还没有搜索记录</strong><p>首页网页搜索和 AI 搜索都会记录在这里，只保存在当前浏览器。</p></div>';
      return;
    }
    if (!filtered.length) {
      dom.historyList.innerHTML = '<div class="history-empty"><strong>没有匹配的记录</strong><p>可以调整关键词或类型筛选。</p></div>';
      return;
    }
    dom.historyList.innerHTML = filtered
      .map((item, index) => {
        const isAI = item.kind === 'ai';
        const cached = isAI && Boolean(item.answer);
        const meta = isAI
          ? `AI · ${item.providerLabel || 'AI'}${cached ? ' · 查看缓存答案' : ''}`
          : item.engineName || '网页搜索';
        const snippet = isAI
          ? item.answer
              .replace(/[#*`>~]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120)
          : '';
        return `<div class="history-item${isAI ? ' is-ai' : ''}">
          <button class="history-main" type="button" data-history-open="${index}" data-history-action="${cached ? 'cache' : 'search'}" aria-label="${cached ? '查看缓存：' : '重新搜索：'}${escapeHTML(item.query)}">
            <span class="history-query-row">
              ${isAI ? '<span class="history-kind">AI</span>' : ''}
              <span class="history-query">${escapeHTML(item.query)}</span>
            </span>
            <span class="history-meta">${escapeHTML(meta)} · ${escapeHTML(historyTime(item.at))}</span>
            ${snippet ? `<span class="history-snippet">${escapeHTML(snippet)}</span>` : ''}
            ${isAI && !cached ? '<span class="history-snippet">无缓存答案，可重新搜索</span>' : ''}
          </button>
          ${cached ? `<button class="history-research" type="button" data-history-open="${index}" data-history-action="search" aria-label="重新搜索：${escapeHTML(item.query)}">重新搜索</button>` : ''}
          <button class="history-remove" type="button" data-history-remove="${index}" aria-label="删除这条搜索历史">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>`;
      })
      .join('');
  }

  function openSearchHistory() {
    readSearchHistory({ fresh: true });
    renderSearchHistory();
    if (dom.historyDialog && !dom.historyDialog.open) dom.historyDialog.showModal();
  }

  function openAIHistory(item, cached = false) {
    const query = encodeURIComponent(item.query);
    const provider = encodeURIComponent(item.providerId || '');
    const url = `/ai?q=${query}&provider=${provider}${cached ? '&cached=1' : ''}`;
    if (dom.historyDialog && dom.historyDialog.open) dom.historyDialog.close();
    const tab = window.open(url, '_blank');
    if (tab) tab.opener = null;
    else location.href = url;
  }

  function sameHistoryItem(a, b) {
    return a && b && a.kind === b.kind && a.query === b.query && a.at === b.at &&
      a.engineId === b.engineId && a.providerId === b.providerId;
  }

  function runHistorySearch(index, action = 'search') {
    const selected = state.historyRows[index];
    const item = readSearchHistory().find((candidate) => sameHistoryItem(candidate, selected));
    if (!item) return;
    if (item.kind === 'ai') {
      if (action === 'cache' && !item.answer) return;
      openAIHistory(item, action === 'cache');
      return;
    }
    const engine = allEngines().find((candidate) => candidate.id === item.engineId) || currentEngine();
    recordSearch(item.query, engine);
    if (dom.historyDialog && dom.historyDialog.open) dom.historyDialog.close();
    navigate(engineBuild(engine)(item.query));
  }

  function removeHistoryItem(index) {
    const items = readSearchHistory();
    const selected = state.historyRows[index];
    const actualIndex = items.findIndex((item) => sameHistoryItem(item, selected));
    if (actualIndex < 0) return;
    items.splice(actualIndex, 1);
    writeSearchHistory(items);
    renderSearchHistory();
  }

  async function clearSearchHistory() {
    if (!readSearchHistory().length) return;
    const confirmed = await askConfirm({
      title: '清空搜索历史',
      message: '只会删除当前浏览器中的搜索记录，不影响快捷方式或云端数据。',
      confirmText: '清空',
    });
    if (!confirmed) return;
    writeSearchHistory([]);
    renderSearchHistory();
    showToast('搜索历史已清空');
  }

  function handleSearch(event) {
    event.preventDefault();
    if (event.isComposing || dom.searchInput.dataset.composing === 'true') return;
    setEngineMenu(false);

    let query = dom.searchInput.value.trim();
    if (!query) {
      dom.searchInput.focus();
      return;
    }

    let engine = currentEngine();
    const bangMatch = query.match(/^!([a-z]+)\s+([\s\S]+)$/i);
    if (bangMatch) {
      const target = allEngines().find((item) => item.bang === bangMatch[1].toLowerCase());
      if (target) {
        engine = target;
        query = bangMatch[2].trim();
      }
    }

    if (isURL(query)) {
      navigate(normalizeUrl(query) || query);
      return;
    }
    if (globalThis.QingdhAI && QingdhAI.isActive()) {
      QingdhAI.openAsk(query);
      return;
    }
    recordSearch(query, engine);
    navigate(engineBuild(engine)(query));
  }

  function applySiteInfo(info) {
    if (!info) return;
    const name = String(info.name || '').trim().slice(0, 40) || '氢导航';
    const logo = String(info.logo || '').trim();
    document.title = name;
    const brandLink = document.getElementById('brand-link');
    const brandName = document.querySelector('.brand .sidebar-text');
    if (brandLink) brandLink.title = name;
    if (brandName) brandName.textContent = name;
    const mark = document.querySelector('.brand-mark');
    if (!mark) return;
    if (logo && /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(logo)) {
      mark.classList.add('has-image');
      mark.innerHTML = `<img src="${escapeHTML(logo)}" alt="" />`;
    } else {
      mark.classList.remove('has-image');
    }
  }

  async function loadSiteInfo() {
    try {
      const response = await fetch('/api/v1/site', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      applySiteInfo(await response.json());
    } catch (error) {
      // 默认品牌不需要阻塞首屏。
    }
  }

  function toggleGroup(id) {
    if (!id) return;
    const group = document.querySelector(`[data-group-id="${CSS.escape(id)}"]`);
    if (!group) return;
    const collapsed = group.classList.toggle('is-collapsed');
    if (collapsed) prefs.collapsedGroups[id] = true;
    else delete prefs.collapsedGroups[id];
    savePrefs();
    const button = group.querySelector('[data-action="toggle-group"]');
    if (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.title = collapsed ? '展开分组' : '收起分组';
      button.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}分组`);
      const path = button.querySelector('path');
      if (path) path.setAttribute('d', collapsed ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6');
    }
  }

  function jumpToGroup(id) {
    if (!id) return;
    if (globalThis.QingdhMemo && QingdhMemo.isOpen()) QingdhMemo.close();
    if (globalThis.QingdhPrivacy && QingdhPrivacy.isOpen()) {
      QingdhPrivacy.lock('navigate', { silent: true });
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    let group = document.querySelector(`[data-group-id="${CSS.escape(id)}"]`);
    if (!group) {
      showToast('没有找到该分组');
      return;
    }
    if (group.classList.contains('is-collapsed')) {
      toggleGroup(id);
      group = document.querySelector(`[data-group-id="${CSS.escape(id)}"]`);
    }
    group.scrollIntoView({ behavior: 'smooth', block: 'center' });
    group.classList.remove('is-highlighted');
    // Force a reflow so repeated jumps replay the highlight.
    void group.offsetWidth;
    group.classList.add('is-highlighted');
    clearTimeout(state.groupHighlightTimer);
    state.groupHighlightTimer = setTimeout(() => group.classList.remove('is-highlighted'), 1600);
  }

  function focusSearch() {
    setEngineMenu(false);
    dom.searchInput.focus();
    dom.searchInput.select();
  }

  /* ------------------------------------------------------------------ *
   * API
   * ------------------------------------------------------------------ */

  function authSupported() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  async function api(path, { method = 'GET', body = null, keepalive = false } = {}) {
    const options = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };
    if (keepalive) options.keepalive = true;
    if (body !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(path, options);
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          payload = null;
        }
      }
      return { status: response.status, ok: response.ok, data: payload, networkError: false };
    } catch (error) {
      return { status: 0, ok: false, data: null, networkError: true };
    }
  }

  function apiError(response, fallback) {
    return (response && response.data && response.data.error && response.data.error.message) || fallback;
  }

  /* ------------------------------------------------------------------ *
   * 账号状态
   * ------------------------------------------------------------------ */

  function setStatus(status) {
    sync.status = status;
    updateSyncUI();
  }

  /* ------------------------------------------------------------------ *
   * 客户端加密
   * ------------------------------------------------------------------ */

  function cryptoCacheKey() {
    return `qingdh.crypto.v1:${sync.user ? sync.user.id : 'guest'}`;
  }

  function cacheDataKey(raw) {
    try {
      sessionStorage.setItem(cryptoCacheKey(), QingdhCrypto.toBase64(raw));
    } catch (error) {
      // 隐私模式下不可用，只是每次刷新都要重新解锁。
    }
  }

  function readCachedDataKey() {
    try {
      const raw = sessionStorage.getItem(cryptoCacheKey());
      if (!raw) return null;
      return QingdhCrypto.fromBase64(raw);
    } catch (error) {
      return null;
    }
  }

  function clearCachedDataKey() {
    try {
      sessionStorage.removeItem(cryptoCacheKey());
    } catch (error) {
      // ignore
    }
  }

  function resetCryptoState() {
    clearCachedDataKey();
    cryptoState.enabled = false;
    cryptoState.unlocked = false;
    cryptoState.envelope = null;
    cryptoState.dataKeyRaw = null;
    cryptoState.pendingSetup = null;
    cryptoState.vaultRemembered = false;
    cryptoState.vaultEnvelopeId = null;
    if (globalThis.QingdhSecrets) QingdhSecrets.forget();
    if (globalThis.QingdhAI) QingdhAI.reset();
    if (globalThis.QingdhMemo) QingdhMemo.lock();
    if (globalThis.QingdhCommandPalette && QingdhCommandPalette.clearSuggestions) {
      QingdhCommandPalette.clearSuggestions();
    }
    if (globalThis.QingdhPrivacy) QingdhPrivacy.lock('logout', { silent: true });
    updateEncryptionUI();
    updateDeviceUI();
  }

  /* ------------------------------------------------------------------ *
   * Device Vault：本机记住解锁
   * ------------------------------------------------------------------ */

  function vaultSupported() {
    return Boolean(globalThis.QingdhDeviceVault && QingdhDeviceVault.supported());
  }

  async function envelopeFingerprint(envelope) {
    if (!envelope || !globalThis.QingdhCrypto) return null;
    try {
      return await QingdhCrypto.envelopeId(envelope);
    } catch (error) {
      return null;
    }
  }

  async function rememberDevice(envelope, dataKeyRaw) {
    if (!sync.user || !vaultSupported() || !envelope || !dataKeyRaw) return false;
    const fingerprint = await envelopeFingerprint(envelope);
    if (!fingerprint) return false;
    try {
      const ok = await QingdhDeviceVault.remember(sync.user.id, fingerprint, dataKeyRaw);
      if (ok) {
        cryptoState.vaultRemembered = true;
        cryptoState.vaultEnvelopeId = fingerprint;
      }
      updateDeviceUI();
      return ok;
    } catch (error) {
      return false;
    }
  }

  async function recallDevice(envelope) {
    if (!sync.user || !vaultSupported() || !envelope) return null;
    const fingerprint = await envelopeFingerprint(envelope);
    if (!fingerprint) return null;
    try {
      const raw = await QingdhDeviceVault.recall(sync.user.id, fingerprint);
      if (!raw) {
        cryptoState.vaultRemembered = false;
        updateDeviceUI();
        return null;
      }
      cryptoState.vaultRemembered = true;
      cryptoState.vaultEnvelopeId = fingerprint;
      updateDeviceUI();
      return raw;
    } catch (error) {
      return null;
    }
  }

  async function forgetDevice({ silent = false, clearMemory = true } = {}) {
    if (!sync.user || !globalThis.QingdhDeviceVault) return;
    try {
      await QingdhDeviceVault.forget(sync.user.id);
    } catch (error) {
      // IndexedDB 不可用时仍然清理内存状态。
    }
    cryptoState.vaultRemembered = false;
    cryptoState.vaultEnvelopeId = null;
    if (globalThis.QingdhDeviceVault) QingdhDeviceVault.revokeGate(sync.user.id);
    if (globalThis.QingdhPasskey) {
      QingdhPasskey.remove(sync.user.id).catch(() => {});
      cryptoState.passkeyRegistered = false;
    }
    if (clearMemory && cryptoState.dataKeyRaw) {
      cryptoState.dataKeyRaw = null;
      cryptoState.unlocked = false;
      clearCachedDataKey();
      updateEncryptionUI();
    }
    updateDeviceUI();
    if (!silent) showToast('已忘记此设备，下次需要重新输入加密密码');
  }

  async function refreshVaultState() {
    if (!sync.user || !vaultSupported()) {
      cryptoState.vaultRemembered = false;
      cryptoState.vaultEnvelopeId = null;
      updateDeviceUI();
      return;
    }
    const fingerprint = await envelopeFingerprint(cryptoState.envelope);
    try {
      const status = await QingdhDeviceVault.status(sync.user.id, fingerprint);
      cryptoState.vaultRemembered = Boolean(status.remembered && status.matches !== false);
      cryptoState.vaultEnvelopeId = cryptoState.vaultRemembered ? fingerprint : null;
    } catch (error) {
      cryptoState.vaultRemembered = false;
      cryptoState.vaultEnvelopeId = null;
    }
    updateDeviceUI();
  }

  function passkeySupported() {
    return Boolean(globalThis.QingdhPasskey && QingdhPasskey.supported());
  }

  async function refreshPasskeyUI() {
    if (!dom.passkeyState) return;
    if (!passkeySupported()) {
      cryptoState.passkeyRegistered = false;
      dom.passkeyState.textContent = 'Passkey：不可用';
      dom.passkeyState.classList.remove('is-on');
      dom.passkeyEnable.hidden = true;
      dom.passkeyRemove.hidden = true;
      dom.passkeyHint.textContent =
        (globalThis.QingdhPasskey && QingdhPasskey.unsupportedReason && QingdhPasskey.unsupportedReason()) ||
        '当前环境不支持 Passkey，仍可使用加密密码解锁。';
      return;
    }
    if (!sync.user) {
      cryptoState.passkeyRegistered = false;
      dom.passkeyState.textContent = 'Passkey：需登录';
      dom.passkeyEnable.hidden = true;
      dom.passkeyRemove.hidden = true;
      return;
    }

    let status = { registered: false };
    try {
      status = await QingdhPasskey.status(sync.user.id);
    } catch (error) {
      status = { registered: false };
    }
    cryptoState.passkeyRegistered = Boolean(status.registered);
    const platform = await QingdhPasskey.platformAvailable();

    dom.passkeyState.textContent = status.registered
      ? 'Passkey：已启用'
      : platform
        ? 'Passkey：未启用'
        : 'Passkey：设备不支持';
    dom.passkeyState.classList.toggle('is-on', Boolean(status.registered));
    dom.passkeyEnable.hidden = Boolean(status.registered) || !cryptoState.enabled || !platform;
    dom.passkeyRemove.hidden = !status.registered;

    if (status.registered && !platform) {
      dom.passkeyHint.textContent =
        '本机当前没有可用的系统生物识别，已注册的 Passkey 暂时无法使用；可移除后改用加密密码。';
    } else if (status.registered) {
      dom.passkeyHint.textContent =
        '下次打开页面可用 Touch ID / Windows Hello 解锁本机保存的密钥；移除后回退到加密密码。';
    } else if (!cryptoState.enabled) {
      dom.passkeyHint.textContent = '先开启数据加密，再启用生物识别解锁。';
    } else if (!platform) {
      dom.passkeyHint.textContent =
        '这台设备没有可用的 Touch ID / Windows Hello；仍可使用加密密码解锁，或换一台支持生物识别的设备。';
    } else {
      dom.passkeyHint.textContent =
        '启用后可用 Touch ID / Windows Hello 解锁本机保存的密钥；失败时始终可以输入加密密码。';
    }
  }

  function promptPasskey() {
    return new Promise((resolve) => {
      if (!passkeySupported() || !sync.user) {
        resolve(false);
        return;
      }
      if (cryptoState.passkeyResolver) cryptoState.passkeyResolver(false);
      cryptoState.passkeyResolver = resolve;
      dom.passkeyError.hidden = true;
      dom.passkeyVerify.disabled = false;
      dom.passkeyDialog.showModal();
      setTimeout(() => dom.passkeyVerify.focus(), 30);
    });
  }

  function resolvePasskey(value) {
    const resolve = cryptoState.passkeyResolver;
    cryptoState.passkeyResolver = null;
    if (dom.passkeyDialog.open) dom.passkeyDialog.close();
    if (resolve) resolve(value);
  }

  async function submitPasskey() {
    if (!sync.user) {
      resolvePasskey(false);
      return;
    }
    dom.passkeyVerify.disabled = true;
    dom.passkeyError.hidden = true;
    try {
      await QingdhPasskey.assert(sync.user.id);
      if (globalThis.QingdhDeviceVault) QingdhDeviceVault.grant(sync.user.id);
      resolvePasskey(true);
      refreshPasskeyUI();
    } catch (error) {
      dom.passkeyError.textContent =
        error && error.code === 'passkey_cancelled'
          ? '已取消生物识别，可以改用加密密码'
          : (error && error.message) || '生物识别验证失败';
      dom.passkeyError.hidden = false;
      dom.passkeyVerify.disabled = false;
    }
  }

  async function enablePasskey() {
    if (!sync.user) {
      showToast('请先登录');
      return;
    }
    if (!passkeySupported()) {
      showToast(
        (globalThis.QingdhPasskey && QingdhPasskey.unsupportedReason && QingdhPasskey.unsupportedReason()) ||
          '当前浏览器不支持 Passkey'
      );
      return;
    }
    if (!(await QingdhPasskey.platformAvailable())) {
      showToast('这台设备没有可用的系统生物识别，仍可使用加密密码');
      return;
    }
    if (!cryptoState.enabled) {
      showToast('请先开启数据加密');
      return;
    }
    if (!(await ensureDataKey())) {
      showToast('解锁云端数据后才能启用生物识别');
      return;
    }
    if (!cryptoState.envelope) {
      showToast('请先完成一次云端同步');
      return;
    }
    if (!cryptoState.vaultRemembered) {
      const remembered = await rememberDevice(cryptoState.envelope, cryptoState.dataKeyRaw);
      if (!remembered) {
        showToast('无法保存本机解锁密钥，请重试');
        return;
      }
    }

    dom.passkeyEnable.disabled = true;
    try {
      await QingdhPasskey.register(sync.user.id, sync.user.email);
      await QingdhDeviceVault.setPasskeyRequired(sync.user.id, true);
      QingdhDeviceVault.grant(sync.user.id);
      await refreshPasskeyUI();
      showToast('已启用生物识别解锁');
    } catch (error) {
      showToast(
        error && error.code === 'passkey_cancelled'
          ? '已取消生物识别注册'
          : (error && error.message) || '启用生物识别失败'
      );
    } finally {
      dom.passkeyEnable.disabled = false;
    }
  }

  async function removePasskey() {
    if (!sync.user) return;
    const confirmed = await askConfirm({
      title: '移除生物识别解锁',
      message: '移除后，下次打开页面需要输入加密密码。加密数据和恢复码不受影响。',
      confirmText: '移除',
    });
    if (!confirmed) return;
    try {
      await QingdhDeviceVault.setPasskeyRequired(sync.user.id, false);
      await QingdhPasskey.remove(sync.user.id);
      QingdhDeviceVault.revokeGate(sync.user.id);
      await refreshPasskeyUI();
      showToast('已移除生物识别解锁');
    } catch (error) {
      showToast('移除失败，请重试');
    }
  }

  function updateDeviceUI() {
    if (!dom.deviceState) return;
    const supported = vaultSupported();
    const remembered = Boolean(cryptoState.vaultRemembered);

    dom.deviceState.textContent = !supported ? '不可用' : remembered ? '已记住' : '未记住';
    dom.deviceState.classList.toggle('is-on', remembered);
    dom.deviceForget.hidden = !remembered;

    if (!supported) {
      dom.deviceHint.textContent = '当前浏览器不支持 IndexedDB，无法记住此设备。';
    } else if (!sync.user) {
      dom.deviceHint.textContent = '登录后可选择在这台设备上记住解锁。';
    } else if (!cryptoState.enabled) {
      dom.deviceHint.textContent = '开启数据加密后，可以选择在这台设备上记住解锁。';
    } else if (remembered) {
      dom.deviceHint.textContent = '这台设备已保存包裹后的密钥。忘记此设备或退出登录都会清除，之后需重新输入加密密码。';
    } else {
      dom.deviceHint.textContent = '首次解锁时勾选“在此设备上记住解锁”，之后打开页面不再输入加密密码。';
    }
  }

  function updateEncryptionUI() {
    if (!dom.encryptionState) return;

    const enabled = cryptoState.enabled;
    dom.encryptionState.textContent = enabled ? (cryptoState.unlocked ? '已开启' : '已锁定') : '未开启';
    dom.encryptionState.classList.toggle('is-on', enabled);
    dom.encryptionEnable.hidden = enabled;
    dom.encryptionUnlock.hidden = !(enabled && !cryptoState.unlocked);
    dom.encryptionChange.hidden = !(enabled && cryptoState.envelope);

    if (!enabled) {
      dom.encryptionHint.textContent = '开启后云端只保存密文，管理员也需要密码才能查看。';
    } else if (cryptoState.unlocked) {
      dom.encryptionHint.textContent = '云端只保存密文。修改密码只会重新包裹数据密钥，不会重新加密链接。';
    } else {
      dom.encryptionHint.textContent = '云端数据已加密，解锁后才能同步。';
    }

    updateDeviceUI();
  }

  function resolveUnlock(value) {
    const resolve = cryptoState.unlockResolver;
    cryptoState.unlockResolver = null;
    if (dom.unlockDialog.open) dom.unlockDialog.close();
    if (resolve) resolve(value);
  }

  function promptUnlock(envelope) {
    return new Promise((resolve) => {
      if (!globalThis.QingdhCrypto) {
        showToast('当前环境不支持加密，请使用 HTTPS 或 localhost');
        resolve(null);
        return;
      }
      cryptoState.unlockResolver = resolve;
      dom.unlockMessage.textContent = sync.user
        ? `账号 ${sync.user.email} 的云端数据已加密，请输入加密密码。`
        : '云端数据已加密，请输入加密密码。';
      dom.unlockPassword.value = '';
      dom.unlockRecovery.value = '';
      dom.unlockRecoveryToggle.checked = false;
      dom.unlockRecoveryField.hidden = true;
      dom.unlockRemember.checked = true;
      const canRemember = Boolean(sync.user && vaultSupported());
      dom.unlockRememberLine.hidden = !canRemember;
      dom.unlockRememberNote.hidden = !canRemember;
      dom.unlockError.hidden = true;
      dom.unlockSubmit.disabled = false;
      dom.unlockDialog.showModal();
      setTimeout(() => dom.unlockPassword.focus(), 30);
    });
  }

  async function decodePayload(payload) {
    const version = payload && Number(payload.version);
    if (version > 3) {
      const error = new Error('unsupported_version');
      error.code = 'unsupported_version';
      throw error;
    }
    if (version !== 3) {
      // 冲突处理曾把解密后的文档再次传进来；这种“明文”不是云端降级，
      // 不能因此关掉加密状态，否则后续上传会变成明文。
      if (cryptoState.enabled && cryptoState.unlocked) {
        return payload;
      }
      cryptoState.enabled = false;
      cryptoState.unlocked = false;
      cryptoState.envelope = null;
      cryptoState.dataKeyRaw = null;
      updateEncryptionUI();
      return payload;
    }

    cryptoState.enabled = true;
    cryptoState.envelope = payload;
    cryptoState.unlocked = false;
    updateEncryptionUI();

    if (!globalThis.QingdhCrypto) {
      const error = new Error('crypto_unavailable');
      error.code = 'crypto_unavailable';
      throw error;
    }
    if (!QingdhCrypto.isEncrypted(payload)) {
      const error = new Error('invalid_envelope');
      error.code = 'invalid_envelope';
      throw error;
    }

    if (cryptoState.dataKeyRaw) {
      try {
        const plain = await QingdhCrypto.unlockWithKey(payload, cryptoState.dataKeyRaw);
        cryptoState.unlocked = true;
        updateEncryptionUI();
        return plain;
      } catch (error) {
        cryptoState.dataKeyRaw = null;
        clearCachedDataKey();
      }
    }

    const cached = readCachedDataKey();
    if (cached) {
      try {
        const plain = await QingdhCrypto.unlockWithKey(payload, cached);
        cryptoState.dataKeyRaw = cached;
        cryptoState.unlocked = true;
        updateEncryptionUI();
        return plain;
      } catch (error) {
        clearCachedDataKey();
      }
    }

    // 本机 vault：同一设备首次解锁后，刷新/新标签页无需再次输入密码。
    // 启用 Passkey 后，先通过系统生物识别门禁；取消则回退到加密密码。
    if (sync.user && vaultSupported() && (await QingdhDeviceVault.requiresPasskey(sync.user.id))) {
      if (!QingdhDeviceVault.hasGate(sync.user.id)) {
        await promptPasskey();
      }
    }
    const vaultKey = await recallDevice(payload);
    if (vaultKey) {
      try {
        const plain = await QingdhCrypto.unlockWithKey(payload, vaultKey);
        cryptoState.dataKeyRaw = vaultKey;
        cryptoState.unlocked = true;
        cacheDataKey(vaultKey);
        updateEncryptionUI();
        return plain;
      } catch (error) {
        cryptoState.vaultRemembered = false;
        if (sync.user && globalThis.QingdhDeviceVault) {
          QingdhDeviceVault.forget(sync.user.id).catch(() => {});
        }
        updateDeviceUI();
      }
    }

    const opened = await promptUnlock(payload);
    if (!opened) {
      cryptoState.unlocked = false;
      updateEncryptionUI();
      const error = new Error('unlock_cancelled');
      error.code = 'unlock_cancelled';
      throw error;
    }

    cryptoState.dataKeyRaw = opened.dataKeyRaw;
    cryptoState.unlocked = true;
    cacheDataKey(opened.dataKeyRaw);
    updateEncryptionUI();
    return opened.payload;
  }

  async function ensureUnlockedForPush() {
    if (!cryptoState.enabled) return true;
    if (cryptoState.dataKeyRaw) return true;

    if (!cryptoState.envelope) {
      const response = await api('/api/v1/workspace');
      if (!response.ok) return false;
      try {
        await decodePayload(response.data.payload);
      } catch (error) {
        return false;
      }
      return !cryptoState.enabled || Boolean(cryptoState.dataKeyRaw);
    }

    const opened = await promptUnlock(cryptoState.envelope);
    if (!opened) return false;
    cryptoState.dataKeyRaw = opened.dataKeyRaw;
    cryptoState.unlocked = true;
    cacheDataKey(opened.dataKeyRaw);
    updateEncryptionUI();
    return true;
  }

  async function ensureDataKey() {
    if (cryptoState.dataKeyRaw) return true;
    if (!cryptoState.enabled) return false;

    if (cryptoState.envelope) {
      const opened = await promptUnlock(cryptoState.envelope);
      if (!opened) return false;
      cryptoState.dataKeyRaw = opened.dataKeyRaw;
      cryptoState.unlocked = true;
      cacheDataKey(opened.dataKeyRaw);
      updateEncryptionUI();
      return true;
    }

    // Envelope not loaded yet: a sync pulls and unlocks it.
    await syncNow();
    return Boolean(cryptoState.dataKeyRaw);
  }

  function syncScopedData() {
    const next = normalizeData(data);
    const cloud = sync.cloudData;
    if (prefs.syncScope.groups === false) {
      next.groups = cloud ? cloud.groups : [];
    }
    if (prefs.syncScope.settings === false) {
      next.settings = cloud
        ? cloud.settings
        : { name: '', engine: 'bing', customEngines: [], updatedAt: 0 };
    }
    return next;
  }

  async function payloadForUpload() {
    const payloadData = syncScopedData();
    if (!cryptoState.enabled) return payloadData;
    if (!cryptoState.dataKeyRaw || !cryptoState.envelope) {
      throw new Error('encryption_locked');
    }
    return QingdhCrypto.seal(cryptoState.envelope, cryptoState.dataKeyRaw, payloadData);
  }

  async function putWorkspacePayload(payload, baseRevision) {
    return api('/api/v1/workspace', {
      method: 'PUT',
      body: { baseRevision, payload },
    });
  }

  function showEncryptError(message) {
    dom.encryptError.textContent = message;
    dom.encryptError.hidden = false;
  }

  function showRecoveryError(message) {
    dom.recoveryError.textContent = message;
    dom.recoveryError.hidden = false;
  }

  function openEncryptDialog() {
    if (!sync.user || cryptoState.enabled) return;
    dom.encryptForm.reset();
    dom.encryptError.hidden = true;
    dom.encryptSubmit.disabled = false;
    dom.encryptDialog.showModal();
    setTimeout(() => dom.encryptPassword.focus(), 30);
  }

  async function submitEncrypt(event) {
    event.preventDefault();
    const password = dom.encryptPassword.value;
    const confirm = dom.encryptPassword2.value;
    dom.encryptError.hidden = true;

    if (password.length < 8) {
      showEncryptError('加密密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      showEncryptError('两次输入的密码不一致');
      return;
    }
    if (!globalThis.QingdhCrypto) {
      showEncryptError('当前环境不支持加密，请使用 HTTPS 或 localhost');
      return;
    }

    dom.encryptSubmit.disabled = true;
    try {
      await syncNow();
      if (sync.revision == null) {
        throw new Error('请先完成一次云端同步');
      }
      if (cryptoState.enabled) {
        throw new Error('云端数据已经开启加密');
      }
      const created = await QingdhCrypto.setup(password, data);
      cryptoState.pendingSetup = created;
      dom.encryptDialog.close();
      dom.recoveryCode.textContent = QingdhCrypto.formatRecoveryCode(created.recoveryCode);
      dom.recoveryConfirm.checked = false;
      dom.recoveryContinue.disabled = false;
      dom.recoveryError.hidden = true;
      dom.recoveryDialog.showModal();
    } catch (error) {
      showEncryptError(error && error.message ? error.message : '开启加密失败');
    } finally {
      dom.encryptSubmit.disabled = false;
    }
  }

  async function finishEncryption() {
    const pending = cryptoState.pendingSetup;
    if (!pending) return;
    if (!dom.recoveryConfirm.checked) {
      showRecoveryError('请先勾选“我已把恢复码保存在离线、安全的地方”');
      dom.recoveryConfirm.focus();
      return;
    }

    dom.recoveryContinue.disabled = true;
    dom.recoveryError.hidden = true;
    try {
      const response = await putWorkspacePayload(pending.envelope, sync.revision == null ? 0 : sync.revision);
      if (response.status === 401) {
        await handleAuthLost();
        return;
      }
      if (response.status === 409) {
        showRecoveryError('云端已在其他地方更新，请关闭后重新开启加密');
        return;
      }
      if (!response.ok) {
        showRecoveryError(apiError(response, '上传加密数据失败'));
        return;
      }

      sync.revision = response.data.revision;
      sync.dirty = false;
      sync.hasLocal = true;
      sync.lastSyncedAt = now();
      cryptoState.enabled = true;
      cryptoState.unlocked = true;
      cryptoState.envelope = pending.envelope;
      cryptoState.dataKeyRaw = pending.dataKeyRaw;
      cryptoState.pendingSetup = null;
      cacheDataKey(pending.dataKeyRaw);
      await rememberDevice(pending.envelope, pending.dataKeyRaw);
      writeSyncMeta();
      writeGuestDirty(false);
      persist();
      updateEncryptionUI();
      setStatus('synced');
      dom.recoveryDialog.close();
      showToast('云端数据已加密');
    } catch (error) {
      showRecoveryError(error && error.message ? error.message : '上传加密数据失败');
    } finally {
      dom.recoveryContinue.disabled = false;
    }
  }

  function copyRecoveryCode() {
    const code = dom.recoveryCode.textContent;
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(
        () => showToast('恢复码已复制'),
        () => showToast('复制失败，请手动选择')
      );
    } else {
      showToast('请手动选择恢复码复制');
    }
  }

  function downloadRecoveryCode() {
    const code = dom.recoveryCode.textContent;
    if (!code) return;
    const text = [
      '氢导航 · 云端数据恢复码',
      '',
      code,
      '',
      `账号：${sync.user ? sync.user.email : ''}`,
      `生成时间：${new Date().toLocaleString()}`,
      '',
      '忘记加密密码时，用这个恢复码解锁云端数据。',
      '请离线保存，不要发给任何人。',
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'qingdh-recovery-code.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function openChangeEncryptionDialog() {
    if (!cryptoState.enabled) return;
    dom.changeEncryptionForm.reset();
    dom.changeEncryptionOldField.hidden = false;
    dom.changeEncryptionRecoveryField.hidden = true;
    dom.changeEncryptionError.hidden = true;
    dom.changeEncryptionSubmit.disabled = false;
    dom.changeEncryptionDialog.showModal();
    setTimeout(() => dom.changeEncryptionOld.focus(), 30);
  }

  async function submitChangeEncryption(event) {
    event.preventDefault();
    const useRecovery = dom.changeEncryptionRecoveryToggle.checked;
    const oldPassword = dom.changeEncryptionOld.value;
    const recoveryCode = dom.changeEncryptionRecovery.value.trim();
    const newPassword = dom.changeEncryptionNew.value;
    const confirm = dom.changeEncryptionNew2.value;
    dom.changeEncryptionError.hidden = true;

    if (newPassword.length < 8) {
      dom.changeEncryptionError.textContent = '新密码至少 8 位';
      dom.changeEncryptionError.hidden = false;
      return;
    }
    if (newPassword !== confirm) {
      dom.changeEncryptionError.textContent = '两次输入的新密码不一致';
      dom.changeEncryptionError.hidden = false;
      return;
    }
    if (useRecovery && !recoveryCode) {
      dom.changeEncryptionError.textContent = '请输入恢复码';
      dom.changeEncryptionError.hidden = false;
      return;
    }
    if (!useRecovery && !oldPassword) {
      dom.changeEncryptionError.textContent = '请输入当前加密密码';
      dom.changeEncryptionError.hidden = false;
      return;
    }

    dom.changeEncryptionSubmit.disabled = true;
    try {
      if (!cryptoState.envelope) throw new Error('请先解锁云端数据');
      const updated = useRecovery
        ? await QingdhCrypto.rewrapWithRecovery(cryptoState.envelope, recoveryCode, newPassword)
        : await QingdhCrypto.rewrap(cryptoState.envelope, oldPassword, newPassword);
      const response = await putWorkspacePayload(updated, sync.revision == null ? 0 : sync.revision);
      if (response.status === 401) {
        await handleAuthLost();
        return;
      }
      if (response.status === 409) {
        throw new Error('云端已在其他地方更新，请同步后重试');
      }
      if (!response.ok) {
        throw new Error(apiError(response, '保存失败'));
      }
      sync.revision = response.data.revision;
      sync.lastSyncedAt = now();
      cryptoState.envelope = updated;
      writeSyncMeta();
      updateEncryptionUI();
      dom.changeEncryptionDialog.close();
      showToast('加密密码已更新');
    } catch (error) {
      const message = error && error.code === 'unlock_failed'
        ? (useRecovery ? '恢复码不正确' : '当前加密密码不正确')
        : (error.message || '保存失败');
      dom.changeEncryptionError.textContent = message;
      dom.changeEncryptionError.hidden = false;
    } finally {
      dom.changeEncryptionSubmit.disabled = false;
    }
  }

  async function unlockFromPanel() {
    if (!cryptoState.enabled) return;
    if (!cryptoState.envelope) {
      await syncNow();
      return;
    }
    const opened = await promptUnlock(cryptoState.envelope);
    if (!opened) return;
    cryptoState.dataKeyRaw = opened.dataKeyRaw;
    cryptoState.unlocked = true;
    cacheDataKey(opened.dataKeyRaw);
    updateEncryptionUI();
    await syncNow();
  }

  async function submitUnlock(event) {
    event.preventDefault();
    const useRecovery = dom.unlockRecoveryToggle.checked;
    const secret = useRecovery ? dom.unlockRecovery.value.trim() : dom.unlockPassword.value;
    dom.unlockError.hidden = true;

    if (!secret) {
      dom.unlockError.textContent = useRecovery ? '请输入恢复码' : '请输入加密密码';
      dom.unlockError.hidden = false;
      return;
    }
    if (!cryptoState.envelope) {
      dom.unlockError.textContent = '无法获取加密数据，请关闭后重新同步';
      dom.unlockError.hidden = false;
      return;
    }

    dom.unlockSubmit.disabled = true;
    try {
      const opened = useRecovery
        ? await QingdhCrypto.unlockWithRecovery(cryptoState.envelope, secret)
        : await QingdhCrypto.unlock(cryptoState.envelope, secret);
      cryptoState.dataKeyRaw = opened.dataKeyRaw;
      cryptoState.unlocked = true;
      cacheDataKey(opened.dataKeyRaw);
      updateEncryptionUI();
      if (dom.unlockRemember.checked) {
        await rememberDevice(cryptoState.envelope, opened.dataKeyRaw);
      }
      resolveUnlock(opened);
      setStatus('synced');
    } catch (error) {
      dom.unlockError.textContent = error && error.code === 'crypto_unavailable'
        ? '当前环境不支持加密，请使用 HTTPS 或 localhost'
        : (useRecovery ? '恢复码不正确' : '加密密码不正确');
      dom.unlockError.hidden = false;
      dom.unlockSubmit.disabled = false;
    }
  }

  function resolveDecryptFile(value) {
    const resolve = cryptoState.fileDecryptResolver;
    cryptoState.fileDecryptResolver = null;
    cryptoState.fileDecryptEnvelope = null;
    if (dom.decryptFileDialog.open) dom.decryptFileDialog.close();
    if (resolve) resolve(value);
  }

  function promptDecryptFile(envelope) {
    return new Promise((resolve) => {
      if (cryptoState.fileDecryptResolver) resolve(null);
      cryptoState.fileDecryptResolver = resolve;
      cryptoState.fileDecryptEnvelope = envelope;
      dom.decryptFileForm.reset();
      dom.decryptFileRecoveryField.hidden = true;
      dom.decryptFileError.hidden = true;
      dom.decryptFileSubmit.disabled = false;
      dom.decryptFileDialog.showModal();
      setTimeout(() => dom.decryptFilePassword.focus(), 30);
    });
  }

  async function submitDecryptFile(event) {
    event.preventDefault();
    const envelope = cryptoState.fileDecryptEnvelope;
    if (!envelope) return;
    const useRecovery = dom.decryptFileRecoveryToggle.checked;
    const secret = useRecovery ? dom.decryptFileRecovery.value.trim() : dom.decryptFilePassword.value;
    dom.decryptFileError.hidden = true;
    if (!secret) {
      dom.decryptFileError.textContent = useRecovery ? '请输入恢复码' : '请输入加密密码';
      dom.decryptFileError.hidden = false;
      return;
    }

    dom.decryptFileSubmit.disabled = true;
    try {
      const opened = useRecovery
        ? await QingdhCrypto.unlockWithRecovery(envelope, secret)
        : await QingdhCrypto.unlock(envelope, secret);
      resolveDecryptFile(opened.payload);
    } catch (error) {
      dom.decryptFileError.textContent = useRecovery ? '恢复码不正确' : '加密密码不正确';
      dom.decryptFileError.hidden = false;
      dom.decryptFileSubmit.disabled = false;
    }
  }

  function documentLinkCount(doc) {
    if (!doc || !Array.isArray(doc.groups)) return 0;
    return doc.groups.reduce(
      (total, group) => total + (Array.isArray(group.links) ? group.links.length : 0),
      0
    );
  }

  function documentGroupCount(doc) {
    return doc && Array.isArray(doc.groups) ? doc.groups.length : 0;
  }

  function cachedSecretCount(kind) {
    if (!globalThis.QingdhSecrets) return null;
    const entry = QingdhSecrets.getCached(kind);
    if (!entry || !entry.plain) return null;
    const plain = entry.plain;
    if (kind === 'ai') {
      return Array.isArray(plain.providers) ? plain.providers.length : 0;
    }
    if (kind === 'memo') {
      return Array.isArray(plain.memos)
        ? plain.memos.filter((memo) => memo && !memo.deletedAt).length
        : 0;
    }
    if (kind === 'privacy') {
      const links = (Array.isArray(plain.groups) ? plain.groups : []).reduce(
        (total, group) => total + (Array.isArray(group.links) ? group.links.length : 0),
        0
      );
      const memos = Array.isArray(plain.memos)
        ? plain.memos.filter((memo) => memo && !memo.deletedAt).length
        : 0;
      return links + memos;
    }
    return 0;
  }

  function syncSecretRow(label, kind, description) {
    const count = cachedSecretCount(kind);
    return `<div class="sync-item sync-item-static">
      <span class="sync-item-lock" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      </span>
      <span class="sync-item-copy">
        <strong>${escapeHTML(label)}</strong>
        <small>${escapeHTML(description)} · ${
          count == null ? '尚未载入' : `已载入 ${count} 项`
        }</small>
      </span>
      <span class="sync-tag">主加密</span>
    </div>`;
  }

  function renderSyncManager() {
    if (!dom.syncManagerPanel || !dom.syncGuestPanel) return;
    const loggedIn = Boolean(sync.user);
    dom.syncGuestPanel.hidden = loggedIn;
    dom.syncManagerPanel.hidden = !loggedIn;
    if (!loggedIn) return;

    const localLinks = documentLinkCount(data);
    const localGroups = documentGroupCount(data);
    const cloudDoc = sync.cloudData || data;
    const cloudLinks = documentLinkCount(cloudDoc);
    const cloudGroups = documentGroupCount(cloudDoc);
    const secretCounts = ['ai', 'memo', 'privacy']
      .map((kind) => cachedSecretCount(kind))
      .filter((count) => count != null);
    const secretTotal = secretCounts.reduce((total, count) => total + count, 0);
    const localTotal = localLinks + localGroups + 1 + secretTotal;
    const cloudTotal = cloudLinks + cloudGroups + 1 + secretTotal;

    if (dom.syncCloudTotal) dom.syncCloudTotal.textContent = String(cloudTotal);
    if (dom.syncLocalTotal) dom.syncLocalTotal.textContent = String(localTotal);
    if (dom.syncPageState) {
      dom.syncPageState.textContent = STATUS_SHORT[sync.status] || STATUS_SHORT.guest;
    }
    if (dom.syncAutoToggle) dom.syncAutoToggle.checked = prefs.autoSync !== false;

    if (!dom.syncItemList) return;
    const groupsChecked = prefs.syncScope.groups !== false ? 'checked' : '';
    const settingsChecked = prefs.syncScope.settings !== false ? 'checked' : '';
    dom.syncItemList.innerHTML = `
      <label class="sync-item">
        <input type="checkbox" class="setting-switch" role="switch" data-sync-scope="groups" ${groupsChecked} />
        <span class="sync-item-copy">
          <strong>快捷方式与分组</strong>
          <small>云端 ${cloudLinks} 条链接 / ${cloudGroups} 个分组 · 本地 ${localLinks} / ${localGroups}</small>
        </span>
      </label>
      <label class="sync-item">
        <input type="checkbox" class="setting-switch" role="switch" data-sync-scope="settings" ${settingsChecked} />
        <span class="sync-item-copy">
          <strong>站点设置</strong>
          <small>昵称、默认搜索引擎、自定义引擎与打开方式等设置</small>
        </span>
      </label>
      ${syncSecretRow('AI 配置', 'ai', '供应商、模型与 API Key')}
      ${syncSecretRow('备忘录', 'memo', '本机或云端加密备忘录')}
      ${syncSecretRow('隐私空间', 'privacy', '独立密码保护的链接与备忘录')}
      <div class="sync-item sync-item-static">
        <span class="sync-item-lock" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        </span>
        <span class="sync-item-copy">
          <strong>搜索历史</strong>
          <small>本地 ${readSearchHistory().length} 条记录 · 仅保存在当前浏览器</small>
        </span>
        <span class="sync-tag">仅本机</span>
      </div>`;
  }

  function updateSyncUI() {
    const text = STATUS_TEXT[sync.status] || STATUS_TEXT.guest;
    const short = STATUS_SHORT[sync.status] || STATUS_SHORT.guest;

    dom.syncBadgeText.textContent = short;
    dom.syncBadge.dataset.status = sync.status;
    dom.syncBadge.title = text;
    dom.syncBadge.setAttribute('aria-label', `${short}：${text}`);

    dom.syncText.textContent = text;

    const dot = dom.syncDot;
    dot.classList.remove('is-ok', 'is-busy', 'is-warn', 'is-error');
    if (sync.status === 'synced') dot.classList.add('is-ok');
    else if (sync.status === 'syncing') dot.classList.add('is-busy');
    else if (sync.status === 'dirty' || sync.status === 'paused') dot.classList.add('is-warn');
    else if (sync.status === 'error' || sync.status === 'auth') dot.classList.add('is-error');

    dom.syncNowBtn.disabled = !sync.user || sync.inFlight;
    dom.accountLabel.textContent = sync.user ? '账号' : '登录';
    dom.accountBtn.setAttribute('aria-label', sync.user ? '账号' : '登录');
    dom.accountBtn.title = sync.user ? '账号' : '登录';

    if (sync.user) {
      setAccountAvatar(dom.accountAvatar, sync.user);
      setAccountAvatar(dom.accountAvatarMini, sync.user);
      dom.accountEmail.textContent = sync.user.email;
      const parts = [sync.user.emailVerified ? '邮箱已验证' : '邮箱未验证'];
      if (sync.lastSyncedAt) parts.push(`上次同步 ${formatTime(sync.lastSyncedAt)}`);
      dom.accountMeta.textContent = parts.join(' · ');
    } else {
      // 未登录显示中性的“个人中心”轮廓图标。
      setAccountAvatar(dom.accountAvatar, null);
      setAccountAvatar(dom.accountAvatarMini, null);
    }

    dom.accountGuest.hidden = Boolean(sync.user);
    dom.accountUser.hidden = !sync.user;
    if (dom.encryptionPanel) dom.encryptionPanel.hidden = !sync.user;
    const securityGuest = $('#security-account-guest');
    if (securityGuest) securityGuest.hidden = Boolean(sync.user);
    dom.adminLink.hidden = !(sync.user && sync.user.isAdmin);
    updateEncryptionUI();
    updateDeviceUI();
    if (dom.syncPanel && !dom.syncPanel.hidden) renderSyncManager();
  }

  function showAccountView(loggedIn) {
    dom.accountGuest.hidden = loggedIn;
    dom.accountUser.hidden = !loggedIn;
  }

  function updateAccountUI() {
    updateSyncUI();
    showAccountView(Boolean(sync.user));
  }

  async function initAccount() {
    if (!authSupported()) {
      await loadGuestDocument();
      setStatus('guest');
      return;
    }

    const response = await api('/api/v1/auth/me');
    if (response.ok && response.data && response.data.user) {
      await onAuthenticated(response.data.user, { initial: true });
      return;
    }
    if (response.status === 401) {
      sync.user = null;
      await loadGuestDocument();
      setStatus('guest');
      return;
    }
    sync.user = null;
    await loadGuestDocument();
    setStatus('guest');
  }

  async function loadGuestDocument() {
    const stored = readJSON(GUEST_KEY);
    data = stored ? normalizeData(stored) : createDefaultData();
    if (!stored) writeJSON(GUEST_KEY, data);
    render();
    renderClock();
  }

  async function onAuthenticated(user, { initial = false } = {}) {
    sync.sessionSeq += 1;
    if (sync.user && sync.user.id !== user.id) {
      resetCryptoState();
      resetSessionsUI();
      sync.cloudData = null;
    } else if (!sync.user) {
      resetSessionsUI();
    }
    sync.user = user;
    sync.inFlight = false;

    const stored = readJSON(USER_KEY_PREFIX + user.id);
    const meta = readJSON(SYNC_KEY_PREFIX + user.id);
    sync.revision = meta && Number.isFinite(meta.revision) ? meta.revision : null;
    sync.lastSyncedAt = meta && meta.lastSyncedAt ? meta.lastSyncedAt : null;
    sync.dirty = Boolean(meta && meta.dirty);
    sync.hasLocal = Boolean(stored);

    if (stored) {
      data = normalizeData(stored);
    } else if (readGuestDirty()) {
      const guest = readJSON(GUEST_KEY);
      data = guest ? normalizeData(guest) : createDefaultData();
      sync.dirty = true;
    } else {
      data = createDefaultData();
    }

    render();
    renderClock();
    updateAccountUI();

    // Always pull once so an encrypted document is unlocked before any push.
    await reconcile();
    await refreshVaultState();
    if (globalThis.QingdhAI) QingdhAI.refreshState();
  }

  async function signOutLocally({ keepData = false, clearVault = true } = {}) {
    sync.sessionSeq += 1;
    const wasUser = sync.user;
    if (wasUser && clearVault && globalThis.QingdhDeviceVault) {
      // 退出登录默认清除本机 vault，避免共用电脑被下一位使用者直接打开。
      try {
        await QingdhDeviceVault.forget(wasUser.id);
      } catch (error) {
        // IndexedDB 不可用时忽略。
      }
    }
    if (globalThis.QingdhPrivacy) QingdhPrivacy.lock('logout', { silent: true });
    resetCryptoState();
    resetSessionsUI();
    sync.user = null;
    sync.revision = null;
    sync.cloudData = null;
    sync.dirty = false;
    sync.hasLocal = false;
    sync.lastSyncedAt = null;

    if (keepData && wasUser) {
      // Keep the current links as guest data after deleting the account.
      writeJSON(GUEST_KEY, normalizeData(data));
      writeGuestDirty(true);
    }

    await loadGuestDocument();
    setStatus('guest');
    updateAccountUI();
    clearAuthForms();
  }

  function clearAuthForms() {
    dom.loginError.hidden = true;
    dom.registerError.hidden = true;
    dom.forgotError.hidden = true;
    dom.authNote.hidden = true;
    dom.loginPassword.value = '';
    dom.registerPassword.value = '';
    dom.registerPassword2.value = '';
    dom.resendLink.hidden = true;
  }

  /* ------------------------------------------------------------------ *
   * 认证操作
   * ------------------------------------------------------------------ */

  function setAuthView(view) {
    state.authView = view;
    dom.loginForm.hidden = view !== 'login';
    dom.registerForm.hidden = view !== 'register';
    dom.forgotForm.hidden = view !== 'forgot';
    dom.authNote.hidden = true;

    $$('.auth-tab').forEach((tab) => {
      const active = tab.dataset.authView === view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    const focusTarget =
      view === 'login' ? dom.loginEmail : view === 'register' ? dom.registerEmail : dom.forgotEmail;
    requestAnimationFrame(() => focusTarget.focus());
  }

  function showAuthError(element, message) {
    element.textContent = message;
    element.hidden = false;
  }

  async function handleLogin(event) {
    event.preventDefault();
    dom.loginError.hidden = true;

    const email = dom.loginEmail.value.trim();
    const password = dom.loginPassword.value;
    if (!email || !password) {
      showAuthError(dom.loginError, '请输入邮箱和密码');
      return;
    }

    dom.loginSubmit.disabled = true;
    const response = await api('/api/v1/auth/login', { method: 'POST', body: { email, password } });
    dom.loginSubmit.disabled = false;

    if (response.ok && response.data && response.data.user) {
      state.pendingEmail = '';
      dom.loginPassword.value = '';
      showToast('已登录');
      await onAuthenticated(response.data.user, { initial: true });
      return;
    }

    if (response.status === 403) {
      state.pendingEmail = email;
      dom.resendLink.hidden = false;
      showAuthError(dom.loginError, apiError(response, '请先完成邮箱验证'));
      return;
    }
    if (response.status === 429) {
      showAuthError(dom.loginError, apiError(response, '尝试次数过多，请稍后再试'));
      return;
    }
    if (response.networkError) {
      showAuthError(dom.loginError, '网络不可用，请稍后再试');
      return;
    }
    if (response.status === 404 || response.status === 405) {
      showAuthError(dom.loginError, '当前页面没有连接同步服务');
      return;
    }
    showAuthError(dom.loginError, apiError(response, '邮箱或密码不正确'));
  }

  async function handleRegister(event) {
    event.preventDefault();
    dom.registerError.hidden = true;
    dom.authNote.hidden = true;

    const email = dom.registerEmail.value.trim();
    const password = dom.registerPassword.value;
    const confirm = dom.registerPassword2.value;

    if (!email) {
      showAuthError(dom.registerError, '请输入邮箱');
      return;
    }
    if (password.length < 8) {
      showAuthError(dom.registerError, '密码至少需要 8 个字符');
      return;
    }
    if (password !== confirm) {
      showAuthError(dom.registerError, '两次输入的密码不一致');
      return;
    }

    dom.registerSubmit.disabled = true;
    const response = await api('/api/v1/auth/register', { method: 'POST', body: { email, password } });
    dom.registerSubmit.disabled = false;

    if (response.status === 202) {
      state.pendingEmail = email;
      dom.authNote.textContent = `验证邮件已发送到 ${email}，点击邮件中的链接即可完成注册并自动登录。`;
      dom.authNote.hidden = false;
      dom.registerPassword.value = '';
      dom.registerPassword2.value = '';
      dom.resendLink.hidden = false;
      dom.resendLink.textContent = '重新发送验证邮件';
      setAuthView('login');
      dom.loginEmail.value = email;
      dom.authNote.hidden = false;
      return;
    }

    if (response.ok && response.data && response.data.user) {
      showToast('注册成功');
      await onAuthenticated(response.data.user, { initial: true });
      return;
    }

    if (response.status === 409) {
      showAuthError(dom.registerError, '这个邮箱已经注册过了');
      return;
    }
    if (response.status === 422) {
      showAuthError(dom.registerError, apiError(response, '请检查邮箱和密码'));
      return;
    }
    if (response.status === 502) {
      state.pendingEmail = email;
      dom.resendLink.hidden = false;
      showAuthError(dom.registerError, apiError(response, '验证邮件发送失败，请稍后重试'));
      return;
    }
    showAuthError(dom.registerError, apiError(response, '注册失败，请稍后再试'));
  }

  async function handleForgot(event) {
    event.preventDefault();
    dom.forgotError.hidden = true;

    const email = dom.forgotEmail.value.trim();
    if (!email) {
      showAuthError(dom.forgotError, '请输入邮箱');
      return;
    }

    dom.forgotSubmit.disabled = true;
    const response = await api('/api/v1/auth/forgot-password', { method: 'POST', body: { email } });
    dom.forgotSubmit.disabled = false;

    if (response.networkError) {
      showAuthError(dom.forgotError, '网络不可用，请稍后再试');
      return;
    }
    if (response.status === 429) {
      showAuthError(dom.forgotError, apiError(response, '请求过于频繁，请稍后再试'));
      return;
    }

    dom.authNote.textContent = '如果这个邮箱已经注册，重置邮件会在几分钟内送达。';
    dom.authNote.hidden = false;
    setAuthView('login');
    dom.authNote.hidden = false;
  }

  async function resendVerification() {
    const email = state.pendingEmail || dom.loginEmail.value.trim() || dom.registerEmail.value.trim();
    if (!email) {
      showToast('请先填写邮箱');
      return;
    }
    const response = await api('/api/v1/auth/resend-verification', { method: 'POST', body: { email } });
    if (response.status === 429) {
      showToast('发送过于频繁，请稍后再试');
      return;
    }
    if (response.networkError) {
      showToast('网络不可用，请稍后再试');
      return;
    }
    showToast('如果该邮箱需要验证，邮件已重新发送');
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    dom.resetError.hidden = true;

    const password = dom.resetPassword.value;
    const confirm = dom.resetPassword2.value;
    if (password.length < 8) {
      showAuthError(dom.resetError, '密码至少需要 8 个字符');
      return;
    }
    if (password !== confirm) {
      showAuthError(dom.resetError, '两次输入的密码不一致');
      return;
    }

    dom.resetSubmit.disabled = true;
    const response = await api('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token: state.resetToken, password },
    });
    dom.resetSubmit.disabled = false;

    if (response.ok) {
      state.resetToken = '';
      dom.resetForm.reset();
      dom.resetDialog.close();
      showToast('密码已重置，请重新登录');
      setAuthView('login');
      openAccountDialog();
      return;
    }
    showAuthError(dom.resetError, apiError(response, '重置失败，请重新申请'));
  }

  async function handleLogout() {
    if (sync.dirty) {
      const confirmed = await askConfirm({
        title: '退出登录',
        message: '还有修改没有同步到云端，退出后这些修改只保留在本机。确定退出吗？',
        confirmText: '仍然退出',
      });
      if (!confirmed) return;
    }

    await api('/api/v1/auth/logout', { method: 'POST' });
    await signOutLocally();
    showToast('已退出登录');
  }

  async function handleLogoutAll() {
    const response = await api('/api/v1/auth/logout-all', { method: 'POST' });
    if (response.ok) {
      showToast('其他设备已退出登录');
      loadSessions();
      return;
    }
    showToast(apiError(response, '操作失败'));
  }

  async function handleDeleteAccount(event) {
    event.preventDefault();
    dom.deleteError.hidden = true;

    const password = dom.deletePassword.value;
    if (!password) {
      showAuthError(dom.deleteError, '请输入密码');
      return;
    }

    dom.deleteSubmit.disabled = true;
    const response = await api('/api/v1/account', { method: 'DELETE', body: { password } });
    dom.deleteSubmit.disabled = false;

    if (response.ok) {
      dom.deleteForm.reset();
      dom.deleteDialog.close();
      await signOutLocally({ keepData: true });
      showToast('账号已删除，本机数据已保留');
      return;
    }
    showAuthError(dom.deleteError, apiError(response, '删除失败'));
  }

  function resetSessionsUI() {
    dom.sessionsList.innerHTML = '';
    dom.sessionsBlock.open = false;
  }

  async function loadSessions() {
    if (!sync.user) return;
    dom.sessionsList.innerHTML = '<p class="group-empty">加载中…</p>';
    const response = await api('/api/v1/auth/sessions');
    if (!response.ok) {
      dom.sessionsList.innerHTML = '<p class="group-empty">无法加载登录设备</p>';
      return;
    }

    const sessions = (response.data && response.data.sessions) || [];
    dom.sessionsList.innerHTML = sessions
      .map(
        (item) => `<div class="session-item">
          <div class="session-main">
            <p class="session-agent">${escapeHTML(describeAgent(item.userAgent))}${item.current ? ' <span class="session-badge">当前</span>' : ''}</p>
            <p class="session-meta">最近活跃 ${escapeHTML(formatTime(item.lastSeenAt))} · ${escapeHTML(item.ip || '未知地址')}</p>
          </div>
          ${item.current ? '' : `<button class="mini-btn" type="button" data-session-id="${escapeHTML(item.id)}" aria-label="退出该设备" title="退出该设备">${ICON_X}</button>`}
        </div>`
      )
      .join('');
  }

  function describeAgent(userAgent) {
    if (!userAgent) return '未知设备';
    const os = /Windows/.test(userAgent)
      ? 'Windows'
      : /iPhone|iPad|iPod/.test(userAgent)
        ? 'iOS'
        : /Android/.test(userAgent)
          ? 'Android'
          : /Mac OS X|Macintosh/.test(userAgent)
            ? 'macOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : '未知系统';
    const browser = /Edg\//.test(userAgent)
      ? 'Edge'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : '浏览器';
    return `${browser} · ${os}`;
  }

  /* ------------------------------------------------------------------ *
   * 同步
   * ------------------------------------------------------------------ */

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
    if (!channel) return;
    try {
      channel.postMessage({ type: 'data-changed', userId: sync.user ? sync.user.id : null });
    } catch (error) {
      // ignore
    }
  }

  function scheduleSync(delay = SYNC_DEBOUNCE) {
    if (!sync.user || prefs.autoSync === false) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => {
      syncNow();
    }, delay);
  }

  async function reconcile() {
    if (!sync.user) return;

    const sessionSeq = sync.sessionSeq;
    setStatus('syncing');
    const response = await api('/api/v1/workspace');
    if (sessionSeq !== sync.sessionSeq) return;

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
        local: data,
        cloud: normalizeData(cloud),
      });
      if (sessionSeq !== sync.sessionSeq) return;

      if (choice === 'merge') {
        data = mergeDocuments(data, normalizeData(cloud));
        const dropped = enforceLimits(data);
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
      local: data,
      cloud: normalizeData(plain),
    });
    if (sessionSeq !== sync.sessionSeq) return;

    if (choice === 'merge') {
      data = mergeDocuments(data, normalizeData(plain));
      const dropped = enforceLimits(data);
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

  async function syncNow({ pullOnly = false } = {}) {
    if (!sync.user || sync.inFlight) return;
    sync.inFlight = true;
    const sessionSeq = sync.sessionSeq;
    updateSyncUI();

    try {
      if (sync.dirty && !pullOnly) {
        await pushWithRetries(sync.revision == null ? 0 : sync.revision);
        return;
      }

      setStatus('syncing');
      const response = await api('/api/v1/workspace');
      if (sessionSeq !== sync.sessionSeq) return;
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
    if (countLinks(data) > 0 || countGroups(data) > 0) saveSnapshot('before-cloud');
    const incoming = normalizeData(cloud);
    sync.cloudData = incoming;
    const next = normalizeData(incoming);
    if (prefs.syncScope.groups === false) next.groups = data.groups;
    if (prefs.syncScope.settings === false) next.settings = data.settings;
    data = normalizeData(next);
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

      const group = mergeGroup(localGroup, cloudGroup);
      result.groups.push(group);
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
      let merged = localLink && cloudLink ? mergeLink(localLink, cloudLink) : clone(localLink || cloudLink);
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

  /* ------------------------------------------------------------------ *
   * 快捷方式编辑
   * ------------------------------------------------------------------ */

  function setEditing(editing) {
    state.editing = editing;
    document.body.classList.toggle('editing', editing);
    if (dom.batchBtn) dom.batchBtn.hidden = !editing;
    if (!editing && state.batchMode) setBatchMode(false);

    dom.editBtn.setAttribute('aria-pressed', String(editing));
    dom.editBtn.setAttribute('aria-label', editing ? '完成编辑' : '编辑快捷方式');
    dom.editBtn.title = editing ? '完成编辑' : '编辑快捷方式';

    const label = $('#edit-label', dom.editBtn);
    if (label) label.textContent = editing ? '完成' : '编辑';

    render();

    if (editing) {
      showToast('点击快捷方式可编辑，点 × 删除', { duration: 3200 });
    }
  }

  function fillGroupSelect(selectedId) {
    const visible = data.groups.filter((group) => !group.deletedAt);
    const options = visible.map(
      (group) => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.name)}</option>`
    );
    options.push('<option value="__new">＋ 新建分组…</option>');
    dom.linkGroup.innerHTML = options.join('');

    const fallback = visible[0] ? visible[0].id : '__new';
    const value = visible.some((group) => group.id === selectedId) ? selectedId : fallback;
    dom.linkGroup.value = value;
    if (globalThis.QingdhSelect) QingdhSelect.sync(dom.linkGroup);
    toggleNewGroupField();
  }

  function toggleNewGroupField() {
    const isNew = dom.linkGroup.value === '__new';
    dom.linkGroupName.hidden = !isNew;
    if (isNew) dom.linkGroupName.value = '';
  }

  function openLinkDialog({ linkId = null, groupId = null } = {}) {
    const found = linkId ? findLink(linkId) : null;
    state.linkEditId = found ? found.link.id : null;

    dom.linkDialogTitle.textContent = found ? '编辑快捷方式' : '添加快捷方式';
    dom.linkSubmit.textContent = found ? '保存修改' : '保存';
    dom.linkTitle.value = found ? found.link.title : '';
    dom.linkUrl.value = found ? found.link.url : '';
    dom.linkIcon.value = found ? found.link.icon : '';
    hideUrlError();
    fillGroupSelect(found ? found.group.id : groupId);

    dom.linkDialog.showModal();
    requestAnimationFrame(() => {
      dom.linkTitle.focus();
      dom.linkTitle.select();
    });
  }

  function showUrlError() {
    dom.linkUrlError.hidden = false;
    dom.linkUrl.classList.add('invalid');
    dom.linkUrl.focus();
  }

  function hideUrlError() {
    dom.linkUrlError.hidden = true;
    dom.linkUrl.classList.remove('invalid');
  }

  function totalLinks() {
    return data.groups.reduce(
      (total, group) => total + group.links.filter((link) => !link.deletedAt).length,
      0
    );
  }

  function handleLinkSubmit(event) {
    event.preventDefault();

    const url = normalizeUrl(dom.linkUrl.value);
    if (!url) {
      showUrlError();
      return;
    }

    const title = (dom.linkTitle.value.trim() || hostOf(url) || '未命名').slice(0, 40);
    const icon = dom.linkIcon.value.trim().slice(0, 200);

    let group = data.groups.find((item) => item.id === dom.linkGroup.value && !item.deletedAt);
    if (!group) {
      if (countGroups(data) >= MAX_GROUPS) {
        showToast(`最多只能有 ${MAX_GROUPS} 个分组`);
        return;
      }
      const name = (dom.linkGroupName.value.trim() || '常用').slice(0, 20);
      group = makeGroup(name);
      data.groups.push(group);
    }

    const found = state.linkEditId ? findLink(state.linkEditId) : null;
    const stamp = now();

    if (found) {
      const updated = { ...found.link, title, url, icon, updatedAt: stamp, deletedAt: null };
      if (found.group.id === group.id) {
        group.links[found.index] = updated;
      } else {
        found.group.links[found.index] = { ...found.link, deletedAt: stamp, updatedAt: stamp };
        found.group.updatedAt = stamp;
        group.links.push(updated);
      }
      group.updatedAt = stamp;
    } else {
      if (totalLinks() >= MAX_LINKS) {
        showToast(`最多只能有 ${MAX_LINKS} 个快捷方式`);
        return;
      }
      group.links.push({ id: uid(), title, url, icon, updatedAt: stamp, deletedAt: null });
      group.updatedAt = stamp;
    }

    commitLocalChange();
    dom.linkDialog.close();
  }

  function findLink(id) {
    for (const group of data.groups) {
      const index = group.links.findIndex((link) => link.id === id && !link.deletedAt);
      if (index !== -1) return { group, link: group.links[index], index };
    }
    return null;
  }

  function updateBatchBar() {
    if (!dom.batchBar) return;
    const count = state.batchSelected.size;
    if (dom.batchCount) dom.batchCount.textContent = `已选 ${count} 项`;
    if (dom.batchMove) dom.batchMove.disabled = count === 0;
    if (dom.batchDelete) dom.batchDelete.disabled = count === 0;
  }

  function fillBatchTargets() {
    if (!dom.batchTarget) return;
    dom.batchTarget.innerHTML = data.groups
      .filter((group) => !group.deletedAt)
      .map((group) => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.name)}</option>`)
      .join('');
    if (globalThis.QingdhSelect) QingdhSelect.enhance(dom.batchTarget);
  }

  function setBatchMode(on) {
    state.batchMode = Boolean(on);
    state.batchSelected.clear();
    document.body.classList.toggle('batch-mode', state.batchMode);
    if (dom.batchBar) dom.batchBar.hidden = !state.batchMode;
    if (dom.batchBtn) dom.batchBtn.setAttribute('aria-pressed', String(state.batchMode));
    if (state.batchMode) fillBatchTargets();
    updateBatchBar();
    render();
    if (state.batchMode) showToast('点击快捷方式多选，可批量移动或删除');
  }

  function toggleBatchLink(id) {
    if (!state.batchMode || !id) return;
    if (state.batchSelected.has(id)) state.batchSelected.delete(id);
    else state.batchSelected.add(id);
    const selected = state.batchSelected.has(id);
    const row = dom.groups.querySelector(`.link-row[data-batch-row="${id}"]`);
    if (row) {
      row.classList.toggle('is-batch-selected', selected);
      const box = row.querySelector('[data-batch-toggle]');
      if (box) box.checked = selected;
    }
    updateBatchBar();
  }

  function batchMoveSelected() {
    const targetId = dom.batchTarget.value;
    const target = data.groups.find((group) => group.id === targetId && !group.deletedAt);
    if (!target || !state.batchSelected.size) return;
    let moved = 0;
    const stamp = now();
    for (const group of data.groups) {
      if (group.id === target.id) continue;
      const keep = [];
      for (const link of group.links) {
        if (link.deletedAt || !state.batchSelected.has(link.id)) {
          keep.push(link);
          continue;
        }
        link.updatedAt = stamp;
        target.links.push(link);
        moved += 1;
      }
      if (keep.length !== group.links.length) group.updatedAt = stamp;
      group.links = keep;
    }
    target.updatedAt = stamp;
    const count = state.batchSelected.size;
    state.batchSelected.clear();
    commitLocalChange();
    updateBatchBar();
    showToast(`已移动 ${moved} 个快捷方式到「${target.name}」`);
  }

  function batchCheckDuplicates() {
    const seen = new Map();
    for (const group of data.groups) {
      if (group.deletedAt) continue;
      for (const link of group.links) {
        if (link.deletedAt) continue;
        const url = normalizeUrl(link.url);
        if (!url) continue;
        const key = url.replace(/\/+$/, '');
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(link.id);
      }
    }
    const duplicates = [...seen.values()].filter((ids) => ids.length > 1);
    state.batchSelected.clear();
    for (const ids of duplicates) {
      for (const id of ids) state.batchSelected.add(id);
    }
    render();
    updateBatchBar();
    if (!duplicates.length) {
      showToast('没有发现重复链接');
    } else {
      showToast(`发现 ${duplicates.length} 组重复链接，已选中相关项`);
    }
  }

  async function batchDeleteSelected() {
    const count = state.batchSelected.size;
    if (!count) return;
    const confirmed = await askConfirm({
      title: '批量删除快捷方式',
      message: `将删除选中的 ${count} 个快捷方式。删除会同步到其他设备。`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    const stamp = now();
    for (const group of data.groups) {
      for (const link of group.links) {
        if (link.deletedAt || !state.batchSelected.has(link.id)) continue;
        link.deletedAt = stamp;
        link.updatedAt = stamp;
        group.updatedAt = stamp;
      }
    }
    state.batchSelected.clear();
    commitLocalChange();
    updateBatchBar();
    showToast(`已删除 ${count} 个快捷方式`);
  }

  function deleteLink(id) {
    const found = findLink(id);
    if (!found) return;

    const stamp = now();
    found.link.deletedAt = stamp;
    found.link.updatedAt = stamp;
    found.group.updatedAt = stamp;
    commitLocalChange();

    showToast(`已删除「${found.link.title || hostOf(found.link.url)}」`, {
      actionLabel: '撤销',
      duration: 6000,
      onAction: () => {
        const group = data.groups.find((item) => item.id === found.group.id);
        const link = group && group.links.find((item) => item.id === found.link.id);
        if (!link) return;
        link.deletedAt = null;
        link.updatedAt = now();
        group.updatedAt = link.updatedAt;
        commitLocalChange();
      },
    });
  }

  async function deleteGroup(id) {
    const group = data.groups.find((item) => item.id === id && !item.deletedAt);
    if (!group) return;

    const count = group.links.filter((link) => !link.deletedAt).length;
    const confirmed = await askConfirm({
      title: '删除分组',
      message: `确定删除分组「${group.name}」及其中 ${count} 个快捷方式吗？`,
      confirmText: '删除',
    });
    if (!confirmed) return;

    const stamp = now();
    group.deletedAt = stamp;
    group.updatedAt = stamp;
    commitLocalChange();
  }

  /* ------------------------------------------------------------------ *
   * 分组对话框
   * ------------------------------------------------------------------ */

  function openGroupDialog({ groupId = null } = {}) {
    const group = groupId ? data.groups.find((item) => item.id === groupId && !item.deletedAt) : null;
    state.groupEditId = group ? group.id : null;

    dom.groupDialogTitle.textContent = group ? '重命名分组' : '新建分组';
    dom.groupName.value = group ? group.name : '';

    dom.groupDialog.showModal();
    requestAnimationFrame(() => {
      dom.groupName.focus();
      dom.groupName.select();
    });
  }

  function handleGroupSubmit(event) {
    event.preventDefault();

    const name = dom.groupName.value.trim().slice(0, 20);
    if (!name) {
      dom.groupName.focus();
      return;
    }

    if (state.groupEditId) {
      const group = data.groups.find((item) => item.id === state.groupEditId);
      if (group) {
        group.name = name;
        group.updatedAt = now();
      }
    } else {
      if (countGroups(data) >= MAX_GROUPS) {
        showToast(`最多只能有 ${MAX_GROUPS} 个分组`);
        return;
      }
      data.groups.push(makeGroup(name));
    }

    commitLocalChange();
    dom.groupDialog.close();
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  const HUB_GROUPS = {
    account: 'account',
    appearance: 'appearance',
    sidebar: 'appearance',
    search: 'search',
    ai: 'search',
    usage: 'search',
    sync: 'sync',
    data: 'sync',
    privacy: 'privacy',
  };

  function prepareHubPanels() {
    const order = ['account', 'appearance', 'sidebar', 'search', 'ai', 'usage', 'sync', 'data', 'privacy'];
    const titles = {
      sidebar: '侧栏',
      search: '网页搜索',
      ai: 'AI 配置',
      usage: '调用概览',
      data: '本地数据',
    };
    for (const key of order) {
      const panel = dom.hubPanels.find((item) => item.dataset.hubPanel === key);
      if (!panel) continue;
      dom.hubBody.appendChild(panel);
      panel.classList.toggle('hub-group-start', HUB_GROUPS[key] === key);
      if (titles[key]) {
        panel.insertAdjacentHTML('afterbegin', `<h3 class="hub-section-title">${titles[key]}</h3>`);
      }
    }
    const privacy = dom.hubPanels.find((item) => item.dataset.hubPanel === 'privacy');
    if (privacy && dom.encryptionPanel) {
      privacy.insertAdjacentHTML('afterbegin', '<h3 class="hub-section-title">隐私空间</h3>');
      privacy.insertAdjacentHTML('afterbegin', '<div class="usage-empty" id="security-account-guest" hidden>登录后可开启数据加密。</div>');
      privacy.prepend(dom.encryptionPanel);
      privacy.insertAdjacentHTML('afterbegin', '<h3 class="hub-section-title">数据加密</h3>');
    }
  }

  function syncSettingsUI() {
    dom.setName.value = data.settings.name;
    dom.setEngine.value = data.settings.engine;
    dom.setOpen.value = prefs.openInNewTab ? 'new' : 'same';
    dom.setTheme.value = prefs.theme;

    if (dom.setClock) {
      dom.setClock.value = CLOCK_STYLES.includes(prefs.clockStyle) ? prefs.clockStyle : 'editorial';
      dom.setHour.value = HOUR_CYCLES.includes(prefs.hourCycle) ? prefs.hourCycle : 'auto';
      dom.setSeconds.checked = Boolean(prefs.showSeconds);
      syncSettingsSidebarUI();
    }

    if (globalThis.QingdhSelect) {
      QingdhSelect.sync(dom.setEngine);
      QingdhSelect.sync(dom.setOpen);
      QingdhSelect.sync(dom.setTheme);
      QingdhSelect.sync(dom.setClock);
      QingdhSelect.sync(dom.setHour);
      QingdhSelect.sync(dom.setSidebar);
    }

    $$('input[name="season"]', dom.seasonPicker).forEach((input) => {
      input.checked = input.value === prefs.season;
    });
    renderEngineSettings();
    updateSnapshotButton();
  }

  function setHubTab(tab) {
    const section = Object.prototype.hasOwnProperty.call(HUB_GROUPS, tab) ? tab : 'account';
    const next = HUB_GROUPS[section];

    dom.hubTabs.forEach((button) => {
      const active = button.dataset.hubTab === next;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    dom.hubPanels.forEach((panel) => {
      panel.hidden = HUB_GROUPS[panel.dataset.hubPanel] !== next;
    });

    if (dom.hubCategory && dom.hubCategory.value !== next) {
      dom.hubCategory.value = next;
      if (globalThis.QingdhSelect) QingdhSelect.sync(dom.hubCategory);
    }
    const activeButton = dom.hubTabs.find((button) => button.dataset.hubTab === next);
    if (activeButton) {
      dom.hubPanelTitle.textContent = activeButton.dataset.title || activeButton.textContent.trim();
      dom.hubPanelDesc.textContent = activeButton.dataset.desc || '';
    }
    if (dom.hubBody) {
      dom.hubBody.scrollTop = 0;
      if (section !== next) {
        const target = dom.hubPanels.find((panel) => panel.dataset.hubPanel === section);
        if (target) requestAnimationFrame(() => {
          const top = target.getBoundingClientRect().top - dom.hubBody.getBoundingClientRect().top;
          dom.hubBody.scrollTop += top;
        });
      }
    }
    if (activeButton && window.matchMedia('(max-width: 860px)').matches) {
      const nav = activeButton.closest('.hub-nav');
      if (nav) {
        requestAnimationFrame(() => {
          nav.scrollTo({
            left: activeButton.offsetLeft - (nav.clientWidth - activeButton.offsetWidth) / 2,
            behavior: 'smooth',
          });
        });
      }
    }
    if (dom.hubFootNote) {
      if (next === 'account') dom.hubFootNote.textContent = '登录状态与同步会自动更新';
      else if (next === 'search') dom.hubFootNote.textContent = '网页搜索设置即时保存；AI 配置点击保存';
      else dom.hubFootNote.textContent = '修改会即时保存';
    }
    if (dom.aiConfigSave) dom.aiConfigSave.hidden = next !== 'search' || !sync.user || !cryptoState.enabled;

    if (next === 'account') {
      updateAccountUI();
    } else {
      syncSettingsUI();
      if (next === 'privacy' && globalThis.QingdhPrivacy) QingdhPrivacy.refreshSettings();
      if (next === 'search' && globalThis.QingdhAI) QingdhAI.openUsage();
      if (next === 'sync') renderSyncManager();
    }
  }

  function openHub(tab) {
    if (!dom.hubDialog.open) dom.hubDialog.showModal();
    setHubTab(tab || 'account');
    requestAnimationFrame(() => dom.hubDialog.focus());
  }

  function openSettings() {
    openHub('appearance');
    if (globalThis.QingdhPrivacy) QingdhPrivacy.refreshSettings();
  }

  function openAIConfig() {
    openHub('ai');
  }

  function openAccountDialog() {
    if (!authSupported()) {
      showToast('登录需要通过网络访问本页面');
      return;
    }
    updateAccountUI();
    if (!sync.user) setAuthView('login');
    else {
      refreshVaultState();
      refreshPasskeyUI();
    }
    openHub('account');
  }

  function downloadJSON(payload, suffix = '') {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate()
    ).padStart(2, '0')}`;

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `qingdh-${stamp}${suffix}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportData() {
    if (!cryptoState.enabled) {
      downloadJSON(data);
      return;
    }

    if (!(await ensureUnlockedForPush())) return;
    await syncNow();

    const response = await api('/api/v1/workspace');
    if (!response.ok) {
      showToast('导出失败：无法读取云端数据');
      return;
    }
    if (!QingdhCrypto.isEncrypted(response.data.payload)) {
      showToast('导出失败：云端数据不是加密状态');
      return;
    }

    downloadJSON(response.data.payload, '-encrypted');
    dom.hubDialog.close();
    showToast('已导出加密备份，需要加密密码或恢复码才能导入');
  }

  function validateJSONImport(parsed) {
    if (!parsed || !Array.isArray(parsed.groups)) return '缺少快捷方式数据';
    if (parsed.version !== 2) return '不支持的 JSON 数据版本';
    if (parsed.groups.length > MAX_GROUPS) return `文件中的分组超过 ${MAX_GROUPS} 个`;
    const sizeOf = (value) => new TextEncoder().encode(value).length;
    const settings = parsed.settings;
    if (settings != null) {
      if (typeof settings !== 'object' || Array.isArray(settings)) return '设置格式不正确';
      if (settings.name != null && (typeof settings.name !== 'string' || settings.name.length > 12)) {
        return '昵称超过 12 个字符或格式不正确';
      }
      if (settings.engine != null && (typeof settings.engine !== 'string' || settings.engine.length > 50)) {
        return '搜索引擎标识格式不正确';
      }
      if (settings.customEngines != null) {
        if (!Array.isArray(settings.customEngines) || settings.customEngines.length > 20) return '自定义搜索引擎超过 20 个或格式不正确';
        const engineIds = new Set(ENGINES.map((engine) => engine.id));
        const bangs = new Set(ENGINES.map((engine) => engine.bang));
        for (const engine of settings.customEngines) {
          if (!engine || typeof engine.id !== 'string' || !/^[a-z0-9-]{3,50}$/i.test(engine.id) ||
              engineIds.has(engine.id) || typeof engine.name !== 'string' || !engine.name.trim() ||
              engine.name.length > 20 ||
              typeof engine.template !== 'string' || engine.template.length > 500 ||
              !engine.template.includes('{query}') || !/^https?:\/\//i.test(engine.template) ||
              (engine.bang != null && (typeof engine.bang !== 'string' || !/^[a-z0-9]{0,8}$/.test(engine.bang) ||
                (engine.bang && bangs.has(engine.bang))))) {
            return '自定义搜索引擎格式不正确';
          }
          engineIds.add(engine.id);
          if (engine.bang) bangs.add(engine.bang);
        }
      }
      if (settings.engineOrder != null && (!Array.isArray(settings.engineOrder) || settings.engineOrder.length > 50)) {
        return '搜索引擎顺序格式不正确';
      }
      if (settings.engineOrder && settings.engineOrder.some((id) => typeof id !== 'string')) {
        return '搜索引擎顺序格式不正确';
      }
      const knownEngineIds = new Set([...ENGINES, ...(settings.customEngines || [])].map((engine) => engine.id));
      if (settings.engineOrder && settings.engineOrder.some((id) => !knownEngineIds.has(id))) {
        return '搜索引擎顺序包含未知引擎';
      }
      if (settings.engine && ![...ENGINES, ...(settings.customEngines || [])]
        .some((engine) => engine.id === settings.engine)) {
        return '默认搜索引擎不存在';
      }
    }
    let links = 0;
    const groupIds = new Set();
    const linkIds = new Set();
    for (const group of parsed.groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.links)) {
        return '文件中的分组格式不正确';
      }
      if (typeof group.id !== 'string' || !group.id || groupIds.has(group.id) ||
          typeof group.name !== 'string' || !group.name.trim() || group.name.length > 20) {
        return '文件中的分组 id 或名称无效';
      }
      groupIds.add(group.id);
      links += group.links.length;
      if (links > MAX_LINKS) return `文件中的链接超过 ${MAX_LINKS} 个`;
      for (const link of group.links) {
        if (!link || typeof link !== 'object' || typeof link.id !== 'string' || !link.id || linkIds.has(link.id) ||
            typeof link.title !== 'string' || link.title.length > 40 ||
            (link.icon != null && (typeof link.icon !== 'string' || sizeOf(link.icon) > 200)) ||
            (link.url != null && typeof link.url !== 'string')) {
          return '文件中的链接 id、标题或图标无效';
        }
        linkIds.add(link.id);
        if (!link.deletedAt && (!link.url || sizeOf(link.url) > 2048 || !normalizeLink(link))) {
          return '文件包含无效或过长的链接地址';
        }
      }
    }
    return '';
  }

  function importLimitError(doc) {
    if (doc.groups.length > MAX_GROUPS) return `导入后分组超过 ${MAX_GROUPS} 个`;
    const links = doc.groups.reduce((total, group) =>
      total + (group.deletedAt ? 0 : group.links.length), 0);
    if (links > MAX_LINKS) return `导入后链接超过 ${MAX_LINKS} 个`;
    const plainBytes = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (plainBytes > 256 * 1024) return '导入后导航数据超过 256 KiB 同步预算';
    if (cryptoState.enabled && cryptoState.envelope) {
      const envelopeBytes = new TextEncoder().encode(JSON.stringify({ ...cryptoState.envelope, data: '' })).length;
      const encodedLength = Math.ceil((plainBytes + 28) / 3) * 4;
      if (envelopeBytes + encodedLength > 512 * 1024) {
        return '导入后加密导航数据超过 512 KiB 同步上限';
      }
    }
    return '';
  }

  function planJSONImport(incoming, mode) {
    if (mode === 'replace') {
      const next = stampAll(normalizeData(incoming));
      return { next, addedGroups: countGroups(next), addedLinks: countLinks(next), duplicates: 0 };
    }

    const next = clone(data);
    const byId = new Map(next.groups.map((group) => [group.id, group]));
    const byName = new Map(next.groups.filter((group) => !group.deletedAt).map((group) => [group.name, group]));
    const knownLinkIds = new Set(next.groups.flatMap((group) => group.links.map((link) => link.id)));
    let addedGroups = 0;
    let addedLinks = 0;
    let duplicates = 0;

    for (const group of incoming.groups) {
      if (group.deletedAt) continue;
      let target = byId.get(group.id) || byName.get(group.name);
      if (target && target.deletedAt) {
        duplicates += group.links.filter((link) => !link.deletedAt).length;
        continue;
      }
      if (!target) {
        target = { ...group, links: [], updatedAt: now() };
        next.groups.push(target);
        byId.set(target.id, target);
        byName.set(target.name, target);
        addedGroups += 1;
      }
      const knownUrls = new Set(target.links
        .map((link) => normalizeUrl(link.url, { allowShortHost: true }).replace(/\/+$/, '')));
      for (const link of group.links) {
        if (link.deletedAt) continue;
        const urlKey = normalizeUrl(link.url, { allowShortHost: true }).replace(/\/+$/, '');
        if (knownLinkIds.has(link.id) || knownUrls.has(urlKey)) {
          duplicates += 1;
          continue;
        }
        target.links.push({ ...link, updatedAt: now(), deletedAt: null });
        target.updatedAt = now();
        knownLinkIds.add(link.id);
        knownUrls.add(urlKey);
        addedLinks += 1;
      }
    }
    return { next, addedGroups, addedLinks, duplicates };
  }

  function updateJSONImportPreview() {
    const pending = state.jsonImport;
    if (!pending) return;
    const mode = $('input[name="json-import-mode"]:checked', dom.jsonImportDialog).value;
    const plan = planJSONImport(pending.incoming, mode);
    const error = importLimitError(plan.next);
    const beforeGroups = countGroups(data);
    const beforeLinks = countLinks(data);
    const afterGroups = countGroups(plan.next);
    const afterLinks = countLinks(plan.next);
    dom.jsonImportSummary.textContent = mode === 'merge'
      ? `当前 ${beforeGroups} 个分组、${beforeLinks} 个链接；合并后 ${afterGroups} 个分组、${afterLinks} 个链接。新增 ${plan.addedGroups} 个分组、${plan.addedLinks} 个链接，跳过 ${plan.duplicates} 个重复项；保留当前设置。`
      : `当前 ${beforeGroups} 个分组、${beforeLinks} 个链接；替换后 ${afterGroups} 个分组、${afterLinks} 个链接。当前快捷方式和常规设置将被文件内容替换。`;
    dom.jsonImportError.hidden = !error;
    dom.jsonImportError.textContent = error;
    dom.jsonImportOk.disabled = Boolean(error) || (mode === 'merge' && !plan.addedGroups && !plan.addedLinks);
    dom.jsonImportOk.textContent = mode === 'merge' ? '合并导入' : '替换导入';
    pending.plan = plan;
    pending.mode = mode;
    pending.dataFingerprint = JSON.stringify(data);
  }

  async function importData(file) {
    if (!file) return;
    const request = ++state.jsonImportSeq;
    const sessionSeq = sync.sessionSeq;
    const key = currentKey();
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      showToast('导入失败：文件不是有效的 JSON');
      return;
    }
    if (request !== state.jsonImportSeq || sessionSeq !== sync.sessionSeq || key !== currentKey()) return;

    if (globalThis.QingdhCrypto && QingdhCrypto.isEncrypted(parsed)) {
      const decrypted = await promptDecryptFile(parsed);
      if (!decrypted) return;
      parsed = decrypted;
    }
    if (request !== state.jsonImportSeq || sessionSeq !== sync.sessionSeq || key !== currentKey()) return;
    const error = validateJSONImport(parsed);
    if (error) {
      showToast(`导入失败：${error}`);
      return;
    }

    state.jsonImport = { incoming: normalizeData(parsed), sessionSeq, key };
    dom.jsonImportSource.textContent = `文件：${file.name}。文件包含 ${countGroups(state.jsonImport.incoming)} 个分组、${countLinks(state.jsonImport.incoming)} 个链接。`;
    $('input[value="merge"]', dom.jsonImportDialog).checked = true;
    updateJSONImportPreview();
    dom.jsonImportDialog.showModal();
  }

  function applyJSONImport() {
    const pending = state.jsonImport;
    if (!pending) return;
    if (pending.sessionSeq !== sync.sessionSeq || pending.key !== currentKey()) {
      dom.jsonImportDialog.close();
      showToast('账号已变化，请重新选择导入文件');
      return;
    }
    if (pending.dataFingerprint !== JSON.stringify(data)) {
      updateJSONImportPreview();
      dom.jsonImportError.hidden = false;
      dom.jsonImportError.textContent = '当前数据已变化，请核对更新后的预览并再次确认。';
      return;
    }
    if (importLimitError(pending.plan.next)) {
      updateJSONImportPreview();
      return;
    }
    if (!saveSnapshot('before-import')) return;
    if (!writeJSON(currentKey(), pending.plan.next)) return;
    data = pending.plan.next;
    markDirty();
    broadcastChange();
    render();
    renderClock();
    updateSnapshotButton();
    dom.jsonImportDialog.close();
    dom.hubDialog.close();
    showToast(pending.mode === 'merge'
      ? `已合并 ${pending.plan.addedGroups} 个分组、${pending.plan.addedLinks} 个链接`
      : `已替换为 ${countGroups(data)} 个分组、${countLinks(data)} 个链接`);
  }

  async function importBookmarks(file) {
    if (!file) return;
    if (!globalThis.QingdhBookmarks) {
      showToast('当前页面不支持书签导入');
      return;
    }

    let parsed;
    try {
      parsed = QingdhBookmarks.parse(await file.text());
    } catch (error) {
      showToast('导入失败：无法解析书签文件');
      return;
    }
    if (!parsed || !parsed.total) {
      showToast('没有找到可导入的书签');
      return;
    }

    const visible = data.groups.filter((group) => !group.deletedAt);
    const planned = [];
    const plannedNames = new Set(visible.map((group) => group.name));
    let newGroups = 0;
    let newLinks = 0;
    let duplicates = parsed.duplicates || 0;

    // 全工作区按规范化 URL 去重：同一条书签不会因为存在于别的分组而重复导入。
    const knownUrls = new Set();
    for (const group of visible) {
      for (const link of group.links) {
        if (link.deletedAt) continue;
        const url = normalizeUrl(link.url);
        if (url) knownUrls.add(url.replace(/\/+$/, ''));
      }
    }

    for (const group of parsed.groups) {
      const target = visible.find((item) => item.name === group.name) || null;
      const links = [];
      for (const link of group.links) {
        const url = normalizeUrl(link.url);
        if (!url) continue;
        const key = url.replace(/\/+$/, '');
        if (knownUrls.has(key)) {
          duplicates += 1;
          continue;
        }
        knownUrls.add(key);
        links.push({ title: link.title, url });
      }
      if (!links.length) continue;
      if (!target && !plannedNames.has(group.name)) {
        newGroups += 1;
        plannedNames.add(group.name);
      }
      newLinks += links.length;
      planned.push({ group, target, links });
    }

    if (!newLinks) {
      showToast(`没有新的书签${duplicates ? `（跳过 ${duplicates} 个重复）` : ''}`);
      return;
    }

    openBookmarkImport(planned, { duplicates, newLinks, newGroups });
  }

  function uniqueGroupName(base, used) {
    let name = String(base || '导入的书签').slice(0, 20);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    for (let i = 2; i < 100; i += 1) {
      const suffix = ` (${i})`;
      const candidate = `${name.slice(0, 20 - suffix.length)}${suffix}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    return name;
  }

  function openBookmarkImport(planned, { duplicates, newLinks, newGroups }) {
    if (!dom.bookmarkImportDialog) return;
    const visible = data.groups.filter((group) => !group.deletedAt);
    const usedNames = new Set(visible.map((group) => group.name));
    for (const item of planned) {
      item.newName = item.target ? item.target.name : uniqueGroupName(item.group.name, usedNames);
    }
    state.bookmarkImport = { planned, duplicates };
    if (dom.bookmarkImportSummary) {
      dom.bookmarkImportSummary.textContent = `将导入 ${newLinks} 个链接、${newGroups} 个新分组${
        duplicates ? `，跳过 ${duplicates} 个重复网址` : ''
      }。可以为每个目录选择现有分组，或保留新建分组。`;
    }
    dom.bookmarkImportList.innerHTML = planned
      .map((item, index) => {
        const options = [
          item.target
            ? ''
            : `<option value="new">新建分组「${escapeHTML(item.newName)}」</option>`,
          ...visible.map(
            (group) =>
              `<option value="existing:${escapeHTML(group.id)}" ${
                item.target && item.target.id === group.id ? 'selected' : ''
              }>${escapeHTML(group.name)}</option>`
          ),
        ];
        if (item.target) {
          options.unshift(
            `<option value="new">改为新建分组「${escapeHTML(item.newName)}」</option>`
          );
        }
        return `<div class="bookmark-import-row">
          <div class="bookmark-import-copy">
            <strong>${escapeHTML(item.group.name)}</strong>
            <small title="${escapeHTML(item.group.path)}">${escapeHTML(
              item.group.path
            )} · ${item.links.length} 个链接</small>
          </div>
          <select data-bookmark-target="${index}" aria-label="「${escapeHTML(
            item.group.name
          )}」的目标分组">${options.join('')}</select>
        </div>`;
      })
      .join('');
    dom.bookmarkImportList.querySelectorAll('select').forEach((select) => {
      if (globalThis.QingdhSelect) QingdhSelect.enhance(select);
    });
    dom.bookmarkImportDialog.showModal();
  }

  function applyBookmarkImport() {
    const pending = state.bookmarkImport;
    if (!pending) return;
    const planned = pending.planned;
    saveSnapshot('before-bookmarks');
    let added = 0;
    let limitHit = false;
    let createdGroups = 0;
    const created = new Map();

    for (let index = 0; index < planned.length; index += 1) {
      if (limitHit) break;
      const item = planned[index];
      const select = dom.bookmarkImportList.querySelector(
        `[data-bookmark-target="${index}"]`
      );
      const choice = select ? select.value : 'new';
      let target = null;
      if (choice.startsWith('existing:')) {
        target = data.groups.find((group) => group.id === choice.slice(9) && !group.deletedAt) || null;
      }
      if (!target && created.has(item.newName)) {
        target = created.get(item.newName);
      }
      if (!target) {
        if (data.groups.filter((group) => !group.deletedAt).length >= MAX_GROUPS) {
          limitHit = true;
          break;
        }
        target = makeGroup(item.newName);
        data.groups.push(target);
        created.set(item.newName, target);
        createdGroups += 1;
      }
      for (const link of item.links) {
        if (countLinks(data) >= MAX_LINKS) {
          limitHit = true;
          break;
        }
        target.links.push(makeLink(link.title, link.url));
        added += 1;
      }
      target.updatedAt = now();
    }

    state.bookmarkImport = null;
    if (dom.bookmarkImportDialog && dom.bookmarkImportDialog.open) dom.bookmarkImportDialog.close();
    const dropped = enforceLimits(data);
    commitLocalChange();
    dom.hubDialog.close();
    if (limitHit) showToast(`已导入 ${added} 个书签，达到数量上限后停止`);
    else if (dropped > 0) showToast(`已导入 ${added} 个书签，省略 ${dropped} 项超限数据`);
    else showToast(`已导入 ${added} 个书签${createdGroups ? `，新建 ${createdGroups} 个分组` : ''}`);
  }

  async function resetData() {
    const confirmed = await askConfirm({
      title: '恢复默认',
      message: '将清除所有自定义快捷方式，恢复为初始状态。确定继续吗？',
      confirmText: '恢复默认',
    });
    if (!confirmed) return;

    saveSnapshot('before-reset');
    data = createDefaultData();
    commitLocalChange();
    dom.hubDialog.close();
    showToast('已恢复默认设置');
  }

  async function restoreSnapshot() {
    const result = readSnapshot();
    if (result.status !== 'ready') {
      showToast(result.status === 'legacy'
        ? '旧备份缺少账号归属，无法安全恢复'
        : result.status === 'other'
          ? '备份属于其他账号，无法恢复'
          : '没有可用的备份');
      return;
    }
    const snapshot = result.snapshot;
    const owner = currentKey();
    const sessionSeq = sync.sessionSeq;
    const snapshotFingerprint = JSON.stringify(snapshot);
    const confirmed = await askConfirm({
      title: '恢复备份',
      message: `将用 ${formatTime(snapshot.at)} 的备份覆盖当前数据，确定继续吗？`,
      confirmText: '恢复',
      danger: false,
    });
    if (!confirmed) return;
    const latest = readSnapshot();
    if (owner !== currentKey() || sessionSeq !== sync.sessionSeq || latest.status !== 'ready' ||
        JSON.stringify(latest.snapshot) !== snapshotFingerprint) {
      showToast('账号或备份已变化，请重新查看备份');
      return;
    }

    data = stampAll(normalizeData(snapshot.data));
    commitLocalChange();
    dom.hubDialog.close();
    showToast('已恢复备份');
  }

  /* ------------------------------------------------------------------ *
   * 确认框 / 提示条
   * ------------------------------------------------------------------ */

  function askConfirm({ title = '确认操作', message = '', confirmText = '确定', danger = true }) {
    if (confirmResolver) settleConfirm(false);

    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmOk.textContent = confirmText;
    dom.confirmOk.classList.toggle('btn-danger', danger);
    dom.confirmOk.classList.toggle('btn-primary', !danger);

    dom.confirmDialog.showModal();
    requestAnimationFrame(() => dom.confirmCancel.focus());

    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function settleConfirm(result) {
    if (!confirmResolver) return;
    const resolve = confirmResolver;
    confirmResolver = null;
    if (dom.confirmDialog.open) dom.confirmDialog.close();
    resolve(result);
  }

  function showToast(message, { actionLabel = '', onAction = null, duration = 3000 } = {}) {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    dom.toastMessage.textContent = message;
    toastActionHandler = null;

    if (actionLabel && onAction) {
      dom.toastAction.textContent = actionLabel;
      dom.toastAction.hidden = false;
      toastActionHandler = onAction;
    } else {
      dom.toastAction.hidden = true;
    }

    // Native <dialog> lives in the top layer; a plain fixed toast would be
    // painted underneath its backdrop. A manual popover keeps the toast in
    // the same top layer, so errors triggered from dialogs stay visible.
    if (typeof dom.toast.showPopover === 'function') {
      try {
        if (!dom.toast.matches(':popover-open')) dom.toast.showPopover();
      } catch (error) {
        // Older browser: fall back to the normal fixed element.
      }
    }
    dom.toast.classList.add('show');
    toastTimer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    toastActionHandler = null;
    dom.toast.classList.remove('show');
    toastHideTimer = setTimeout(() => {
      if (typeof dom.toast.hidePopover === 'function') {
        try {
          if (dom.toast.matches(':popover-open')) dom.toast.hidePopover();
        } catch (error) {
          // ignore
        }
      }
    }, 220);
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  dom.searchForm.addEventListener('submit', handleSearch);
  dom.searchInput.addEventListener('compositionstart', () => {
    dom.searchInput.dataset.composing = 'true';
  });
  dom.searchInput.addEventListener('compositionend', () => {
    dom.searchInput.dataset.composing = 'false';
  });

  dom.engineBtn.addEventListener('click', () => setEngineMenu(!state.engineMenuOpen));
  dom.engineBtn.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setEngineMenu(true);
    }
  });

  dom.engineMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-engine]');
    if (option) selectEngine(option.dataset.engine);
  });

  dom.engineMenu.addEventListener('keydown', (event) => {
    const options = $$('.engine-option', dom.engineMenu);
    const index = options.indexOf(document.activeElement);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEngineMenu(false);
      dom.engineBtn.focus();
    } else if (event.key === 'Tab') {
      setEngineMenu(false);
    }
  });

  dom.searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setEngineMenu(false);
    if (dom.searchInput.value) {
      dom.searchInput.value = '';
    } else {
      dom.searchInput.blur();
    }
  });

  dom.groups.addEventListener('click', (event) => {
    if (state.batchMode) {
      const row = event.target.closest('.link-row[data-batch-row], .link-row');
      const link = row && row.querySelector('[data-link-id]');
      if (link) {
        event.preventDefault();
        toggleBatchLink(link.dataset.linkId);
        return;
      }
    }
    const actionEl = event.target.closest('[data-action]');

    if (actionEl) {
      event.preventDefault();
      const { action } = actionEl.dataset;

      if (action === 'delete-link') deleteLink(actionEl.dataset.linkId);
      else if (action === 'delete-group') deleteGroup(actionEl.dataset.groupId);
      else if (action === 'add-link') openLinkDialog({ groupId: actionEl.dataset.groupId });
      else if (action === 'toggle-group') toggleGroup(actionEl.dataset.groupId);
      return;
    }

    const titleEl = event.target.closest('.group-title');
    if (titleEl && state.editing) {
      openGroupDialog({ groupId: titleEl.closest('.group').dataset.groupId });
      return;
    }

    const linkEl = event.target.closest('a.link');
    if (linkEl && state.editing) {
      event.preventDefault();
      openLinkDialog({ linkId: linkEl.dataset.linkId });
    }
  });

  dom.groups.addEventListener('keydown', (event) => {
    if (!state.editing) return;
    const titleEl = event.target.closest('.group-title');
    if (titleEl && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openGroupDialog({ groupId: titleEl.closest('.group').dataset.groupId });
    }
  });

  dom.editBtn.addEventListener('click', () => setEditing(!state.editing));
  dom.settingsBtn.addEventListener('click', () => {
    if (state.drawerOpen) closeDrawer({ restoreFocus: false });
    openSettings();
  });
  dom.accountBtn.addEventListener('click', () => {
    if (state.drawerOpen) closeDrawer({ restoreFocus: false });
    openAccountDialog();
  });
  dom.accountSecurityOpen.addEventListener('click', () => setHubTab('privacy'));

  dom.brand.addEventListener('click', (event) => {
    if (isMobileLayout()) return;
    if (sidebarMode() !== 'collapsed') return;
    event.preventDefault();
    setSidebarMode('expanded');
  });

  dom.homeNav.addEventListener('click', (event) => {
    if (globalThis.QingdhMemo && QingdhMemo.isOpen()) {
      event.preventDefault();
      QingdhMemo.close();
    }
  });
  dom.historyNav.addEventListener('click', openSearchHistory);
  dom.historySearch.addEventListener('input', renderSearchHistory);
  dom.historyKinds.forEach((button) => button.addEventListener('click', () => {
    state.historyKind = button.dataset.historyKind;
    dom.historyKinds.forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderSearchHistory();
  }));
  dom.historyList.addEventListener('click', (event) => {
    const open = event.target.closest('[data-history-open]');
    if (open) {
      runHistorySearch(Number(open.dataset.historyOpen), open.dataset.historyAction);
      return;
    }
    const remove = event.target.closest('[data-history-remove]');
    if (remove) removeHistoryItem(Number(remove.dataset.historyRemove));
  });
  dom.historyClear.addEventListener('click', clearSearchHistory);

  dom.memoNav.addEventListener('click', () => {
    if (state.drawerOpen) closeDrawer({ restoreFocus: false });
    withOptionalModule('QingdhMemo', () => QingdhMemo.toggle());
  });

  prepareHubPanels();
  if (dom.hubCategory) {
    dom.hubCategory.innerHTML = dom.hubTabs
      .map(
        (button) =>
          `<option value="${escapeHTML(button.dataset.hubTab)}">${escapeHTML(
            button.dataset.title || button.textContent.trim()
          )}</option>`
      )
      .join('');
    dom.hubCategory.value = 'account';
    if (globalThis.QingdhSelect) QingdhSelect.enhance(dom.hubCategory);
    dom.hubCategory.addEventListener('change', () => {
      setHubTab(dom.hubCategory.value);
    });
  }

  dom.hubTabs.forEach((button) => {
    button.addEventListener('click', () => {
      setHubTab(button.dataset.hubTab);
    });
  });
  dom.aiConfigOpen.addEventListener('click', () => {
    if (globalThis.QingdhAI) QingdhAI.openConfig();
  });

  dom.sidebarCollapse.addEventListener('click', toggleSidebar);
  dom.sidebarHide.addEventListener('click', () => setSidebarMode('hidden'));
  dom.sidebarReveal.addEventListener('click', () => setSidebarMode(restoreSidebarMode()));
  dom.sidebarOpen.addEventListener('click', openDrawer);
  dom.sidebarScrim.addEventListener('click', () => closeDrawer());
  dom.syncBadge.addEventListener('click', () => openAccountDialog());
  dom.sidebar.addEventListener('mouseenter', () => {
    if (!prefs.sidebarAutoCollapse || isMobileLayout()) return;
    if (!state.hoverCollapsed) return;
    state.hoverCollapsed = false;
    applySidebar();
  });
  dom.sidebar.addEventListener('mouseleave', () => {
    if (!prefs.sidebarAutoCollapse || isMobileLayout()) return;
    if (prefs.sidebar !== 'expanded' || state.hoverCollapsed) return;
    if (isDialogOpen()) return;
    state.hoverCollapsed = true;
    applySidebar();
  });

  dom.themeBtn.addEventListener('click', () => {
    prefs.theme = resolveTheme() === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyTheme();
    syncSettingsUI();
  });

  dom.addLinkBtn.addEventListener('click', () => openLinkDialog());
  dom.addGroupBtn.addEventListener('click', () => openGroupDialog());
  dom.batchBtn.addEventListener('click', () => setBatchMode(!state.batchMode));
  dom.batchMove.addEventListener('click', batchMoveSelected);
  dom.batchDuplicates.addEventListener('click', batchCheckDuplicates);
  dom.batchDelete.addEventListener('click', batchDeleteSelected);
  dom.batchCancel.addEventListener('click', () => setBatchMode(false));

  dom.linkGroup.addEventListener('change', () => {
    toggleNewGroupField();
    if (!dom.linkGroupName.hidden) dom.linkGroupName.focus();
  });
  dom.linkForm.addEventListener('submit', handleLinkSubmit);
  dom.linkUrl.addEventListener('input', hideUrlError);
  dom.linkDialog.addEventListener('close', () => {
    state.linkEditId = null;
    hideUrlError();
  });

  dom.groupForm.addEventListener('submit', handleGroupSubmit);
  dom.groupDialog.addEventListener('close', () => {
    state.groupEditId = null;
  });

  dom.setName.addEventListener('input', () => {
    data.settings.name = dom.setName.value.trim().slice(0, 12);
    data.settings.updatedAt = now();
    commitLocalChange();
  });

  dom.setEngine.addEventListener('change', () => {
    data.settings.engine = dom.setEngine.value;
    data.settings.updatedAt = now();
    commitLocalChange();
    updateEngineUI();
    renderEngineSettings();
  });

  dom.engineConfigList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-engine-remove]');
    if (remove) {
      removeCustomEngine(remove.dataset.engineRemove);
      return;
    }
    const button = event.target.closest('[data-engine-default]');
    if (!button) return;
    setDefaultEngine(button.dataset.engineDefault);
  });

  dom.engineAddBtn.addEventListener('click', addCustomEngine);
  dom.engineAddOpen.addEventListener('click', () => {
    dom.engineAddError.hidden = true;
    dom.engineNewName.value = '';
    dom.engineNewBang.value = '';
    dom.engineNewUrl.value = '';
    dom.engineAddDialog.showModal();
    requestAnimationFrame(() => dom.engineNewName.focus());
  });
  dom.aiEngineConfigList.addEventListener('click', (event) => {
    if (!event.target.closest('[data-ai-config-open]')) return;
    if (globalThis.QingdhAI) QingdhAI.openConfig();
  });
  dom.engineConfigList.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-engine-id]');
    if (!row) return;
    engineDragId = row.dataset.engineId;
    row.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', engineDragId);
  });
  dom.engineConfigList.addEventListener('dragover', (event) => {
    const row = event.target.closest('[data-engine-id]');
    if (!row || !engineDragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dom.engineConfigList.querySelectorAll('.is-drag-over').forEach((item) => item.classList.remove('is-drag-over'));
    row.classList.add('is-drag-over');
  });
  dom.engineConfigList.addEventListener('drop', (event) => {
    const row = event.target.closest('[data-engine-id]');
    if (!row) return;
    event.preventDefault();
    moveEngineOrder(engineDragId, row.dataset.engineId);
    engineDragId = null;
  });
  dom.engineConfigList.addEventListener('dragend', () => {
    engineDragId = null;
    dom.engineConfigList.querySelectorAll('.is-dragging, .is-drag-over').forEach((item) => {
      item.classList.remove('is-dragging', 'is-drag-over');
    });
  });
  [dom.engineNewName, dom.engineNewBang, dom.engineNewUrl].forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addCustomEngine();
    });
  });

  dom.setOpen.addEventListener('change', () => {
    prefs.openInNewTab = dom.setOpen.value === 'new';
    savePrefs();
    render();
  });

  dom.setDensity.addEventListener('change', () => {
    prefs.density = dom.setDensity.value === 'compact' ? 'compact' : 'comfortable';
    savePrefs();
    applyDensity();
  });

  dom.setTheme.addEventListener('change', () => {
    prefs.theme = dom.setTheme.value;
    savePrefs();
    applyTheme();
  });

  dom.setClock.addEventListener('change', () => {
    prefs.clockStyle = CLOCK_STYLES.includes(dom.setClock.value) ? dom.setClock.value : 'editorial';
    applyClockPrefs();
    savePrefs();
    restartClock();
  });

  dom.setHour.addEventListener('change', () => {
    prefs.hourCycle = HOUR_CYCLES.includes(dom.setHour.value) ? dom.setHour.value : 'auto';
    applyClockPrefs();
    savePrefs();
    restartClock();
  });

  dom.setSeconds.addEventListener('change', () => {
    prefs.showSeconds = dom.setSeconds.checked;
    savePrefs();
    restartClock();
  });

  dom.setSidebar.addEventListener('change', () => {
    setSidebarMode(dom.setSidebar.value);
    syncSettingsSidebarUI();
  });

  dom.setSidebarSide.addEventListener('change', () => {
    prefs.sidebarSide = dom.setSidebarSide.value === 'right' ? 'right' : 'left';
    savePrefs();
    applySidebar();
  });

  dom.setSidebarHover.addEventListener('change', () => {
    prefs.sidebarAutoCollapse = dom.setSidebarHover.checked;
    if (!prefs.sidebarAutoCollapse) state.hoverCollapsed = false;
    savePrefs();
    applySidebar();
  });

  dom.seasonPicker.addEventListener('change', (event) => {
    const input = event.target.closest('input[name="season"]');
    if (!input || !SEASONS.includes(input.value)) return;
    prefs.season = input.value;
    savePrefs();
    applyTheme();
  });

  dom.deviceForget.addEventListener('click', () => forgetDevice());
  dom.passkeyEnable.addEventListener('click', enablePasskey);
  dom.passkeyRemove.addEventListener('click', removePasskey);
  dom.passkeyVerify.addEventListener('click', submitPasskey);
  dom.passkeyUsePassword.addEventListener('click', () => resolvePasskey(false));
  dom.passkeyDialog.addEventListener('close', () => {
    if (!cryptoState.passkeyResolver) return;
    const resolve = cryptoState.passkeyResolver;
    cryptoState.passkeyResolver = null;
    resolve(false);
  });

  dom.encryptionEnable.addEventListener('click', openEncryptDialog);
  dom.encryptionUnlock.addEventListener('click', unlockFromPanel);
  dom.encryptionChange.addEventListener('click', openChangeEncryptionDialog);
  dom.encryptForm.addEventListener('submit', submitEncrypt);
  dom.changeEncryptionForm.addEventListener('submit', submitChangeEncryption);
  dom.changeEncryptionRecoveryToggle.addEventListener('change', () => {
    const useRecovery = dom.changeEncryptionRecoveryToggle.checked;
    dom.changeEncryptionOldField.hidden = useRecovery;
    dom.changeEncryptionRecoveryField.hidden = !useRecovery;
    dom.changeEncryptionError.hidden = true;
    setTimeout(() => (useRecovery ? dom.changeEncryptionRecovery : dom.changeEncryptionOld).focus(), 20);
  });
  dom.recoveryContinue.addEventListener('click', finishEncryption);
  dom.recoveryCopy.addEventListener('click', copyRecoveryCode);
  dom.recoveryDownload.addEventListener('click', downloadRecoveryCode);
  dom.recoveryConfirm.addEventListener('change', () => {
    if (dom.recoveryConfirm.checked) dom.recoveryError.hidden = true;
  });
  dom.recoveryDialog.addEventListener('close', () => {
    if (cryptoState.pendingSetup) {
      cryptoState.pendingSetup = null;
      showToast('已取消开启加密');
    }
  });

  dom.unlockForm.addEventListener('submit', submitUnlock);
  dom.unlockRecoveryToggle.addEventListener('change', () => {
    const recovery = dom.unlockRecoveryToggle.checked;
    dom.unlockRecoveryField.hidden = !recovery;
    dom.unlockError.hidden = true;
    setTimeout(() => (recovery ? dom.unlockRecovery : dom.unlockPassword).focus(), 20);
  });
  dom.unlockLater.addEventListener('click', () => resolveUnlock(null));
  dom.unlockDialog.addEventListener('close', () => {
    const resolve = cryptoState.unlockResolver;
    if (!resolve) return;
    cryptoState.unlockResolver = null;
    resolve(null);
  });

  dom.decryptFileForm.addEventListener('submit', submitDecryptFile);
  dom.decryptFileRecoveryToggle.addEventListener('change', () => {
    const recovery = dom.decryptFileRecoveryToggle.checked;
    dom.decryptFileRecoveryField.hidden = !recovery;
    dom.decryptFileError.hidden = true;
    setTimeout(() => (recovery ? dom.decryptFileRecovery : dom.decryptFilePassword).focus(), 20);
  });
  dom.decryptFileCancel.addEventListener('click', () => resolveDecryptFile(null));
  dom.decryptFileDialog.addEventListener('close', () => {
    if (!cryptoState.fileDecryptResolver) return;
    const resolve = cryptoState.fileDecryptResolver;
    cryptoState.fileDecryptResolver = null;
    cryptoState.fileDecryptEnvelope = null;
    resolve(null);
  });

  dom.exportBtn.addEventListener('click', exportData);
  dom.importBtn.addEventListener('click', () => dom.importFile.click());
  dom.importBookmarksBtn.addEventListener('click', () => dom.bookmarksFile.click());
  dom.bookmarksFile.addEventListener('change', () => {
    const file = dom.bookmarksFile.files && dom.bookmarksFile.files[0];
    dom.bookmarksFile.value = '';
    importBookmarks(file);
  });
  if (dom.bookmarkImportOk) dom.bookmarkImportOk.addEventListener('click', applyBookmarkImport);
  if (dom.bookmarkImportDialog) {
    dom.bookmarkImportDialog.addEventListener('close', () => {
      state.bookmarkImport = null;
    });
  }
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    dom.importFile.value = '';
    importData(file);
  });
  dom.jsonImportDialog.addEventListener('change', (event) => {
    if (event.target.name === 'json-import-mode') updateJSONImportPreview();
  });
  dom.jsonImportDialog.addEventListener('close', () => {
    state.jsonImport = null;
  });
  dom.jsonImportOk.addEventListener('click', applyJSONImport);
  dom.restoreSnapshotBtn.addEventListener('click', restoreSnapshot);
  dom.resetBtn.addEventListener('click', resetData);

  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setAuthView(tab.dataset.authView));
  });
  dom.loginForm.addEventListener('submit', handleLogin);
  dom.registerForm.addEventListener('submit', handleRegister);
  dom.forgotForm.addEventListener('submit', handleForgot);
  dom.forgotLink.addEventListener('click', () => {
    dom.forgotEmail.value = dom.loginEmail.value.trim();
    setAuthView('forgot');
  });
  dom.forgotBack.addEventListener('click', () => setAuthView('login'));
  dom.resendLink.addEventListener('click', resendVerification);
  dom.resetForm.addEventListener('submit', handleResetPassword);
  dom.deleteForm.addEventListener('submit', handleDeleteAccount);

  dom.syncNowBtn.addEventListener('click', () => syncNow());
  if (dom.syncPageNow) dom.syncPageNow.addEventListener('click', () => syncNow());
  if (dom.syncAutoToggle) {
    dom.syncAutoToggle.addEventListener('change', () => {
      prefs.autoSync = dom.syncAutoToggle.checked;
      savePrefs();
      if (prefs.autoSync) syncNow();
      else if (sync.dirty) setStatus(sync.online ? 'dirty' : 'offline');
      renderSyncManager();
    });
  }
  if (dom.syncItemList) {
    dom.syncItemList.addEventListener('change', (event) => {
      const input = event.target.closest('[data-sync-scope]');
      if (!input) return;
      const key = input.dataset.syncScope;
      if (key !== 'groups' && key !== 'settings') return;
      prefs.syncScope[key] = input.checked;
      savePrefs();
      if (sync.user) {
        sync.dirty = true;
        writeSyncMeta();
        setStatus(sync.online ? 'dirty' : 'offline');
        scheduleSync(0);
      }
      renderSyncManager();
    });
  }
  dom.logoutBtn.addEventListener('click', handleLogout);
  dom.logoutAllBtn.addEventListener('click', handleLogoutAll);
  dom.deleteAccountBtn.addEventListener('click', () => {
    dom.deleteError.hidden = true;
    dom.deleteForm.reset();
    dom.deleteDialog.showModal();
    requestAnimationFrame(() => dom.deletePassword.focus());
  });
  dom.exportCloudBtn.addEventListener('click', () => {
    const anchor = document.createElement('a');
    anchor.href = '/api/v1/account/export';
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });

  dom.sessionsBlock.addEventListener('toggle', () => {
    if (dom.sessionsBlock.open) loadSessions();
  });

  dom.sessionsList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-session-id]');
    if (!button) return;
    button.disabled = true;
    const response = await api(`/api/v1/auth/sessions/${encodeURIComponent(button.dataset.sessionId)}`, {
      method: 'DELETE',
    });
    if (response.ok) {
      showToast('该设备已退出登录');
      loadSessions();
    } else {
      showToast(apiError(response, '操作失败'));
      button.disabled = false;
    }
  });

  dom.mergeDialog.addEventListener('click', (event) => {
    const button = event.target.closest('[data-merge]');
    if (button) settleMerge(button.dataset.merge);
  });
  dom.mergeDialog.addEventListener('close', () => {
    if (state.mergeResolver) settleMerge('later');
  });

  dom.confirmOk.addEventListener('click', () => settleConfirm(true));
  dom.confirmCancel.addEventListener('click', () => settleConfirm(false));
  dom.confirmDialog.addEventListener('close', () => {
    if (!confirmResolver) return;
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  });

  dom.toastAction.addEventListener('click', () => {
    const handler = toastActionHandler;
    hideToast();
    if (handler) handler();
  });

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const closeTrigger = event.target.closest('[data-close-dialog]');
    if (closeTrigger) {
      closeTrigger.closest('dialog')?.close();
      return;
    }

    if (state.engineMenuOpen && !dom.engine.contains(event.target)) {
      setEngineMenu(false);
    }
  });

  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const isTyping = isTypingTarget(target);

    // 隐私空间打开时，普通快捷键不生效，避免把搜索框等焦点抢到遮罩后面。
    if (globalThis.QingdhPrivacy && QingdhPrivacy.isOpen()) return;

    if (state.drawerOpen && !isDialogOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      trapDrawerFocus(event);
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Period') {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      withOptionalModule('QingdhMemo', () => QingdhMemo.quickCapture());
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      withOptionalModule('QingdhCommandPalette', () => QingdhCommandPalette.open());
      return;
    }

    if (
      event.key === '/' &&
      !isTyping &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !isDialogOpen()
    ) {
      event.preventDefault();
      focusSearch();
      return;
    }

    if (
      event.key === 'Escape' &&
      globalThis.QingdhMemo &&
      QingdhMemo.isOpen() &&
      !isTyping &&
      !isDialogOpen()
    ) {
      QingdhMemo.close();
      return;
    }

    if (event.key === 'Escape' && state.editing && !isTyping && !isDialogOpen() && !state.engineMenuOpen) {
      setEditing(false);
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (prefs.theme === 'auto') applyTheme();
  });

  window.addEventListener('online', () => {
    sync.online = true;
    if (sync.user) {
      setStatus(sync.dirty ? 'dirty' : 'syncing');
      syncNow();
    }
  });

  window.addEventListener('offline', () => {
    sync.online = false;
    if (sync.user) setStatus('offline');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      restartClock();
      if (globalThis.QingdhMemo) QingdhMemo.checkReminders();
    }
    if (document.visibilityState === 'visible' && sync.user && !sync.inFlight && sync.status !== 'auth') {
      syncNow();
    }
  });

  window.addEventListener('focus', () => {
    if (sync.user && !sync.inFlight && sync.status !== 'auth') syncNow();
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function handleUrlFlags() {
    // /ai 的 q/provider 是结果页路由参数，不能被认证参数清理逻辑移除。
    if (location.pathname === '/ai' || location.pathname === '/ai/') return;
    const params = new URLSearchParams(location.search);
    if (!params.toString()) return;

    const verified = params.get('verified');
    const verifyError = params.get(VERIFY_TOKEN_PARAM);
    const resetToken = params.get(RESET_TOKEN_PARAM);
    const loginRequested = params.get('login') === '1';

    if (verified === '1') showToast('邮箱验证成功，已登录');
    else if (verifyError === 'error') showToast('验证链接无效或已过期');
    else if (verifyError === 'rate_limited') showToast('请求过于频繁，请稍后再试');

    if (loginRequested) {
      state.openLoginAfterInit = true;
    }

    if (resetToken) {
      state.resetToken = resetToken;
      dom.resetForm.reset();
      dom.resetError.hidden = true;
      dom.resetDialog.showModal();
      requestAnimationFrame(() => dom.resetPassword.focus());
    }

    const clean = location.pathname + location.hash;
    history.replaceState(null, '', clean);
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== SEARCH_HISTORY_KEY) return;
    searchHistoryCache = null;
    if (dom.historyDialog && dom.historyDialog.open) renderSearchHistory();
  });

  function setupChannel() {
    if (!('BroadcastChannel' in window)) return;
    channel = new BroadcastChannel(BROADCAST_CHANNEL);
    channel.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'data-changed') return;
      if (applyingRemote) return;

      const currentUser = sync.user ? sync.user.id : null;
      if (message.userId !== currentUser) return;

      const stored = readJSON(currentKey());
      if (!stored) return;
      applyingRemote = true;
      data = normalizeData(stored);
      render();
      renderClock();
      applyingRemote = false;
    });
  }

  // 首屏只需要 core + app；备忘录、AI、隐私、命令面板等按需加载，避免在
  // 手机上为从不打开的页面解析数百 KiB JS。脚本注入仍走同源 classic script。
  const OPTIONAL_SCRIPTS = ['memo.js', 'ai.js', 'privacy.js', 'command-palette.js', 'passkey.js', 'avatars.js'];
  let optionalModulesPromise = null;
  let optionalModulesWired = false;

  function loadOptionalModules() {
    if (optionalModulesPromise) return optionalModulesPromise;
    optionalModulesPromise = Promise.all(
      OPTIONAL_SCRIPTS.map(
        (name) =>
          new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = ASSET_VERSION ? `${name}?v=${ASSET_VERSION}` : name;
            script.defer = true;
            script.onload = () => resolve(true);
            script.onerror = () => {
              console.warn('加载前端模块失败', name);
              resolve(false);
            };
            document.head.appendChild(script);
          })
      )
    );
    return optionalModulesPromise;
  }

  function withOptionalModule(name, action) {
    if (globalThis[name]) {
      action();
      return;
    }
    loadOptionalModules().then(() => {
      wireOptionalModules();
      if (globalThis[name]) action();
    });
  }

  async function init() {
    try {
      if (!localStorage.getItem(PREFS_KEY)) savePrefs();
    } catch (error) {
      // 隐私模式等场景下本地存储不可用，页面仍然可以正常浏览。
    }

    mobileQuery = window.matchMedia('(max-width: 860px)');
    mobileQuery.addEventListener('change', () => {
      if (!mobileQuery.matches) {
        state.drawerOpen = false;
      }
      applySidebar();
    });

    migrateLegacyStorage();
    applyDensity();
    loadSiteInfo();

    refreshEngineSelect();

    if (globalThis.QingdhSelect) {
      QingdhSelect.enhance(dom.linkGroup);
      QingdhSelect.enhance(dom.setDensity);
      QingdhSelect.enhance(dom.setEngine);
      QingdhSelect.enhance(dom.setOpen);
      QingdhSelect.enhance(dom.setTheme);
      QingdhSelect.enhance(dom.setClock);
      QingdhSelect.enhance(dom.setHour);
      QingdhSelect.enhance(dom.setSidebar);
    }

    buildEngineMenu();
    applyTheme();
    applyClockPrefs();
    applySidebar();
    restartClock();
    render();
    syncSettingsUI();
    updateEngineUI();
    updateSyncUI();

    setupChannel();
    handleUrlFlags();

    // Start fetching optional modules immediately; the first render above is
    // already interactive while they download and parse.
    const modules = loadOptionalModules();

    await initAccount();
    updateSnapshotButton();
    await modules;
    wireOptionalModules();
    updateAccountUI();
    updateDeviceUI();
    if (globalThis.QingdhAI) QingdhAI.restoreRoute();

    if (state.openLoginAfterInit) {
      state.openLoginAfterInit = false;
      openAccountDialog();
    }
  }

  function wireOptionalModules() {
    if (optionalModulesWired) return;
    optionalModulesWired = true;
    if (globalThis.QingdhMemo) {
    QingdhMemo.init({
      escapeHTML,
      uid,
      now,
      formatTime,
      toast: showToast,
      confirm: askConfirm,
      openAccountDialog,
      openSettings,
      currentUser: () => sync.user,
      isEncrypted: () => cryptoState.enabled && Boolean(cryptoState.envelope),
      hasDataKey: () => Boolean(cryptoState.dataKeyRaw),
      ensureDataKey,
      onCount: (count) => {
        dom.memoCount.hidden = !(count > 0);
        dom.memoCount.textContent = count > 99 ? '99+' : String(count);
      },
      onOpenChange: (open) => {
        dom.memoNav.classList.toggle('is-current', open);
        dom.homeNav.classList.toggle('is-current', !open);
        if (open) dom.homeNav.removeAttribute('aria-current');
        else dom.homeNav.setAttribute('aria-current', 'page');
      },
    });
  }

  if (globalThis.QingdhAI) {
    QingdhAI.init({
      toast: showToast,
      openAccountDialog,
      openAIConfig: () => openAIConfig(),
      isHubOpen: () => Boolean(dom.hubDialog && dom.hubDialog.open),
      focusSearch,
      openURL: navigate,
      isLoggedIn: () => Boolean(sync.user),
      engineName: () => currentEngine().name,
      engineIcon: () => {
        try {
          // 只为当前选中的搜索引擎请求一次图标；直接访问其站点，避免
          // 服务端无法出网时连搜索引擎图标都退化成首字母。
          return new URL(engineBuild(currentEngine())('q')).origin + '/favicon.ico';
        } catch (error) {
          return '';
        }
      },
      getEngines: () =>
        allEngines().map((engine) => ({
          id: engine.id,
          name: engine.name,
          bang: engine.bang,
          selected: engine.id === currentEngine().id,
        })),
      selectEngine: (id) => selectEngine(id),
      webSearch: (query) => {
        recordSearch(query, currentEngine());
        navigate(engineBuild(currentEngine())(query));
      },
      recordAIHistory: (payload) => recordAIHistory(payload),
      getAIHistorySnapshot: (query, providerId) => getAIHistorySnapshot(query, providerId),
      isEncrypted: () => cryptoState.enabled && Boolean(cryptoState.envelope),
      hasDataKey: () => Boolean(cryptoState.dataKeyRaw),
      ensureDataKey,
    });
  }

  if (globalThis.QingdhCommandPalette) {
    QingdhCommandPalette.init({
      escapeHTML,
      engineName: () => currentEngine().name,
      aiProviderName: () => (globalThis.QingdhAI ? QingdhAI.activeLabel() : ''),
      searchWeb: (query) => {
        recordSearch(query, currentEngine());
        navigate(engineBuild(currentEngine())(query));
      },
      askAI: async (query) => {
        if (!globalThis.QingdhAI) return;
        if (!QingdhAI.isActive()) await QingdhAI.activate();
        QingdhAI.openAsk(query);
      },
      newMemo: () => {
        if (globalThis.QingdhMemo) QingdhMemo.openAndCreate();
      },
      openMemo: () => {
        if (globalThis.QingdhMemo) QingdhMemo.open();
      },
      openMemoById: (id) => {
        if (globalThis.QingdhMemo) QingdhMemo.openById(id);
      },
      openPrivacy: () => {
        if (globalThis.QingdhPrivacy) QingdhPrivacy.requestOpen();
      },
      openSettings,
      openAccount: openAccountDialog,
      toggleTheme: () => {
        prefs.theme = resolveTheme() === 'dark' ? 'light' : 'dark';
        savePrefs();
        applyTheme();
        syncSettingsUI();
      },
      toggleEdit: () => setEditing(!state.editing),
      exportData,
      navigateURL: (url) => navigate(url),
      getGroups: () => data.groups.filter((group) => !group.deletedAt),
      openGroup: jumpToGroup,
      getLinks: () =>
        data.groups
          .filter((group) => !group.deletedAt)
          .flatMap((group) => group.links.filter((link) => !link.deletedAt)),
      getMemoTitles: () => (globalThis.QingdhMemo ? QingdhMemo.titles() : []),
      getMemos: () => (globalThis.QingdhMemo ? QingdhMemo.searchEntries() : []),
    });
  }

  if (globalThis.QingdhPrivacy) {
    QingdhPrivacy.init({
      api,
      toast: showToast,
      confirm: askConfirm,
      escapeHTML,
      uid,
      now,
      formatTime,
      currentUser: () => sync.user,
      openAccountDialog,
      normalizeURL: (value) => normalizeUrl(value),
      closeMemo: () => {
        if (globalThis.QingdhMemo) QingdhMemo.close();
      },
      getShortcut: () => prefs.privacyShortcut,
      setShortcut: (value) => {
        prefs.privacyShortcut = value;
        savePrefs();
      },
    });
  }

  }

  if (globalThis.QingdhSecrets) {
    QingdhSecrets.configure({
      api,
      getDataKey: () => cryptoState.dataKeyRaw,
      onAuthLost: () => {
        handleAuthLost();
      },
      onChange: () => {},
    });
  }

  if (globalThis.QingdhPWA) {
    QingdhPWA.init({ toast: showToast });
  }

  init();
})();
