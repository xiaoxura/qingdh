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

  const storeLib = globalThis.QingdhStore;
  const renderLib = globalThis.QingdhRender;
  const enginesLib = globalThis.QingdhEngines;
  if (!storeLib || !renderLib || !enginesLib) {
    throw new Error('QingdhStore/QingdhRender/QingdhEngines is not loaded');
  }
  const ENGINES = enginesLib.ENGINES;
  const { engineBuild, engineHost } = enginesLib;

  const storage = storeLib.createStorage({
    storage: (() => {
      try {
        return globalThis.localStorage;
      } catch (error) {
        return null;
      }
    })(),
    onError: () => showToast('保存失败：浏览器本地存储不可用或已满'),
  });
  const { readJSON, writeJSON, removeKey, readFlag, writeFlag } = storage;

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

  const dataModel = globalThis.QingdhData.createDataModel({
    uid,
    toTimestamp,
    toTombstone,
    normalizeUrl,
    engines: ENGINES,
    now,
  });
  const {
    makeLink,
    makeGroup,
    createDefaultData,
    normalizeLink,
    normalizeData,
    countLinks,
    countGroups,
  } = dataModel;

  const mergeModel = globalThis.QingdhMerge.createMergeModel({
    normalizeData,
    normalizeUrl,
    clone,
    now,
  });
  const {
    linkIndexForMerge,
    buildMergeDiff,
    newer,
    mergeSettings,
    mergeLink,
    mergeDocuments,
    mergeGroup,
  } = mergeModel;

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

  const domSpec = {
    clock: '#clock',
    today: '#today',
    greeting: '#greeting',

    sidebar: '#sidebar',
    brand: '#brand-link',
    sidebarCollapse: '#sidebar-collapse',
    sidebarHide: '#sidebar-hide',
    sidebarReveal: '#sidebar-reveal',
    sidebarOpen: '#sidebar-open',
    sidebarScrim: '#sidebar-scrim',
    homeNav: '#home-nav',
    memoNav: '#memo-nav',
    memoCount: '#memo-count',
    historyNav: '#history-nav',
    historyDialog: '#history-dialog',
    historyList: '#history-list',
    historySearch: '#history-search',
    historyKinds: { all: '[data-history-kind]' },
    historyCount: '#history-count',
    historyClear: '#history-clear',

    searchForm: '#search-form',
    searchInput: '#search-input',
    engine: '#engine',
    engineBtn: '#engine-btn',
    aiModeBtn: '#ai-mode-btn',
    engineName: '#engine-name',
    engineMenu: '#engine-menu',

    groups: '#groups',
    addLinkBtn: '#add-link-btn',
    addGroupBtn: '#add-group-btn',
    batchBtn: '#batch-btn',
    batchBar: '#batch-bar',
    batchCount: '#batch-count',
    batchTarget: '#batch-target',
    batchMove: '#batch-move',
    batchDuplicates: '#batch-duplicates',
    batchDelete: '#batch-delete',
    batchCancel: '#batch-cancel',

    themeBtn: '#theme-btn',
    themeLabel: '#theme-label',
    editBtn: '#edit-btn',
    settingsBtn: '#settings-btn',
    accountBtn: '#account-btn',
    accountLabel: '#account-label',
    accountAvatarMini: '#account-avatar-mini',
    syncBadge: '#sync-badge',
    syncBadgeText: '#sync-badge-text',

    linkDialog: '#link-dialog',
    linkForm: '#link-form',
    linkDialogTitle: '#link-dialog-title',
    linkTitle: '#link-title',
    linkUrl: '#link-url',
    linkUrlError: '#link-url-error',
    linkIcon: '#link-icon',
    linkGroup: '#link-group',
    linkGroupName: '#link-group-name',
    linkSubmit: '#link-submit',

    groupDialog: '#group-dialog',
    groupForm: '#group-form',
    groupDialogTitle: '#group-dialog-title',
    groupName: '#group-name',

    hubDialog: '#hub-dialog',
    hubTabs: { all: '[data-hub-tab]' },
    hubCategory: '#hub-category',
    hubPanels: { all: '[data-hub-panel]' },
    hubPanelTitle: '#hub-panel-title',
    hubPanelDesc: '#hub-panel-desc',
    hubSubnav: '#hub-subnav',
    hubBody: '#hub-body',
    hubFootNote: '#hub-foot-note',
    hubDone: '#hub-done',
    aiConfigSave: '#ai-config-save',
    aiConfigGate: '#ai-config-gate',
    aiConfigGateTitle: '#ai-config-gate-title',
    aiConfigGateDesc: '#ai-config-gate-desc',
    aiConfigGateAction: '#ai-config-gate-action',
    aiProviderList: '#ai-provider-list',
    setName: '#set-name',
    setDensity: '#set-density',
    setEngine: '#set-engine',
    engineConfigList: '#engine-config-list',
    engineAddOpen: '#engine-add-open',
    engineAddDialog: '#engine-add-dialog',
    engineNewName: '#engine-new-name',
    engineNewBang: '#engine-new-bang',
    engineNewUrl: '#engine-new-url',
    engineAddBtn: '#engine-add-btn',
    engineAddError: '#engine-add-error',
    setOpen: '#set-open',
    setTheme: '#set-theme',
    setClock: '#set-clock',
    setHour: '#set-hour',
    setSeconds: '#set-seconds',
    setSidebar: '#set-sidebar',
    setSidebarSide: '#set-sidebar-side',
    setSidebarHover: '#set-sidebar-hover',
    seasonPicker: '#season-picker',
    exportBtn: '#export-btn',
    importBtn: '#import-btn',
    importFile: '#import-file',
    jsonImportDialog: '#json-import-dialog',
    jsonImportSource: '#json-import-source',
    jsonImportSummary: '#json-import-summary',
    jsonImportError: '#json-import-error',
    jsonImportOk: '#json-import-ok',
    importBookmarksBtn: '#import-bookmarks-btn',
    bookmarksFile: '#bookmarks-file',
    bookmarkImportDialog: '#bookmark-import-dialog',
    bookmarkImportList: '#bookmark-import-list',
    bookmarkImportSummary: '#bookmark-import-summary',
    bookmarkImportOk: '#bookmark-import-ok',
    restoreSnapshotBtn: '#restore-snapshot-btn',
    revisionsBtn: '#revisions-btn',
    revisionsDialog: '#revisions-dialog',
    revisionsList: '#revisions-list',
    revisionsError: '#revisions-error',
    revisionPreview: '#revision-preview',
    revisionPreviewTitle: '#revision-preview-title',
    revisionPreviewBody: '#revision-preview-body',
    revisionPreviewGroups: '#revision-preview-groups',
    resetBtn: '#reset-btn',

    accountGuest: '#account-guest',
    accountUser: '#account-user',
    accountAvatar: '#account-avatar',
    accountEmail: '#account-email',
    accountMeta: '#account-meta',
    authNote: '#auth-note',

    loginForm: '#login-form',
    loginEmail: '#login-email',
    loginPassword: '#login-password',
    loginError: '#login-error',
    loginSubmit: '#login-submit',
    forgotLink: '#forgot-link',
    resendLink: '#resend-link',

    registerForm: '#register-form',
    registerEmail: '#register-email',
    registerPassword: '#register-password',
    registerPassword2: '#register-password2',
    registerError: '#register-error',
    registerSubmit: '#register-submit',

    forgotForm: '#forgot-form',
    forgotEmail: '#forgot-email',
    forgotError: '#forgot-error',
    forgotSubmit: '#forgot-submit',
    forgotBack: '#forgot-back',

    syncPanel: '[data-hub-panel="sync"]',
    syncGuestPanel: '#sync-guest-panel',
    syncManagerPanel: '#sync-manager-panel',
    syncCloudTotal: '#sync-cloud-total',
    syncLocalTotal: '#sync-local-total',
    syncPageState: '#sync-page-state',
    syncItemList: '#sync-item-list',
    syncAutoToggle: '#sync-auto-toggle',
    syncPageNow: '#sync-page-now',
    encryptionState: '#encryption-state',
    encryptionPanel: '#encryption-panel',
    encryptionGuest: '#encryption-guest',
    encryptionHint: '#encryption-hint',
    encryptionEnable: '#encryption-enable',
    encryptionUnlock: '#encryption-unlock',
    encryptionChange: '#encryption-change',
    encryptionRecovery: '#encryption-recovery',
    encryptionDisable: '#encryption-disable',
    disableEncryptionDialog: '#disable-encryption-dialog',
    disableEncryptionForm: '#disable-encryption-form',
    disableEncryptionDependency: '#disable-encryption-dependency',
    disableEncryptionDependencyMessage: '#disable-encryption-dependency-message',
    disableEncryptionDiscard: '#disable-encryption-discard',
    disableEncryptionPassword: '#disable-encryption-password',
    disableEncryptionConfirm: '#disable-encryption-confirm',
    disableEncryptionError: '#disable-encryption-error',
    disableEncryptionSubmit: '#disable-encryption-submit',
    encryptDialog: '#encrypt-dialog',
    encryptForm: '#encrypt-form',
    encryptPassword: '#encrypt-password',
    encryptPassword2: '#encrypt-password2',
    encryptError: '#encrypt-error',
    encryptSubmit: '#encrypt-submit',
    recoveryDialog: '#recovery-dialog',
    recoveryCode: '#recovery-code',
    recoveryCopy: '#recovery-copy',
    recoveryDownload: '#recovery-download',
    recoveryConfirm: '#recovery-confirm',
    recoveryContinue: '#recovery-continue',
    recoveryError: '#recovery-error',
    unlockDialog: '#unlock-dialog',
    unlockForm: '#unlock-form',
    unlockMessage: '#unlock-message',
    unlockPassword: '#unlock-password',
    unlockRecoveryToggle: '#unlock-recovery-toggle',
    unlockRecoveryField: '#unlock-recovery-field',
    unlockRecovery: '#unlock-recovery',
    unlockRemember: '#unlock-remember',
    unlockRememberLine: '#unlock-remember-line',
    unlockRememberNote: '#unlock-remember-note',
    unlockError: '#unlock-error',
    unlockSubmit: '#unlock-submit',
    unlockLater: '#unlock-later',
    deviceState: '#device-state',
    deviceHint: '#device-hint',
    deviceForget: '#device-forget',
    passkeyState: '#passkey-state',
    passkeyHint: '#passkey-hint',
    passkeyEnable: '#passkey-enable',
    passkeyRemove: '#passkey-remove',
    passkeyDialog: '#passkey-dialog',
    passkeyError: '#passkey-error',
    passkeyVerify: '#passkey-verify',
    passkeyUsePassword: '#passkey-use-password',
    rotateRecoveryDialog: '#rotate-recovery-dialog',
    rotateRecoveryForm: '#rotate-recovery-form',
    rotateRecoveryPassword: '#rotate-recovery-password',
    rotateRecoveryError: '#rotate-recovery-error',
    rotateRecoverySubmit: '#rotate-recovery-submit',
    newRecoveryDialog: '#new-recovery-dialog',
    newRecoveryCode: '#new-recovery-code',
    newRecoveryConfirm: '#new-recovery-confirm',
    newRecoveryError: '#new-recovery-error',
    newRecoverySave: '#new-recovery-save',
    newRecoveryCopy: '#new-recovery-copy',
    newRecoveryDownload: '#new-recovery-download',
    changeEncryptionDialog: '#change-encryption-dialog',
    changeEncryptionForm: '#change-encryption-form',
    changeEncryptionOld: '#change-encryption-old',
    changeEncryptionOldField: '#change-encryption-old-field',
    changeEncryptionRecoveryToggle: '#change-encryption-recovery-toggle',
    changeEncryptionRecoveryField: '#change-encryption-recovery-field',
    changeEncryptionRecovery: '#change-encryption-recovery',
    changeEncryptionNew: '#change-encryption-new',
    changeEncryptionNew2: '#change-encryption-new2',
    changeEncryptionError: '#change-encryption-error',
    changeEncryptionSubmit: '#change-encryption-submit',
    decryptFileDialog: '#decrypt-file-dialog',
    decryptFileForm: '#decrypt-file-form',
    decryptFilePassword: '#decrypt-file-password',
    decryptFileRecoveryToggle: '#decrypt-file-recovery-toggle',
    decryptFileRecoveryField: '#decrypt-file-recovery-field',
    decryptFileRecovery: '#decrypt-file-recovery',
    decryptFileError: '#decrypt-file-error',
    decryptFileSubmit: '#decrypt-file-submit',
    decryptFileCancel: '#decrypt-file-cancel',
    sessionsBlock: '#sessions-block',
    sessionsList: '#sessions-list',
    adminLink: '#admin-link',
    changeEmailBtn: '#change-email',
    changeEmailHint: '#email-change-hint',
    changeEmailDialog: '#change-email-dialog',
    changeEmailForm: '#change-email-form',
    changeEmailCurrent: '#change-email-current',
    changeEmailPassword: '#change-email-password',
    changeEmailNew: '#change-email-new',
    changeEmailError: '#change-email-error',
    changeEmailSubmit: '#change-email-submit',
    changePasswordBtn: '#change-password',
    logoutAllBtn: '#logout-all',
    logoutBtn: '#logout',
    deleteAccountBtn: '#delete-account',
    changePasswordDialog: '#change-password-dialog',
    changePasswordForm: '#change-password-form',
    changePasswordCurrent: '#change-password-current',
    changePasswordNew: '#change-password-new',
    changePasswordNew2: '#change-password-new2',
    changePasswordError: '#change-password-error',
    changePasswordSubmit: '#change-password-submit',

    mergeDialog: '#merge-dialog',
    mergeTitle: '#merge-title',
    mergeMessage: '#merge-message',
    mergeDiff: '#merge-diff',

    resetDialog: '#reset-dialog',
    resetForm: '#reset-form',
    resetPassword: '#reset-password',
    resetPassword2: '#reset-password2',
    resetError: '#reset-error',
    resetSubmit: '#reset-submit',

    deleteDialog: '#delete-dialog',
    deleteForm: '#delete-form',
    deletePassword: '#delete-password',
    deleteError: '#delete-error',
    deleteSubmit: '#delete-submit',

    confirmDialog: '#confirm-dialog',
    confirmTitle: '#confirm-title',
    confirmMessage: '#confirm-message',
    confirmOk: '#confirm-ok',
    confirmCancel: '#confirm-cancel',

    toast: '#toast',
    toastMessage: '#toast-message',
    toastAction: '#toast-action',
  };

  // 对话框的 HTML 先放在 <template> 里，首次打开任意对话框时一次性注入。
  // dom 通过 Proxy 惰性解析：元素还不存在时返回一个可记录监听器的占位对象，
  // 注入完成后清空缓存并把这些监听器绑定到真实元素上。
  const domCache = new Map();
  const domPlaceholders = new Map();

  function makeDomPlaceholder(key) {
    if (domPlaceholders.has(key)) return domPlaceholders.get(key).stub;
    const listeners = [];
    const noop = () => {};
    const stub = {
      __qingdhPlaceholder: true,
      addEventListener(type, fn, opts) {
        listeners.push({ type, fn, opts });
      },
      removeEventListener: noop,
      dispatchEvent: () => false,
      setAttribute: noop,
      removeAttribute: noop,
      getAttribute: () => null,
      hasAttribute: () => false,
      toggleAttribute: noop,
      focus: noop,
      blur: noop,
      click: noop,
      reset: noop,
      showModal: noop,
      close: noop,
      appendChild: noop,
      removeChild: noop,
      remove: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {},
      dataset: {},
      hidden: false,
      value: '',
      checked: false,
      disabled: false,
      open: false,
      textContent: '',
      innerHTML: '',
      title: '',
      href: '',
      src: '',
    };
    domPlaceholders.set(key, { stub, listeners });
    return stub;
  }

  function resolveDomKey(key) {
    const spec = domSpec[key];
    if (typeof spec === 'string') return spec ? document.querySelector(spec) : null;
    if (spec && spec.all) return Array.from(document.querySelectorAll(spec.all));
    return null;
  }

  const dom = new Proxy({}, {
    get(_target, key) {
      if (domCache.has(key)) return domCache.get(key);
      const value = resolveDomKey(key) ?? makeDomPlaceholder(key);
      domCache.set(key, value);
      return value;
    },
  });

  let dialogsInjected = false;

  // 首次打开任意对话框时，把 26 个 <template> 中的 dialog 一次性注入 DOM。
  // 之后清空 dom 缓存，并把此前在占位对象上注册的监听器重放到真实元素。
  function ensureDialogs() {
    if (dialogsInjected) return;
    dialogsInjected = true;
    for (const template of Array.from(document.querySelectorAll('template[data-dialog-template]'))) {
      const dialog = template.content.querySelector('dialog');
      if (dialog) document.body.appendChild(dialog);
      template.remove();
    }
    domCache.clear();
    cryptoUI.initDialogControllers();
    enhanceDialogSelects();
    for (const [key, record] of domPlaceholders) {
      const element = resolveDomKey(key);
      if (element && typeof element.addEventListener === 'function') {
        for (const { type, fn, opts } of record.listeners) element.addEventListener(type, fn, opts);
      }
    }
    domPlaceholders.clear();
    bindDialogShells();
  }

  function bindDialogShells() {
    document.querySelectorAll('dialog').forEach((dialog) => {
      if (dialog.dataset.shellBound === '1') return;
      dialog.dataset.shellBound = '1';
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  function enhanceDialogSelects() {
    if (!globalThis.QingdhSelect) return;
    if (dom.linkGroup && !dom.linkGroup.__qingdhPlaceholder) QingdhSelect.enhance(dom.linkGroup);
  }

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
    disableBlockingSecrets: [],
    revisions: [],
  };

  const cryptoState = {
    enabled: false,
    unlocked: false,
    envelope: null,
    dataKeyRaw: null,
    pendingSetup: null,
    pendingRecovery: null,
    unlockEnvelope: null,
    unlockTemporary: false,
    fileDecryptEnvelope: null,
    vaultRemembered: false,
    vaultEnvelopeId: null,
    passkeyRegistered: false,
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
    lastAutoSyncAt: 0,
    encrypted: false,
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

  // 限额逻辑是纯函数，放在 lib/core.js 里做表驱动测试；这里只绑定本应用的限额。
  function enforceLimits(doc) {
    return core.enforceLimits(doc, { maxGroups: MAX_GROUPS, maxLinks: MAX_LINKS });
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
    return readFlag(GUEST_DIRTY_KEY);
  }

  function writeGuestDirty(value) {
    writeFlag(GUEST_DIRTY_KEY, value);
  }

  function writeSyncMeta() {
    if (!sync.user) return;
    writeJSON(syncMetaKey(), {
      revision: sync.revision,
      lastSyncedAt: sync.lastSyncedAt,
      dirty: sync.dirty,
      encrypted: Boolean(sync.encrypted),
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

  const renderer = renderLib.createRenderer({
    escapeHTML,
    hostOf,
    faviconOf,
    hueOf,
    glyphOf,
    directFaviconOf,
    icons: { plus: ICON_PLUS, x: ICON_X },
    getPrefs: () => prefs,
    getState: () => state,
  });

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
    dom.groups.innerHTML =
      renderer.renderGroups(data.groups) ||
      '<p class="empty">还没有快捷方式，点击下方按钮添加一个吧</p>';

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
      // 桌面端完全隐藏侧栏时也要 inert，否则 Tab 仍会进入视觉上不可见的
      // 链接；焦点先移到屏幕边缘的唤出按钮，再标记 aria-hidden。
      const hidden = mode === 'hidden';
      dom.sidebar.inert = hidden;
      if (hidden && dom.sidebar.contains(document.activeElement)) {
        dom.sidebarReveal.focus();
      }
      if (hidden) dom.sidebar.setAttribute('aria-hidden', 'true');
      else dom.sidebar.removeAttribute('aria-hidden');
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
    // 菜单用 allEngines() 渲染，校验也必须覆盖自定义引擎，否则自定义项点击无效。
    if (!allEngines().some((engine) => engine.id === id)) return;
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
    ensureDialogs();
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
      mark.innerHTML = '<span class="brand-logo"></span>';
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

  async function api(path, { method = 'GET', body = null, keepalive = false, etag = null } = {}) {
    const options = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };
    if (keepalive) options.keepalive = true;
    if (etag) options.headers['If-None-Match'] = etag;
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
      return {
        status: response.status,
        ok: response.ok || response.status === 304,
        notModified: response.status === 304,
        data: payload,
        networkError: false,
      };
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

  const cryptoUI = globalThis.QingdhCryptoUI.create({
    dom,
    prefs,
    sync,
    cryptoState,
    state,
    api,
    apiError,
    normalizeData,
    now,
    showToast,
    askConfirm,
    ensureDialogs,
    syncNow: (options) => syncNow(options),
    setStatus,
    writeSyncMeta,
    writeGuestDirty,
    persist,
    updateSyncUI: () => updateSyncUI(),
    handleAuthLost: () => handleAuthLost(),
    broadcast: (message) => {
      if (!channel) return;
      try {
        channel.postMessage(message);
      } catch (error) {
        // ignore
      }
    },
    getData: () => data,
  });
  const {
    initDialogControllers,
    resetCryptoState,
    decodePayload,
    ensureUnlockedForPush,
    ensureDataKey,
    syncScopedData,
    payloadForUpload,
    putWorkspacePayload,
    promptUnlock,
    promptDecryptFile,
    resolveUnlock,
    resolveDecryptFile,
    resolvePasskey,
    updateEncryptionUI,
    updateDeviceUI,
    refreshVaultState,
    refreshPasskeyUI,
    forgetDevice,
    unlockFromPanel,
    openEncryptDialog,
    openChangeEncryptionDialog,
    openRotateRecoveryDialog,
    openDisableEncryptionDialog,
    submitEncrypt,
    finishEncryption,
    submitChangeEncryption,
    submitRotateRecovery,
    finishRotateRecovery,
    submitDisableEncryption,
    submitDecryptFile,
    submitUnlock,
    submitPasskey,
    enablePasskey,
    removePasskey,
    copyRecoveryCode,
    downloadRecoveryCode,
    copyNewRecoveryCode,
    downloadNewRecoveryCode,
    readCachedDataKey,
  } = cryptoUI;

  const syncUI = globalThis.QingdhSync.create({
    dom,
    prefs,
    sync,
    state,
    cryptoState,
    api,
    apiError,
    autoSyncAllowed: core.autoSyncAllowed,
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
    updateSyncUI: () => updateSyncUI(),
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
    broadcast: (message) => {
      if (!channel) return;
      try {
        channel.postMessage(message);
      } catch (error) {
        // ignore
      }
    },
    signOutLocally: (options) => signOutLocally(options),
    openAccountDialog: () => openAccountDialog(),
    getData: () => data,
    setData: (next) => {
      data = next;
    },
  });
  const {
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
  } = syncUI;

  const revisionsUI = globalThis.QingdhRevisions.create({
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
    setData: (next) => {
      data = next;
    },
  });
  const { openRevisionsDialog, previewRevision, restoreRevision } = revisionsUI;

  const accountUI = globalThis.QingdhAccount.create({
    dom,
    prefs,
    sync,
    cryptoState,
    state,
    api,
    apiError,
    $$,
    authSupported,
    setStatus,
    updateDeviceUI,
    resetCryptoState,
    refreshVaultState,
    refreshPasskeyUI,
    withOptionalModule,
    reconcile,
    ensureDialogs,
    showToast,
    askConfirm,
    normalizeData,
    createDefaultData,
    render,
    renderClock,
    readJSON,
    writeJSON,
    writeGuestDirty,
    updateSyncUI: () => updateSyncUI(),
    escapeHTML,
    formatTime,
    ICON_X,
    STATUS_TEXT,
    STATUS_SHORT,
    GUEST_KEY,
    USER_KEY_PREFIX,
    SYNC_KEY_PREFIX,
    handleAuthLost: () => handleAuthLost(),
    openAccountDialog: () => openAccountDialog(),
    readGuestDirty,
    readSearchHistory,
    setAccountAvatar,
    updateAIConfigGate: () => updateAIConfigGate(),
    updateEncryptionUI,
    getData: () => data,
    setData: (next) => {
      data = next;
    },
  });
  const {
    initAccount,
    loadGuestDocument,
    onAuthenticated,
    signOutLocally,
    clearAuthForms,
    setAuthView,
    showAuthError,
    handleLogin,
    handleRegister,
    handleForgot,
    resendVerification,
    handleResetPassword,
    handleLogout,
    handleLogoutAll,
    openChangeEmailDialog,
    handleChangeEmail,
    openChangePasswordDialog,
    handleChangePassword,
    handleDeleteAccount,
    resetSessionsUI,
    loadSessions,
    updateSyncUI,
    updateAccountUI,
    renderSyncManager,
  } = accountUI;

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
    ensureDialogs();
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
    ensureDialogs();
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

  // 设置 Hub 只在第一次打开/修改设置时加载，避免把 8 KiB 面板塞进首屏。
  let settingsUI = null;
  let settingsPromise = null;

  function createSettingsUI() {
    settingsUI = globalThis.QingdhSettings.create({
      dom,
      prefs,
      sync,
      state,
      cryptoState,
      $,
      $$,
      MAX_GROUPS,
      MAX_LINKS,
      ENGINES,
      CLOCK_STYLES,
      HOUR_CYCLES,
      ICON_X,
      escapeHTML,
      normalizeData,
      normalizeLink,
      normalizeUrl,
      clone,
      now,
      stampAll,
      countGroups,
      countLinks,
      createDefaultData,
      makeGroup,
      makeLink,
      enforceLimits,
      currentKey,
      formatTime,
      readSnapshot,
      saveSnapshot,
      writeJSON,
      markDirty,
      broadcastChange,
      render,
      renderClock,
      updateSnapshotButton,
      renderEngineSettings,
      syncSettingsSidebarUI,
      renderSyncManager,
      commitLocalChange,
      showToast,
      askConfirm,
      api,
      ensureDialogs,
      withOptionalModule,
      updateAccountUI,
      refreshVaultState,
      refreshPasskeyUI,
      setAuthView,
      authSupported,
      ensureUnlockedForPush,
      syncNow,
      promptDecryptFile,
      setStatus,
      updateSyncUI,
      getData: () => data,
      setData: (next) => {
        data = next;
      },
    });
    settingsUI.syncSettingsUI();
    settingsUI.updateAIConfigGate();
    return settingsUI;
  }

  function ensureSettingsUI() {
    if (settingsUI) return Promise.resolve(settingsUI);
    if (settingsPromise) return settingsPromise;
    settingsPromise = loadOptionalModule('QingdhSettings')
      .then(() => {
        if (!globalThis.QingdhSettings) throw new Error('设置模块未加载');
        return createSettingsUI();
      })
      .catch((error) => {
        settingsPromise = null;
        showToast('设置模块加载失败，请刷新重试');
        throw error;
      });
    return settingsPromise;
  }

  function openHub(tab) {
    ensureSettingsUI()
      .then((ui) => ui.openHub(tab))
      .catch(() => {});
  }

  function openSettings() {
    openHub('account');
  }

  function openAIConfig() {
    openHub('ai');
  }

  function openAccountDialog() {
    ensureSettingsUI()
      .then((ui) => ui.openAccountDialog())
      .catch(() => {});
  }

  function setHubTab(tab) {
    if (settingsUI) settingsUI.setHubTab(tab);
    else ensureSettingsUI().then((ui) => ui.setHubTab(tab)).catch(() => {});
  }

  function syncSettingsUI() {
    if (settingsUI) settingsUI.syncSettingsUI();
    else ensureSettingsUI().then((ui) => ui.syncSettingsUI()).catch(() => {});
  }

  function updateAIConfigGate() {
    if (settingsUI) settingsUI.updateAIConfigGate();
  }

  function updateJSONImportPreview() {
    if (settingsUI) settingsUI.updateJSONImportPreview();
  }

  function exportData() {
    return ensureSettingsUI().then((ui) => ui.exportData());
  }

  function importData(file) {
    return ensureSettingsUI().then((ui) => ui.importData(file));
  }

  function applyJSONImport() {
    return ensureSettingsUI().then((ui) => ui.applyJSONImport());
  }

  function importBookmarks(file) {
    return ensureSettingsUI().then((ui) => ui.importBookmarks(file));
  }

  function applyBookmarkImport() {
    return ensureSettingsUI().then((ui) => ui.applyBookmarkImport());
  }

  function resetData() {
    return ensureSettingsUI().then((ui) => ui.resetData());
  }

  function restoreSnapshot() {
    return ensureSettingsUI().then((ui) => ui.restoreSnapshot());
  }

  /* ------------------------------------------------------------------ *
   * 确认框 / 提示条
   * ------------------------------------------------------------------ */

  function askConfirm({ title = '确认操作', message = '', confirmText = '确定', danger = true }) {
    ensureDialogs();
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
  if (dom.hubSubnav) {
    dom.hubSubnav.addEventListener('click', (event) => {
      const button = event.target.closest('[data-hub-subtab]');
      if (button) setHubTab(button.dataset.hubSubtab);
    });
    dom.hubSubnav.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const items = Array.from(dom.hubSubnav.querySelectorAll('[data-hub-subtab]'));
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = items[(index + step + items.length) % items.length];
      next.focus();
      next.click();
    });
  }
  if (dom.aiConfigGateAction) {
    dom.aiConfigGateAction.addEventListener('click', () => {
      setHubTab(sync.user ? 'encryption' : 'account');
    });
  }

  dom.sidebarCollapse.addEventListener('click', toggleSidebar);
  dom.sidebarHide.addEventListener('click', () => setSidebarMode('hidden'));
  dom.sidebarReveal.addEventListener('click', () => setSidebarMode(restoreSidebarMode()));
  dom.sidebarOpen.addEventListener('click', openDrawer);
  dom.sidebarScrim.addEventListener('click', () => closeDrawer());
  dom.syncBadge.addEventListener('click', () => openHub('sync'));
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
  dom.passkeyDialog.addEventListener('close', () => resolvePasskey(false));

  dom.encryptionEnable.addEventListener('click', openEncryptDialog);
  dom.encryptionUnlock.addEventListener('click', unlockFromPanel);
  dom.encryptionChange.addEventListener('click', openChangeEncryptionDialog);
  dom.encryptionRecovery.addEventListener('click', openRotateRecoveryDialog);
  dom.encryptionDisable.addEventListener('click', openDisableEncryptionDialog);
  dom.disableEncryptionForm.addEventListener('submit', submitDisableEncryption);
  dom.disableEncryptionDiscard.addEventListener('change', () => {
    if (dom.disableEncryptionDiscard.checked) dom.disableEncryptionError.hidden = true;
  });
  dom.rotateRecoveryForm.addEventListener('submit', submitRotateRecovery);
  dom.newRecoverySave.addEventListener('click', finishRotateRecovery);
  dom.newRecoveryCopy.addEventListener('click', copyNewRecoveryCode);
  dom.newRecoveryDownload.addEventListener('click', downloadNewRecoveryCode);
  dom.newRecoveryConfirm.addEventListener('change', () => {
    if (dom.newRecoveryConfirm.checked) dom.newRecoveryError.hidden = true;
  });
  dom.newRecoveryDialog.addEventListener('close', () => {
    if (cryptoState.pendingRecovery) {
      cryptoState.pendingRecovery = null;
      showToast('已取消，旧恢复码继续有效');
    }
  });
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
  dom.unlockDialog.addEventListener('close', () => resolveUnlock(null));

  dom.decryptFileForm.addEventListener('submit', submitDecryptFile);
  dom.decryptFileRecoveryToggle.addEventListener('change', () => {
    const recovery = dom.decryptFileRecoveryToggle.checked;
    dom.decryptFileRecoveryField.hidden = !recovery;
    dom.decryptFileError.hidden = true;
    setTimeout(() => (recovery ? dom.decryptFileRecovery : dom.decryptFilePassword).focus(), 20);
  });
  dom.decryptFileCancel.addEventListener('click', () => resolveDecryptFile(null));
  dom.decryptFileDialog.addEventListener('close', () => resolveDecryptFile(null));

  dom.revisionsBtn.addEventListener('click', openRevisionsDialog);
  dom.revisionsList.addEventListener('click', (event) => {
    const preview = event.target.closest('[data-revision-preview]');
    if (preview) {
      previewRevision(preview.dataset.revisionPreview);
      return;
    }
    const restore = event.target.closest('[data-revision-restore]');
    if (restore) restoreRevision(restore.dataset.revisionRestore);
  });
  dom.exportBtn.addEventListener('click', exportData);
  dom.importBtn.addEventListener('click', () => dom.importFile.click());
  dom.importBookmarksBtn.addEventListener('click', () => dom.bookmarksFile.click());
  dom.bookmarksFile.addEventListener('change', () => {
    const file = dom.bookmarksFile.files && dom.bookmarksFile.files[0];
    dom.bookmarksFile.value = '';
    if (file) withOptionalModule('QingdhBookmarks', () => importBookmarks(file));
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

  if (dom.syncPageNow) dom.syncPageNow.addEventListener('click', () => syncNow({ manual: true }));
  if (dom.syncAutoToggle) {
    dom.syncAutoToggle.addEventListener('change', () => {
      prefs.autoSync = dom.syncAutoToggle.checked;
      savePrefs();
      if (prefs.autoSync) syncNow({ manual: true });
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
  dom.changeEmailBtn.addEventListener('click', openChangeEmailDialog);
  dom.changeEmailForm.addEventListener('submit', handleChangeEmail);
  dom.changePasswordBtn.addEventListener('click', openChangePasswordDialog);
  dom.changePasswordForm.addEventListener('submit', handleChangePassword);
  dom.deleteAccountBtn.addEventListener('click', () => {
    ensureDialogs();
    dom.deleteError.hidden = true;
    dom.deleteForm.reset();
    dom.deleteDialog.showModal();
    requestAnimationFrame(() => dom.deletePassword.focus());
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

  bindDialogShells();

  function shortcutMatches(event, shortcut) {
    const parts = String(shortcut || '')
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const key = parts.pop();
    if (!key) return false;
    const needAlt = parts.includes('alt');
    const needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needMeta = parts.includes('meta') || parts.includes('cmd');
    const needShift = parts.includes('shift');
    return (
      event.altKey === needAlt &&
      event.ctrlKey === needCtrl &&
      event.metaKey === needMeta &&
      event.shiftKey === needShift &&
      String(event.key).toLowerCase() === key
    );
  }

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const isTyping = isTypingTarget(target);

    // 隐私空间打开时，普通快捷键不生效，避免把搜索框等焦点抢到遮罩后面。
    if (globalThis.QingdhPrivacy && QingdhPrivacy.isOpen()) return;

    // 隐私模块按需加载：快捷键先于模块初始化时由这里接管一次。
    if (
      !globalThis.QingdhPrivacy &&
      !isTyping &&
      !isDialogOpen() &&
      shortcutMatches(event, prefs.privacyShortcut)
    ) {
      event.preventDefault();
      withOptionalModule('QingdhPrivacy', () => QingdhPrivacy.requestOpen());
      return;
    }

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

  function autoSyncFromFocus() {
    if (!sync.user || sync.inFlight || sync.status === 'auth') return;
    if (!core.focusSyncAllowed(sync.lastAutoSyncAt, now())) return;
    sync.lastAutoSyncAt = now();
    syncNow();
  }

  window.addEventListener('online', () => {
    sync.online = true;
    if (sync.user) {
      setStatus(sync.dirty ? 'dirty' : 'syncing');
      sync.lastAutoSyncAt = now();
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
    if (document.visibilityState === 'visible') autoSyncFromFocus();
  });

  window.addEventListener('focus', autoSyncFromFocus);

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
    const emailChanged = params.get('email_changed') === '1';
    const emailChangeError = params.get('email_change');

    if (verified === '1') showToast('邮箱验证成功，已登录');
    else if (verifyError === 'error') showToast('验证链接无效或已过期');
    else if (verifyError === 'rate_limited') showToast('请求过于频繁，请稍后再试');

    if (emailChanged) showToast('账号邮箱已更新');
    else if (emailChangeError === 'expired') showToast('确认链接无效或已过期，请重新发起修改');
    else if (emailChangeError === 'taken') showToast('这个邮箱已被其他账号使用');
    else if (emailChangeError === 'pending') showToast('待验证邮箱已变化，请以最新一封邮件为准');
    else if (emailChangeError === 'rate_limited') showToast('请求过于频繁，请稍后再试');
    else if (emailChangeError) showToast('邮箱修改失败，请重新发起');

    if (loginRequested) {
      state.openLoginAfterInit = true;
    }

    if (resetToken) {
      ensureDialogs();
      state.resetToken = resetToken;
      dom.resetForm.reset();
      dom.resetError.hidden = true;
      ensureDialogs();
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
      const currentUser = sync.user ? sync.user.id : null;

      // 其他标签页关闭了加密：立即清掉本页密钥并拉取明文文档。
      if (message.type === 'encryption-disabled') {
        if (message.userId !== currentUser) return;
        resetCryptoState();
        syncNow({ manual: true });
        return;
      }

      if (message.type !== 'data-changed') return;
      if (applyingRemote) return;
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

  // 首屏只需要 core + app（以及头像、选择器等轻量基础脚本）。备忘录、
  // AI、隐私、命令面板、Passkey 在首次使用时按单个文件加载，避免为从不
  // 打开的页面解析数十 KiB JS；脚本注入仍走同源 classic script。
  const OPTIONAL_MODULES = {
    QingdhMemo: 'memo.js',
    QingdhAI: 'ai.js',
    QingdhPrivacy: 'privacy.js',
    QingdhCommandPalette: 'command-palette.js',
    QingdhPasskey: 'passkey.js',
    QingdhSettings: 'lib/settings.js',
    QingdhBookmarks: 'bookmarks.js',
    QingdhPWA: 'pwa.js',
    QingdhAvatars: 'avatars.js',
  };
  const modulePromises = new Map();
  const wiredModules = new Set();
  // 这些模块的 UI 里有由 <template> 管理的对话框，加载前必须先注入。
  const MODULES_WITH_DIALOGS = new Set(['QingdhMemo', 'QingdhPrivacy', 'QingdhCommandPalette', 'QingdhPasskey']);

  function loadOptionalModule(name) {
    if (modulePromises.has(name)) return modulePromises.get(name);
    const file = OPTIONAL_MODULES[name];
    const promise = new Promise((resolve) => {
      if (!file) {
        resolve(false);
        return;
      }
      const script = document.createElement('script');
      script.src = ASSET_VERSION ? `${file}?v=${ASSET_VERSION}` : file;
      script.defer = true;
      script.onload = () => resolve(true);
      script.onerror = () => {
        console.warn('加载前端模块失败', file);
        resolve(false);
      };
      document.head.appendChild(script);
    });
    modulePromises.set(name, promise);
    return promise;
  }

  function withOptionalModule(name, action) {
    if (MODULES_WITH_DIALOGS.has(name)) ensureDialogs();
    if (globalThis[name]) {
      wireOptionalModules();
      action();
      return;
    }
    loadOptionalModule(name).then(() => {
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
    updateEngineUI();
    updateSyncUI();

    setupChannel();
    handleUrlFlags();

    // AI 按钮在首屏可见，但模块只在悬停/聚焦/点击时加载；点击路径先加载
    // 再重放一次 click，让 ai.js 自己注册的处理逻辑接管。
    const preloadAI = () => withOptionalModule('QingdhAI', () => {});
    if (dom.aiModeBtn) {
      dom.aiModeBtn.addEventListener('pointerenter', preloadAI, { once: true });
      dom.aiModeBtn.addEventListener('focus', preloadAI, { once: true });
      dom.aiModeBtn.addEventListener('click', (event) => {
        if (globalThis.QingdhAI) return;
        event.preventDefault();
        event.stopPropagation();
        loadOptionalModule('QingdhAI').then(() => {
          wireOptionalModules();
          if (globalThis.QingdhAI) dom.aiModeBtn.click();
        });
      });
    }

    wireOptionalModules();

    await initAccount();
    updateSnapshotButton();
    updateAccountUI();
    updateDeviceUI();
    if (location.pathname === '/ai' || location.pathname === '/ai/') {
      withOptionalModule('QingdhAI', () => QingdhAI.restoreRoute());
    }

    if (state.openLoginAfterInit) {
      state.openLoginAfterInit = false;
      openAccountDialog();
    }
  }

  function wireOptionalModules() {
    if (globalThis.QingdhMemo && !wiredModules.has('QingdhMemo')) {
    wiredModules.add('QingdhMemo');
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

  if (globalThis.QingdhAI && !wiredModules.has('QingdhAI')) {
    wiredModules.add('QingdhAI');
    QingdhAI.init({
      toast: showToast,
      openAccountDialog,
      openEncryptionSettings: () => openHub('encryption'),
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

  if (globalThis.QingdhCommandPalette && !wiredModules.has('QingdhCommandPalette')) {
    wiredModules.add('QingdhCommandPalette');
    QingdhCommandPalette.init({
      escapeHTML,
      engineName: () => currentEngine().name,
      aiProviderName: () => (globalThis.QingdhAI ? QingdhAI.activeLabel() : ''),
      searchWeb: (query) => {
        recordSearch(query, currentEngine());
        navigate(engineBuild(currentEngine())(query));
      },
      askAI: (query) => {
        withOptionalModule('QingdhAI', async () => {
          if (!QingdhAI.isActive()) await QingdhAI.activate();
          QingdhAI.openAsk(query);
        });
      },
      newMemo: () => withOptionalModule('QingdhMemo', () => QingdhMemo.openAndCreate()),
      openMemo: () => withOptionalModule('QingdhMemo', () => QingdhMemo.open()),
      openMemoById: (id) => withOptionalModule('QingdhMemo', () => QingdhMemo.openById(id)),
      openPrivacy: () => withOptionalModule('QingdhPrivacy', () => QingdhPrivacy.requestOpen()),
      openSettings,
      openAIConfig,
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

  if (globalThis.QingdhPrivacy && !wiredModules.has('QingdhPrivacy')) {
    wiredModules.add('QingdhPrivacy');
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

  function startPWA() {
    withOptionalModule('QingdhPWA', () => QingdhPWA.init({ toast: showToast }));
  }
  if (document.readyState === 'complete') {
    setTimeout(startPWA, 1200);
  } else {
    window.addEventListener('load', () => setTimeout(startPWA, 1200), { once: true });
  }

  init();
})();
