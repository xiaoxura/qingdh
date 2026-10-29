/* ==========================================================================
 * 氢导航 · 对话框等待队列
 *
 * 原生 <dialog> 只有一个打开状态，但调用方是 Promise。重复触发解锁、导入
 * 解密或 Passkey 时，必须先把上一次的 Promise 结算掉，否则旧调用会永久悬挂；
 * 同一个 dialog 也不能重复 showModal()（浏览器会抛 InvalidStateError）。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhDialog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // createModal 返回 { prompt, settle, isPending }：
  // - prompt(resolve, setup) 注册新的等待者；已有等待者先用 null 结算；
  // - settle(value) 结算当前等待者并关闭 dialog；
  // - isPending() 供 close 事件判断是否还有未结算的 Promise。
  function createModal(dialog) {
    let pending = null;

    function prompt(resolve, setup) {
      if (typeof resolve !== 'function') return;
      if (pending) {
        const previous = pending;
        pending = null;
        previous(null);
      }
      pending = resolve;
      if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal();
      }
      if (typeof setup === 'function') setup();
    }

    function settle(value) {
      const resolve = pending;
      pending = null;
      if (dialog && dialog.open && typeof dialog.close === 'function') dialog.close();
      if (resolve) resolve(value);
      return Boolean(resolve);
    }

    function isPending() {
      return pending !== null;
    }

    return { prompt, settle, isPending };
  }

  return { createModal };
});
