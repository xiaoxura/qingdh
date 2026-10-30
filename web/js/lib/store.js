/* ==========================================================================
 * 氢导航 · 本地存储边界
 *
 * 把 localStorage 的读写、异常降级和账号键名集中到一处，供 app.js 与
 * node:test 共用。存储不可用（隐私模式、配额满）时只上报一次，不阻塞页面。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createStorage(options) {
    const storage = (options && options.storage) || null;
    const onError = (options && options.onError) || function () {};

    function readJSON(key) {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    function writeJSON(key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    }

    function removeKey(key) {
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch (error) {
        // ignore
      }
    }

    function readFlag(key) {
      if (!storage) return false;
      try {
        return storage.getItem(key) === '1';
      } catch (error) {
        return false;
      }
    }

    function writeFlag(key, value) {
      if (!storage) return;
      try {
        if (value) storage.setItem(key, '1');
        else storage.removeItem(key);
      } catch (error) {
        // ignore
      }
    }

    return { readJSON, writeJSON, removeKey, readFlag, writeFlag };
  }

  return { createStorage };
});
