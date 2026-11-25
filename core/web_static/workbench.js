(function () {
  "use strict";

  const FOCUS_KEY = "scada.focus.context.v1";

  // ==================== 1. 健康探活 ====================
  async function refreshHealth() {
    const status = document.querySelector("#connection");
    if (!status) return;
    try {
      const response = await fetch("/api/health", { cache: "no-cache" });
      if (!response.ok) throw new Error("health");
      const result = await response.json();
      if (result.status !== "ok") throw new Error("health");
      status.textContent = "Web 已连接";
      status.classList.add("ok");
      status.classList.remove("error", "bad");
    } catch (_) {
      status.textContent = "Web 连接失败";
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

  window.scadaFocusContext = { read: readFocus, write: writeFocus, set: writeFocus, clear: clearFocus };
  window.scadaTrackCommand = scadaTrackCommand;

  function init() {
    syncFocusFromUrl();
    renderFocusChip();
    bindFocusWatchers();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
