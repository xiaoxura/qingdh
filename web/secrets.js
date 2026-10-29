/* ==========================================================================
 * 氢导航 · 加密 secret 同步
 *
 * 统一处理 /api/v1/secrets/{kind}：读取、解密、加密上传、revision 冲突。
 * 只缓存解密后的内容在内存里，不写入 localStorage；退出登录或锁定后清空。
 * ========================================================================== */

(() => {
  'use strict';

  const KINDS = ['ai', 'memo', 'privacy'];
  const cache = new Map();
  // 每个 kind 独立代次；退出/换账号时全部递增，锁定单个功能时只递增该 kind。
  const epochs = new Map(KINDS.map((kind) => [kind, 0]));

  function currentEpoch(kind) {
    return epochs.get(kind) || 0;
  }

  const deps = {
    api: async () => ({ ok: false, status: 0, data: null, networkError: true }),
    getDataKey: () => null,
    onAuthLost: () => {},
    onChange: () => {},
  };

  function configure(next) {
    if (!next) return;
    if (typeof next.api === 'function') deps.api = next.api;
    if (typeof next.getDataKey === 'function') deps.getDataKey = next.getDataKey;
    if (typeof next.onAuthLost === 'function') deps.onAuthLost = next.onAuthLost;
    if (typeof next.onChange === 'function') deps.onChange = next.onChange;
  }

  function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function assertKind(kind) {
    if (!KINDS.includes(kind)) throw fail('invalid_kind', '未知的 secret 类型');
  }

  function emptyFor(kind) {
    if (kind === 'memo') return { version: 1, memos: [] };
    if (kind === 'ai') return { version: 1, defaultProvider: '', providers: [] };
    return { version: 1 };
  }

  function getCached(kind) {
    return cache.get(kind) || null;
  }

  function revisionOf(kind) {
    const entry = cache.get(kind);
    return entry ? entry.revision : 0;
  }

  function forget(kind) {
    if (kind) {
      cache.delete(kind);
      epochs.set(kind, currentEpoch(kind) + 1);
      return;
    }
    cache.clear();
    for (const item of KINDS) epochs.set(item, currentEpoch(item) + 1);
  }

  async function load(kind, { force = false } = {}) {
    assertKind(kind);
    const requestEpoch = currentEpoch(kind);
    const existing = cache.get(kind);
    if (existing && !force) return existing.plain;

    const response = await deps.api(`/api/v1/secrets/${kind}`);
    if (requestEpoch !== currentEpoch(kind)) throw fail('stale', '账号已切换');
    if (response.status === 401) {
      deps.onAuthLost();
      throw fail('auth', '登录已过期');
    }
    if (!response.ok) {
      throw fail(response.networkError ? 'offline' : 'load_failed', '无法读取加密配置');
    }

    const body = response.data || {};
    const revision = Number(body.revision) || 0;
    const payload = body.payload || null;

    if (!payload) {
      const entry = { revision, envelope: null, plain: emptyFor(kind), updatedAt: body.updatedAt || null };
      cache.set(kind, entry);
      deps.onChange(kind, entry.plain);
      return entry.plain;
    }

    if (!globalThis.QingdhCrypto || !globalThis.QingdhCrypto.isSecret(payload) || payload.kind !== kind) {
      throw fail('invalid_envelope', '云端返回了不匹配的密文');
    }
    const dataKey = deps.getDataKey();
    if (!dataKey) throw fail('locked', '需要先解锁云端数据');

    const plain = await globalThis.QingdhCrypto.openSecret(payload, kind, dataKey);
    if (requestEpoch !== currentEpoch(kind)) throw fail('stale', '账号已切换');
    const entry = { revision, envelope: payload, plain, updatedAt: body.updatedAt || null };
    cache.set(kind, entry);
    deps.onChange(kind, plain);
    return plain;
  }

  async function save(kind, plain, { baseRevision, keepalive = false } = {}) {
    assertKind(kind);
    const requestEpoch = currentEpoch(kind);
    const dataKey = deps.getDataKey();
    if (!dataKey) throw fail('locked', '需要先解锁云端数据');

    const envelope = await globalThis.QingdhCrypto.sealSecret(kind, dataKey, plain);
    const entry = cache.get(kind);
    const base = baseRevision != null ? baseRevision : entry ? entry.revision : 0;

    const response = await deps.api(`/api/v1/secrets/${kind}`, {
      method: 'PUT',
      body: { baseRevision: base, payload: envelope },
      keepalive,
    });

    if (requestEpoch !== currentEpoch(kind)) throw fail('stale', '账号已切换');
    if (response.status === 401) {
      deps.onAuthLost();
      throw fail('auth', '登录已过期');
    }
    if (response.status === 409) {
      cache.delete(kind);
      const error = fail('conflict', '云端配置已更新');
      error.current = (response.data && response.data.current) || null;
      throw error;
    }
    if (!response.ok) {
      throw fail(response.networkError ? 'offline' : 'save_failed', '保存加密配置失败');
    }

    if (requestEpoch !== currentEpoch(kind)) throw fail('stale', '账号已切换');
    const saved = {
      revision: response.data.revision,
      envelope,
      plain,
      updatedAt: response.data.updatedAt || null,
    };
    cache.set(kind, saved);
    deps.onChange(kind, plain);
    return saved;
  }

  globalThis.QingdhSecrets = {
    KINDS,
    configure,
    load,
    save,
    getCached,
    revisionOf,
    forget,
    fail,
  };
})();
