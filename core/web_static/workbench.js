(function () {
  "use strict";

  const FOCUS_KEY = "scada.focus.context.v1";

  // 统一高可读极简矢量图标（1.75px 线宽）
  const UI_ICONS = {
    connOk: '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.55a11 11 0 0 1 14.08 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>',
    connErr: '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.7"/><circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/></svg>',
    alertOk: '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 5-3.2 8.2-7 9-3.8-.8-7-4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    alertWarn: '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9L1.8 18.5A2 2 0 0 0 3.5 21.5h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/></svg>',
    search: '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/></svg>',
    c: '<svg class="ui-ico ui-ico-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.6"/><path d="M5.6 18.4a9 9 0 0 1 0-12.8m12.8 0a9 9 0 0 1 0 12.8M8.8 15.2a4.6 4.6 0 0 1 0-6.4m6.4 0a4.6 4.6 0 0 1 0 6.4"/></svg>',
    s: '<svg class="ui-ico ui-ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg>',
    t: '<svg class="ui-ico ui-ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h12m0 0-3-3m3 3-3 3M4 17h12m0 0-3-3m3 3-3 3M20 4v16"/></svg>',
    sbFloat: '<svg class="ui-ico ui-ico-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="10" height="16" rx="2"/><path d="M17 7h4M17 12h4M17 17h4"/></svg>',
    sbDock: '<svg class="ui-ico ui-ico-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
    sbHide: '<svg class="ui-ico ui-ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  };

  // ==================== 1. 健康探活 ====================
  async function refreshHealth() {
    const status = document.querySelector("#connection");
    if (!status) return;
    try {
      const response = await fetch("/api/health", { cache: "no-cache" });
      if (!response.ok) throw new Error("health");
      const result = await response.json();
      if (result.status !== "ok") throw new Error("health");
      status.innerHTML = UI_ICONS.connOk;
      status.title = "Web 服务在线";
      status.setAttribute("aria-label", "Web 服务在线");
      status.classList.add("ok");
      status.classList.remove("error", "bad");
    } catch (_) {
      status.innerHTML = UI_ICONS.connErr;
      status.title = "Web 服务连接异常";
      status.setAttribute("aria-label", "Web 服务连接异常");
      status.classList.remove("ok");
      status.classList.add("error");
    }
  }
  if (document.querySelector("#connection")) {
    refreshHealth();
    setInterval(() => { if (!document.hidden) refreshHealth(); }, 15000);
  }

  // ==================== 2. 跨页聚焦上下文（RTU / 通道） ====================
  function readFocus() {
    try {
      const raw = sessionStorage.getItem(FOCUS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeFocus(patch) {
    const next = { ...readFocus(), ...patch };
    if (next.rtu_id != null && next.rtu_id !== "") next.rtu_id = String(next.rtu_id);
    else delete next.rtu_id;
    if (next.channel_id != null && next.channel_id !== "") next.channel_id = String(next.channel_id);
    else delete next.channel_id;
    if (!next.rtu_id && !next.channel_id) delete next.label;
    try {
      if (Object.keys(next).length) sessionStorage.setItem(FOCUS_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(FOCUS_KEY);
    } catch (_) {
      // 隐私模式忽略
    }
    renderFocusChip();
    return next;
  }

  function clearFocus() {
    try { sessionStorage.removeItem(FOCUS_KEY); } catch (_) { /* ignore */ }
    renderFocusChip();
  }

  function syncFocusFromUrl() {
    const params = new URLSearchParams(location.search);
    const rtu = params.get("rtu_id") || params.get("log_rtu");
    const ch = params.get("channel_id") || params.get("log_channel");
    if (rtu && /^\d+$/.test(rtu)) writeFocus({ rtu_id: rtu });
    if (ch && /^\d+$/.test(ch)) writeFocus({ channel_id: ch });
  }

  function renderFocusChip() {
    const tools = document.querySelector(".header-tools");
    if (!tools) return;
    let chip = document.getElementById("ui-focus-chip");
    const ctx = readFocus();
    const parts = [];
    if (ctx.rtu_id) parts.push(`RTU ${ctx.rtu_id}`);
    if (ctx.channel_id && ctx.channel_id !== ctx.rtu_id) parts.push(`通道 ${ctx.channel_id}`);
    if (!parts.length) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("span");
      chip.id = "ui-focus-chip";
      chip.className = "ui-focus-chip";
      chip.title = "跨页保持当前聚焦对象，切到日志/SOE/连接/指令追踪自动带入筛选";
      const label = document.createElement("span");
      label.className = "ui-focus-chip-text";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "icon-button ui-focus-chip-clear";
      clearBtn.textContent = "×";
      clearBtn.setAttribute("aria-label", "清除聚焦上下文");
      clearBtn.title = "清除聚焦上下文";
      clearBtn.onclick = clearFocus;
      chip.append(label, clearBtn);
      tools.prepend(chip);
    }
    chip.querySelector(".ui-focus-chip-text").textContent = "聚焦 " + parts.join(" · ");
  }

  function bindFocusWatchers() {
    const watch = (selector, key) => {
      document.addEventListener("change", event => {
        const el = event.target;
        if (!el || !el.matches || !el.matches(selector)) return;
        const val = String(el.value || "").trim();
        if (/^\d+$/.test(val)) {
          writeFocus({ [key]: val });
        } else if (val === "") {
          writeFocus({ [key]: "" });
        }
      }, true);
    };
    watch("#rtu-select, #rtu-filter, #point-rtu, #rtu", "rtu_id");
    watch("#selected-channel, #parameter-channel-filter, #log-channel", "channel_id");

    // 侧边栏跨页跳转自动透传当前聚焦上下文
    document.addEventListener("click", event => {
      const link = event.target?.closest?.(".workbench-sidebar a.nav, .sidebar a.nav");
      if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      const ctx = readFocus();
      if (!ctx.rtu_id && !ctx.channel_id) return;
      let url;
      try {
        url = new URL(link.getAttribute("href"), location.href);
      } catch (_) {
        return;
      }
      if (url.origin !== location.origin) return;
      const p = url.pathname;
      const q = url.searchParams;
      let changed = false;
      if ((p === "/soe" || p === "/command-traces" || p === "/test" || p === "/points" || p === "/point-trace") && ctx.rtu_id && !q.has("rtu_id")) {
        q.set("rtu_id", ctx.rtu_id);
        changed = true;
      } else if ((p === "/logs" || p === "/logs.html" || p === "/connections" || p === "/points.html") && (ctx.channel_id || ctx.rtu_id) && !q.has("channel_id") && !q.has("rtu_id")) {
        if (ctx.channel_id) q.set("channel_id", ctx.channel_id);
        else if (p === "/connections" && ctx.rtu_id) q.set("rtu_id", ctx.rtu_id);
        changed = true;
      }
      if (changed) {
        event.preventDefault();
        location.href = url.toString();
      }
    });
  }

  // ==================== 3. 全局遥控/遥调下发实时进度浮条 ====================
  const STAGE_LABELS = {
    queued: "已入库待派发",
    dispatching: "派发中",
    select_sent: "已发选择",
    select_confirmed: "选择已确认",
    execute_sent: "已发执行",
    protocol_confirmed: "规约已确认",
    driver_completed: "驱动已完成",
    received: "仿真库已接收",
    failed: "失败/未确认",
  };
  const TERMINAL_STAGES = new Set(["protocol_confirmed", "driver_completed", "received", "failed"]);
  let trackerTimer = null;

  function ensureTrackerBox() {
    let box = document.getElementById("ui-command-tracker");
    if (!box) {
      box = document.createElement("aside");
      box.id = "ui-command-tracker";
      box.className = "ui-command-tracker";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      box.innerHTML =
        '<div class="ui-cmd-head"><strong class="ui-cmd-title">指令进度</strong><span class="ui-cmd-stage status">—</span><a class="ui-cmd-link" href="/command-traces">追踪 ↗</a><button type="button" class="icon-button ui-cmd-close" aria-label="关闭">×</button></div>' +
        '<div class="ui-cmd-meta"></div>';
      box.querySelector(".ui-cmd-close").onclick = () => {
        clearInterval(trackerTimer);
        trackerTimer = null;
        box.hidden = true;
      };
      document.body.append(box);
    }
    box.hidden = false;
    return box;
  }

  function scadaTrackCommand({ rtu_id, kind, pnt_no, value } = {}) {
    if (!rtu_id || !kind || pnt_no == null) return;
    clearInterval(trackerTimer);
    const box = ensureTrackerBox();
    const titleEl = box.querySelector(".ui-cmd-title");
    const stageEl = box.querySelector(".ui-cmd-stage");
    const metaEl = box.querySelector(".ui-cmd-meta");
    const linkEl = box.querySelector(".ui-cmd-link");
    const q = new URLSearchParams({ rtu_id: String(rtu_id), kind: String(kind), pnt_no: String(pnt_no) });
    linkEl.href = "/command-traces?" + q.toString();
    titleEl.textContent = `RTU ${rtu_id} · ${String(kind).toUpperCase()} ${pnt_no}`;
    stageEl.textContent = "已提交";
    stageEl.className = "ui-cmd-stage status";
    metaEl.textContent = value !== undefined ? `目标值 ${value} · 正在追踪执行阶段…` : "正在追踪执行阶段…";

    let ticks = 0;
    const poll = async () => {
      ticks += 1;
      try {
        const resp = await fetch("/api/command-traces?view=summary&" + q.toString(), { cache: "no-cache" });
        if (!resp.ok) return;
        const data = await resp.json().catch(() => ({}));
        const item = (data.items || [])[0];
        if (!item) return;
        const stageText = STAGE_LABELS[item.stage] || item.stage;
        stageEl.textContent = stageText;
        stageEl.className = "ui-cmd-stage status " + (
          item.stage === "failed" ? "s5" : (TERMINAL_STAGES.has(item.stage) ? "s2" : "s1")
        );
        const fb = item.feedback_label ? ` · 回采：${item.feedback_label}` : "";
        const err = item.has_error ? " · 有错误" : "";
        metaEl.textContent = `#${item.command_id} · 值 ${item.value ?? "—"}${fb}${err}`;
        const feedbackDone = !item.feedback_state || !["armed", "waiting"].includes(item.feedback_state);
        if ((TERMINAL_STAGES.has(item.stage) && feedbackDone) || ticks >= 25) {
          clearInterval(trackerTimer);
          trackerTimer = null;
        }
      } catch (_) {
        if (ticks >= 25) { clearInterval(trackerTimer); trackerTimer = null; }
      }
    };
    poll();
    trackerTimer = setInterval(() => { if (!document.hidden) poll(); }, 1000);
  }

  // ==================== 4. 三端顶栏快捷互跳（C | S | T）与运维权限状态 ====================
  function buildSiblingUrl(baseUrl) {
    const u = new URL(baseUrl);
    u.pathname = "/dashboard";
    return u.toString();
  }

  function renderAuthButton(auth) {
    const tools = document.querySelector(".header-tools");
    if (!tools || !auth || auth.mode === "open") return;
    let btn = document.getElementById("ui-auth-chip");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "ui-auth-chip";
      btn.type = "button";
      btn.className = "ui-auth-chip";
      tools.prepend(btn);
    }
    if (auth.readonly) {
      btn.textContent = "只读模式";
      btn.className = "ui-auth-chip is-readonly";
      btn.disabled = true;
      btn.title = "服务端已强制开启只读观察模式（SCADA_WEB_READONLY=1）";
      return;
    }
    btn.disabled = false;
    if (auth.unlocked) {
      btn.textContent = "运维已解锁";
      btn.className = "ui-auth-chip is-unlocked";
      btn.title = "点击锁定并切回只读观察模式";
      btn.onclick = async () => {
        await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
        location.reload();
      };
    } else {
      btn.textContent = "只读 · 解锁";
      btn.className = "ui-auth-chip is-locked";
      btn.title = "当前处于只读保护态，点击输入运维口令解锁写操作";
      btn.onclick = () => openAuthDialog();
    }
  }

  function openAuthDialog() {
    let dlg = document.getElementById("ui-auth-dialog");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "ui-auth-dialog";
      dlg.className = "ui-auth-dialog";
      dlg.innerHTML =
        '<form method="dialog" id="ui-auth-form">' +
        '<div class="ui-auth-head"><strong>解锁运维权限</strong><button type="button" id="ui-auth-close" aria-label="关闭">×</button></div>' +
        '<div class="ui-auth-body"><label>运维口令<input id="ui-auth-token" type="password" required autocomplete="current-password" placeholder="输入 SCADA_WEB_OPERATOR_TOKEN"></label>' +
        '<p id="ui-auth-err" class="ui-auth-err" role="alert"></p></div>' +
        '<div class="ui-auth-foot"><button type="button" id="ui-auth-cancel">取消</button><button type="submit" class="primary">确认解锁</button></div>' +
        '</form>';
      document.body.appendChild(dlg);
      dlg.querySelector("#ui-auth-close").onclick = () => dlg.close();
      dlg.querySelector("#ui-auth-cancel").onclick = () => dlg.close();
      dlg.querySelector("#ui-auth-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const errEl = dlg.querySelector("#ui-auth-err");
        const tokenEl = dlg.querySelector("#ui-auth-token");
        errEl.textContent = "";
        try {
          const resp = await fetch("/api/auth/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenEl.value }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.error?.message || "口令错误");
          dlg.close();
          renderAuthButton(data);
        } catch (err) {
          errEl.textContent = err.message || "解锁失败";
        }
      };
    }
    const errEl = dlg.querySelector("#ui-auth-err");
    const tokenEl = dlg.querySelector("#ui-auth-token");
    if (errEl) errEl.textContent = "";
    if (tokenEl) tokenEl.value = "";
    dlg.showModal();
    tokenEl?.focus();
  }

  async function initWorkbenchLinks() {
    const brand = document.querySelector(".workbench-brand, .topbar .brand");
    if (!brand || document.getElementById("ui-sibling-nav")) return;
    try {
      const resp = await fetch("/api/workbench-links", { cache: "no-cache" });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.auth) renderAuthButton(data.auth);
      const links = Array.isArray(data.links) ? data.links : [];
      if (!links.length) return;
      const nav = document.createElement("nav");
      nav.id = "ui-sibling-nav";
      nav.className = "ui-sibling-nav";
      nav.setAttribute("aria-label", "三端系统快捷切换");
      const onOwnDashboard = location.pathname === "/dashboard" || location.pathname === "/dashboard.html";
      const roleTitles = { c: "采集态势指挥屏 (scdfe_c)", s: "规约仿真实验台 (scdfe_s)", t: "四遥转发枢纽 (scdfe_t)" };
      links.forEach((item) => {
        const targetUrl = buildSiblingUrl(item.url, item.key);
        const a = document.createElement("a");
        a.className = "ui-sibling-link" + (item.active ? " is-active" : "");
        const ico = UI_ICONS[item.key] || "";
        const shortTag = String(item.key || "").toUpperCase();
        a.innerHTML = `${ico}<span>${shortTag}</span>`;
        a.title = roleTitles[item.key] || item.label;
        a.setAttribute("aria-label", roleTitles[item.key] || item.label);
        a.href = targetUrl;
        if (item.active) a.setAttribute("aria-current", "true");
        a.onclick = (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          if (item.active && onOwnDashboard) return;
          location.href = targetUrl;
        };
        nav.appendChild(a);
      });
      brand.insertAdjacentElement("afterend", nav);
    } catch (_) {
      // 忽略网络异常，不影响主界面
    }
  }

  // ==================== 5. 顶栏异常聚合徽标（⚠ N） ====================
  let alertPopoverOpen = false;
  let alertDataCache = null;

  function renderAlertChip(data) {
    const tools = document.querySelector(".header-tools");
    if (!tools || !data) return;
    alertDataCache = data;
    let wrap = document.getElementById("ui-alert-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "ui-alert-wrap";
      wrap.className = "ui-alert-wrap";
      wrap.innerHTML =
        '<button type="button" id="ui-alert-chip" class="ui-alert-chip" aria-haspopup="dialog" aria-expanded="false"></button>' +
        '<div id="ui-alert-popover" class="ui-alert-popover" hidden></div>';
      const siblingAnchor = document.getElementById("ui-focus-chip") || tools.firstChild;
      if (siblingAnchor) tools.insertBefore(wrap, siblingAnchor);
      else tools.prepend(wrap);

      const chipBtn = wrap.querySelector("#ui-alert-chip");
      const popover = wrap.querySelector("#ui-alert-popover");
      chipBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        alertPopoverOpen = !alertPopoverOpen;
        popover.hidden = !alertPopoverOpen;
        chipBtn.setAttribute("aria-expanded", String(alertPopoverOpen));
        if (alertPopoverOpen) renderAlertPopover(alertDataCache);
      });
      document.addEventListener("click", (ev) => {
        if (alertPopoverOpen && !wrap.contains(ev.target)) {
          alertPopoverOpen = false;
          popover.hidden = true;
          chipBtn.setAttribute("aria-expanded", "false");
        }
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && alertPopoverOpen) {
          alertPopoverOpen = false;
          popover.hidden = true;
          chipBtn.setAttribute("aria-expanded", "false");
        }
      });
    }
    const chipBtn = wrap.querySelector("#ui-alert-chip");
    const total = Number(data.total || 0);
    const hasErr = (data.counts?.thread_errors || 0) + (data.counts?.process_errors || 0) + (data.counts?.failed_commands || 0) > 0;
    chipBtn.className = "ui-alert-chip " + (total === 0 ? "is-ok" : (hasErr ? "is-err" : "is-warn"));
    chipBtn.innerHTML = total === 0
      ? UI_ICONS.alertOk
      : `${UI_ICONS.alertWarn}<span>${total}</span>`;
    chipBtn.title = total === 0
      ? "运行态正常，无异常告警"
      : `异常 ${total} · 线程 ${data.counts?.thread_errors || 0} · 进程 ${data.counts?.process_errors || 0} · 偏差 ${data.counts?.trace_diffs || 0} · 指令 ${data.counts?.failed_commands || 0}`;
    chipBtn.setAttribute("aria-label", chipBtn.title);
    if (alertPopoverOpen) renderAlertPopover(data);
  }

  function escHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderAlertPopover(data) {
    const popover = document.getElementById("ui-alert-popover");
    if (!popover || !data) return;
    const c = data.counts || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const summary =
      `<div class="ui-alert-pop-head">` +
      `<strong>异常汇总 (${Number(data.total || 0)})</strong>` +
      `<span class="ui-alert-counts">线程 ${c.thread_errors || 0} · 进程 ${c.process_errors || 0} · 偏差 ${c.trace_diffs || 0} · 指令 ${c.failed_commands || 0}</span>` +
      `</div>`;
    if (!items.length) {
      popover.innerHTML = summary + '<div class="ui-alert-empty">当前无通信、进程或对账异常</div>';
      return;
    }
    const listHtml = items.map((it, idx) =>
      `<button type="button" class="ui-alert-item is-${it.severity === "error" ? "err" : "warn"}" data-alert-idx="${idx}">` +
      `<span class="ui-alert-cat">${escHtml(it.category)}</span>` +
      `<span class="ui-alert-title">${escHtml(it.title)}</span>` +
      `<span class="ui-alert-detail">${escHtml(it.detail || "")}</span>` +
      `</button>`
    ).join("");
    popover.innerHTML = summary + `<div class="ui-alert-list">${listHtml}</div>`;
    popover.querySelectorAll("[data-alert-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        const it = items[Number(btn.dataset.alertIdx)];
        if (!it) return;
        const patch = {};
        if (it.rtu_id != null) patch.rtu_id = String(it.rtu_id);
        if (it.channel_id != null) patch.channel_id = String(it.channel_id);
        if (Object.keys(patch).length) writeFocus(patch);
        alertPopoverOpen = false;
        popover.hidden = true;
        if (it.href) location.href = it.href;
      });
    });
  }

  async function refreshAlerts() {
    try {
      const resp = await fetch("/api/alerts-summary", { cache: "no-cache" });
      if (!resp.ok) return;
      const data = await resp.json();
      renderAlertChip(data);
    } catch (_) {
      // 忽略异常
    }
  }

  // ==================== 6. 全局 Ctrl+K 命令面板 ====================
  let cmdkEntries = [];
  let cmdkIndex = 0;
  let cmdkFetchTimer = null;
  let cmdkAbort = null;

  function collectPageCommands() {
    const results = [];
    const seen = new Set();
    document.querySelectorAll(".workbench-sidebar a.nav, .sidebar a.nav, .sidebar button.nav").forEach(el => {
      const label = (el.querySelector("b")?.textContent || el.textContent || "").trim();
      if (!label || seen.has(label)) return;
      seen.add(label);
      const href = el.tagName === "A" ? el.getAttribute("href") : "";
      const res = el.dataset?.resource || el.dataset?.tabResource || "";
      results.push({
        group: "页面",
        title: label,
        sub: href || (res ? `#${res}` : "当前工作台"),
        keywords: `${label} ${href} ${res}`.toLowerCase(),
        run: () => {
          if (href) location.href = href;
          else el.click();
        },
      });
    });
    const i18n = window.scadaI18n;
    if (i18n && Array.isArray(i18n.themes)) {
      i18n.themes.forEach(themeId => {
        const name = i18n.t(`ui.theme.${themeId}`, themeId);
        results.push({
          group: "主题",
          title: `切换风格 · ${name}`,
          sub: themeId,
          keywords: `theme 主题 风格 ${name} ${themeId}`.toLowerCase(),
          run: () => i18n.setTheme(themeId),
        });
      });
    }
    results.push(
      {
        group: "动作",
        title: "刷新当前页面数据",
        sub: "Alt+R",
        keywords: "refresh 刷新 reload".toLowerCase(),
        run: () => {
          const btn = document.querySelector("#refresh, #scdfe-refresh, #process-refresh, #pt-refresh, #points-refresh, #test-refresh, #lb-refresh");
          if (btn && !btn.disabled) btn.click();
          else location.reload();
        },
      },
      {
        group: "动作",
        title: "清除跨页聚焦上下文",
        sub: "解除当前 RTU / 通道锁定",
        keywords: "clear focus 清除 聚焦 上下文".toLowerCase(),
        run: () => clearFocus(),
      },
      {
        group: "动作",
        title: "执行 WAL 日志整理 (PASSIVE)",
        sub: "POST /api/diagnostics/wal-checkpoint",
        keywords: "wal checkpoint 数据库 整理".toLowerCase(),
        run: async () => {
          await fetch("/api/diagnostics/wal-checkpoint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "PASSIVE" }),
          }).catch(() => {});
        },
      },
    );
    return results;
  }

  function ensureCmdkDialog() {
    let dlg = document.getElementById("ui-cmdk-dialog");
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = "ui-cmdk-dialog";
    dlg.className = "ui-cmdk-dialog";
    dlg.innerHTML =
      '<div class="ui-cmdk-head">' +
      '<input id="ui-cmdk-input" type="search" autocomplete="off" placeholder="搜索 RTU、通道、四遥测点、页面或 14 套主题… (↑↓ 选择 · Enter 直达)" aria-label="全局命令搜索">' +
      '<button type="button" id="ui-cmdk-close" class="icon-button" aria-label="关闭">Esc</button>' +
      '</div>' +
      '<div id="ui-cmdk-list" class="ui-cmdk-list" role="listbox"></div>';
    document.body.appendChild(dlg);

    const input = dlg.querySelector("#ui-cmdk-input");
    const list = dlg.querySelector("#ui-cmdk-list");
    dlg.querySelector("#ui-cmdk-close").onclick = () => dlg.close();
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) dlg.close();
    });
    input.addEventListener("input", () => {
      clearTimeout(cmdkFetchTimer);
      renderCmdkLocalAndRemote(input.value.trim());
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (cmdkEntries.length) {
          cmdkIndex = (cmdkIndex + 1) % cmdkEntries.length;
          paintCmdkList();
        }
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (cmdkEntries.length) {
          cmdkIndex = (cmdkIndex - 1 + cmdkEntries.length) % cmdkEntries.length;
          paintCmdkList();
        }
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const entry = cmdkEntries[cmdkIndex];
        if (entry) {
          dlg.close();
          entry.run();
        }
      }
    });
    list.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-cmdk-idx]");
      if (!btn) return;
      const entry = cmdkEntries[Number(btn.dataset.cmdkIdx)];
      if (entry) {
        dlg.close();
        entry.run();
      }
    });
    return dlg;
  }

  function paintCmdkList() {
    const list = document.getElementById("ui-cmdk-list");
    if (!list) return;
    if (!cmdkEntries.length) {
      list.innerHTML = '<div class="ui-cmdk-empty">无匹配项</div>';
      return;
    }
    list.innerHTML = cmdkEntries.map((item, idx) =>
      `<button type="button" role="option" class="ui-cmdk-item${idx === cmdkIndex ? " is-active" : ""}" data-cmdk-idx="${idx}" aria-selected="${idx === cmdkIndex}">` +
      `<span class="ui-cmdk-group">${escHtml(item.group)}</span>` +
      `<span class="ui-cmdk-title">${escHtml(item.title)}</span>` +
      `<span class="ui-cmdk-sub">${escHtml(item.sub || "")}</span>` +
      `</button>`
    ).join("");
    const active = list.querySelector(".ui-cmdk-item.is-active");
    active?.scrollIntoView?.({ block: "nearest" });
  }

  function buildRemoteEntries(data) {
    const out = [];
    const comp = data?.component || "c";
    (data?.rtus || []).forEach(r => {
      out.push({
        group: "RTU",
        title: `RTU ${r.rtu_id}${r.name ? " · " + r.name : ""}`,
        sub: `${r.channel_type || "—"} · 通道 ${r.channel_id ?? "—"}`,
        run: () => {
          writeFocus({ rtu_id: String(r.rtu_id), channel_id: r.channel_id != null ? String(r.channel_id) : "" });
          if (comp === "c") location.href = `/point-trace?rtu_id=${encodeURIComponent(r.rtu_id)}`;
          else if (comp === "s") location.href = `/test?rtu_id=${encodeURIComponent(r.rtu_id)}`;
          else location.href = `/point-trace?rtu_id=${encodeURIComponent(r.rtu_id)}`;
        },
      });
    });
    (data?.trans_channels || []).forEach(ch => {
      out.push({
        group: "转发通道",
        title: `通道 ${ch.channel_id}${ch.name ? " · " + ch.name : ""}`,
        sub: `${ch.protocol || "—"}${ch.bind_port ? " :" + ch.bind_port : ""}`,
        run: () => {
          writeFocus({ channel_id: String(ch.channel_id) });
          location.href = comp === "t" ? `/points?channel_id=${encodeURIComponent(ch.channel_id)}` : `/point-trace`;
        },
      });
    });
    (data?.points || []).forEach(p => {
      out.push({
        group: p.kind.toUpperCase(),
        title: `RTU ${p.rtu_id} #${p.pnt_no}${p.name ? " · " + p.name : ""}`,
        sub: p.value != null ? `当前值 ${p.value}` : "定位到对账",
        run: () => {
          writeFocus({ rtu_id: String(p.rtu_id) });
          location.href = `/point-trace?kind=${encodeURIComponent(p.kind)}&rtu_id=${encodeURIComponent(p.rtu_id)}&q=${encodeURIComponent(p.pnt_no)}`;
        },
      });
    });
    return out;
  }

  function renderCmdkLocalAndRemote(q) {
    const low = q.toLowerCase();
    const locals = collectPageCommands().filter(item => !low || item.keywords.includes(low) || item.title.toLowerCase().includes(low));
    cmdkEntries = locals.slice(0, 14);
    cmdkIndex = 0;
    paintCmdkList();

    cmdkFetchTimer = setTimeout(async () => {
      if (cmdkAbort) cmdkAbort.abort();
      cmdkAbort = typeof AbortController === "function" ? new AbortController() : null;
      try {
        const resp = await fetch("/api/quick-search?q=" + encodeURIComponent(q), {
          cache: "no-cache",
          signal: cmdkAbort?.signal,
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const remotes = buildRemoteEntries(data);
        cmdkEntries = [...remotes, ...locals].slice(0, 24);
        cmdkIndex = 0;
        paintCmdkList();
      } catch (_) {
        // 忽略中止/网络错
      }
    }, q ? 120 : 10);
  }

  function openCmdk() {
    const dlg = ensureCmdkDialog();
    const input = dlg.querySelector("#ui-cmdk-input");
    if (!dlg.open) dlg.showModal();
    input.value = "";
    renderCmdkLocalAndRemote("");
    input.focus();
  }

  function mountCmdkTrigger() {
    const tools = document.querySelector(".header-tools");
    if (!tools || document.getElementById("ui-cmdk-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "ui-cmdk-btn";
    btn.className = "ui-cmdk-btn";
    btn.title = "全局速查与跳转 (Ctrl+K)";
    btn.setAttribute("aria-label", "全局速查 (Ctrl+K)");
    btn.innerHTML = UI_ICONS.search;
    btn.onclick = openCmdk;
    tools.prepend(btn);
  }

  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      openCmdk();
    }
  });

  // ==================== 7. 左栏双模式（悬浮 float / 内嵌 dock）+ 双向可隐藏 ====================
  function initAutoHideSidebar() {
    const sidebar = document.querySelector(".workbench-sidebar, .sidebar");
    if (!sidebar || document.getElementById("ui-sidebar-edge")) return;

    const MODE_KEY = "scada_sidebar_mode";
    const HIDDEN_KEY = "scada_sidebar_hidden";
    let mode = "float";
    let dockHidden = false;
    try {
      mode = localStorage.getItem(MODE_KEY) === "dock" ? "dock" : "float";
      dockHidden = localStorage.getItem(HIDDEN_KEY) === "1";
    } catch (_) { /* ignore */ }

    const edge = document.createElement("div");
    edge.id = "ui-sidebar-edge";
    edge.className = "ui-sidebar-edge";
    edge.setAttribute("aria-hidden", "true");
    document.body.appendChild(edge);

    // 侧栏顶部紧凑模式切换条（悬浮 | 内嵌 + 一键隐藏）
    const bar = document.createElement("div");
    bar.id = "ui-sidebar-bar";
    bar.className = "ui-sidebar-bar";
    bar.innerHTML =
      '<div class="ui-sidebar-mode-seg" role="group" aria-label="左栏模式">' +
      `<button type="button" class="ui-sidebar-mode-btn" data-sb-mode="float" title="悬浮模式">${UI_ICONS.sbFloat}<span>悬浮</span></button>` +
      `<button type="button" class="ui-sidebar-mode-btn" data-sb-mode="dock" title="内嵌模式">${UI_ICONS.sbDock}<span>内嵌</span></button>` +
      '</div>' +
      `<button type="button" id="ui-sidebar-hide" class="ui-sidebar-hide-btn" title="隐藏左栏" aria-label="隐藏左栏">${UI_ICONS.sbHide}</button>`;
    sidebar.prepend(bar);

    // 顶栏品牌左侧极简侧栏显隐开关按钮（悬浮/内嵌两种模式均可随时呼出或隐藏）
    let toggleBtn = document.getElementById("ui-sidebar-toggle");
    const brand = document.querySelector(".workbench-brand, .topbar .brand");
    if (brand && !toggleBtn) {
      toggleBtn = document.createElement("button");
      toggleBtn.id = "ui-sidebar-toggle";
      toggleBtn.type = "button";
      toggleBtn.className = "ui-sidebar-toggle";
      toggleBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>';
      brand.prepend(toggleBtn);
    }

    let hideTimer = null;
    let isPeekOpen = false;
    const EDGE_ZONE_PX = 14;
    const HIDE_DELAY_MS = 160;

    const cancelHide = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const syncUi = () => {
      document.documentElement.dataset.sidebarMode = mode;
      document.documentElement.dataset.sidebarHidden = mode === "dock" && dockHidden ? "1" : "0";
      bar.querySelectorAll("[data-sb-mode]").forEach((btn) => {
        const active = btn.dataset.sbMode === mode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      const visible = mode === "dock" ? !dockHidden : isPeekOpen;
      if (toggleBtn) {
        toggleBtn.classList.toggle("is-active", visible);
        toggleBtn.title = visible ? "隐藏左栏" : "展开左栏";
        toggleBtn.setAttribute("aria-label", visible ? "隐藏左栏" : "展开左栏");
        toggleBtn.setAttribute("aria-expanded", String(visible));
      }
      edge.title = mode === "dock" ? "点击展开内嵌左栏" : "移至左侧边缘展开悬浮左栏";
    };

    const persistState = () => {
      try {
        localStorage.setItem(MODE_KEY, mode);
        localStorage.setItem(HIDDEN_KEY, dockHidden ? "1" : "0");
      } catch (_) { /* ignore */ }
    };

    const showPeek = () => {
      if (mode !== "float") return;
      cancelHide();
      if (isPeekOpen) return;
      isPeekOpen = true;
      document.body.classList.add("is-sidebar-peek");
      sidebar.classList.add("is-peek");
      syncUi();
    };

    const hidePeekNow = () => {
      cancelHide();
      if (!isPeekOpen) return;
      isPeekOpen = false;
      document.body.classList.remove("is-sidebar-peek");
      sidebar.classList.remove("is-peek");
      syncUi();
    };

    const schedulePeekHide = () => {
      if (mode !== "float") return;
      cancelHide();
      hideTimer = setTimeout(() => {
        if (mode !== "float") return;
        if (sidebar.matches(":hover") || edge.matches(":hover")) return;
        const active = document.activeElement;
        if (active && sidebar.contains(active) && active !== document.body) return;
        hidePeekNow();
      }, HIDE_DELAY_MS);
    };

    const setMode = (nextMode) => {
      const target = nextMode === "dock" ? "dock" : "float";
      if (mode === target) return;
      mode = target;
      if (mode === "dock") {
        hidePeekNow();
        dockHidden = false;
      } else {
        dockHidden = false;
        showPeek();
      }
      persistState();
      syncUi();
      window.dispatchEvent(new Event("resize"));
    };

    const hideCurrent = () => {
      if (mode === "dock") {
        dockHidden = true;
        persistState();
        syncUi();
        window.dispatchEvent(new Event("resize"));
      } else {
        hidePeekNow();
      }
    };

    const toggleSidebar = () => {
      if (mode === "dock") {
        dockHidden = !dockHidden;
        persistState();
        syncUi();
        window.dispatchEvent(new Event("resize"));
      } else if (isPeekOpen) {
        hidePeekNow();
      } else {
        showPeek();
      }
    };

    bar.addEventListener("click", (ev) => {
      const mBtn = ev.target?.closest?.("[data-sb-mode]");
      if (mBtn) {
        ev.stopPropagation();
        setMode(mBtn.dataset.sbMode);
        return;
      }
      if (ev.target?.closest?.("#ui-sidebar-hide")) {
        ev.stopPropagation();
        hideCurrent();
      }
    });

    toggleBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleSidebar();
    });

    edge.addEventListener("mouseenter", () => {
      if (mode === "float") showPeek();
    });
    edge.addEventListener("click", () => {
      if (mode === "dock" && dockHidden) {
        dockHidden = false;
        persistState();
        syncUi();
        window.dispatchEvent(new Event("resize"));
      } else if (mode === "float") {
        showPeek();
      }
    });

    sidebar.addEventListener("mouseenter", () => {
      if (mode === "float") showPeek();
    });
    sidebar.addEventListener("mouseleave", schedulePeekHide);

    document.addEventListener("mousemove", (ev) => {
      if (mode !== "float" || ev.clientY < 46) return;
      if (ev.clientX <= EDGE_ZONE_PX) {
        showPeek();
        return;
      }
      if (isPeekOpen) {
        const rect = sidebar.getBoundingClientRect();
        if (ev.clientX > rect.right + 12) {
          schedulePeekHide();
        }
      }
    }, { passive: true });

    document.addEventListener("mouseleave", schedulePeekHide);
    sidebar.addEventListener("focusin", () => { if (mode === "float") showPeek(); });
    sidebar.addEventListener("focusout", schedulePeekHide);

    // SPA 页面点击功能按钮切页后：悬浮模式自动收起，内嵌模式保持常驻
    sidebar.addEventListener("click", (ev) => {
      if (mode !== "float") return;
      const navBtn = ev.target?.closest?.("button.nav");
      if (navBtn && !ev.target?.closest?.("summary")) {
        hidePeekNow();
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && mode === "float" && isPeekOpen && !document.querySelector("dialog[open]")) {
        hidePeekNow();
      }
    });

    syncUi();
    window.scadaSidebar = {
      getMode: () => mode,
      setMode,
      toggle: toggleSidebar,
      hide: hideCurrent,
    };
  }

  window.scadaFocusContext = { read: readFocus, write: writeFocus, set: writeFocus, clear: clearFocus };
  window.scadaTrackCommand = scadaTrackCommand;
  window.scadaOpenCmdk = openCmdk;

  function init() {
    syncFocusFromUrl();
    renderFocusChip();
    bindFocusWatchers();
    initWorkbenchLinks();
    mountCmdkTrigger();
    initAutoHideSidebar();
    refreshAlerts();
    setInterval(() => { if (!document.hidden) refreshAlerts(); }, 12000);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
