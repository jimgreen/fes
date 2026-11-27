/* SCADA 全站多语言（zh-CN / en-US / ru-RU）与 14 套主题轻量核心引擎。
 * 扩展三语词典已拆分至 ui-i18n-dict.js，默认简体中文零词典下载、不挂 MutationObserver；
 * 仅在切换至 en-US / ru-RU 时按需动态加载词典并启动增量 DOM 翻译。
 */
(() => {
  "use strict";

  const THEME_KEY = "scada_ui_theme";
  const LANG_KEY = "scada_ui_lang";
  const THEME_GROUPS = [
    {
      key: "light",
      themes: ["minimalist-light", "arctic-frost", "warm-paper", "slate-daylight", "bento-grid", "editorial"],
    },
    {
      key: "dark",
      themes: ["precision-dark", "ocean-slate", "nord-dark", "industrial-amber", "glassmorphism"],
    },
    {
      key: "scifi",
      themes: ["sci-fi-cyan", "sci-fi-purple", "sci-fi-matrix"],
    },
  ];
  const THEMES = THEME_GROUPS.flatMap(g => g.themes);
  const LEGACY_THEME_MAP = {
    "sci-fi": "sci-fi-cyan",
    "neo-brutalism": "minimalist-light",
  };
  const DARK_THEMES = new Set([
    "precision-dark",
    "ocean-slate",
    "nord-dark",
    "industrial-amber",
    "glassmorphism",
    "sci-fi-cyan",
    "sci-fi-purple",
    "sci-fi-matrix",
  ]);
  const LANGS = ["zh-CN", "en-US", "ru-RU"];
  const TRANSLATED_ATTRS = ["placeholder", "title", "aria-label"];

  const I18N_DICT = {
    "zh-CN": {
      "ui.theme.label": "界面风格",
      "ui.theme.group.light": "明亮办公",
      "ui.theme.group.dark": "暗黑工程",
      "ui.theme.group.scifi": "霓虹科幻",
      "ui.theme.minimalist-light": "极简明亮",
      "ui.theme.arctic-frost": "极地冰蓝",
      "ui.theme.warm-paper": "护眼暖纸",
      "ui.theme.slate-daylight": "冷灰工程",
      "ui.theme.bento-grid": "便当盒网格",
      "ui.theme.editorial": "编辑杂志",
      "ui.theme.precision-dark": "精密暗黑",
      "ui.theme.ocean-slate": "深海工业蓝",
      "ui.theme.nord-dark": "北欧极夜",
      "ui.theme.industrial-amber": "碳黑琥珀",
      "ui.theme.glassmorphism": "毛玻璃拟态",
      "ui.theme.sci-fi-cyan": "科幻 · 电光青",
      "ui.theme.sci-fi-purple": "科幻 · 赛博紫",
      "ui.theme.sci-fi-matrix": "科幻 · 矩阵绿",
      "ui.lang.label": "界面语言",
    },
    "en-US": {
      "ui.theme.label": "UI Theme",
      "ui.theme.group.light": "Light Office",
      "ui.theme.group.dark": "Dark Engineering",
      "ui.theme.group.scifi": "Neon Sci-Fi",
      "ui.theme.minimalist-light": "Minimalist Light",
      "ui.theme.arctic-frost": "Arctic Frost",
      "ui.theme.warm-paper": "Warm Paper",
      "ui.theme.slate-daylight": "Slate Daylight",
      "ui.theme.bento-grid": "Bento Grid",
      "ui.theme.editorial": "Editorial",
      "ui.theme.precision-dark": "Precision Dark",
      "ui.theme.ocean-slate": "Ocean Slate",
      "ui.theme.nord-dark": "Nord Dark",
      "ui.theme.industrial-amber": "Industrial Amber",
      "ui.theme.glassmorphism": "Glassmorphism",
      "ui.theme.sci-fi-cyan": "Sci-Fi · Cyan",
      "ui.theme.sci-fi-purple": "Sci-Fi · Cyber Purple",
      "ui.theme.sci-fi-matrix": "Sci-Fi · Matrix Green",
      "ui.lang.label": "Language",
    },
    "ru-RU": {
      "ui.theme.label": "Стиль интерфейса",
      "ui.theme.group.light": "Светлые",
      "ui.theme.group.dark": "Тёмные инженерные",
      "ui.theme.group.scifi": "Неон Sci-Fi",
      "ui.theme.minimalist-light": "Светлый минимализм",
      "ui.theme.arctic-frost": "Арктический лёд",
      "ui.theme.warm-paper": "Тёплая бумага",
      "ui.theme.slate-daylight": "Инженерный серый",
      "ui.theme.bento-grid": "Сетка Бенто",
      "ui.theme.editorial": "Журнальный",
      "ui.theme.precision-dark": "Тёмный приборный",
      "ui.theme.ocean-slate": "Глубокий океан",
      "ui.theme.nord-dark": "Полярная ночь",
      "ui.theme.industrial-amber": "Графит и янтарь",
      "ui.theme.glassmorphism": "Стекломорфизм",
      "ui.theme.sci-fi-cyan": "Sci-Fi · Циан",
      "ui.theme.sci-fi-purple": "Sci-Fi · Кибер-пурпур",
      "ui.theme.sci-fi-matrix": "Sci-Fi · Матрица",
      "ui.lang.label": "Язык интерфейса",
    },
  };

  const PATTERN_RULES = [];
  let dictLoaded = false;
  let dictPromise = null;
  let domObserver = null;

  let currentTheme = "minimalist-light";
  let currentLang = "zh-CN";
  let isTranslating = false;
  const originalTexts = new WeakMap();
  const originalAttrs = new WeakMap();
  let originalDocTitle = null;

  function normalizeTheme(theme) {
    if (THEMES.includes(theme)) return theme;
    if (theme && Object.prototype.hasOwnProperty.call(LEGACY_THEME_MAP, theme)) {
      return LEGACY_THEME_MAP[theme];
    }
    return "minimalist-light";
  }

  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) currentTheme = normalizeTheme(savedTheme);
    const savedLang = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(savedLang)) currentLang = savedLang;
  } catch (_) {
    // 隐私模式忽略
  }

  function registerDict(fn) {
    if (dictLoaded || typeof fn !== "function") return;
    fn(I18N_DICT, PATTERN_RULES);
    dictLoaded = true;
  }
  window.__scadaRegisterI18nDict = registerDict;
  if (typeof window.__scadaPendingI18nDict === "function") {
    registerDict(window.__scadaPendingI18nDict);
    delete window.__scadaPendingI18nDict;
  }

  function ensureDictLoaded() {
    if (dictLoaded) return Promise.resolve(true);
    if (dictPromise) return dictPromise;
    if (typeof document === "undefined" || !document.head) return Promise.resolve(false);
    dictPromise = new Promise(resolve => {
      const script = document.createElement("script");
      script.src = "/static/ui-i18n-dict.js";
      script.async = true;
      script.onload = () => resolve(dictLoaded);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    return dictPromise;
  }

  function t(key, fallback) {
    const table = I18N_DICT[currentLang] || I18N_DICT["zh-CN"];
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    if (Object.prototype.hasOwnProperty.call(I18N_DICT["zh-CN"], key)) return I18N_DICT["zh-CN"][key];
    return fallback !== undefined ? fallback : key;
  }

  function translateString(raw) {
    if (typeof raw !== "string") return raw;
    const trimmed = raw.trim();
    if (!trimmed || currentLang === "zh-CN") return raw;
    const table = I18N_DICT[currentLang];
    if (!table) return raw;
    let translated = null;
    if (Object.prototype.hasOwnProperty.call(table, trimmed)) {
      translated = table[trimmed];
    } else if (/[\u4e00-\u9fff]/.test(trimmed)) {
      for (const [regex, builders] of PATTERN_RULES) {
        const match = trimmed.match(regex);
        if (match && builders[currentLang]) {
          translated = builders[currentLang](...match);
          break;
        }
      }
    }
    if (translated === null || translated === trimmed) return raw;
    const idx = raw.indexOf(trimmed);
    return raw.slice(0, idx) + translated + raw.slice(idx + trimmed.length);
  }

  function isTranslatableString(trimmed) {
    if (!trimmed) return false;
    if (Object.prototype.hasOwnProperty.call(I18N_DICT["en-US"], trimmed)) return true;
    if (/[\u4e00-\u9fff]/.test(trimmed)) {
      for (const [regex] of PATTERN_RULES) {
        if (regex.test(trimmed)) return true;
      }
    }
    return false;
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent || parent.closest("script, style, code, pre, .lb-content, .log-content, #status-json, #schema-json, #ui-lang-select, #ui-theme-select")) {
      return;
    }
    const raw = node.nodeValue || "";
    const trimmed = raw.trim();
    if (!trimmed) return;
    let entry = originalTexts.get(node);
    if (!entry || (entry.lastApplied !== undefined && raw !== entry.lastApplied)) {
      if (!isTranslatableString(trimmed)) return;
      entry = { raw, lastApplied: raw };
      originalTexts.set(node, entry);
    }
    const nextValue = currentLang === "zh-CN" ? entry.raw : translateString(entry.raw);
    entry.lastApplied = nextValue;
    if (node.nodeValue !== nextValue) node.nodeValue = nextValue;
    if (currentLang !== "zh-CN" && parent.matches(".nav b, button, th") && !parent.title) {
      parent.title = nextValue.trim();
    }
  }

  function translateElementAttrs(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.id === "ui-lang-select" || el.id === "ui-theme-select") return;
    let map = originalAttrs.get(el);
    for (const attr of TRANSLATED_ATTRS) {
      if (attr === "title" && el.hasAttribute("data-i18n-title")) continue;
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr) || "";
      const trimmed = val.trim();
      if (!trimmed) continue;
      let rec = map?.[attr];
      if (!rec || (rec.lastApplied !== undefined && val !== rec.lastApplied)) {
        if (!isTranslatableString(trimmed) || (rec && !/[\u4e00-\u9fff]/.test(trimmed))) continue;
        if (!map) {
          map = {};
          originalAttrs.set(el, map);
        }
        rec = { raw: val, lastApplied: val };
        map[attr] = rec;
      }
      const nextVal = currentLang === "zh-CN" ? rec.raw : translateString(rec.raw);
      rec.lastApplied = nextVal;
      if (val !== nextVal) el.setAttribute(attr, nextVal);
    }
  }

  function translateDocumentTitle() {
    if (typeof document === "undefined" || !document.title) return;
    if (originalDocTitle === null || (originalDocTitle.lastApplied !== document.title && isTranslatableString(document.title.trim()))) {
      originalDocTitle = { raw: document.title, lastApplied: document.title };
    }
    if (!originalDocTitle) return;
    const nextTitle = currentLang === "zh-CN" ? originalDocTitle.raw : translateString(originalDocTitle.raw);
    originalDocTitle.lastApplied = nextTitle;
    if (document.title !== nextTitle) document.title = nextTitle;
  }

  function translateRoot(root = document.body) {
    if (!root) return;
    isTranslating = true;
    try {
      if (root === document.body) translateDocumentTitle();
      if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root);
        return;
      }
      if (root.nodeType === Node.ELEMENT_NODE) {
        translateElementAttrs(root);
      }
      if (root.querySelectorAll) {
        root.querySelectorAll("[data-i18n]").forEach(el => {
          const key = el.getAttribute("data-i18n");
          if (key) el.textContent = t(key, el.textContent);
        });
        root.querySelectorAll("[data-i18n-title]").forEach(el => {
          const key = el.getAttribute("data-i18n-title");
          if (key) el.title = t(key, el.title);
        });
        root.querySelectorAll("[placeholder], [title], [aria-label]").forEach(translateElementAttrs);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) translateTextNode(node);
    } finally {
      isTranslating = false;
    }
  }

  function isDarkTheme(theme = currentTheme) {
    return DARK_THEMES.has(theme);
  }

  function updateControls() {
    const langSelect = document.getElementById("ui-lang-select");
    if (langSelect) {
      langSelect.value = currentLang;
      langSelect.setAttribute("aria-label", t("ui.lang.label"));
    }
    const themeSelect = document.getElementById("ui-theme-select");
    if (themeSelect) {
      themeSelect.setAttribute("aria-label", t("ui.theme.label"));
      themeSelect.title = t("ui.theme.label");
      Array.from(themeSelect.querySelectorAll("optgroup")).forEach(grp => {
        const key = grp.dataset.themeGroup;
        if (key) grp.label = t(`ui.theme.group.${key}`, grp.label);
      });
      Array.from(themeSelect.options).forEach(opt => {
        opt.textContent = t(`ui.theme.${opt.value}`, opt.value);
      });
      themeSelect.value = currentTheme;
    }
  }

  function ensureObserver() {
    if (domObserver || !document.body || typeof MutationObserver !== "function") return;
    domObserver = new MutationObserver(scheduleTranslate);
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATED_ATTRS,
    });
  }

  function stopObserver() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }

  function applyTheme(theme, persist = true) {
    theme = normalizeTheme(theme);
    currentTheme = theme;
    const scheme = isDarkTheme(theme) ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorScheme = scheme;
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* ignore */ }
    }
    updateControls();
    document.dispatchEvent(new CustomEvent("scada:theme-change", { detail: { theme, colorScheme: scheme } }));
  }

  function applyLang(lang, persist = true) {
    if (!LANGS.includes(lang)) lang = "zh-CN";
    currentLang = lang;
    document.documentElement.lang = lang;
    if (persist) {
      try { localStorage.setItem(LANG_KEY, lang); } catch (_) { /* ignore */ }
    }
    updateControls();
    if (lang === "zh-CN") {
      stopObserver();
      if (dictLoaded) translateRoot(document.body);
      document.dispatchEvent(new CustomEvent("scada:lang-change", { detail: { lang } }));
      return;
    }
    ensureDictLoaded().then(() => {
      if (currentLang !== lang) return;
      translateRoot(document.body);
      ensureObserver();
      updateControls();
      document.dispatchEvent(new CustomEvent("scada:lang-change", { detail: { lang } }));
    });
  }

  function mountGlobalControls() {
    if (document.getElementById("ui-global-controls")) return;
    let tools = document.querySelector(".header-tools");
    if (!tools) {
      const header = document.querySelector("body > header");
      if (!header) return;
      tools = document.createElement("div");
      tools.className = "header-tools standalone-header-tools";
      header.append(tools);
    }
    const box = document.createElement("div");
    box.id = "ui-global-controls";
    box.className = "ui-global-controls";

    const select = document.createElement("select");
    select.id = "ui-lang-select";
    select.className = "ui-lang-select";
    select.innerHTML =
      '<option value="zh-CN">中文</option>' +
      '<option value="en-US">English</option>' +
      '<option value="ru-RU">Русский</option>';
    select.value = currentLang;
    select.addEventListener("change", () => applyLang(select.value));

    const themeSelect = document.createElement("select");
    themeSelect.id = "ui-theme-select";
    themeSelect.className = "ui-theme-select";
    for (const group of THEME_GROUPS) {
      const optgroup = document.createElement("optgroup");
      optgroup.dataset.themeGroup = group.key;
      optgroup.label = t(`ui.theme.group.${group.key}`, group.key);
      for (const themeId of group.themes) {
        const opt = document.createElement("option");
        opt.value = themeId;
        opt.textContent = t(`ui.theme.${themeId}`, themeId);
        optgroup.append(opt);
      }
      themeSelect.append(optgroup);
    }
    themeSelect.value = currentTheme;
    themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));

    box.append(select, themeSelect);
    tools.append(box);
    updateControls();
  }

  // 全局快捷操作：/ 聚焦搜索框，搜索框内 Esc 清空并失焦，Alt+R 触发当前页刷新
  document.addEventListener("keydown", event => {
    const tag = event.target?.tagName;
    if (event.key === "Escape" && tag === "INPUT" && event.target.type === "search" && !document.querySelector("dialog[open]")) {
      if (event.target.value) {
        event.target.value = "";
        event.target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      event.target.blur();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "r" || event.key === "R")) {
      if (document.querySelector("dialog[open]")) return;
      const refreshIds = ["#refresh", "#points-refresh", "#test-refresh", "#scdfe-refresh", "#process-refresh", "#logs-refresh", "#lb-refresh", "#pt-refresh", "#dash-refresh"];
      for (const sel of refreshIds) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null && !btn.disabled && !btn.closest("[hidden]")) {
          event.preventDefault();
          btn.click();
          return;
        }
      }
      return;
    }
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return;
    if (document.querySelector("dialog[open]")) return;
    const candidates = document.querySelectorAll('input[type="search"], #point-search, #search, #lb-keyword, #log-search, #keyword, #pt-query');
    for (const input of candidates) {
      if (input.offsetParent !== null && !input.disabled && !input.closest("[hidden]")) {
        event.preventDefault();
        input.focus();
        input.select?.();
        return;
      }
    }
  });

  document.documentElement.dataset.theme = currentTheme;
  document.documentElement.dataset.colorScheme = isDarkTheme(currentTheme) ? "dark" : "light";
  document.documentElement.lang = currentLang;

  let pendingTranslate = false;
  const pendingTargets = new Set();
  function scheduleTranslate(records) {
    if (isTranslating || currentLang === "zh-CN" || !dictLoaded) return;
    if (Array.isArray(records) && records.length) {
      for (const rec of records) {
        if (rec.type === "childList") {
          for (const added of rec.addedNodes) pendingTargets.add(added);
          if (!rec.addedNodes.length && rec.target) pendingTargets.add(rec.target);
        } else if (rec.target) {
          pendingTargets.add(rec.target);
        }
      }
    } else if (document.body) {
      pendingTargets.add(document.body);
    }
    if (pendingTranslate || !pendingTargets.size) return;
    pendingTranslate = true;
    const run = () => {
      pendingTranslate = false;
      if (currentLang === "zh-CN" || !dictLoaded) { pendingTargets.clear(); return; }
      const nodes = Array.from(pendingTargets);
      pendingTargets.clear();
      if (nodes.length > 64 || nodes.includes(document.body)) {
        translateRoot(document.body);
        return;
      }
      const unique = nodes.filter(node => node.isConnected && !nodes.some(other => other !== node && other.contains && other.contains(node)));
      for (const node of unique) translateRoot(node);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function boot() {
    mountGlobalControls();
    applyTheme(currentTheme, false);
    if (currentLang !== "zh-CN") {
      ensureDictLoaded().then(() => {
        if (currentLang !== "zh-CN") {
          translateRoot(document.body);
          ensureObserver();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  /**
   * 全站共享模态确认框：用于高危/不可逆操作，默认聚焦安全“取消”按钮，确认按钮按危险程度视觉区分。
   */
  function scadaConfirm(message, options = {}) {
    const title = options.title || "请确认操作";
    const confirmText = options.confirmText || "确认";
    const cancelText = options.cancelText || "取消";
    const danger = options.danger !== false;
    if (typeof document === "undefined" || !document.body || typeof document.createElement !== "function") {
      return Promise.resolve(false);
    }
    let dialog = document.getElementById("scada-global-confirm");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "scada-global-confirm";
      dialog.className = "scada-confirm-dialog";
      dialog.innerHTML =
        '<form method="dialog" class="scada-confirm-form">' +
        '<h3 class="scada-confirm-title"></h3>' +
        '<p class="scada-confirm-body"></p>' +
        '<div class="scada-confirm-actions">' +
        '<button type="button" class="scada-confirm-cancel"></button>' +
        '<button type="submit" class="scada-confirm-ok"></button>' +
        "</div></form>";
      document.body.append(dialog);
    }
    if (typeof dialog.showModal !== "function") {
      return Promise.resolve(false);
    }
    const titleEl = dialog.querySelector(".scada-confirm-title");
    const bodyEl = dialog.querySelector(".scada-confirm-body");
    const cancelBtn = dialog.querySelector(".scada-confirm-cancel");
    const okBtn = dialog.querySelector(".scada-confirm-ok");
    const tr = text => (currentLang === "zh-CN" ? String(text) : translateString(String(text)));
    titleEl.textContent = tr(title);
    bodyEl.textContent = tr(message);
    cancelBtn.textContent = tr(cancelText);
    okBtn.textContent = tr(confirmText);
    okBtn.className = "scada-confirm-ok " + (danger ? "danger" : "primary");

    return new Promise(resolve => {
      let settled = false;
      const done = value => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        resolve(Boolean(value));
      };
      cancelBtn.onclick = () => done(false);
      dialog.oncancel = ev => {
        ev.preventDefault();
        done(false);
      };
      dialog.querySelector(".scada-confirm-form").onsubmit = ev => {
        ev.preventDefault();
        done(true);
      };
      dialog.showModal();
      cancelBtn.focus();
    });
  }

  window.scadaConfirm = scadaConfirm;
  window.scadaI18n = {
    t,
    translateText: translateString,
    translateRoot,
    confirm: scadaConfirm,
    themes: THEMES.slice(),
    themeGroups: THEME_GROUPS.map(g => ({ key: g.key, themes: g.themes.slice() })),
    langs: LANGS.slice(),
    isDarkTheme,
    ensureDictLoaded,
    getLang: () => currentLang,
    setLang: lang => applyLang(lang, true),
    getTheme: () => currentTheme,
    setTheme: theme => applyTheme(theme, true),
    dict: I18N_DICT,
  };
})();
