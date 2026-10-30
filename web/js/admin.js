/* ==========================================================================
 * 氢导航 · 管理后台
 * 依赖 /api/v1/admin/*，权限由服务端校验。
 * ========================================================================== */

(() => {
  'use strict';

  const PREFS_KEY = 'qingdh.prefs.v1';
  const $ = (selector) => document.querySelector(selector);

  const dom = {
    gate: $('#gate'),
    gateText: $('#gate-text'),
    admin: $('#admin'),
    themeBtn: $('#theme-btn'),
    themeLabel: $('#theme-label'),

    navUserCount: $('#nav-user-count'),
    sidebarUser: $('#sidebar-user'),
    sidebarEmail: $('#sidebar-email'),
    sidebarAvatar: $('#sidebar-avatar'),
    serverVersion: $('#server-version'),

    tabs: Array.from(document.querySelectorAll('.tab')),
    overviewPanel: $('#panel-overview'),
    settingsPanel: $('#panel-settings'),
    usersPanel: $('#panel-users'),
    auditPanel: $('#panel-audit'),
    auditAction: $('#audit-action'),
    auditActor: $('#audit-actor'),
    auditSearch: $('#audit-search'),
    auditRows: $('#audit-rows'),
    auditTotal: $('#audit-total'),
    auditPrev: $('#audit-prev'),
    auditNext: $('#audit-next'),

    overviewRefresh: $('#overview-refresh'),
    ovUsers: $('#ov-users'),
    ovUsersSub: $('#ov-users-sub'),
    ovNewUsers: $('#ov-new-users'),
    ovSessions: $('#ov-sessions'),
    ovDocs: $('#ov-docs'),
    ovDocsSub: $('#ov-docs-sub'),
    ovDocsRecent: $('#ov-docs-recent'),
    ovAI: $('#ov-ai'),
    ovMemo: $('#ov-memo'),
    ovPrivacy: $('#ov-privacy'),
    ovBaseURL: $('#ov-base-url'),
    ovRegistration: $('#ov-registration'),
    ovVerification: $('#ov-verification'),
    ovSMTP: $('#ov-smtp'),
    ovAILimit: $('#ov-ai-limit'),

    settingsForm: $('#settings-form'),
    settingsModal: $('#settings-modal'),
    settingsModalTitle: $('#settings-modal-title'),
    settingsModalFields: $('#settings-modal-fields'),
    settingsModalError: $('#settings-modal-error'),
    settingsModalClose: $('#settings-modal-close'),
    settingsCancel: $('#settings-cancel'),
    siteName: $('#site-name'),
    siteLogoUrl: $('#site-logo-url'),
    siteLogoPreview: $('#site-logo-preview'),
    siteLogoUploadBtn: $('#site-logo-upload-btn'),
    siteLogoClear: $('#site-logo-clear'),
    siteLogoFile: $('#site-logo-file'),
    siteLogoError: $('#site-logo-error'),
    baseURL: $('#base-url'),
    allowRegistration: $('#allow-registration'),
    requireVerification: $('#require-verification'),
    verificationHint: $('#verification-hint'),

    smtpHost: $('#smtp-host'),
    smtpPort: $('#smtp-port'),
    smtpUsername: $('#smtp-username'),
    smtpPassword: $('#smtp-password'),
    passwordHintText: $('#password-hint-text'),
    clearPassword: $('#clear-password'),
    smtpFrom: $('#smtp-from'),
    smtpTLS: $('#smtp-tls'),
    testEmailTo: $('#test-email-to'),
    testEmailBtn: $('#test-email-btn'),

    sessionIdle: $('#session-idle'),
    sessionAbsolute: $('#session-absolute'),
    sessionRenew: $('#session-renew'),
    aiDailyLimit: $('#ai-daily-limit'),

    saveBtn: $('#save-settings'),

    userSearch: $('#user-search'),
    userSearchBtn: $('#user-search-btn'),
    userRows: $('#user-rows'),
    userTotal: $('#user-total'),
    pagePrev: $('#page-prev'),
    pageNext: $('#page-next'),

    drawer: $('#user-drawer'),
    drawerScrim: $('[data-modal-close]'),
    drawerBody: $('#modal-body'),
    drawerTitle: $('#drawer-title'),
    drawerSubtitle: $('#modal-subtitle'),
    drawerAvatar: $('#drawer-avatar'),
    drawerClose: $('#modal-close'),

    confirmLayer: $('#admin-confirm-layer'),
    confirmTitle: $('#admin-confirm-title'),
    confirmSubtitle: $('#admin-confirm-subtitle'),
    confirmText: $('#admin-confirm-text'),
    confirmCancel: $('#admin-confirm-cancel'),
    confirmOk: $('#admin-confirm-ok'),

    toast: $('#toast'),
    toastMessage: $('#toast-message'),
  };

  const state = {
    user: null,
    tab: 'overview',
    settings: null,
    page: 1,
    pageSize: 20,
    total: 0,
    query: '',
    users: [],
    auditPage: 1,
    auditPageSize: 50,
    auditTotal: 0,
    auditEntries: [],
    auditAction: '',
    auditActor: '',
    clearPassword: false,
    passwordSet: false,
    siteLogo: '',
    editGroup: null,
    editTrigger: null,
    savingSettings: false,
    logoReading: false,
    logoReadToken: 0,
    drawerTrigger: null,
  };

  let toastTimer = null;
  let confirmResolver = null;
  let confirmTrigger = null;
  const configGroups = new Map();

  /* ------------------------------------------------------------------ *
   * 基础
   * ------------------------------------------------------------------ */

  const TABS = ['overview', 'users', 'audit', 'site', 'access', 'security'];
  const CONFIG_TABS = ['site', 'access', 'security'];

  function tabFromHash() {
    const value = String(location.hash || '').replace(/^#/, '');
    return TABS.includes(value) ? value : 'overview';
  }

  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch (error) {
      return {};
    }
  }

  function writePrefs(patch) {
    const prefs = Object.assign({ theme: 'auto', season: 'default', openInNewTab: false }, readPrefs(), patch);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (error) {
      /* ignore */
    }
  }

  function resolveTheme() {
    const prefs = readPrefs();
    if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = resolveTheme();
    document.documentElement.dataset.theme = theme;

    const prefs = readPrefs();
    document.documentElement.dataset.season = ['default', 'spring', 'summer', 'autumn', 'winter'].includes(prefs.season)
      ? prefs.season
      : 'default';

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      meta.setAttribute('content', bg || '#f4f5f9');
    }

    dom.themeBtn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色' : '切换到深色');
    dom.themeLabel.textContent = theme === 'dark' ? '浅色模式' : '深色模式';
  }

  function toast(message, duration = 2600) {
    clearTimeout(toastTimer);
    dom.toastMessage.textContent = message;
    dom.toast.classList.add('show');
    toastTimer = setTimeout(() => dom.toast.classList.remove('show'), duration);
  }

  async function api(path, { method = 'GET', body = null } = {}) {
    const options = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };
    if (body !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(path, options);
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = null;
        }
      }
      return { status: response.status, ok: response.ok, data };
    } catch (error) {
      return { status: 0, ok: false, data: null };
    }
  }

  function errorMessage(response, fallback) {
    return (response && response.data && response.data.error && response.data.error.message) || fallback;
  }

  /* ------------------------------------------------------------------ *
   * 权限门禁
   * ------------------------------------------------------------------ */

  function showGate(message) {
    document.body.classList.add('is-gated');
    dom.gate.hidden = false;
    dom.admin.hidden = true;
    if (message) dom.gateText.textContent = message;
  }

  async function bootstrap() {
    if (globalThis.QingdhSelect) QingdhSelect.enhance(dom.smtpTLS);
    applyTheme();

    const response = await api('/api/v1/auth/me');
    if (response.status === 401) {
      showGate('请先在首页登录管理员账号。');
      return;
    }
    if (!response.ok || !response.data || !response.data.user) {
      showGate('无法读取账号信息，请确认服务端正在运行。');
      return;
    }
    if (!response.data.user.isAdmin) {
      showGate(`当前账号 ${response.data.user.email} 不是管理员。`);
      return;
    }

    state.user = response.data.user;
    dom.sidebarUser.hidden = false;
    dom.sidebarEmail.textContent = state.user.email;
    dom.sidebarEmail.title = state.user.email;
    dom.sidebarAvatar.textContent = (state.user.email || '?').slice(0, 1).toUpperCase();
    dom.sidebarAvatar.style.setProperty('--hue', hueFor(state.user.email || ''));

    document.body.classList.remove('is-gated');
    dom.gate.hidden = true;
    dom.admin.hidden = false;
    await loadSettings();
    switchTab(tabFromHash(), { updateHash: false });
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  function secondsToDays(seconds) {
    return Math.max(1, Math.round(seconds / 86400));
  }

  function secondsToMinutes(seconds) {
    return Math.max(1, Math.round(seconds / 60));
  }

  function setupConfigCards() {
    document.querySelectorAll('.config-card').forEach((card) => {
      const group = card.dataset.editGroup;
      const title = card.querySelector('.card-head h2').textContent;
      const fields = card.querySelector('.card-body');
      fields.remove();
      const summary = document.createElement('dl');
      summary.className = 'config-summary';
      summaryRow(summary, '读取状态', '读取中…');
      card.append(summary);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'config-edit';
      edit.disabled = true;
      edit.setAttribute('aria-label', `编辑${title}`);
      edit.title = `编辑${title}`;
      edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      card.querySelector('.card-head').append(edit);
      edit.addEventListener('click', () => openSettings(group, edit));
      configGroups.set(group, { card, title, fields, summary, edit });
    });
  }

  function summaryRow(list, label, value, tone = '') {
    const row = document.createElement('div');
    row.className = 'config-summary-row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (tone) dd.className = `config-status is-${tone}`;
    row.append(dt, dd);
    list.append(row);
  }

  function renderSettingsError(message) {
    configGroups.forEach(({ summary, edit }) => {
      edit.disabled = true;
      summary.replaceChildren();
      summaryRow(summary, '读取状态', message, 'warn');
      const retry = document.createElement('button');
      retry.className = 'btn';
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', loadSettings);
      summary.lastElementChild.lastElementChild.append(' ', retry);
    });
  }

  function clearSettingsFieldErrors() {
    dom.settingsForm.querySelectorAll('.settings-field-error').forEach((error) => error.remove());
    dom.settingsForm.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      field.setCustomValidity('');
    });
  }

  function settingsErrorField(message) {
    if (/Logo|图片地址/.test(message)) return dom.siteLogoUrl;
    if (/站点地址/.test(message)) return dom.baseURL;
    if (/站点名称/.test(message)) return dom.siteName;
    if (/SMTP 端口/.test(message)) return dom.smtpPort;
    if (/发件人/.test(message)) return dom.smtpFrom;
    if (/绝对上限/.test(message)) return dom.sessionAbsolute;
    if (/续期间隔/.test(message)) return dom.sessionRenew;
    if (/闲置时间/.test(message)) return dom.sessionIdle;
    if (/AI 每日/.test(message)) return dom.aiDailyLimit;
    return null;
  }

  function showSettingsFieldError(field, message) {
    if (!field) return;
    field.setCustomValidity(message);
    field.setAttribute('aria-invalid', 'true');
    const container = field.closest('.field');
    let error = container.querySelector('.settings-field-error');
    if (!error) {
      error = document.createElement('p');
      error.className = 'field-error settings-field-error';
      error.id = `${field.id}-error`;
      container.append(error);
    }
    error.textContent = message;
    field.setAttribute('aria-describedby', error.id);
  }

  function renderSettingsSummaries() {
    const values = state.settings;
    if (!values) return;
    configGroups.forEach(({ summary, edit }, group) => {
      edit.disabled = false;
      summary.replaceChildren();
      switch (group) {
        case 'site':
          summaryRow(summary, '站点名称', values.siteName || '氢导航');
          summaryRow(summary, '站点 Logo', values.siteLogo ? (values.siteLogo.startsWith('data:') ? '已上传图片' : '外部图片') : '默认标志');
          summaryRow(summary, '对外访问地址', values.baseUrl || '跟随当前访问地址');
          break;
        case 'registration':
          summaryRow(summary, '开放注册', values.allowRegistration ? '已开启' : '未开启', values.allowRegistration ? 'on' : 'off');
          summaryRow(summary, '要求邮箱验证', values.requireEmailVerification ? '已开启' : '未开启', values.requireEmailVerification ? 'on' : 'off');
          if (values.requireEmailVerification && !values.effectiveVerification) {
            summaryRow(summary, '当前状态', 'SMTP 未配置，验证未生效', 'warn');
          }
          break;
        case 'smtp':
          summaryRow(summary, '配置状态', values.smtpConfigured ? '已配置' : '未配置', values.smtpConfigured ? 'on' : 'off');
          summaryRow(summary, '服务器', values.smtpHost || '未填写');
          summaryRow(summary, '端口', String(values.smtpPort || 587));
          summaryRow(summary, '用户名', values.smtpUsername || '未填写');
          summaryRow(summary, '密码', values.smtpPasswordSet ? '已设置' : '未设置');
          summaryRow(summary, '发件人', values.smtpFrom || '未填写');
          summaryRow(summary, '加密方式', { auto: '自动', starttls: 'STARTTLS', tls: '隐式 TLS', none: '不加密' }[values.smtpTls] || values.smtpTls || '自动');
          break;
        case 'session':
          summaryRow(summary, '闲置过期', `${secondsToDays(values.sessionIdleSeconds)} 天`);
          summaryRow(summary, '绝对上限', `${secondsToDays(values.sessionAbsoluteSeconds)} 天`);
          summaryRow(summary, '续期间隔', `${secondsToMinutes(values.sessionRenewSeconds)} 分钟`);
          break;
        case 'ai':
          summaryRow(summary, '每日上限', `${formatCount(values.aiDailyLimit || 200)} 次 / 用户`);
          break;
      }
      if (configGroups.get(group).card.classList.contains('config-save-failed')) {
        summaryRow(summary, '保存状态', '上次保存失败，当前显示已保存值', 'warn');
      }
    });
  }

  function openSettings(group, trigger) {
    if (!state.settings || state.editGroup || !configGroups.has(group)) return;
    const config = configGroups.get(group);
    dom.settingsModalFields.append(config.fields);
    clearSettingsFieldErrors();
    fillSettings(state.settings);
    state.editGroup = group;
    state.editTrigger = trigger;
    dom.settingsModalTitle.textContent = `编辑${config.title}`;
    dom.settingsModalError.hidden = true;
    dom.settingsModal.hidden = false;
    document.querySelector('.app').inert = true;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => {
      const first = config.fields.querySelector('input:not([hidden]), select, button');
      (first || dom.settingsModalClose).focus();
    });
  }

  function closeSettings() {
    if (dom.settingsModal.hidden || state.savingSettings) return;
    state.logoReadToken++;
    state.logoReading = false;
    dom.saveBtn.disabled = false;
    clearSettingsFieldErrors();
    dom.settingsModal.hidden = true;
    dom.settingsModalFields.replaceChildren();
    dom.settingsModalError.hidden = true;
    document.querySelector('.app').inert = false;
    document.body.classList.remove('modal-open');
    state.editGroup = null;
    state.clearPassword = false;
    state.siteLogo = state.settings.siteLogo || '';
    const trigger = state.editTrigger;
    state.editTrigger = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  async function loadPublicSiteInfo() {
    try {
      const response = await fetch('/api/v1/site', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const info = await response.json();
      applyAdminBranding(info.name, info.logo);
    } catch (error) {
      // 忽略品牌读取失败，继续使用默认名称。
    }
  }

  function applyAdminBranding(name, logo) {
    const brandName = document.querySelector('.brand-name');
    if (brandName) brandName.textContent = name || '氢导航';
    document.title = `管理后台 · ${name || '氢导航'}`;
    const mark = document.querySelector('.brand-mark');
    if (mark) {
      const hasLogo = Boolean(logo);
      mark.classList.toggle('has-image', hasLogo);
      if (hasLogo) {
        mark.innerHTML = '';
        mark.style.backgroundImage = `url("${String(logo).replace(/"/g, '')}")`;
        mark.style.backgroundSize = 'cover';
        mark.style.backgroundPosition = 'center';
      } else {
        mark.innerHTML = '<span class="brand-logo"></span>';
        mark.style.backgroundImage = '';
        mark.style.backgroundSize = '';
        mark.style.backgroundPosition = '';
      }
    }
  }

  function renderSiteLogo() {
    if (!dom.siteLogoPreview) return;
    if (state.siteLogo) {
      dom.siteLogoPreview.classList.add('has-image');
      dom.siteLogoPreview.innerHTML = `<img src="${escapeAttr(state.siteLogo)}" alt="" />`;
    } else {
      dom.siteLogoPreview.classList.remove('has-image');
      dom.siteLogoPreview.innerHTML = '<span class="brand-logo"></span>';
    }
  }

  function fillSettings(values) {
    if (dom.serverVersion) {
      dom.serverVersion.textContent = `版本 ${values.serverVersion || 'dev'}`;
    }
    state.settings = values;
    dom.siteName.value = values.siteName || '氢导航';
    state.siteLogo = values.siteLogo || '';
    dom.siteLogoUrl.value = state.siteLogo.startsWith('data:') ? '' : state.siteLogo;
    dom.siteLogoError.hidden = true;
    renderSiteLogo();
    applyAdminBranding(dom.siteName.value, state.siteLogo);
    dom.baseURL.value = values.baseUrl || '';
    dom.allowRegistration.checked = Boolean(values.allowRegistration);
    dom.requireVerification.checked = Boolean(values.requireEmailVerification);

    dom.smtpHost.value = values.smtpHost || '';
    dom.smtpPort.value = values.smtpPort || 587;
    dom.smtpUsername.value = values.smtpUsername || '';
    dom.smtpFrom.value = values.smtpFrom || '';
    dom.smtpTLS.value = values.smtpTls || 'auto';
    if (globalThis.QingdhSelect) QingdhSelect.sync(dom.smtpTLS);

    dom.smtpPassword.value = '';
    state.passwordSet = Boolean(values.smtpPasswordSet);
    state.clearPassword = false;
    dom.passwordHintText.textContent = state.passwordSet ? '已保存，留空表示不修改' : '留空表示不设置';
    dom.clearPassword.hidden = !state.passwordSet;

    dom.sessionIdle.value = secondsToDays(values.sessionIdleSeconds);
    dom.sessionAbsolute.value = secondsToDays(values.sessionAbsoluteSeconds);
    dom.sessionRenew.value = secondsToMinutes(values.sessionRenewSeconds);
    dom.aiDailyLimit.value = values.aiDailyLimit || 200;

    updateVerificationHint(values);
    if (state.tab === 'overview') fillOverviewStatus();
    renderSettingsSummaries();
  }

  function updateVerificationHint(values) {
    const smtpConfigured = Boolean(values && values.smtpConfigured);
    if (dom.requireVerification.checked && !smtpConfigured) {
      dom.verificationHint.textContent = 'SMTP 未配置，验证不会生效，注册后会直接登录';
    } else {
      dom.verificationHint.textContent = '注册后需点击邮件中的链接才能登录';
    }
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString('zh-CN');
  }

  function setBadge(element, text, tone) {
    if (!element) return;
    element.textContent = text;
    element.className = tone ? `badge is-${tone}` : '';
  }

  function fillOverviewStatus() {
    const values = state.settings;
    if (!values) return;
    dom.ovBaseURL.textContent = values.baseUrl || '跟随当前访问地址';
    setBadge(dom.ovRegistration, values.allowRegistration ? '开放' : '关闭', values.allowRegistration ? 'ok' : 'warn');
    if (values.effectiveVerification) {
      setBadge(dom.ovVerification, '已生效', 'ok');
    } else if (values.requireEmailVerification) {
      setBadge(dom.ovVerification, '未生效（SMTP 未配置）', 'warn');
    } else {
      setBadge(dom.ovVerification, '未要求', '');
    }
    setBadge(dom.ovSMTP, values.smtpConfigured ? '已配置' : '未配置', values.smtpConfigured ? 'ok' : 'warn');
    dom.ovAILimit.textContent = `${formatCount(values.aiDailyLimit || 200)} 次 / 天 / 用户`;
  }

  function fillOverview(data) {
    dom.ovUsers.textContent = formatCount(data.usersTotal);
    dom.ovUsersSub.textContent = `已验证 ${formatCount(data.usersVerified)} · 管理员 ${formatCount(data.usersAdmins)}`;
    dom.ovNewUsers.textContent = formatCount(data.usersNew7Days);
    dom.ovSessions.textContent = formatCount(data.sessionsActive);
    dom.ovDocs.textContent = formatCount(data.documentsTotal);
    dom.ovDocsSub.textContent = `加密 ${formatCount(data.documentsEncrypted)}`;
    dom.ovDocsRecent.textContent = formatCount(data.documentsUpdated24h);
    dom.ovAI.textContent = formatCount(data.secretsAI);
    dom.ovMemo.textContent = formatCount(data.secretsMemo);
    dom.ovPrivacy.textContent = formatCount(data.secretsPrivacy);
  }

  async function loadOverview() {
    fillOverviewStatus();
    const response = await api('/api/v1/admin/overview');
    if (response.status === 401 || response.status === 403) {
      showGate('管理员会话已失效，请重新登录。');
      return;
    }
    if (!response.ok) {
      toast(errorMessage(response, '读取数据概览失败'));
      return;
    }
    fillOverview(response.data);
  }

  async function loadSettings() {
    const response = await api('/api/v1/admin/settings');
    if (response.status === 401 || response.status === 403) {
      showGate('管理员会话已失效，请重新登录。');
      return;
    }
    if (!response.ok) {
      renderSettingsError(errorMessage(response, '读取设置失败'));
      return;
    }
    fillSettings(response.data);
  }

  function buildPayload(group) {
    switch (group) {
      case 'site':
        return {
          siteName: dom.siteName.value.trim() || '氢导航',
          siteLogo: state.siteLogo,
          baseUrl: dom.baseURL.value.trim(),
        };
      case 'registration':
        return {
          allowRegistration: dom.allowRegistration.checked,
          requireEmailVerification: dom.requireVerification.checked,
        };
      case 'smtp': {
        const payload = {
          smtpHost: dom.smtpHost.value.trim(),
          smtpPort: Number(dom.smtpPort.value),
          smtpUsername: dom.smtpUsername.value.trim(),
          smtpFrom: dom.smtpFrom.value.trim(),
          smtpTls: dom.smtpTLS.value,
        };
        if (dom.smtpPassword.value) payload.smtpPassword = dom.smtpPassword.value;
        if (state.clearPassword) payload.clearSmtpPassword = true;
        return payload;
      }
      case 'session':
        return {
          sessionIdleSeconds: Number(dom.sessionIdle.value) * 86400,
          sessionAbsoluteSeconds: Number(dom.sessionAbsolute.value) * 86400,
          sessionRenewSeconds: Number(dom.sessionRenew.value) * 60,
        };
      case 'ai':
        return { aiDailyLimit: Number(dom.aiDailyLimit.value) };
      default:
        return {};
    }
  }

  function validateSettings(group) {
    clearSettingsFieldErrors();
    dom.baseURL.setCustomValidity('');
    dom.siteLogoUrl.setCustomValidity('');
    dom.sessionAbsolute.setCustomValidity('');
    dom.sessionRenew.setCustomValidity('');
    if (group === 'site') {
      const base = dom.baseURL.value.trim();
      const logo = state.siteLogo;
      if (base) {
        try {
          const url = new URL(base);
          if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            dom.baseURL.setCustomValidity('请输入不含账号、路径或参数的 http(s) 地址');
          }
        } catch (error) {
          dom.baseURL.setCustomValidity('请输入有效的 http(s) 地址');
        }
      }
      if (logo && !logo.startsWith('data:')) {
        try {
          const url = new URL(logo);
          if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
            dom.siteLogoUrl.setCustomValidity('请输入有效的 http(s) 图片地址');
          }
        } catch (error) {
          dom.siteLogoUrl.setCustomValidity('请输入有效的 http(s) 图片地址');
        }
      }
    }
    if (group === 'session') {
      const idle = Number(dom.sessionIdle.value);
      const absolute = Number(dom.sessionAbsolute.value);
      const renew = Number(dom.sessionRenew.value);
      if (absolute < idle) dom.sessionAbsolute.setCustomValidity('绝对上限不能小于闲置过期时间');
      if (renew > idle * 1440) dom.sessionRenew.setCustomValidity('续期间隔不能大于闲置过期时间');
    }
    const invalid = Array.from(dom.settingsForm.querySelectorAll(':invalid')).find((field) => field !== dom.testEmailTo);
    if (invalid && invalid.validationMessage) {
      showSettingsFieldError(invalid, invalid.validationMessage);
      invalid.focus();
      return false;
    }
    return true;
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.savingSettings || state.logoReading || !state.editGroup) return;
    const group = state.editGroup;
    dom.settingsModalError.hidden = true;
    if (!validateSettings(group)) return;
    state.savingSettings = true;
    dom.saveBtn.disabled = true;
    dom.saveBtn.textContent = '保存中…';
    dom.settingsForm.inert = true;
    dom.settingsForm.setAttribute('aria-busy', 'true');
    dom.settingsModalClose.disabled = true;
    const payload = buildPayload(group);
    if (state.settings && state.settings.version != null) payload.version = state.settings.version;
    const response = await api('/api/v1/admin/settings', { method: 'PUT', body: payload });

    state.savingSettings = false;
    dom.settingsForm.inert = false;
    dom.settingsForm.removeAttribute('aria-busy');
    dom.settingsModalClose.disabled = false;
    dom.saveBtn.disabled = false;
    dom.saveBtn.textContent = '保存设置';

    if (response.status === 401 || response.status === 403) {
      closeSettings();
      showGate('管理员会话已失效，请重新登录。');
      return;
    }
    if (response.status === 409) {
      await loadSettings();
      dom.settingsModalError.textContent = '设置已被其他管理员修改，已刷新为最新值，请重新编辑。';
      dom.settingsModalError.hidden = false;
      dom.settingsModalError.focus();
      return;
    }
    if (!response.ok) {
      const message = errorMessage(response, '保存失败，请检查输入');
      dom.settingsModalError.textContent = message;
      dom.settingsModalError.hidden = false;
      const field = settingsErrorField(message);
      if (field) {
        showSettingsFieldError(field, message);
        field.focus();
      } else {
        dom.settingsModalError.focus();
      }
      configGroups.get(group).card.classList.add('config-save-failed');
      renderSettingsSummaries();
      return;
    }

    configGroups.get(group).card.classList.remove('config-save-failed');
    fillSettings(response.data);
    closeSettings();
    toast('设置已保存');
  }

  async function sendTestEmail() {
    const to = dom.testEmailTo.value.trim();
    if (!to || !dom.testEmailTo.checkValidity()) {
      toast(!to ? '请填写收件地址' : '收件地址格式不正确');
      dom.testEmailTo.focus();
      return;
    }
    dom.testEmailBtn.disabled = true;
    const response = await api('/api/v1/admin/settings/test-email', { method: 'POST', body: { to } });
    dom.testEmailBtn.disabled = false;
    if (response.ok) {
      toast('测试邮件已发送');
    } else {
      toast(errorMessage(response, '发送失败'));
    }
  }

  /* ------------------------------------------------------------------ *
   * 用户
   * ------------------------------------------------------------------ */

  function statusBadges(user) {
    const badges = [];
    if (user.isAdmin) badges.push('<span class="badge is-accent">管理员</span>');
    if (user.disabled) badges.push('<span class="badge is-danger">已禁用</span>');
    else if (user.emailVerified) badges.push('<span class="badge is-ok">已验证</span>');
    else badges.push('<span class="badge is-warn">未验证</span>');
    return badges.join('');
  }

  function formatDate(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function hueFor(text) {
    let hue = 0;
    for (const char of String(text)) {
      hue = (hue * 31 + char.codePointAt(0)) % 360;
    }
    return hue;
  }

  function renderUsers(users) {
    state.users = users;

    if (!users.length) {
      dom.userRows.innerHTML = '<tr><td colspan="5" class="empty-row">没有匹配的用户</td></tr>';
      return;
    }

    dom.userRows.innerHTML = users
      .map((user) => {
        const self = state.user && user.id === state.user.id;
        const initial = (user.email || '?').slice(0, 1).toUpperCase();
        const hue = hueFor(user.email || '');
        const meta = self ? '当前账号' : `ID ${String(user.id).slice(0, 8)}`;

        const viewButton = `<button class="btn btn-small" type="button" data-action="view" data-id="${user.id}">查看</button>`;
        const actions = self
          ? `<div class="row-actions">${viewButton}</div>`
          : `<div class="row-actions">
              ${viewButton}
              <button class="btn btn-small" type="button" data-action="admin" data-id="${user.id}" data-value="${user.isAdmin ? 'false' : 'true'}">
                ${user.isAdmin ? '取消管理员' : '设为管理员'}
              </button>
              <button class="btn btn-small" type="button" data-action="disabled" data-id="${user.id}" data-value="${user.disabled ? 'false' : 'true'}">
                ${user.disabled ? '启用' : '禁用'}
              </button>
              <button class="btn btn-small btn-danger" type="button" data-action="delete" data-id="${user.id}" data-email="${escapeAttr(user.email)}">
                删除
              </button>
            </div>`;

        return `<tr data-user-id="${user.id}">
          <td>
            <div class="user-cell">
              <span class="avatar" style="--hue:${hue}" aria-hidden="true">${escapeHTML(initial)}</span>
              <div class="user-ident">
                <span class="user-email" title="${escapeAttr(user.email)}">${escapeHTML(user.email)}</span>
                <span class="user-meta">${escapeHTML(meta)}</span>
              </div>
            </div>
          </td>
          <td>${statusBadges(user)}</td>
          <td class="col-cloud">
            <span class="cloud-count">${Number(user.cloudItems) || 0} 项</span>
            <span class="cloud-detail">链接 ${Number(user.cloudLinks) || 0} · 分组 ${Number(user.cloudGroups) || 0} · 加密 ${Number(user.cloudSecrets) || 0}</span>
          </td>
          <td class="col-created">${escapeHTML(formatDate(user.createdAt))}</td>
          <td class="col-actions">${actions}</td>
        </tr>`;
      })
      .join('');
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function escapeAttr(value) {
    return escapeHTML(value);
  }

  async function loadUsers() {
    const params = new URLSearchParams({
      q: state.query,
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    const response = await api('/api/v1/admin/users?' + params.toString());
    if (response.status === 401 || response.status === 403) {
      showGate('管理员会话已失效，请重新登录。');
      return;
    }
    if (!response.ok) {
      toast(errorMessage(response, '读取用户失败'));
      return;
    }

    state.total = response.data.total || 0;
    renderUsers(response.data.users || []);

    if (state.total > 0) {
      dom.navUserCount.hidden = false;
      dom.navUserCount.textContent = String(state.total);
    } else {
      dom.navUserCount.hidden = true;
    }

    const start = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, state.total);
    dom.userTotal.textContent = state.total === 0 ? '共 0 个用户' : `第 ${start}-${end} 个，共 ${state.total} 个`;
    dom.pagePrev.disabled = state.page <= 1;
    dom.pageNext.disabled = end >= state.total;
  }

  async function updateUser(id, patch, successMessage) {
    const response = await api('/api/v1/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
    if (!response.ok) {
      toast(errorMessage(response, '操作失败'));
      return false;
    }
    toast(successMessage);
    await loadUsers();
    return true;
  }

  function settleAdminConfirm(value) {
    if (!confirmResolver) return;
    const resolve = confirmResolver;
    confirmResolver = null;
    dom.confirmLayer.hidden = true;
    document.body.classList.remove('modal-open');
    if (confirmTrigger && document.contains(confirmTrigger)) confirmTrigger.focus();
    confirmTrigger = null;
    resolve(value);
  }

  function askAdminConfirm({ title = '确认操作', message = '', confirmText = '确定', danger = true }) {
    if (confirmResolver) settleAdminConfirm(false);
    confirmTrigger = document.activeElement;
    dom.confirmTitle.textContent = title;
    dom.confirmSubtitle.textContent = danger ? '此操作需要谨慎确认' : '请确认是否继续';
    dom.confirmText.textContent = message;
    dom.confirmOk.textContent = confirmText;
    dom.confirmOk.classList.toggle('btn-danger', danger);
    dom.confirmOk.classList.toggle('btn-primary', !danger);
    dom.confirmLayer.hidden = false;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => dom.confirmCancel.focus());
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  async function handleUserAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const id = button.dataset.id;
    const action = button.dataset.action;

    if (action === 'view') {
      const user = state.users.find((item) => item.id === id);
      if (user) openUserDrawer(user, button);
      return;
    }
    if (action === 'admin') {
      const makeAdmin = button.dataset.value === 'true';
      await updateUser(id, { isAdmin: makeAdmin }, makeAdmin ? '已设为管理员' : '已取消管理员');
      return;
    }
    if (action === 'disabled') {
      const disable = button.dataset.value === 'true';
      if (
        disable &&
        !(await askAdminConfirm({
          title: '禁用用户',
          message: '禁用后该用户的所有会话会立即失效，且无法再次登录。确定继续吗？',
          confirmText: '禁用',
        }))
      ) {
        return;
      }
      await updateUser(id, { disabled: disable }, disable ? '已禁用该用户' : '已恢复该用户');
      return;
    }
    if (action === 'delete') {
      const email = button.dataset.email || '该用户';
      if (
        !(await askAdminConfirm({
          title: '永久删除用户',
          message: `将永久删除 ${email} 及其全部云端数据。此操作不可撤销。`,
          confirmText: '永久删除',
        }))
      ) {
        return;
      }
      const response = await api('/api/v1/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!response.ok) {
        toast(errorMessage(response, '删除失败'));
        return;
      }
      toast('用户已删除');
      if (state.total > 1 && (state.page - 1) * state.pageSize >= state.total - 1) {
        state.page = Math.max(1, state.page - 1);
      }
      await loadUsers();
    }
  }

  /* ------------------------------------------------------------------ *
   * 用户数据抽屉
   * ------------------------------------------------------------------ */

  function safeURL(value) {
    if (!value) return '';
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (error) {
      /* ignore */
    }
    return '';
  }

  function displayURL(value) {
    if (!value) return '';
    try {
      const parsed = new URL(value);
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return parsed.host.replace(/^www\./, '') + path + parsed.search;
    } catch (error) {
      return value;
    }
  }

  function renderDrawerLink(link) {
    const url = safeURL(link.url || '');
    const title = link.title || displayURL(link.url || '') || '未命名链接';
    const hue = hueFor(title);
    const glyph = String(title).slice(0, 1).toUpperCase() || '•';
    const inner = `<span class="link-glyph" style="--hue:${hue}" aria-hidden="true">${escapeHTML(glyph)}</span>
      <span class="link-copy">
        <span class="link-title">${escapeHTML(title)}</span>
        <span class="link-url">${escapeHTML(displayURL(link.url || ''))}</span>
      </span>`;
    if (!url) return `<li><div class="data-link">${inner}</div></li>`;
    return `<li><a class="data-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${inner}</a></li>`;
  }

  function renderUserWorkspace(user, data) {
    const payload = data && data.payload ? data.payload : {};
    if (globalThis.QingdhCrypto && QingdhCrypto.isEncrypted(payload)) {
      renderEncryptedWorkspace(user, data, payload);
      return;
    }
    renderWorkspacePayload(user, data, payload);
  }

  function renderEncryptedWorkspace(user, data, envelope) {
    dom.drawerSubtitle.textContent = '已加密 · 需要密码查看';
    dom.drawerBody.innerHTML = `
      <div class="modal-unlock">
        <p class="dialog-note">该用户的云端数据已加密。加密密码只在当前浏览器中使用，不会发送到服务器。</p>
        <div class="field">
          <label for="admin-unlock-password">加密密码</label>
          <input id="admin-unlock-password" type="password" autocomplete="off" />
        </div>
        <label class="checkbox-line">
          <input type="checkbox" id="admin-unlock-recovery-toggle" />
          <span>使用恢复码</span>
        </label>
        <div class="field" id="admin-unlock-recovery-field" hidden>
          <label for="admin-unlock-recovery-code">恢复码</label>
          <input id="admin-unlock-recovery-code" type="text" autocomplete="off" spellcheck="false" placeholder="40 位十六进制字符" />
        </div>
        <p class="field-error" id="admin-unlock-error" hidden></p>
        <div>
          <button class="btn btn-primary" id="admin-unlock-btn" type="button">解锁查看</button>
        </div>
      </div>`;

    const passwordInput = document.getElementById('admin-unlock-password');
    const recoveryInput = document.getElementById('admin-unlock-recovery-code');
    const recoveryToggle = document.getElementById('admin-unlock-recovery-toggle');
    const recoveryField = document.getElementById('admin-unlock-recovery-field');
    const error = document.getElementById('admin-unlock-error');
    const button = document.getElementById('admin-unlock-btn');

    recoveryToggle.addEventListener('change', () => {
      recoveryField.hidden = !recoveryToggle.checked;
      error.hidden = true;
      (recoveryToggle.checked ? recoveryInput : passwordInput).focus();
    });

    const submit = async () => {
      const useRecovery = recoveryToggle.checked;
      const secret = useRecovery ? recoveryInput.value.trim() : passwordInput.value;
      error.hidden = true;
      if (!secret) {
        error.textContent = useRecovery ? '请输入恢复码' : '请输入加密密码';
        error.hidden = false;
        return;
      }
      if (!globalThis.QingdhCrypto) {
        error.textContent = '当前环境不支持解密，请使用 HTTPS 或 localhost';
        error.hidden = false;
        return;
      }

      button.disabled = true;
      try {
        const opened = useRecovery
          ? await QingdhCrypto.unlockWithRecovery(envelope, secret)
          : await QingdhCrypto.unlock(envelope, secret);
        renderWorkspacePayload(user, data, opened.payload);
      } catch (unlockError) {
        error.textContent = unlockError && unlockError.code === 'crypto_unavailable'
          ? '当前环境不支持解密，请使用 HTTPS 或 localhost'
          : (useRecovery ? '恢复码不正确' : '加密密码不正确');
        error.hidden = false;
        button.disabled = false;
      }
    };

    button.addEventListener('click', submit);
    [passwordInput, recoveryInput].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
    });
    setTimeout(() => passwordInput.focus(), 30);
  }

  function renderWorkspacePayload(user, data, payload) {
    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((group) => group && !group.deletedAt)
      : [];
    const totalLinks = groups.reduce((sum, group) => {
      const links = Array.isArray(group.links) ? group.links.filter((link) => link && !link.deletedAt) : [];
      return sum + links.length;
    }, 0);

    const role = user.isAdmin ? '管理员' : '普通用户';
    const status = user.disabled ? ' · 已禁用' : '';
    dom.drawerSubtitle.textContent = `${role}${status} · ${groups.length} 个分组 · ${totalLinks} 个链接`;

    if (!groups.length) {
      dom.drawerBody.innerHTML = '<div class="modal-empty">该用户还没有保存任何导航数据</div>';
      return;
    }

    const updated = data && data.updatedAt
      ? `<span class="chip">更新于 ${escapeHTML(formatDate(data.updatedAt))}</span>`
      : '';
    const summary = `<div class="modal-summary">
      <span class="chip">${groups.length} 个分组</span>
      <span class="chip">${totalLinks} 个链接</span>
      ${updated}
    </div>`;

    const groupsHTML = groups
      .map((group) => {
        const links = Array.isArray(group.links)
          ? group.links.filter((link) => link && !link.deletedAt)
          : [];
        const rows = links.length
          ? `<ul class="data-links">${links.map(renderDrawerLink).join('')}</ul>`
          : '<div class="data-empty">该分组暂无链接</div>';
        return `<section class="data-group">
          <div class="data-group-head">
            <h3>${escapeHTML(group.name || '未命名分组')}</h3>
            <span>${links.length} 个链接</span>
          </div>
          ${rows}
        </section>`;
      })
      .join('');

    dom.drawerBody.innerHTML = summary + groupsHTML;
  }

  async function loadUserWorkspace(user) {
    const response = await api('/api/v1/admin/users/' + encodeURIComponent(user.id) + '/workspace');
    if (response.status === 401 || response.status === 403) {
      closeUserDrawer();
      showGate('管理员会话已失效，请重新登录。');
      return;
    }
    if (response.status === 404) {
      dom.drawerBody.innerHTML = '<div class="modal-empty">该用户已经不存在</div>';
      return;
    }
    if (!response.ok) {
      dom.drawerBody.innerHTML = `<div class="modal-empty">${escapeHTML(errorMessage(response, '读取导航数据失败'))}</div>`;
      return;
    }
    renderUserWorkspace(user, response.data);
  }

  function openUserDrawer(user, trigger) {
    state.drawerTrigger = trigger || null;
    dom.drawerTitle.textContent = user.email;
    dom.drawerSubtitle.textContent = '读取中…';
    dom.drawerAvatar.textContent = (user.email || '?').slice(0, 1).toUpperCase();
    dom.drawerAvatar.style.setProperty('--hue', hueFor(user.email || ''));
    dom.drawerBody.innerHTML = '<div class="modal-loading">正在读取导航数据…</div>';
    dom.drawer.hidden = false;
    document.body.classList.add('modal-open');
    dom.drawerClose.focus();
    loadUserWorkspace(user);
  }

  function closeUserDrawer() {
    if (dom.drawer.hidden) return;
    const trigger = state.drawerTrigger;
    state.drawerTrigger = null;
    dom.drawer.hidden = true;
    document.body.classList.remove('modal-open');
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  /* ------------------------------------------------------------------ *
   * 审计
   * ------------------------------------------------------------------ */

  function formatDetail(detail) {
    if (!detail || (typeof detail === 'object' && Object.keys(detail).length === 0)) return '—';
    const text = JSON.stringify(detail);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  }

  function renderAudit(entries) {
    state.auditEntries = entries;
    if (!entries.length) {
      dom.auditRows.innerHTML = '<tr><td colspan="5" class="empty-row">没有匹配的审计记录</td></tr>';
      return;
    }
    dom.auditRows.innerHTML = entries
      .map((entry) => {
        const actor = entry.actorEmail || (entry.actorId ? `ID ${String(entry.actorId).slice(0, 8)}` : '系统');
        const target = entry.targetId ? String(entry.targetId).slice(0, 8) : '—';
        return `<tr>
          <td class="col-created">${escapeHTML(formatDate(entry.createdAt))}</td>
          <td title="${escapeAttr(entry.actorEmail || '')}">${escapeHTML(actor)}</td>
          <td><code class="audit-action">${escapeHTML(entry.action)}</code></td>
          <td class="col-target" title="${escapeAttr(entry.targetId || '')}">${escapeHTML(target)}</td>
          <td><span class="audit-detail" title="${escapeAttr(formatDetail(entry.detail))}">${escapeHTML(formatDetail(entry.detail))}</span></td>
        </tr>`;
      })
      .join('');
  }

  async function loadAudit() {
    const params = new URLSearchParams({
      limit: String(state.auditPageSize),
      offset: String((state.auditPage - 1) * state.auditPageSize),
    });
    if (state.auditAction) params.set('action', state.auditAction);
    if (state.auditActor) params.set('actor', state.auditActor);

    const response = await api('/api/v1/admin/audit?' + params.toString());
    if (response.status === 401 || response.status === 403) {
      showGate('管理员会话已失效，请重新登录。');
      return;
    }
    if (!response.ok) {
      toast(errorMessage(response, '读取审计日志失败'));
      return;
    }

    state.auditTotal = response.data.total || 0;
    renderAudit(response.data.entries || []);

    const start = state.auditTotal === 0 ? 0 : (state.auditPage - 1) * state.auditPageSize + 1;
    const end = Math.min(state.auditPage * state.auditPageSize, state.auditTotal);
    dom.auditTotal.textContent = state.auditTotal === 0 ? '共 0 条' : `第 ${start}-${end} 条，共 ${state.auditTotal} 条`;
    dom.auditPrev.disabled = state.auditPage <= 1;
    dom.auditNext.disabled = end >= state.auditTotal;
  }

  function applyAuditFilters() {
    state.auditAction = dom.auditAction.value.trim();
    state.auditActor = dom.auditActor.value.trim();
    state.auditPage = 1;
    loadAudit();
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */

  function switchTab(tab, { updateHash = true } = {}) {
    if (!TABS.includes(tab)) tab = 'overview';
    state.tab = tab;
    dom.tabs.forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });

    const config = CONFIG_TABS.includes(tab);
    dom.overviewPanel.hidden = tab !== 'overview';
    dom.settingsPanel.hidden = !config;
    dom.usersPanel.hidden = tab !== 'users';
    dom.auditPanel.hidden = tab !== 'audit';
    document.querySelectorAll('[data-config-group]').forEach((card) => {
      card.hidden = !config || card.dataset.configGroup !== tab;
    });

    if (updateHash && location.hash !== '#' + tab) {
      history.replaceState(null, '', '#' + tab);
    }

    if (tab === 'overview') loadOverview();
    if (tab === 'users') loadUsers();
    if (tab === 'audit') loadAudit();
  }

  dom.auditSearch.addEventListener('click', applyAuditFilters);
  dom.auditAction.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyAuditFilters();
  });
  dom.auditActor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyAuditFilters();
  });
  dom.auditPrev.addEventListener('click', () => {
    if (state.auditPage <= 1) return;
    state.auditPage -= 1;
    loadAudit();
  });
  dom.auditNext.addEventListener('click', () => {
    if ((state.auditPage * state.auditPageSize) >= state.auditTotal) return;
    state.auditPage += 1;
    loadAudit();
  });

  dom.themeBtn.addEventListener('click', () => {
    const next = resolveTheme() === 'dark' ? 'light' : 'dark';
    writePrefs({ theme: next });
    applyTheme();
  });

  dom.tabs.forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  dom.overviewRefresh.addEventListener('click', loadOverview);

  dom.siteName.addEventListener('input', renderSiteLogo);
  dom.siteLogoUrl.addEventListener('input', () => {
    state.siteLogo = dom.siteLogoUrl.value.trim();
    dom.siteLogoError.hidden = true;
    renderSiteLogo();
  });
  dom.siteLogoClear.addEventListener('click', () => {
    state.siteLogo = '';
    dom.siteLogoUrl.value = '';
    dom.siteLogoFile.value = '';
    dom.siteLogoError.hidden = true;
    renderSiteLogo();
  });
  dom.siteLogoUploadBtn.addEventListener('click', () => dom.siteLogoFile.click());
  dom.siteLogoFile.addEventListener('change', () => {
    const file = dom.siteLogoFile.files && dom.siteLogoFile.files[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 128 * 1024) {
      dom.siteLogoError.textContent = '请选择不超过 128 KiB 的 PNG、JPEG、WebP 或 GIF';
      dom.siteLogoError.hidden = false;
      dom.siteLogoFile.value = '';
      return;
    }
    const reader = new FileReader();
    const readToken = ++state.logoReadToken;
    state.logoReading = true;
    dom.saveBtn.disabled = true;
    reader.onload = () => {
      if (readToken !== state.logoReadToken) return;
      state.logoReading = false;
      dom.saveBtn.disabled = false;
      state.siteLogo = String(reader.result || '');
      dom.siteLogoUrl.value = '';
      dom.siteLogoError.hidden = true;
      renderSiteLogo();
    };
    reader.onerror = () => {
      if (readToken !== state.logoReadToken) return;
      state.logoReading = false;
      dom.saveBtn.disabled = false;
      dom.siteLogoError.textContent = '读取图片失败，请重新选择';
      dom.siteLogoError.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  dom.settingsForm.addEventListener('submit', saveSettings);
  dom.testEmailBtn.addEventListener('click', sendTestEmail);
  dom.testEmailTo.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendTestEmail();
    }
  });

  dom.clearPassword.addEventListener('click', () => {
    state.clearPassword = true;
    dom.smtpPassword.value = '';
    dom.passwordHintText.textContent = '保存后会清除已保存的密码';
    dom.clearPassword.hidden = true;
  });
  dom.smtpPassword.addEventListener('input', () => {
    if (dom.smtpPassword.value && state.clearPassword) {
      state.clearPassword = false;
      dom.passwordHintText.textContent = '填写后保存更新密码';
    }
  });

  dom.requireVerification.addEventListener('change', () => {
    updateVerificationHint({
      smtpConfigured: Boolean(dom.smtpHost.value.trim() && dom.smtpFrom.value.trim()),
    });
  });

  dom.smtpHost.addEventListener('input', () => {
    updateVerificationHint({
      smtpConfigured: Boolean(dom.smtpHost.value.trim() && dom.smtpFrom.value.trim()),
    });
  });

  dom.smtpFrom.addEventListener('input', () => {
    updateVerificationHint({
      smtpConfigured: Boolean(dom.smtpHost.value.trim() && dom.smtpFrom.value.trim()),
    });
  });

  dom.settingsForm.addEventListener('input', (event) => {
    if (event.target.setCustomValidity) {
      event.target.setCustomValidity('');
      event.target.removeAttribute('aria-invalid');
      event.target.removeAttribute('aria-describedby');
      const error = event.target.closest('.field')?.querySelector('.settings-field-error');
      if (error) error.remove();
    }
    dom.settingsModalError.hidden = true;
  });
  dom.settingsModalClose.addEventListener('click', closeSettings);
  dom.settingsCancel.addEventListener('click', closeSettings);
  dom.settingsModal.querySelector('[data-settings-close]').addEventListener('click', closeSettings);
  dom.settingsModal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dom.settingsModal.querySelectorAll('button:not([disabled]), input:not([disabled]):not([hidden]), select:not([disabled]), [tabindex="-1"]'))
      .filter((element) => !element.closest('[hidden]') && element.getClientRects().length > 0 && element.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  dom.userSearchBtn.addEventListener('click', () => {
    state.query = dom.userSearch.value.trim();
    state.page = 1;
    loadUsers();
  });
  dom.userSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      dom.userSearchBtn.click();
    }
  });
  dom.userRows.addEventListener('click', handleUserAction);
  dom.userRows.addEventListener('click', (event) => {
    if (event.target.closest('[data-action]')) return;
    const row = event.target.closest('tr[data-user-id]');
    if (!row) return;
    const user = state.users.find((item) => item.id === row.dataset.userId);
    if (user) openUserDrawer(user, row);
  });
  dom.drawerClose.addEventListener('click', closeUserDrawer);
  dom.drawerScrim.addEventListener('click', closeUserDrawer);
  dom.confirmCancel.addEventListener('click', () => settleAdminConfirm(false));
  dom.confirmOk.addEventListener('click', () => settleAdminConfirm(true));
  dom.confirmLayer.querySelector('[data-confirm-close]').addEventListener('click', () => settleAdminConfirm(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!dom.settingsModal.hidden) {
      event.preventDefault();
      closeSettings();
      return;
    }
    if (!dom.confirmLayer.hidden) {
      event.preventDefault();
      settleAdminConfirm(false);
      return;
    }
    if (!dom.drawer.hidden) closeUserDrawer();
  });
  dom.pagePrev.addEventListener('click', () => {
    if (state.page > 1) {
      state.page--;
      loadUsers();
    }
  });
  dom.pageNext.addEventListener('click', () => {
    if ((state.page * state.pageSize) < state.total) {
      state.page++;
      loadUsers();
    }
  });

  window.addEventListener('hashchange', () => {
    switchTab(tabFromHash(), { updateHash: false });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (readPrefs().theme === 'auto') applyTheme();
  });

  loadPublicSiteInfo();
  setupConfigCards();
  bootstrap();
})();
