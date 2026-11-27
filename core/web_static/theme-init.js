/* 首屏同步主题初始化脚本（<1KB，兼容严格 CSP）：在 HTML 渲染前设置 data-theme，消除暗黑/科幻主题切页白闪。 */
(function () {
  "use strict";
  var THEMES = {
    "minimalist-light": 0,
    "arctic-frost": 0,
    "warm-paper": 0,
    "slate-daylight": 0,
    "bento-grid": 0,
    "editorial": 0,
    "precision-dark": 1,
    "ocean-slate": 1,
    "nord-dark": 1,
    "industrial-amber": 1,
    "glassmorphism": 1,
    "sci-fi-cyan": 1,
    "sci-fi-purple": 1,
    "sci-fi-matrix": 1
  };
  var LEGACY = { "sci-fi": "sci-fi-cyan", "neo-brutalism": "minimalist-light" };
  try {
    var saved = localStorage.getItem("scada_ui_theme");
    if (saved) {
      var theme = Object.prototype.hasOwnProperty.call(THEMES, saved)
        ? saved
        : (Object.prototype.hasOwnProperty.call(LEGACY, saved) ? LEGACY[saved] : "minimalist-light");
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.colorScheme = THEMES[theme] ? "dark" : "light";
    }
    var lang = localStorage.getItem("scada_ui_lang");
    if (lang === "zh-CN" || lang === "en-US" || lang === "ru-RU") {
      document.documentElement.lang = lang;
    }
  } catch (_) {
    // 隐私模式忽略
  }
})();
