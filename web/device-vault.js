/* ==========================================================================
 * 氢导航 · Device Vault
 *
 * 每台浏览器生成一个不可导出（extractable: false）的 AES-GCM deviceKey，
 * 保存在 IndexedDB；用它在本地包裹主 dataKey。
 * 不保存密码，不保存明文 dataKey，也不写入 localStorage / URL / 日志。
 * ========================================================================== */

(() => {
  'use strict';

  const DB_NAME = 'qingdh.vault.v1';
  const DB_VERSION = 1;
  const STORE = 'devices';
  const IV_BYTES = 12;

  let dbPromise = null;
  const gate = new Map();

  function supported() {
    return Boolean(globalThis.indexedDB && globalThis.crypto && globalThis.crypto.subtle);
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('vault_open_failed'));
      request.onblocked = () => reject(new Error('vault_blocked'));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('vault_request_failed'));
    });
  }

  async function withStore(mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(STORE, mode);
      } catch (error) {
        reject(error);
        return;
      }
      const store = transaction.objectStore(STORE);
      let result;
      try {
        result = run(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('vault_transaction_failed'));
      transaction.onabort = () => reject(transaction.error || new Error('vault_transaction_aborted'));
    });
  }

  async function readRecord(userId) {
    if (!supported() || !userId) return null;
    const db = await openDatabase();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const record = await requestResult(store.get(userId));
    return record || null;
  }

  async function remember(userId, envelopeId, dataKeyRaw) {
    if (!supported() || !userId || !envelopeId || !dataKeyRaw) return false;

    const existing = await readRecord(userId).catch(() => null);
    const reusable =
      existing && existing.envelopeId === envelopeId && existing.deviceKey && existing.wrappedDataKey;

    let deviceKey = reusable ? existing.deviceKey : null;
    if (!deviceKey) {
      deviceKey = await globalThis.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const wrappedDataKey = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      deviceKey,
      dataKeyRaw
    );

    const timestamp = Date.now();
    const record = {
      id: userId,
      userId,
      envelopeId,
      deviceKey,
      iv,
      wrappedDataKey,
      passkeyRequired: Boolean(existing && existing.passkeyRequired),
      createdAt: reusable && existing.createdAt ? existing.createdAt : timestamp,
      updatedAt: timestamp,
    };

    await withStore('readwrite', (store) => store.put(record));
    return true;
  }

  async function recall(userId, envelopeId) {
    if (!supported() || !userId) return null;

    let record;
    try {
      record = await readRecord(userId);
    } catch (error) {
      return null;
    }
    if (!record || !record.deviceKey || !record.wrappedDataKey || !record.iv) return null;
    if (record.passkeyRequired && !hasGate(userId)) return null;

    if (record.envelopeId !== envelopeId) {
      // 密钥已重建（例如重置 dataKey），本地包裹的旧密钥不再可信。
      await forget(userId).catch(() => {});
      return null;
    }

    try {
      const raw = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
        record.deviceKey,
        record.wrappedDataKey
      );
      return new Uint8Array(raw);
    } catch (error) {
      await forget(userId).catch(() => {});
      return null;
    }
  }

  async function status(userId, envelopeId) {
    if (!supported() || !userId) return { supported: supported(), remembered: false };
    let record = null;
    try {
      record = await readRecord(userId);
    } catch (error) {
      return { supported: true, remembered: false, error: true };
    }
    if (!record) return { supported: true, remembered: false };
    return {
      supported: true,
      remembered: Boolean(record.deviceKey && record.wrappedDataKey),
      matches: !envelopeId || record.envelopeId === envelopeId,
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null,
    };
  }

  async function forget(userId) {
    if (!supported() || !userId) return false;
    gate.delete(userId);
    const db = await openDatabase();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await requestResult(store.delete(userId));
    return true;
  }

  // H1：Passkey 门禁。gate 只存在内存里，刷新/锁定后需要重新验证。
  async function setPasskeyRequired(userId, required) {
    if (!supported() || !userId) return false;
    const record = await readRecord(userId).catch(() => null);
    if (!record) return false;
    record.passkeyRequired = Boolean(required);
    record.updatedAt = Date.now();
    await withStore('readwrite', (store) => store.put(record));
    if (!required) gate.delete(userId);
    return true;
  }

  async function requiresPasskey(userId) {
    if (!supported() || !userId) return false;
    try {
      const record = await readRecord(userId);
      return Boolean(record && record.passkeyRequired);
    } catch (error) {
      return false;
    }
  }

  function grant(userId, ttlMs = 5 * 60 * 1000) {
    if (!userId) return;
    gate.set(userId, Date.now() + ttlMs);
  }

  function hasGate(userId) {
    const expiresAt = gate.get(userId) || 0;
    return Date.now() < expiresAt;
  }

  function revokeGate(userId) {
    if (userId) gate.delete(userId);
    else gate.clear();
  }

  async function forgetAll() {
    if (!supported()) return false;
    const db = await openDatabase();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await requestResult(store.clear());
    return true;
  }

  globalThis.QingdhDeviceVault = {
    supported,
    remember,
    recall,
    status,
    forget,
    forgetAll,
    setPasskeyRequired,
    requiresPasskey,
    grant,
    hasGate,
    revokeGate,
  };
})();
