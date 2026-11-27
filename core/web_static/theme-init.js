/* 首屏同步初始化主题/语言/左栏状态，防切页闪烁（兼容严格 CSP） */
(function () {
  "use strict";
  var T = {
    "ethereal-scifi": 1, "minimalist-light": 0, "arctic-frost": 0, "warm-paper": 0,
    "slate-daylight": 0, "bento-grid": 0, "editorial": 0, "precision-dark": 1,
    "ocean-slate": 1, "nord-dark": 1, "industrial-amber": 1, "glassmorphism": 1,
    "sci-fi-cyan": 1, "sci-fi-purple": 1, "sci-fi-matrix": 1
  };
  var L = { "sci-fi": "ethereal-scifi", "neo-brutalism": "minimalist-light" };
  var has = Object.prototype.hasOwnProperty;
  try {
    var d = document.documentElement, ds = d.dataset, ls = localStorage;
    var s = ls.getItem("scada_ui_theme");
    var t = s ? (has.call(T, s) ? s : (has.call(L, s) ? L[s] : "ethereal-scifi")) : "ethereal-scifi";
    ds.theme = t;
    ds.colorScheme = T[t] ? "dark" : "light";
    var g = ls.getItem("scada_ui_lang");
    if (g === "zh-CN" || g === "en-US" || g === "ru-RU") d.lang = g;
    var m = ls.getItem("scada_sidebar_mode");
    ds.sidebarMode = m === "dock" ? "dock" : "float";
    ds.sidebarHidden = (m === "dock" && ls.getItem("scada_sidebar_hidden") === "1") ? "1" : "0";
  } catch (_) {}
})();
