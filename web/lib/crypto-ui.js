/* ==========================================================================
 * 氢导航 · 客户端加密 UI
 *
 * v3 加密/解锁、恢复码、关闭加密、Device Vault、Passkey 门禁与历史密文
 * 临时解锁。依赖通过 create(deps) 注入，避免 app.js 继续膨胀。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhCryptoUI = api;
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
      normalizeData,
      now,
      showToast,
      askConfirm,
      ensureDialogs,
      syncNow,
      setStatus,
      writeSyncMeta,
      writeGuestDirty,
      persist,
      updateSyncUI,
      handleAuthLost,
      broadcast,
      getData,
    } = deps;

    const dialogLib = globalThis.QingdhDialog;
    if (!dialogLib) throw new Error('QingdhDialog is not loaded');
    let unlockModal = null;
    let decryptFileModal = null;
    let passkeyModal = null;

    function initDialogControllers() {
      if (!unlockModal) unlockModal = dialogLib.createModal(dom.unlockDialog);
      if (!decryptFileModal) decryptFileModal = dialogLib.createModal(dom.decryptFileDialog);
      if (!passkeyModal) passkeyModal = dialogLib.createModal(dom.passkeyDialog);
    }

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
    cryptoState.pendingRecovery = null;
    cryptoState.unlockEnvelope = null;
    cryptoState.unlockTemporary = false;
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
    ensureDialogs();
    return new Promise((resolve) => {
      if (!passkeySupported() || !sync.user) {
        resolve(false);
        return;
      }
      passkeyModal.prompt(resolve, () => {
        dom.passkeyError.hidden = true;
        dom.passkeyVerify.disabled = false;
        setTimeout(() => dom.passkeyVerify.focus(), 30);
      });
    });
  }

  function resolvePasskey(value) {
    passkeyModal.settle(value);
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
    dom.encryptionRecovery.hidden = !(enabled && cryptoState.envelope);
    dom.encryptionDisable.hidden = !enabled;

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
    cryptoState.unlockEnvelope = null;
    cryptoState.unlockTemporary = false;
    unlockModal.settle(value);
  }

  // temporary=true 时只借用 dataKey 预览历史密文，不改变当前加密状态。
  function promptUnlock(envelope, { temporary = false } = {}) {
    ensureDialogs();
    return new Promise((resolve) => {
      if (!globalThis.QingdhCrypto) {
        showToast('当前环境不支持加密，请使用 HTTPS 或 localhost');
        resolve(null);
        return;
      }
      unlockModal.prompt(resolve, () => {
        cryptoState.unlockEnvelope = envelope;
        cryptoState.unlockTemporary = temporary;
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
        setTimeout(() => dom.unlockPassword.focus(), 30);
      });
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
      sync.encrypted = false;
      updateEncryptionUI();
      return payload;
    }

    cryptoState.enabled = true;
    sync.encrypted = true;
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
    await syncNow({ manual: true });
    return Boolean(cryptoState.dataKeyRaw);
  }

  function syncScopedData() {
    const next = normalizeData(getData());
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
    ensureDialogs();
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
      await syncNow({ manual: true });
      if (sync.revision == null) {
        throw new Error('请先完成一次云端同步');
      }
      if (cryptoState.enabled) {
        throw new Error('云端数据已经开启加密');
      }
      const created = await QingdhCrypto.setup(password, getData());
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
      sync.encrypted = true;
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
    ensureDialogs();
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
      await syncNow({ manual: true });
      return;
    }
    const opened = await promptUnlock(cryptoState.envelope);
    if (!opened) return;
    cryptoState.dataKeyRaw = opened.dataKeyRaw;
    cryptoState.unlocked = true;
    cacheDataKey(opened.dataKeyRaw);
    updateEncryptionUI();
    await syncNow({ manual: true });
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
    const envelope = cryptoState.unlockEnvelope || cryptoState.envelope;
    if (!envelope) {
      dom.unlockError.textContent = '无法获取加密数据，请关闭后重新同步';
      dom.unlockError.hidden = false;
      return;
    }

    dom.unlockSubmit.disabled = true;
    try {
      const opened = useRecovery
        ? await QingdhCrypto.unlockWithRecovery(envelope, secret)
        : await QingdhCrypto.unlock(envelope, secret);
      if (!cryptoState.unlockTemporary) {
        cryptoState.dataKeyRaw = opened.dataKeyRaw;
        cryptoState.unlocked = true;
        cacheDataKey(opened.dataKeyRaw);
        updateEncryptionUI();
        if (dom.unlockRemember.checked) {
          await rememberDevice(envelope, opened.dataKeyRaw);
        }
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
    cryptoState.fileDecryptEnvelope = null;
    decryptFileModal.settle(value);
  }

  function promptDecryptFile(envelope) {
    ensureDialogs();
    return new Promise((resolve) => {
      decryptFileModal.prompt(resolve, () => {
        cryptoState.fileDecryptEnvelope = envelope;
        dom.decryptFileForm.reset();
        dom.decryptFileRecoveryField.hidden = true;
        dom.decryptFileError.hidden = true;
        dom.decryptFileSubmit.disabled = false;
        setTimeout(() => dom.decryptFilePassword.focus(), 30);
      });
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

  function openDisableEncryptionDialog() {
    ensureDialogs();
    if (!sync.user || !cryptoState.enabled) return;
    state.disableBlockingSecrets = [];
    dom.disableEncryptionForm.reset();
    dom.disableEncryptionDependency.hidden = true;
    dom.disableEncryptionDependencyMessage.textContent = '';
    dom.disableEncryptionDiscard.checked = false;
    dom.disableEncryptionError.hidden = true;
    dom.disableEncryptionSubmit.disabled = false;
    dom.disableEncryptionDialog.showModal();
    requestAnimationFrame(() => dom.disableEncryptionPassword.focus());
  }

  async function finishDisableEncryption(revision) {
    const userId = sync.user ? sync.user.id : null;
    // 先清除本机 vault，再重置内存/会话中的密钥。
    if (userId && globalThis.QingdhDeviceVault) {
      try {
        await QingdhDeviceVault.forget(userId);
      } catch (error) {
        // IndexedDB 不可用时仍然继续清理内存状态。
      }
    }
    if (userId && globalThis.QingdhPasskey) {
      QingdhPasskey.remove(userId).catch(() => {});
    }
    resetCryptoState();
    sync.encrypted = false;
    sync.revision = revision;
    sync.dirty = false;
    sync.hasLocal = true;
    sync.lastSyncedAt = now();
    sync.cloudData = syncScopedData();
    writeSyncMeta();
    writeGuestDirty(false);
    persist();
    updateSyncUI();
    setStatus('synced');
    broadcast({ type: 'encryption-disabled', userId });
    dom.disableEncryptionDialog.close();
    showToast('已关闭数据加密；历史版本与备份中的旧密文不会自动清理');
  }

  async function submitDisableEncryption(event) {
    event.preventDefault();
    dom.disableEncryptionError.hidden = true;
    const password = dom.disableEncryptionPassword.value;
    if (!password) {
      dom.disableEncryptionError.textContent = '请输入当前登录密码';
      dom.disableEncryptionError.hidden = false;
      return;
    }
    if (!dom.disableEncryptionConfirm.checked) {
      dom.disableEncryptionError.textContent = '请先勾选“我已了解关闭后云端与备份不再加密”';
      dom.disableEncryptionError.hidden = false;
      return;
    }
    if (state.disableBlockingSecrets.length && !dom.disableEncryptionDiscard.checked) {
      dom.disableEncryptionError.textContent = '请先导出或删除 AI 配置/备忘录，并勾选允许删除云端密文';
      dom.disableEncryptionError.hidden = false;
      return;
    }
    if (sync.revision == null) {
      dom.disableEncryptionError.textContent = '请先完成一次云端同步';
      dom.disableEncryptionError.hidden = false;
      return;
    }

    dom.disableEncryptionSubmit.disabled = true;
    try {
      // 依赖清理是用户显式勾选后的动作；删除后立即重试关闭。
      if (state.disableBlockingSecrets.length) {
        for (const kind of state.disableBlockingSecrets) {
          const removed = await api('/api/v1/secrets/' + encodeURIComponent(kind), { method: 'DELETE' });
          if (!removed.ok) {
            throw new Error(apiError(removed, '删除云端密文失败'));
          }
        }
        state.disableBlockingSecrets = [];
        dom.disableEncryptionDependency.hidden = true;
      }

      const response = await api('/api/v1/workspace/disable-encryption', {
        method: 'POST',
        body: { baseRevision: sync.revision, currentPassword: password, payload: syncScopedData() },
      });
      if (response.status === 401) {
        dom.disableEncryptionDialog.close();
        await handleAuthLost();
        return;
      }
      if (response.status === 409) {
        const code = response.data && response.data.error && response.data.error.code;
        if (code === 'encryption_dependency') {
          const secrets = (response.data && response.data.secrets) || [];
          state.disableBlockingSecrets = secrets;
          dom.disableEncryptionDependency.hidden = false;
          dom.disableEncryptionDependencyMessage.textContent = apiError(
            response,
            'AI 配置或备忘录仍使用主数据密钥，需要先导出或删除'
          );
          dom.disableEncryptionDiscard.checked = false;
          return;
        }
        throw new Error('云端已在其他地方更新，请先同步后重试');
      }
      if (!response.ok) {
        const code = response.data && response.data.error && response.data.error.code;
        throw new Error(
          code === 'invalid_password'
            ? '登录密码不正确'
            : code === 'not_encrypted'
              ? '云端数据已经未加密'
              : apiError(response, '关闭加密失败')
        );
      }

      await finishDisableEncryption(response.data.revision);
    } catch (error) {
      dom.disableEncryptionError.textContent = (error && error.message) || '关闭加密失败';
      dom.disableEncryptionError.hidden = false;
    } finally {
      dom.disableEncryptionSubmit.disabled = false;
    }
  }

  function openRotateRecoveryDialog() {
    ensureDialogs();
    if (!cryptoState.enabled || !cryptoState.envelope) return;
    dom.rotateRecoveryForm.reset();
    dom.rotateRecoveryError.hidden = true;
    dom.rotateRecoverySubmit.disabled = false;
    dom.rotateRecoveryDialog.showModal();
    requestAnimationFrame(() => dom.rotateRecoveryPassword.focus());
  }

  async function submitRotateRecovery(event) {
    event.preventDefault();
    dom.rotateRecoveryError.hidden = true;
    const password = dom.rotateRecoveryPassword.value;
    if (!password) {
      dom.rotateRecoveryError.textContent = '请输入当前加密密码';
      dom.rotateRecoveryError.hidden = false;
      return;
    }
    if (!cryptoState.envelope) {
      dom.rotateRecoveryError.textContent = '请先完成一次同步，获取云端加密数据';
      dom.rotateRecoveryError.hidden = false;
      return;
    }

    dom.rotateRecoverySubmit.disabled = true;
    try {
      const rotated = await QingdhCrypto.rewrapRecovery(cryptoState.envelope, password);
      cryptoState.pendingRecovery = rotated;
      dom.rotateRecoveryForm.reset();
      dom.rotateRecoveryDialog.close();
      dom.newRecoveryCode.textContent = QingdhCrypto.formatRecoveryCode(rotated.recoveryCode);
      dom.newRecoveryConfirm.checked = false;
      dom.newRecoveryError.hidden = true;
      dom.newRecoverySave.disabled = false;
      dom.newRecoveryDialog.showModal();
    } catch (error) {
      dom.rotateRecoveryError.textContent = error && error.code === 'unlock_failed'
        ? '加密密码不正确'
        : (error && error.message) || '生成新恢复码失败';
      dom.rotateRecoveryError.hidden = false;
    } finally {
      dom.rotateRecoverySubmit.disabled = false;
    }
  }

  async function finishRotateRecovery() {
    ensureDialogs();
    const pending = cryptoState.pendingRecovery;
    if (!pending) return;
    if (!dom.newRecoveryConfirm.checked) {
      dom.newRecoveryError.textContent = '请先勾选“我已把新恢复码保存在离线、安全的地方”';
      dom.newRecoveryError.hidden = false;
      dom.newRecoveryConfirm.focus();
      return;
    }

    dom.newRecoverySave.disabled = true;
    dom.newRecoveryError.hidden = true;
    try {
      const response = await putWorkspacePayload(pending.envelope, sync.revision == null ? 0 : sync.revision);
      if (response.status === 401) {
        await handleAuthLost();
        return;
      }
      if (response.status === 409) {
        dom.newRecoveryError.textContent = '云端已在其他地方更新，请同步后重新生成';
        dom.newRecoveryError.hidden = false;
        return;
      }
      if (!response.ok) {
        dom.newRecoveryError.textContent = apiError(response, '保存失败');
        dom.newRecoveryError.hidden = false;
        return;
      }
      sync.revision = response.data.revision;
      sync.lastSyncedAt = now();
      cryptoState.envelope = pending.envelope;
      cryptoState.pendingRecovery = null;
      writeSyncMeta();
      updateEncryptionUI();
      dom.newRecoveryDialog.close();
      showToast('恢复码已更新，旧恢复码已失效');
    } catch (error) {
      dom.newRecoveryError.textContent = (error && error.message) || '保存失败';
      dom.newRecoveryError.hidden = false;
    } finally {
      dom.newRecoverySave.disabled = false;
    }
  }

  function copyNewRecoveryCode() {
    const code = dom.newRecoveryCode.textContent;
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

  function downloadNewRecoveryCode() {
    const code = dom.newRecoveryCode.textContent;
    if (!code) return;
    const text = [
      '氢导航 · 新的云端数据恢复码',
      '',
      code,
      '',
      `账号：${sync.user ? sync.user.email : ''}`,
      `生成时间：${new Date().toLocaleString()}`,
      '',
      '这个恢复码已替换旧恢复码。忘记加密密码时，用这个恢复码解锁云端数据。',
      '请离线保存，不要发给任何人。',
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'qingdh-recovery-code.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

    return {
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
    };
  }

  return { create };
});
