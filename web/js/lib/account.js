/* ==========================================================================
 * 氢导航 · 账号与认证 UI
 *
 * 登录/注册/验证/找回、会话列表、改密/改邮箱/删号，以及账号数据装载与
 * 同步状态展示。通过 create(deps) 注入状态、存储和加密/同步回调。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhAccount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(deps) {
    const {
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
      escapeHTML,
      formatTime,
      ICON_X,
      STATUS_TEXT,
      STATUS_SHORT,
      GUEST_KEY,
      USER_KEY_PREFIX,
      SYNC_KEY_PREFIX,
      handleAuthLost,
      openAccountDialog,
      readGuestDirty,
      readSearchHistory,
      setAccountAvatar,
      updateAIConfigGate,
      updateEncryptionUI,
      getData,
      setData,
    } = deps;

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

    const localLinks = documentLinkCount(getData());
    const localGroups = documentGroupCount(getData());
    const cloudDoc = sync.cloudData || getData();
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

    dom.accountLabel.textContent = sync.user ? '账号' : '登录';
    dom.accountBtn.setAttribute('aria-label', sync.user ? '账号' : '登录');
    dom.accountBtn.title = sync.user ? '账号' : '登录';

    if (sync.user) {
      setAccountAvatar(dom.accountAvatar, sync.user);
      setAccountAvatar(dom.accountAvatarMini, sync.user);
      dom.accountEmail.textContent = sync.user.email;
      const parts = [sync.user.emailVerified ? '邮箱已验证' : '邮箱未验证'];
      if (sync.user.pendingEmail) parts.push(`待验证新邮箱 ${sync.user.pendingEmail}`);
      if (sync.lastSyncedAt) parts.push(`上次同步 ${formatTime(sync.lastSyncedAt)}`);
      dom.accountMeta.textContent = parts.join(' · ');
      const emailChangeAvailable = Boolean(sync.user.emailChangeAvailable);
      dom.changeEmailBtn.disabled = !emailChangeAvailable;
      dom.changeEmailBtn.title = emailChangeAvailable ? '' : '需要管理员配置邮件服务后才能修改邮箱';
      dom.changeEmailHint.hidden = emailChangeAvailable;
    } else {
      // 未登录显示中性的“个人中心”轮廓图标。
      setAccountAvatar(dom.accountAvatar, null);
      setAccountAvatar(dom.accountAvatarMini, null);
    }

    dom.accountGuest.hidden = Boolean(sync.user);
    dom.accountUser.hidden = !sync.user;
    if (dom.encryptionPanel) dom.encryptionPanel.hidden = !sync.user;
    if (dom.encryptionGuest) dom.encryptionGuest.hidden = Boolean(sync.user);
    dom.adminLink.hidden = !(sync.user && sync.user.isAdmin);
    updateEncryptionUI();
    updateDeviceUI();
    updateAIConfigGate();
    if (dom.syncPanel && !dom.syncPanel.hidden) renderSyncManager();
  }

  function showAccountView(loggedIn) {
    dom.accountGuest.hidden = loggedIn;
    dom.accountUser.hidden = !loggedIn;
  }

  function updateAccountUI() {
    // 头像库只在登录后需要；首屏游客不下载，登录后按需加载再刷新头像。
    if (sync.user && !globalThis.QingdhAvatars) {
      withOptionalModule('QingdhAvatars', () => updateAccountUI());
    }
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
    const next = stored ? normalizeData(stored) : createDefaultData();
    setData(next);
    if (!stored) writeJSON(GUEST_KEY, next);
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
    sync.encrypted = Boolean(meta && meta.encrypted);
    sync.hasLocal = Boolean(stored);

    if (stored) {
      setData(normalizeData(stored));
    } else if (readGuestDirty()) {
      const guest = readJSON(GUEST_KEY);
      setData(guest ? normalizeData(guest) : createDefaultData());
      sync.dirty = true;
    } else {
      setData(createDefaultData());
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
    sync.encrypted = false;
    sync.hasLocal = false;
    sync.lastSyncedAt = null;

    if (keepData && wasUser) {
      // Keep the current links as guest data after deleting the account.
      writeJSON(GUEST_KEY, normalizeData(getData()));
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

  function openChangeEmailDialog() {
    ensureDialogs();
    if (!sync.user || !sync.user.emailChangeAvailable) return;
    dom.changeEmailForm.reset();
    dom.changeEmailError.hidden = true;
    dom.changeEmailSubmit.disabled = false;
    dom.changeEmailCurrent.textContent = sync.user.pendingEmail
      ? `当前邮箱：${sync.user.email}；待验证新邮箱：${sync.user.pendingEmail}（重新提交会覆盖上一次请求）`
      : `当前邮箱：${sync.user.email}`;
    dom.changeEmailDialog.showModal();
    requestAnimationFrame(() => dom.changeEmailPassword.focus());
  }

  async function handleChangeEmail(event) {
    event.preventDefault();
    dom.changeEmailError.hidden = true;

    const password = dom.changeEmailPassword.value;
    const newEmail = dom.changeEmailNew.value.trim();
    if (!password) {
      showAuthError(dom.changeEmailError, '请输入当前登录密码');
      return;
    }
    if (!newEmail) {
      showAuthError(dom.changeEmailError, '请输入新邮箱');
      return;
    }

    dom.changeEmailSubmit.disabled = true;
    const response = await api('/api/v1/auth/email-change', {
      method: 'POST',
      body: { password, newEmail },
    });
    dom.changeEmailSubmit.disabled = false;

    if (response.ok) {
      const pendingEmail = (response.data && response.data.pendingEmail) || newEmail;
      sync.user.pendingEmail = pendingEmail;
      dom.changeEmailForm.reset();
      dom.changeEmailDialog.close();
      updateSyncUI();
      showToast('确认邮件已发送到新邮箱，请查收并打开链接');
      return;
    }
    if (response.status === 401) {
      dom.changeEmailDialog.close();
      await handleAuthLost();
      return;
    }
    const code = response.data && response.data.error && response.data.error.code;
    const message =
      code === 'email_taken'
        ? '这个邮箱已经注册过了'
        : code === 'same_email'
          ? '新邮箱与当前邮箱相同'
          : code === 'invalid_password'
            ? '当前密码不正确'
            : code === 'invalid_email'
              ? apiError(response, '邮箱格式不正确')
              : code === 'email_not_configured'
                ? '当前实例未配置邮件服务，暂时无法修改邮箱'
                : code === 'rate_limited'
                  ? '操作过于频繁，请稍后再试'
                  : apiError(response, '发送失败，请稍后再试');
    showAuthError(dom.changeEmailError, message);
  }

  function openChangePasswordDialog() {
    ensureDialogs();
    if (!sync.user) return;
    dom.changePasswordForm.reset();
    dom.changePasswordError.hidden = true;
    dom.changePasswordSubmit.disabled = false;
    dom.changePasswordDialog.showModal();
    requestAnimationFrame(() => dom.changePasswordCurrent.focus());
  }

  async function handleChangePassword(event) {
    event.preventDefault();
    dom.changePasswordError.hidden = true;

    const current = dom.changePasswordCurrent.value;
    const next = dom.changePasswordNew.value;
    const confirm = dom.changePasswordNew2.value;

    if (!current) {
      showAuthError(dom.changePasswordError, '请输入当前登录密码');
      return;
    }
    if (next.length < 8) {
      showAuthError(dom.changePasswordError, '新密码至少需要 8 个字符');
      return;
    }
    if (next !== confirm) {
      showAuthError(dom.changePasswordError, '两次输入的新密码不一致');
      return;
    }
    if (next === current) {
      showAuthError(dom.changePasswordError, '新密码不能与当前密码相同');
      return;
    }

    dom.changePasswordSubmit.disabled = true;
    const response = await api('/api/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: current, newPassword: next },
    });
    dom.changePasswordSubmit.disabled = false;

    if (response.ok) {
      dom.changePasswordForm.reset();
      dom.changePasswordDialog.close();
      showToast('登录密码已修改，其他设备已退出登录');
      loadSessions();
      return;
    }
    if (response.status === 401) {
      dom.changePasswordDialog.close();
      await handleAuthLost();
      return;
    }
    const code = response.data && response.data.error && response.data.error.code;
    const message =
      code === 'invalid_password'
        ? '当前密码不正确'
        : code === 'same_password'
          ? '新密码不能与当前密码相同'
          : code === 'weak_password'
            ? apiError(response, '新密码不符合要求')
            : code === 'rate_limited'
              ? '操作过于频繁，请稍后再试'
              : apiError(response, '修改失败，请稍后再试');
    showAuthError(dom.changePasswordError, message);
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



    return {
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
    };
  }

  return { create };
});
