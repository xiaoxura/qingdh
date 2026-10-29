/* ==========================================================================
 * 在首屏绘制前决定明暗和季节风格，避免刷新时闪一下。
 * 独立成文件是为了满足 CSP script-src 'self'（不允许内联脚本）。
 * ========================================================================== */

(function () {
  'use strict';

  var SEASONS = ['default', 'spring', 'summer', 'autumn', 'winter'];

  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem('qingdh.prefs.v1'));
    } catch (error) {
      return null;
    }
  }

  try {
    var prefs = readPrefs();
    var theme = prefs && prefs.theme;

    if (theme !== 'light' && theme !== 'dark' && theme !== 'auto') {
      // 兼容旧版本：主题曾经存在导航数据里。
      try {
        var legacy = JSON.parse(localStorage.getItem('qingdh.data.v1'));
        theme = legacy && legacy.settings && legacy.settings.theme;
      } catch (error) {
        theme = null;
      }
    }
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    var season = prefs && prefs.season;
    if (SEASONS.indexOf(season) === -1) season = 'default';

    var sidebar = prefs && prefs.sidebar;
    if (['expanded', 'collapsed', 'hidden'].indexOf(sidebar) === -1) sidebar = 'expanded';
    if (window.matchMedia('(max-width: 860px)').matches) sidebar = 'expanded';

    var sidebarSide = prefs && prefs.sidebarSide;
    if (['left', 'right'].indexOf(sidebarSide) === -1) sidebarSide = 'left';

    var month = new Date().getMonth();
    var autoSeason =
      month >= 2 && month <= 4 ? 'spring' : month >= 5 && month <= 7 ? 'summer' : month >= 8 && month <= 10 ? 'autumn' : 'winter';

    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.season = season;
    document.documentElement.dataset.clockSeason = season === 'default' ? autoSeason : season;
    document.documentElement.dataset.sidebarSide = sidebarSide;
    document.documentElement.dataset.sidebar = sidebar;
    document.documentElement.dataset.clock = prefs && prefs.clockStyle === 'minimal' ? 'minimal' : 'editorial';
  } catch (error) {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
    document.documentElement.dataset.season = 'default';
    document.documentElement.dataset.clockSeason = 'winter';
    document.documentElement.dataset.sidebarSide = 'left';
    document.documentElement.dataset.sidebar = 'expanded';
    document.documentElement.dataset.clock = 'editorial';
  }
})();
