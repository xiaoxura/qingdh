/* ==========================================================================
 * 氢导航 · 客户端加密
 *
 * PBKDF2-SHA256 600k -> AES-256-GCM。
 * 数据用随机 dataKey 加密，dataKey 由密码派生的 KEK 包裹；恢复码再包裹一份。
 * 服务端只看到 envelope，不参与密码派生和解密。
 * ========================================================================== */

(() => {
  'use strict';

  const VERSION = 3;
  const KDF = 'pbkdf2-sha256';
  const ITERATIONS = 600000;
  const AAD = {
    wrap: 'qingdh:v3:wrap',
    check: 'qingdh:v3:check',
    data: 'qingdh:v3:data',
    recovery: 'qingdh:v3:recovery',
  };
  const CHECK_TEXT = 'qingdh-check-v1';
  const RECOVERY_PREFIX = 'qingdh-recovery-v1:';

  function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function subtle() {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw fail('crypto_unavailable', '当前环境不支持 WebCrypto，请使用 HTTPS 或 localhost');
    }
    return globalThis.crypto.subtle;
  }

  function randomBytes(length) {
    subtle();
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
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

  function toBase64(bytes) {
    if (typeof btoa === 'function') {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }
    return Buffer.from(bytes).toString('base64');
  }

  function fromBase64(value) {
    if (typeof atob === 'function') {
      const binary = atob(value);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  function utf8(value) {
    return new TextEncoder().encode(value);
  }

  function fromUtf8(bytes) {
    return new TextDecoder().decode(bytes);
  }

  async function importDataKey(raw) {
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function deriveKek(password, salt, iterations) {
    const material = await subtle().importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptRaw(key, plaintext, aad) {
    const iv = randomBytes(12);
    const ciphertext = await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(aad) },
      key,
      plaintext
    );
    return toBase64(concat(iv, new Uint8Array(ciphertext)));
  }

  async function decryptRaw(key, blob, aad) {
    const raw = fromBase64(blob);
    if (raw.length < 13) throw fail('unlock_failed', '密文格式不正确');
    const iv = raw.subarray(0, 12);
    const ciphertext = raw.subarray(12);
    try {
      const plaintext = await subtle().decrypt(
        { name: 'AES-GCM', iv, additionalData: utf8(aad) },
        key,
        ciphertext
      );
      return new Uint8Array(plaintext);
    } catch (error) {
      throw fail('unlock_failed', '密码不正确或数据已损坏');
    }
  }

  function isEncrypted(payload) {
    return Boolean(payload && payload.version === VERSION && payload.encrypted === true);
  }

  function assertEnvelope(envelope) {
    if (!isEncrypted(envelope) || envelope.kdf !== KDF || !envelope.salt || !envelope.wrappedKey ||
        !envelope.check || !envelope.data || !envelope.recovery || !envelope.recovery.wrappedKey) {
      throw fail('invalid_envelope', '加密数据结构不完整');
    }
  }

  async function verifyCheck(dataKey, check) {
    const bytes = await decryptRaw(dataKey, check, AAD.check);
    if (fromUtf8(bytes) !== CHECK_TEXT) {
      throw fail('unlock_failed', '密码不正确或数据已损坏');
    }
  }

  async function unwrapPassword(envelope, password) {
    assertEnvelope(envelope);
    const salt = fromBase64(envelope.salt);
    const kek = await deriveKek(password, salt, envelope.iterations || ITERATIONS);
    const raw = await decryptRaw(kek, envelope.wrappedKey, AAD.wrap);
    const dataKey = await importDataKey(raw);
    await verifyCheck(dataKey, envelope.check);
    return raw;
  }

  async function unlock(envelope, password) {
    const dataKeyRaw = await unwrapPassword(envelope, password);
    return { dataKeyRaw, payload: await decryptPayload(envelope, dataKeyRaw) };
  }

  async function decryptPayload(envelope, dataKeyRaw) {
    const dataKey = await importDataKey(dataKeyRaw);
    const plaintext = await decryptRaw(dataKey, envelope.data, AAD.data);
    try {
      return JSON.parse(fromUtf8(plaintext));
    } catch (error) {
      throw fail('unlock_failed', '解密后的数据不是有效 JSON');
    }
  }

  async function unlockWithKey(envelope, dataKeyRaw) {
    assertEnvelope(envelope);
    const dataKey = await importDataKey(dataKeyRaw);
    await verifyCheck(dataKey, envelope.check);
    return decryptPayload(envelope, dataKeyRaw);
  }

  function generateRecoveryCode() {
    const bytes = randomBytes(20);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function normalizeRecoveryCode(value) {
    const code = String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (code.length !== 40) {
      throw fail('invalid_recovery_code', '恢复码应为 40 位十六进制字符');
    }
    return code;
  }

  function formatRecoveryCode(value) {
    const code = normalizeRecoveryCode(value);
    return code.match(/.{1,8}/g).join(' ');
  }

  async function deriveRecoveryKey(code) {
    const normalized = normalizeRecoveryCode(code);
    const digest = await subtle().digest('SHA-256', utf8(RECOVERY_PREFIX + normalized));
    return subtle().importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function unwrapRecovery(envelope, code) {
    assertEnvelope(envelope);
    const recoveryKey = await deriveRecoveryKey(code);
    const raw = await decryptRaw(recoveryKey, envelope.recovery.wrappedKey, AAD.recovery);
    const dataKey = await importDataKey(raw);
    await verifyCheck(dataKey, envelope.check);
    return raw;
  }

  async function unlockWithRecovery(envelope, code) {
    const dataKeyRaw = await unwrapRecovery(envelope, code);
    const dataKey = await importDataKey(dataKeyRaw);
    const plaintext = await decryptRaw(dataKey, envelope.data, AAD.data);
    let payload;
    try {
      payload = JSON.parse(fromUtf8(plaintext));
    } catch (error) {
      throw fail('unlock_failed', '解密后的数据不是有效 JSON');
    }
    return { dataKeyRaw, payload };
  }

  async function setup(password, payload) {
    if (typeof password !== 'string' || password.length < 8) {
      throw fail('weak_password', '加密密码至少 8 位');
    }
    const dataKeyRaw = randomBytes(32);
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, ITERATIONS);
    const dataKey = await importDataKey(dataKeyRaw);

    const wrappedKey = await encryptRaw(kek, dataKeyRaw, AAD.wrap);
    const check = await encryptRaw(dataKey, utf8(CHECK_TEXT), AAD.check);
    const data = await encryptRaw(dataKey, utf8(JSON.stringify(payload)), AAD.data);

    const recoveryCode = generateRecoveryCode();
    const recoveryKey = await deriveRecoveryKey(recoveryCode);
    const recoveryWrapped = await encryptRaw(recoveryKey, dataKeyRaw, AAD.recovery);

    return {
      recoveryCode,
      dataKeyRaw,
      envelope: {
        version: VERSION,
        encrypted: true,
        kdf: KDF,
        iterations: ITERATIONS,
        salt: toBase64(salt),
        wrappedKey,
        check,
        data,
        recovery: { wrappedKey: recoveryWrapped },
      },
    };
  }

  async function seal(envelope, dataKeyRaw, payload) {
    assertEnvelope(envelope);
    const dataKey = await importDataKey(dataKeyRaw);
    const data = await encryptRaw(dataKey, utf8(JSON.stringify(payload)), AAD.data);
    return Object.assign({}, envelope, { data });
  }

  async function rewrap(envelope, oldPassword, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw fail('weak_password', '加密密码至少 8 位');
    }
    const dataKeyRaw = await unwrapPassword(envelope, oldPassword);
    const salt = randomBytes(16);
    const kek = await deriveKek(newPassword, salt, ITERATIONS);
    const wrappedKey = await encryptRaw(kek, dataKeyRaw, AAD.wrap);
    return Object.assign({}, envelope, {
      kdf: KDF,
      iterations: ITERATIONS,
      salt: toBase64(salt),
      wrappedKey,
    });
  }

  // 重新生成恢复码：只替换 envelope.recovery.wrappedKey，salt/wrappedKey/
  // check/data 保持不变，因此 Device Vault 和已加密数据都不受影响。
  // options.useRecovery 为 true 时第一个参数传旧恢复码而不是密码。
  async function rewrapRecovery(envelope, password, options = {}) {
    assertEnvelope(envelope);
    const dataKeyRaw = options.useRecovery
      ? await unwrapRecovery(envelope, password)
      : await unwrapPassword(envelope, password);
    const recoveryCode = generateRecoveryCode();
    const recoveryKey = await deriveRecoveryKey(recoveryCode);
    const wrappedKey = await encryptRaw(recoveryKey, dataKeyRaw, AAD.recovery);
    return {
      recoveryCode,
      envelope: Object.assign({}, envelope, { recovery: { wrappedKey } }),
    };
  }

  async function rewrapWithRecovery(envelope, code, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw fail('weak_password', '加密密码至少 8 位');
    }
    const dataKeyRaw = await unwrapRecovery(envelope, code);
    const salt = randomBytes(16);
    const kek = await deriveKek(newPassword, salt, ITERATIONS);
    const wrappedKey = await encryptRaw(kek, dataKeyRaw, AAD.wrap);
    return Object.assign({}, envelope, {
      kdf: KDF,
      iterations: ITERATIONS,
      salt: toBase64(salt),
      wrappedKey,
    });
  }

  /* ------------------------------------------------------------------ *
   * v4：用途子密钥（HKDF）与 secret / privacy envelope
   * ------------------------------------------------------------------ */

  const SECRET_VERSION = 4;
  const SECRET_KINDS = ['ai', 'memo', 'privacy'];
  const SECRET_CIPHER = 'aes-256-gcm';

  function isSecret(payload) {
    return Boolean(payload && Number(payload.version) === SECRET_VERSION && payload.encrypted === true);
  }

  function assertSecretKind(kind) {
    if (!SECRET_KINDS.includes(kind)) throw fail('invalid_kind', '未知的 secret 类型');
  }

  function secretAAD(kind, part) {
    return `qingdh:v4:${kind}:${part}`;
  }

  // 用主 dataKey 派生用途子密钥，避免 memo 密文被当成 ai 配置解开。
  async function deriveSecretKey(dataKeyRaw, kind) {
    assertSecretKind(kind);
    const material = await subtle().importKey('raw', dataKeyRaw, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: utf8(`qingdh:v4:${kind}:key`),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function sealSecret(kind, dataKeyRaw, value) {
    assertSecretKind(kind);
    const key = await deriveSecretKey(dataKeyRaw, kind);
    const data = await encryptRaw(key, utf8(JSON.stringify(value)), secretAAD(kind, 'data'));
    return {
      version: SECRET_VERSION,
      kind,
      encrypted: true,
      keySource: 'data-key',
      cipher: SECRET_CIPHER,
      data,
    };
  }

  async function openSecret(envelope, kind, dataKeyRaw) {
    assertSecretKind(kind);
    if (!isSecret(envelope)) throw fail('invalid_envelope', '加密数据结构不完整');
    if (envelope.kind !== kind) throw fail('secret_kind_mismatch', '密文用途不匹配');
    if (envelope.keySource !== 'data-key') throw fail('invalid_envelope', '密文密钥来源不匹配');
    if (envelope.cipher !== SECRET_CIPHER) throw fail('invalid_envelope', '不支持的加密算法');
    if (!envelope.data) throw fail('invalid_envelope', '加密数据结构不完整');

    const key = await deriveSecretKey(dataKeyRaw, kind);
    const plaintext = await decryptRaw(key, envelope.data, secretAAD(kind, 'data'));
    try {
      return JSON.parse(fromUtf8(plaintext));
    } catch (error) {
      throw fail('invalid_secret', '解密后的内容不是有效 JSON');
    }
  }

  /* 隐私空间：独立密码 + 独立 dataKey，不与主 dataKey 混用。 */

  function assertPrivacyEnvelope(envelope) {
    if (
      !isSecret(envelope) ||
      envelope.kind !== 'privacy' ||
      envelope.keySource !== 'password' ||
      envelope.kdf !== KDF ||
      !envelope.salt ||
      !envelope.wrappedKey ||
      !envelope.check ||
      !envelope.data ||
      !envelope.recovery ||
      !envelope.recovery.wrappedKey
    ) {
      throw fail('invalid_envelope', '隐私空间数据结构不完整');
    }
  }

  async function setupPrivacy(password, payload) {
    if (typeof password !== 'string' || password.length < 8) {
      throw fail('weak_password', '隐私密码至少 8 位');
    }
    const dataKeyRaw = randomBytes(32);
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, ITERATIONS);
    const dataKey = await importDataKey(dataKeyRaw);

    const wrappedKey = await encryptRaw(kek, dataKeyRaw, secretAAD('privacy', 'wrap'));
    const check = await encryptRaw(dataKey, utf8(CHECK_TEXT), secretAAD('privacy', 'check'));
    const data = await encryptRaw(dataKey, utf8(JSON.stringify(payload)), secretAAD('privacy', 'data'));

    const recoveryCode = generateRecoveryCode();
    const recoveryKey = await deriveRecoveryKey(recoveryCode);
    const recoveryWrapped = await encryptRaw(recoveryKey, dataKeyRaw, secretAAD('privacy', 'recovery'));

    return {
      recoveryCode,
      dataKeyRaw,
      envelope: {
        version: SECRET_VERSION,
        kind: 'privacy',
        encrypted: true,
        keySource: 'password',
        cipher: SECRET_CIPHER,
        kdf: KDF,
        iterations: ITERATIONS,
        salt: toBase64(salt),
        wrappedKey,
        check,
        data,
        recovery: { wrappedKey: recoveryWrapped },
      },
    };
  }

  async function verifyPrivacyCheck(envelope, dataKey) {
    const bytes = await decryptRaw(dataKey, envelope.check, secretAAD('privacy', 'check'));
    if (fromUtf8(bytes) !== CHECK_TEXT) {
      throw fail('unlock_failed', '密码不正确或数据已损坏');
    }
  }

  async function decryptPrivacyPayload(envelope, dataKeyRaw) {
    const dataKey = await importDataKey(dataKeyRaw);
    const plaintext = await decryptRaw(dataKey, envelope.data, secretAAD('privacy', 'data'));
    try {
      return JSON.parse(fromUtf8(plaintext));
    } catch (error) {
      throw fail('invalid_secret', '解密后的内容不是有效 JSON');
    }
  }

  async function unlockPrivacy(envelope, password) {
    assertPrivacyEnvelope(envelope);
    const salt = fromBase64(envelope.salt);
    const kek = await deriveKek(password, salt, envelope.iterations || ITERATIONS);
    const dataKeyRaw = await decryptRaw(kek, envelope.wrappedKey, secretAAD('privacy', 'wrap'));
    await verifyPrivacyCheck(envelope, await importDataKey(dataKeyRaw));
    return { dataKeyRaw, payload: await decryptPrivacyPayload(envelope, dataKeyRaw) };
  }

  async function unlockPrivacyWithRecovery(envelope, code) {
    assertPrivacyEnvelope(envelope);
    const recoveryKey = await deriveRecoveryKey(code);
    const dataKeyRaw = await decryptRaw(recoveryKey, envelope.recovery.wrappedKey, secretAAD('privacy', 'recovery'));
    await verifyPrivacyCheck(envelope, await importDataKey(dataKeyRaw));
    return { dataKeyRaw, payload: await decryptPrivacyPayload(envelope, dataKeyRaw) };
  }

  async function openPrivacyWithKey(envelope, dataKeyRaw) {
    assertPrivacyEnvelope(envelope);
    await verifyPrivacyCheck(envelope, await importDataKey(dataKeyRaw));
    return decryptPrivacyPayload(envelope, dataKeyRaw);
  }

  async function rewrapPrivacyWithRecovery(envelope, code, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw fail('weak_password', '隐私密码至少 8 位');
    }
    assertPrivacyEnvelope(envelope);
    const recoveryKey = await deriveRecoveryKey(code);
    const dataKeyRaw = await decryptRaw(recoveryKey, envelope.recovery.wrappedKey, secretAAD('privacy', 'recovery'));
    const salt = randomBytes(16);
    const kek = await deriveKek(newPassword, salt, ITERATIONS);
    const wrappedKey = await encryptRaw(kek, dataKeyRaw, secretAAD('privacy', 'wrap'));
    return Object.assign({}, envelope, {
      iterations: ITERATIONS,
      salt: toBase64(salt),
      wrappedKey,
    });
  }

  async function sealPrivacy(envelope, dataKeyRaw, payload) {
    assertPrivacyEnvelope(envelope);
    const dataKey = await importDataKey(dataKeyRaw);
    const data = await encryptRaw(dataKey, utf8(JSON.stringify(payload)), secretAAD('privacy', 'data'));
    return Object.assign({}, envelope, { data });
  }

  async function rewrapPrivacy(envelope, oldPassword, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw fail('weak_password', '隐私密码至少 8 位');
    }
    assertPrivacyEnvelope(envelope);
    const salt = fromBase64(envelope.salt);
    const kek = await deriveKek(oldPassword, salt, envelope.iterations || ITERATIONS);
    const dataKeyRaw = await decryptRaw(kek, envelope.wrappedKey, secretAAD('privacy', 'wrap'));
    const newSalt = randomBytes(16);
    const newKek = await deriveKek(newPassword, newSalt, ITERATIONS);
    const wrappedKey = await encryptRaw(newKek, dataKeyRaw, secretAAD('privacy', 'wrap'));
    return Object.assign({}, envelope, {
      iterations: ITERATIONS,
      salt: toBase64(newSalt),
      wrappedKey,
    });
  }

  // envelope 指纹：密码重包裹不变，dataKey 重建后失效，用于检测 Device Vault 是否过期。
  async function envelopeId(envelope) {
    const check = (envelope && envelope.check) || '';
    const digest = await subtle().digest('SHA-256', utf8(`qingdh:envelope:${check}`));
    return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  globalThis.QingdhCrypto = {
    VERSION,
    SECRET_VERSION,
    SECRET_KINDS,
    KDF,
    ITERATIONS,
    isEncrypted,
    isSecret,
    setup,
    unlock,
    unlockWithKey,
    unlockWithRecovery,
    seal,
    rewrap,
    rewrapWithRecovery,
    rewrapRecovery,
    sealSecret,
    openSecret,
    setupPrivacy,
    unlockPrivacy,
    unlockPrivacyWithRecovery,
    openPrivacyWithKey,
    sealPrivacy,
    rewrapPrivacy,
    rewrapPrivacyWithRecovery,
    envelopeId,
    generateRecoveryCode,
    normalizeRecoveryCode,
    formatRecoveryCode,
    toBase64,
    fromBase64,
  };
})();
