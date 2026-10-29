/* ==========================================================================
 * 氢导航 · Service Worker 导航缓存策略
 *
 * 只有真正的 app shell 入口才允许把导航响应写成 /index.html。访问不存在的
 * 路径（404）、管理后台或邮件确认页时，不能覆盖离线 shell，否则下一次离线
 * 打开会看到错误页。单独成文件是为了能在 node:test 里直接测试。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhSWPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHELL_NAVIGATION_PATHS = ['/', '/index.html', '/ai', '/ai/'];

  function isShellNavigation(pathname) {
    return SHELL_NAVIGATION_PATHS.includes(String(pathname || ''));
  }

  return { SHELL_NAVIGATION_PATHS, isShellNavigation };
});
