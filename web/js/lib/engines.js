/* ==========================================================================
 * 氢导航 · 内置搜索引擎注册表
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhEngines = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENGINES = [
    {
      id: 'bing',
      name: 'Bing',
      bang: 'b',
      build: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    },
    {
      id: 'google',
      name: 'Google',
      bang: 'g',
      build: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    },
    {
      id: 'baidu',
      name: '百度',
      bang: 'bd',
      build: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    },
    {
      id: 'duckduckgo',
      name: 'DuckDuckGo',
      bang: 'd',
      build: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    },
    {
      id: 'metaso',
      name: '秘塔',
      bang: 'mt',
      build: (query) => `https://metaso.cn/?q=${encodeURIComponent(query)}`,
    },
  ];

  function engineBuild(engine) {
    if (engine.template) {
      return (query) => engine.template.replaceAll('{query}', encodeURIComponent(query));
    }
    return engine.build;
  }

  function engineHost(engine) {
    try {
      return new URL(engineBuild(engine)('q')).hostname.replace(/^www\./, '');
    } catch (error) {
      return '';
    }
  }

  return { ENGINES, engineBuild, engineHost };
});
