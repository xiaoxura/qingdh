/* ==========================================================================
 * 氢导航 · Passkey（H1：本地 Device Vault 门禁）
 *
 * 用系统平台认证器（Touch ID / Windows Hello / Android 生物识别）作为
 * 打开本机 Device Vault 的额外门禁；公钥与 credential id 只保存在 IndexedDB。
 * 不新增服务端表，也不改变同步协议；失败时始终可以回退加密密码。
 * ========================================================================== */

(() => {
  'use strict';

  const DB_NAME = 'qingdh.passkey.v1';
  const DB_VERSION = 1;
  const STORE = 'credentials';
  const CHALLENGE_BYTES = 32;

  let dbPromise = null;

  function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function isIpHost(host) {
    if (!host) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    return host.includes(':') || host.startsWith('[');
  }

  function relyingPartyId() {
    const host = location.hostname;
    return isIpHost(host) ? '' : host;
  }

  // WebAuthn 不接受 IP 地址作为 RP ID；在 127.0.0.1 这类地址上 create()
  // 只会得到一个含糊的 NotAllowedError，看起来像“用户取消”。
  function unsupportedReason() {
    if (!globalThis.isSecureContext) {
      return 'Passkey 需要 HTTPS 或 localhost 安全上下文';
    }
    if (!relyingPartyId()) {
      return 'Passkey 不能使用 IP 地址，请改用 localhost 或自有域名访问';
    }
    if (
      !globalThis.PublicKeyCredential ||
      !navigator.credentials ||
      !globalThis.crypto ||
      !globalThis.crypto.subtle ||
      typeof navigator.credentials.create !== 'function' ||
      typeof navigator.credentials.get !== 'function'
    ) {
      return '当前浏览器不支持 Passkey';
    }
    return '';
  }

  function supported() {
    return !unsupportedReason();
  }

  let platformPromise = null;

  // 设备是否有 Touch ID / Windows Hello / Android 生物识别。没有平台验证器
  // 时不要等到 create() 失败才提示，否则用户只会看到“已取消”。
  function platformAvailable() {
    if (!supported()) return Promise.resolve(false);
    if (typeof globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
      return Promise.resolve(false);
    }
    if (!platformPromise) {
      platformPromise = globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(Boolean)
        .catch(() => false);
    }
    return platformPromise;
  }

  function credentialError(error, action) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return fail(
        'passkey_cancelled',
        action === 'create' ? '生物识别注册已取消或超时' : '生物识别验证已取消或超时'
      );
    }
    if (name === 'InvalidStateError') {
      return fail('passkey_exists', '这台设备已经注册过 Passkey，请先移除再重试');
    }
    if (name === 'NotSupportedError') {
      return fail('passkey_unsupported', '当前设备没有可用的生物识别验证器');
    }
    if (name === 'SecurityError') {
      return fail('passkey_insecure', '当前地址不被 WebAuthn 接受，请使用 HTTPS 域名或 localhost');
    }
    return fail('passkey_failed', '生物识别操作失败：' + ((error && error.message) || name || '未知错误'));
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
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'userId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || fail('passkey_db_failed', '无法打开 Passkey 存储'));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || fail('passkey_db_failed', 'Passkey 存储失败'));
    });
  }

  async function getRecord(userId) {
    if (!supported() || !userId) return null;
    const db = await openDatabase();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    return (await requestResult(store.get(userId))) || null;
  }

  async function putRecord(record) {
    const db = await openDatabase();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await requestResult(store.put(record));
  }

  async function status(userId) {
    if (!supported() || !userId) return { supported: supported(), registered: false };
    try {
      const record = await getRecord(userId);
      return {
        supported: true,
        registered: Boolean(record && record.credentialId),
        createdAt: record ? record.createdAt || null : null,
        lastUsedAt: record ? record.lastUsedAt || null : null,
      };
    } catch (error) {
      return { supported: true, registered: false, error: true };
    }
  }

  function randomBytes(length) {
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
  }

  function base64url(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  async function sha256(bytes) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  async function register(userId, email) {
    const reason = unsupportedReason();
    if (reason) throw fail('passkey_unavailable', reason);
    if (!userId) throw fail('passkey_no_user', '请先登录');
    if (!(await platformAvailable())) {
      throw fail('passkey_no_platform', '这台设备没有可用的 Touch ID / Windows Hello，仍可使用加密密码');
    }

    const challenge = randomBytes(CHALLENGE_BYTES);
    let credential;
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: '氢导航', id: relyingPartyId() },
          user: {
            id: randomBytes(16),
            name: String(email || 'qingdh-user').slice(0, 64),
            displayName: String(email || '氢导航用户').slice(0, 64),
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          timeout: 60000,
          attestation: 'none',
        },
      });
    } catch (error) {
      throw credentialError(error, 'create');
    }
    if (!credential || !credential.response) throw fail('passkey_failed', '没有创建 Passkey');

    const response = credential.response;
    if (typeof response.getPublicKey !== 'function') {
      throw fail('passkey_unsupported', '当前浏览器无法读取 Passkey 公钥');
    }
    const spki = response.getPublicKey();
    if (!spki) throw fail('passkey_unsupported', 'Passkey 公钥为空');
    const algorithm = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : -7;

    await putRecord({
      userId,
      credentialId: credential.rawId,
      spki,
      algorithm,
      signCount: 0,
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    return true;
  }

  async function assert(userId) {
    const reason = unsupportedReason();
    if (reason) throw fail('passkey_unavailable', reason);
    const record = await getRecord(userId);
    if (!record || !record.credentialId) throw fail('passkey_missing', '这台设备还没有注册 Passkey');

    const challenge = randomBytes(CHALLENGE_BYTES);
    let assertion;
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          rpId: relyingPartyId(),
          allowCredentials: [{ type: 'public-key', id: record.credentialId, transports: ['internal'] }],
          userVerification: 'required',
          timeout: 60000,
        },
      });
    } catch (error) {
      throw credentialError(error, 'get');
    }
    if (!assertion || !assertion.response) throw fail('passkey_failed', '没有获得 Passkey 断言');

    const verified = await verifyAssertion(record, assertion, challenge);
    if (!verified) throw fail('passkey_verify_failed', '生物识别验证未通过');

    record.lastUsedAt = Date.now();
    record.signCount = verified.signCount;
    await putRecord(record).catch(() => {});
    return true;
  }

  async function verifyAssertion(record, assertion, challenge) {
    const response = assertion.response;
    const clientData = JSON.parse(new TextDecoder().decode(response.clientDataJSON));
    if (clientData.type !== 'webauthn.get') return null;
    if (clientData.challenge !== base64url(challenge)) return null;
    if (clientData.origin !== location.origin) return null;

    const rawAuthData =
      response.authenticatorData ||
      (typeof response.getAuthenticatorData === 'function' ? response.getAuthenticatorData() : null);
    if (!rawAuthData) return null;
    const authData = new Uint8Array(rawAuthData);
    if (authData.length < 37) return null;

    const expectedRpId = await sha256(new TextEncoder().encode(relyingPartyId()));
    for (let i = 0; i < 32; i += 1) {
      if (authData[i] !== expectedRpId[i]) return null;
    }
    const flags = authData[32];
    if ((flags & 0x01) === 0) return null; // user present
    if ((flags & 0x04) === 0) return null; // user verified
    const signCount = ((authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36]) >>> 0;

    const clientHash = await sha256(new Uint8Array(response.clientDataJSON));
    const signed = concat(authData, clientHash);
    const signature = new Uint8Array(response.signature);

    if (record.algorithm === -257) {
      const key = await globalThis.crypto.subtle.importKey(
        'spki',
        record.spki,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
      const ok = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
      return ok ? { signCount } : null;
    }

    const key = await globalThis.crypto.subtle.importKey(
      'spki',
      record.spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    let candidate = derToRaw(signature);
    if (candidate) {
      const ok = await globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        candidate,
        signed
      );
      if (ok) return { signCount };
    }
    // 少数平台返回 raw r||s 而不是 DER。
    if (signature.length === 64) {
      const ok = await globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signature,
        signed
      );
      if (ok) return { signCount };
    }
    return null;
  }

  function trimLeadingZeros(bytes) {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    return bytes.slice(start);
  }

  function derToRaw(signature) {
    const bytes = new Uint8Array(signature);
    if (bytes.length < 8 || bytes[0] !== 0x30) return null;
    let offset = 2;
    if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
    if (bytes[offset] !== 0x02) return null;
    const rLength = bytes[offset + 1];
    const r = trimLeadingZeros(bytes.slice(offset + 2, offset + 2 + rLength));
    offset = offset + 2 + rLength;
    if (bytes[offset] !== 0x02) return null;
    const sLength = bytes[offset + 1];
    const s = trimLeadingZeros(bytes.slice(offset + 2, offset + 2 + sLength));
    if (r.length > 32 || s.length > 32) return null;
    const out = new Uint8Array(64);
    out.set(r, 32 - r.length);
    out.set(s, 64 - s.length);
    return out;
  }

  async function remove(userId) {
    if (!userId) return false;
    try {
      const db = await openDatabase();
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      await requestResult(store.delete(userId));
      return true;
    } catch (error) {
      return false;
    }
  }

  globalThis.QingdhPasskey = {
    supported,
    platformAvailable,
    unsupportedReason,
    relyingPartyId,
    register,
    assert,
    status,
    remove,
  };
})();
