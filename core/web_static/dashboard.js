/* SCADA C / S / T 三端动态可视化大屏前端引擎（零外部依赖，全适配 14 套风格与中/英/俄三语）。 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const ROLE_META = {
    c: {
      title: "采集态势指挥屏",
      tag: "scdfe_c · 采集引擎",
      gaugeTitle: "采集健康与在线态势",
      topoTitle: "多规约实时汇流拓扑",
      trendTitle: "实时收发帧吞吐曲线",
      barTitle: "RTU 通道流量与规模排行",
      hbarTitle: "四遥构成与重点遥测",
      feedTitle: "采集动态与核心进程",
      hubName: "scdfe_c",
      hubSub: "采集汇聚",
      rightNodes: [
        { title: "实时库 .db", sub: "WAL 写入", href: "/diagnostics" },
        { title: "指令派发", sub: "YK / YT", href: "/command-traces" },
        { title: "全链路对账", sub: "C → T", href: "/point-trace" },
      ],
    },
    s: {
      title: "规约仿真实验台大屏",
      tag: "scdfe_s · 规约仿真",
      gaugeTitle: "仿真服务在线与活跃度",
      topoTitle: "多规约仿真脉冲流向",
      trendTitle: "仿真报文交互曲线",
      barTitle: "规约通道点数与连接",
      hbarTitle: "四遥仿真与遥信状态",
      feedTitle: "客户端联动与测试动态",
      hubName: "scdfe_s",
      hubSub: "仿真引擎",
      rightNodes: [
        { title: "客户端会话", sub: "多协议接入", href: "/connections" },
        { title: "通信测试台", sub: "激励/改值", href: "/test" },
        { title: "SOE / 指令", sub: "事件回放", href: "/soe" },
      ],
    },
    t: {
      title: "四遥转发枢纽大屏",
      tag: "scdfe_t · 转发枢纽",
      gaugeTitle: "映射覆盖与零偏差保真",
      topoTitle: "源采集 → 转发分发拓扑",
      trendTitle: "转发吞吐趋势曲线",
      barTitle: "转发通道映射与吞吐",
      hbarTitle: "四遥映射覆盖率棒图",
      feedTitle: "转发连接与对账动态",
      hubName: "scdfe_t",
      hubSub: "转发调度",
      rightNodes: [
        { title: "全链路对账", sub: "偏差监视", href: "/point-trace" },
        { title: "上游主站", sub: "在线连接", href: "/connections" },
        { title: "转发点表", sub: "映射维护", href: "/points" },
      ],
    },
  };

  const state = {
    component: document.body?.dataset?.dashRole || "c",
    isAllMode: document.body?.dataset?.dashRole === "all",
    allData: null,
    data: null,
    timer: null,
    intervalMs: 2000,
    abort: null,
    hbarTab: document.body?.dataset?.dashRole === "s" ? "led" : "primary",
    tLeftTab: "bars",
    scopeMode: document.body?.dataset?.dashRole === "all" ? "wave" : "sync",
    scopePhase: 0,
    scopeAnimFrame: 0,
    scopeHistory: [],
    trendHistory: [],
    prevTotals: null,
    barHitboxes: [],
    barGrow: 1,
    barAnimFrame: 0,
    trendHoverIdx: -1,
    barHoverIdx: -1,
    kpiPrevNums: new Map(),
  };

  const tr = (text) => {
    if (window.scadaI18n?.getLang?.() && window.scadaI18n.getLang() !== "zh-CN") {
      return window.scadaI18n.translateText(text);
    }
    return text;
  };

  function getPalette() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fb) => (cs.getPropertyValue(name) || "").trim() || fb;
    const dark = document.documentElement.dataset.colorScheme === "dark";
    return {
      dark,
      bgSurface: get("--bg-surface", dark ? "#111827" : "#ffffff"),
      bgSubtle: get("--bg-subtle", dark ? "#1e293b" : "#f1f5f9"),
      text: get("--text-primary", dark ? "#f8fafc" : "#0f172a"),
      textSub: get("--text-secondary", dark ? "#94a3b8" : "#64748b"),
      textMuted: get("--text-muted", dark ? "#64748b" : "#94a3b8"),
      border: get("--border-color", dark ? "rgba(255,255,255,0.1)" : "#e2e8f0"),
      accent: get("--accent", dark ? "#38bdf8" : "#2563eb"),
      ok: get("--ok", dark ? "#34d399" : "#0d9488"),
      warn: get("--warn", dark ? "#fbbf24" : "#d97706"),
      danger: get("--danger", dark ? "#fb7185" : "#dc2626"),
      series: dark
        ? [get("--accent", "#38bdf8"), get("--ok", "#34d399"), get("--warn", "#fbbf24"), get("--danger", "#fb7185"), "#a78bfa"]
        : [get("--accent", "#2563eb"), get("--ok", "#0d9488"), get("--warn", "#d97706"), get("--danger", "#dc2626"), "#7c3aed"],
    };
  }

  function hexToRgba(color, alpha) {
    const c = (color || "").trim();
    if (c.startsWith("#")) {
      let hex = c.slice(1);
      if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
      }
    }
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
    return `rgba(56,189,248,${alpha})`;
  }

  function fmtCompact(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return "0";
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
    if (Math.abs(v) >= 10_000) return (v / 1_000).toFixed(1) + "K";
    return Math.round(v).toLocaleString();
  }

  function animateElementNumber(el, key, targetVal) {
    if (!el) return;
    const to = Number(targetVal || 0);
    const from = state.kpiPrevNums.has(key) ? state.kpiPrevNums.get(key) : to;
    state.kpiPrevNums.set(key, to);
    if (from === to || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      el.textContent = fmtCompact(to);
      return;
    }
    const start = performance.now();
    const dur = 420;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtCompact(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ==================== 1. 顶部单行指挥指标条 ====================
  function renderStrip(data) {
    const meta = ROLE_META[data.component] || ROLE_META.c;
    const k = data.kpis || {};
    if ($("dash-theme-title")) $("dash-theme-title").textContent = tr(meta.title);
    if ($("dash-role-tag")) $("dash-role-tag").textContent = tr(meta.tag);
    if ($("dash-gauge-title")) $("dash-gauge-title").textContent = tr(meta.gaugeTitle);
    if ($("dash-topo-title")) $("dash-topo-title").textContent = tr(meta.topoTitle);
    if ($("dash-trend-title")) $("dash-trend-title").textContent = tr(meta.trendTitle);
    if ($("dash-bar-title")) $("dash-bar-title").textContent = tr(meta.barTitle);
    if ($("dash-hbar-title")) $("dash-hbar-title").textContent = tr(meta.hbarTitle);
    if ($("dash-feed-title")) $("dash-feed-title").textContent = tr(meta.feedTitle);

    const dot = $("dash-live-dot");
    if (dot) {
      dot.className = "dash-live-dot" + (k.channels_error > 0 || k.alerts_total > 0 ? " is-err" : (k.channels_running === 0 && k.channels_total > 0 ? " is-warn" : ""));
    }

    const items =
      data.component === "t"
        ? [
            { key: "ch", label: "转发通道", val: `${k.channels_running}/${k.channels_total}`, cls: k.channels_error ? "is-err" : "is-ok", raw: null },
            { key: "mapped", label: "已映射点", val: k.mapped_points, cls: "is-accent", raw: k.mapped_points },
            { key: "diff", label: "对账偏差", val: k.diff_points, cls: k.diff_points > 0 ? "is-warn" : "is-ok", raw: k.diff_points },
            { key: "cli", label: "在线主站", val: k.active_clients, cls: "is-ok", raw: k.active_clients },
            { key: "tx", label: "累计转发", val: k.tx_total, cls: "", raw: k.tx_total, unit: "帧" },
          ]
        : data.component === "s"
          ? [
              { key: "ch", label: "仿真服务", val: `${k.channels_running}/${k.channels_total}`, cls: k.channels_error ? "is-err" : "is-ok", raw: null },
              { key: "pts", label: "仿真四遥", val: k.points_total, cls: "is-accent", raw: k.points_total },
              { key: "cli", label: "接入客户端", val: k.active_clients, cls: "is-ok", raw: k.active_clients },
              { key: "rx", label: "累计收发", val: k.rx_total + k.tx_total, cls: "", raw: k.rx_total + k.tx_total, unit: "帧" },
              { key: "err", label: "异常告警", val: k.alerts_total, cls: k.alerts_total > 0 ? "is-err" : "is-ok", raw: k.alerts_total },
            ]
          : [
              { key: "ch", label: "采集 RTU", val: `${k.channels_running}/${k.channels_total}`, cls: k.channels_error ? "is-err" : "is-ok", raw: null },
              { key: "pts", label: "四遥测点", val: k.points_total, cls: "is-accent", raw: k.points_total },
              { key: "rx", label: "累计接收", val: k.rx_total, cls: "", raw: k.rx_total, unit: "帧" },
              { key: "tx", label: "累计发送", val: k.tx_total, cls: "", raw: k.tx_total, unit: "帧" },
              { key: "err", label: "异常告警", val: k.alerts_total, cls: k.alerts_total > 0 ? "is-err" : "is-ok", raw: k.alerts_total },
            ];

    const host = $("dash-kpis");
    if (!host) return;
    if (host.dataset.comp !== data.component) {
      host.dataset.comp = data.component;
      host.innerHTML = items
        .map(
          (it) =>
            `<div class="dash-kpi-item"><span class="dash-kpi-label">${esc(tr(it.label))}</span>` +
            `<span class="dash-kpi-val ${it.cls}" data-kpi-key="${it.key}">${esc(it.raw === null ? it.val : fmtCompact(it.raw))}</span>` +
            (it.unit ? `<span class="dash-kpi-unit">${esc(tr(it.unit))}</span>` : "") +
            `</div>`,
        )
        .join("");
    }
    items.forEach((it) => {
      const valEl = host.querySelector(`[data-kpi-key="${it.key}"]`);
      if (!valEl) return;
      valEl.className = `dash-kpi-val ${it.cls}`;
      if (it.raw === null) valEl.textContent = it.val;
      else animateElementNumber(valEl, `${data.component}:${it.key}`, it.raw);
    });
  }

  // ==================== 2. 双环动态仪表盘（SVG） ====================
  function renderGauge(data) {
    const pal = getPalette();
    const k = data.kpis || {};
    const comp = data.component;
    let primaryPct = Number(data.health_score || 0);
    let primaryLabel = "健康评分";
    let secondaryPct = k.channels_total > 0 ? Math.round((k.channels_running / k.channels_total) * 100) : 0;
    let secondaryLabel = "在线率";

    if (comp === "t") {
      const cov = k.points_total > 0 ? Math.round((k.mapped_points / k.points_total) * 100) : 0;
      const fid = k.mapped_points > 0 ? Math.max(0, Math.round(((k.mapped_points - k.diff_points) / k.mapped_points) * 100)) : 100;
      primaryPct = fid;
      primaryLabel = "零偏差率";
      secondaryPct = Math.min(100, cov);
      secondaryLabel = "映射覆盖";
    } else if (comp === "s") {
      primaryPct = Number(data.health_score || 0);
      primaryLabel = "服务健康";
      secondaryPct = k.channels_total > 0 ? Math.round((k.channels_running / k.channels_total) * 100) : 0;
      secondaryLabel = "仿真在线";
    }

    const r1 = 68;
    const c1 = 2 * Math.PI * r1;
    const off1 = c1 * (1 - Math.max(0, Math.min(100, primaryPct)) / 100);
    const r2 = 52;
    const c2 = 2 * Math.PI * r2;
    const off2 = c2 * (1 - Math.max(0, Math.min(100, secondaryPct)) / 100);
    const col1 = primaryPct >= 85 ? pal.ok : primaryPct >= 60 ? pal.warn : pal.danger;
    const col2 = pal.accent;

    if (!$("dash-gauge-svg")) return;
    $("dash-gauge-meta").textContent = `${tr(secondaryLabel)} ${secondaryPct}%`;
    $("dash-gauge-svg").innerHTML = `
      <svg class="dash-gauge-svg" viewBox="0 0 180 180" aria-label="${esc(tr(primaryLabel))} ${primaryPct}">
        <circle class="dash-gauge-orbit" cx="90" cy="90" r="80" fill="none" stroke="${pal.border}" stroke-width="1.2" stroke-dasharray="3 6"></circle>
        <circle cx="90" cy="90" r="${r1}" fill="none" stroke="${pal.bgSubtle}" stroke-width="10"></circle>
        <circle class="dash-gauge-arc" cx="90" cy="90" r="${r1}" fill="none" stroke="${col1}" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${c1.toFixed(1)}" stroke-dashoffset="${off1.toFixed(1)}" transform="rotate(-90 90 90)"></circle>
        <circle cx="90" cy="90" r="${r2}" fill="none" stroke="${pal.bgSubtle}" stroke-width="6"></circle>
        <circle class="dash-gauge-arc" cx="90" cy="90" r="${r2}" fill="none" stroke="${col2}" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="${c2.toFixed(1)}" stroke-dashoffset="${off2.toFixed(1)}" transform="rotate(-90 90 90)"></circle>
        <text x="90" y="88" text-anchor="middle" fill="${pal.text}" font-size="30" font-weight="700" font-family="var(--font-mono)">${primaryPct}</text>
        <text x="90" y="108" text-anchor="middle" fill="${pal.textSub}" font-size="11">${esc(tr(primaryLabel))}</text>
      </svg>`;

    const stats =
      comp === "t"
        ? [
            { val: k.channels_running, label: "运行通道", cls: "is-ok" },
            { val: k.diff_points, label: "偏差点", cls: k.diff_points ? "is-warn" : "is-ok" },
            { val: k.active_clients, label: "主站连接", cls: "" },
          ]
        : [
            { val: k.channels_running, label: "运行中", cls: "is-ok" },
            { val: k.channels_error, label: "异常", cls: k.channels_error ? "is-err" : "" },
            { val: k.channels_stopped, label: "待机", cls: "" },
          ];

    $("dash-gauge-stats").innerHTML = stats
      .map((s) => `<div class="dash-mini-stat ${s.cls}"><b>${fmtCompact(s.val)}</b><span>${esc(tr(s.label))}</span></div>`)
      .join("");
  }

  // ==================== 3. 动态脉冲业务拓扑（SVG） ====================
  function renderTopology(data) {
    const pal = getPalette();
    const comp = data.component;
    const meta = ROLE_META[comp] || ROLE_META.c;
    const host = $("dash-topo-host");
    if (!host) return;

    let leftNodes = [];
    if (comp === "t") {
      leftNodes = (data.source_rtus || []).slice(0, 5).map((r) => ({
        title: `RTU ${r.rtu_id}`,
        sub: `${(r.protocol || "—").toUpperCase()} · ${r.points}点`,
        state: r.state,
        href: `/point-trace?rtu_id=${encodeURIComponent(r.rtu_id)}`,
        rtuId: r.rtu_id,
      }));
    } else if (comp === "s") {
      leftNodes = (data.channels || []).slice(0, 5).map((ch) => ({
        title: ch.name || `RTU ${ch.rtu_id ?? ch.id}`,
        sub: `${(ch.protocol || "—").toUpperCase()} · ${ch.points}点`,
        state: ch.state,
        href: `/test?rtu_id=${encodeURIComponent(ch.rtu_id ?? ch.id)}`,
        rtuId: ch.rtu_id ?? ch.id,
      }));
    } else {
      leftNodes = (data.channels || []).slice(0, 5).map((ch) => ({
        title: `RTU ${ch.rtu_id ?? ch.id}`,
        sub: `${(ch.protocol || "—").toUpperCase()} · ${ch.points}点`,
        state: ch.state,
        href: `/#scdfe`,
        rtuId: ch.rtu_id ?? ch.id,
      }));
    }
    if (!leftNodes.length) {
      leftNodes = [{ title: comp === "t" ? "源采集池" : "通道就绪", sub: "等待配置", state: "stopped", href: "/channels", rtuId: null }];
    }

    let rightNodes = meta.rightNodes;
    if (comp === "t" && (data.channels || []).length) {
      rightNodes = data.channels.slice(0, 4).map((ch) => ({
        title: ch.name || `通道 ${ch.id}`,
        sub: `${(ch.protocol || "iec104").toUpperCase()} · ${ch.mapped}点`,
        state: ch.state,
        href: `/points?channel_id=${encodeURIComponent(ch.id)}`,
      }));
    }

    const W = 520;
    const H = 204;
    const hubX = W / 2;
    const hubY = H / 2;
    const leftX = 10;
    const nodeW = 152;
    const nodeH = 38;
    const rightX = W - nodeW - 10;

    const stateColor = (st) => (st === "running" ? pal.ok : st === "error" ? pal.danger : pal.accent);

    const posY = (idx, total) => {
      const gap = Math.min(48, (H - 16) / Math.max(1, total));
      const start = (H - gap * (total - 1) - nodeH) / 2;
      return start + idx * gap;
    };

    const lines = [];
    const nodes = [];

    leftNodes.forEach((n, i) => {
      const y = posY(i, leftNodes.length);
      const cy = y + nodeH / 2;
      const col = stateColor(n.state);
      const d = `M ${leftX + nodeW} ${cy} C ${leftX + nodeW + 42} ${cy}, ${hubX - 72} ${hubY}, ${hubX - 44} ${hubY}`;
      lines.push(`<path class="dash-flow-line" d="${d}" stroke="${col}"></path>`);
      lines.push(`<path class="dash-flow-pulse${n.state !== "running" ? " is-slow" : ""}" d="${d}" stroke="${col}"></path>`);
      nodes.push(`
        <g class="dash-node-box" data-nav-href="${esc(n.href)}" data-nav-rtu="${esc(n.rtuId ?? "")}">
          <rect x="${leftX}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${pal.bgSubtle}" stroke="${col}" stroke-width="1.35"></rect>
          <circle cx="${leftX + 12}" cy="${cy}" r="3.8" fill="${col}"></circle>
          <text x="${leftX + 23}" y="${y + 16}" fill="${pal.text}" font-size="11.5" font-weight="650">${esc(n.title.slice(0, 14))}</text>
          <text x="${leftX + 23}" y="${y + 30}" fill="${pal.textSub}" font-size="10" font-family="var(--font-mono)">${esc(n.sub.slice(0, 20))}</text>
        </g>`);
    });

    rightNodes.forEach((n, i) => {
      const y = posY(i, rightNodes.length);
      const cy = y + nodeH / 2;
      const col = n.state ? stateColor(n.state) : pal.accent;
      const d = `M ${hubX + 44} ${hubY} C ${hubX + 72} ${hubY}, ${rightX - 42} ${cy}, ${rightX} ${cy}`;
      lines.push(`<path class="dash-flow-line" d="${d}" stroke="${col}"></path>`);
      lines.push(`<path class="dash-flow-pulse${n.state && n.state !== "running" ? " is-slow" : ""}" d="${d}" stroke="${col}"></path>`);
      nodes.push(`
        <g class="dash-node-box" data-nav-href="${esc(n.href)}">
          <rect x="${rightX}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${pal.bgSubtle}" stroke="${col}" stroke-width="1.35"></rect>
          <circle cx="${rightX + 12}" cy="${cy}" r="3.8" fill="${col}"></circle>
          <text x="${rightX + 23}" y="${y + 16}" fill="${pal.text}" font-size="11.5" font-weight="650">${esc(tr(n.title).slice(0, 14))}</text>
          <text x="${rightX + 23}" y="${y + 30}" fill="${pal.textSub}" font-size="10" font-family="var(--font-mono)">${esc(tr(n.sub).slice(0, 20))}</text>
        </g>`);
    });

    const k = data.kpis || {};
    $("dash-topo-meta").textContent = `${k.channels_running}/${k.channels_total} ${tr("运行中")} · ${(data.protocols || []).length} ${tr("规约")}`;

    host.innerHTML = `
      <svg class="dash-topo-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${lines.join("")}
        <g>
          <circle class="dash-hub-ring" cx="${hubX}" cy="${hubY}" r="48" fill="none" stroke="${pal.accent}" stroke-width="1.5" stroke-dasharray="5 5"></circle>
          <circle cx="${hubX}" cy="${hubY}" r="40" fill="${pal.bgSubtle}" stroke="${pal.accent}" stroke-width="2"></circle>
          <text x="${hubX}" y="${hubY - 4}" text-anchor="middle" fill="${pal.text}" font-size="13" font-weight="700" font-family="var(--font-mono)">${esc(meta.hubName)}</text>
          <text x="${hubX}" y="${hubY + 13}" text-anchor="middle" fill="${pal.accent}" font-size="10.5" font-weight="600">${esc(tr(meta.hubSub))}</text>
        </g>
        ${nodes.join("")}
      </svg>`;

    host.querySelectorAll("[data-nav-href]").forEach((g) => {
      g.addEventListener("click", () => {
        const rid = g.dataset.navRtu;
        if (rid && window.scadaFocusContext?.set) window.scadaFocusContext.set({ rtu_id: rid });
        const href = g.dataset.navHref;
        if (href) location.href = href;
      });
    });
  }

  // ==================== 4. 实时平滑双曲线趋势图（Canvas） ====================
  function pushTrendPoint(data) {
    const k = data.kpis || {};
    const now = Date.now();
    const rx = Number(k.rx_total || 0);
    const tx = Number(k.tx_total || 0);
    let rxRate = 0;
    let txRate = 0;
    if (state.prevTotals && now > state.prevTotals.ts) {
      const dt = Math.max(0.5, (now - state.prevTotals.ts) / 1000);
      rxRate = Math.max(0, (rx - state.prevTotals.rx) / dt);
      txRate = Math.max(0, (tx - state.prevTotals.tx) / dt);
    } else if (state.trendHistory.length === 0) {
      // 首屏预置 6 个历史基线点避免单点孤立，后续全部为真实相邻采样增量速率
      const activeScale = Math.max(0, Number(k.channels_running || 0));
      const baseRx = rx > 0 ? Math.min(20, activeScale * 0.5) : 0;
      const baseTx = tx > 0 ? Math.min(20, activeScale * 0.3) : 0;
      for (let i = 5; i >= 1; i--) {
        const ts = now - i * state.intervalMs;
        state.trendHistory.push({
          label: new Date(ts).toTimeString().slice(0, 8),
          rx: Number(baseRx.toFixed(2)),
          tx: Number(baseTx.toFixed(2)),
          rxTotal: rx,
          txTotal: tx,
        });
      }
      rxRate = baseRx;
      txRate = baseTx;
    }
    state.prevTotals = { rx, tx, ts: now };
    const tStr = new Date(now).toTimeString().slice(0, 8);
    state.trendHistory.push({ label: tStr, rx: Number(rxRate.toFixed(2)), tx: Number(txRate.toFixed(2)), rxTotal: rx, txTotal: tx });
    if (state.trendHistory.length > 24) state.trendHistory.shift();
  }

  function drawTrendCanvas() {
    const canvas = $("dash-trend-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const pal = getPalette();

    const s1Label = state.component === "t" ? tr("源读入/s") : tr("接收帧/s");
    const s2Label = state.component === "t" ? tr("转发上送/s") : tr("发送帧/s");
    if ($("dash-trend-legend")) {
      $("dash-trend-legend").innerHTML =
        `<span class="dash-legend-item"><i class="dash-legend-swatch is-s0"></i>${esc(s1Label)}</span>` +
        `<span class="dash-legend-item"><i class="dash-legend-swatch is-s1"></i>${esc(s2Label)}</span>`;
    }

    const pad = { top: 14, right: 26, bottom: 22, left: 36 };
    const plotW = Math.max(20, W - pad.left - pad.right);
    const plotH = Math.max(20, H - pad.top - pad.bottom);
    const pts = state.trendHistory;
    const maxVal = Math.max(2, ...pts.map((p) => Math.max(p.rx, p.tx))) * 1.18;

    ctx.clearRect(0, 0, W, H);

    // 水平虚线网格 + Y 轴刻度
    ctx.font = "10.5px var(--font-mono), Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH * i) / 4;
      const v = maxVal * (1 - i / 4);
      ctx.strokeStyle = hexToRgba(pal.textMuted, pal.dark ? 0.18 : 0.25);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = pal.textMuted;
      ctx.fillText(v >= 10 ? String(Math.round(v)) : v.toFixed(1), pad.left - 5, y);
    }

    if (!pts.length) return;
    const xOf = (idx) => pad.left + (pts.length <= 1 ? plotW : (idx / (pts.length - 1)) * plotW);
    const yOf = (val) => pad.top + plotH - (Math.max(0, val) / maxVal) * plotH;

    // X 轴稀疏时刻刻度（首左对齐、末右对齐防边缘裁字）
    ctx.textBaseline = "top";
    ctx.fillStyle = pal.textMuted;
    const tickIndices = pts.length <= 3
      ? pts.map((_, i) => i)
      : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
    tickIndices.forEach((idx, pos) => {
      ctx.textAlign = pos === 0 ? "left" : pos === tickIndices.length - 1 ? "right" : "center";
      ctx.fillText(pts[idx].label, xOf(idx), H - pad.bottom + 5);
    });

    const drawSeries = (key, color, withArea) => {
      const coords = pts.map((p, i) => [xOf(i), yOf(p[key])]);
      ctx.beginPath();
      coords.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else {
          const [px, py] = coords[i - 1];
          const cx = (px + x) / 2;
          ctx.bezierCurveTo(cx, py, cx, y, x, y);
        }
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      if (withArea && coords.length > 1) {
        const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        grad.addColorStop(0, hexToRgba(color, 0.16));
        grad.addColorStop(1, hexToRgba(color, 0.0));
        ctx.lineTo(coords[coords.length - 1][0], pad.top + plotH);
        ctx.lineTo(coords[0][0], pad.top + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      // 尾端脉冲光点
      const [lx, ly] = coords[coords.length - 1];
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.25);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };

    drawSeries("rx", pal.series[0], true);
    drawSeries("tx", pal.series[1], false);

    // 悬停十字准星
    if (state.trendHoverIdx >= 0 && state.trendHoverIdx < pts.length) {
      const idx = state.trendHoverIdx;
      const hx = xOf(idx);
      ctx.strokeStyle = hexToRgba(pal.accent, 0.55);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      [
        ["rx", pal.series[0]],
        ["tx", pal.series[1]],
      ].forEach(([k, c]) => {
        ctx.beginPath();
        ctx.arc(hx, yOf(pts[idx][k]), 4, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.fill();
      });
    }
  }

  // ==================== 5. 动态分组/堆叠柱状图（Canvas） ====================
  function drawBarCanvas() {
    const canvas = $("dash-bar-canvas");
    if (!canvas || !state.data) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const pal = getPalette();

    const comp = state.component;
    let items = [];
    let mode = "traffic";
    if (comp === "t") {
      const tChs = state.data.channels || [];
      if (tChs.length) {
        items = tChs.slice(0, 7).map((c) => ({
          label: `CH${c.id}`,
          full: c.name,
          v1: c.mapped || 0,
          v2: c.rx + c.tx,
          href: `/points?channel_id=${encodeURIComponent(c.id)}`,
        }));
        mode = "trans";
      } else {
        items = (state.data.source_rtus || []).slice(0, 7).map((r) => ({
          label: `R${r.rtu_id}`,
          full: r.name,
          v1: r.points || 0,
          v2: 0,
          href: `/point-trace?rtu_id=${encodeURIComponent(r.rtu_id)}`,
        }));
        mode = "points";
      }
    } else if (comp === "s") {
      items = (state.data.channels || []).slice(0, 7).map((c) => ({
        label: `R${c.rtu_id ?? c.id}`,
        full: `${c.name} (${c.protocol})`,
        v1: c.points || 0,
        v2: c.rx + c.tx,
        href: `/test?rtu_id=${encodeURIComponent(c.rtu_id ?? c.id)}`,
      }));
      mode = "sim";
    } else {
      const chs = state.data.channels || [];
      const hasTraffic = chs.some((c) => c.rx + c.tx > 0);
      mode = hasTraffic ? "traffic" : "points";
      items = chs.slice(0, 7).map((c) => ({
        label: `R${c.rtu_id ?? c.id}`,
        full: `${c.name} (${c.protocol})`,
        v1: hasTraffic ? c.rx : c.points,
        v2: hasTraffic ? c.tx : 0,
        err: c.err || 0,
        href: `/#scdfe`,
        rtuId: c.rtu_id ?? c.id,
      }));
    }

    const legendNames =
      mode === "traffic"
        ? [tr("接收帧"), tr("发送帧")]
        : mode === "trans"
          ? [tr("映射点数"), tr("收发帧")]
          : mode === "sim"
            ? [tr("四遥点数"), tr("交互帧")]
            : [tr("四遥测点数")];

    $("dash-bar-legend").innerHTML = legendNames
      .map((name, i) => `<span class="dash-legend-item"><i class="dash-legend-swatch is-s${i % 5}"></i>${esc(name)}</span>`)
      .join("");

    ctx.clearRect(0, 0, W, H);
    state.barHitboxes = [];
    if (!items.length) {
      ctx.fillStyle = pal.textMuted;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(tr("暂无通道数据"), W / 2, H / 2);
      return;
    }

    const pad = { top: 14, right: 10, bottom: 24, left: 42 };
    const plotW = Math.max(20, W - pad.left - pad.right);
    const plotH = Math.max(20, H - pad.top - pad.bottom);
    const dual = legendNames.length > 1;
    const maxVal = Math.max(1, ...items.map((it) => Math.max(it.v1, dual ? it.v2 : 0))) * 1.15;

    // 水平网格
    ctx.font = "10.5px var(--font-mono), Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 3; i++) {
      const y = pad.top + (plotH * i) / 3;
      const v = maxVal * (1 - i / 3);
      ctx.strokeStyle = hexToRgba(pal.textMuted, pal.dark ? 0.16 : 0.24);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = pal.textMuted;
      ctx.fillText(fmtCompact(v), pad.left - 5, y);
    }

    const slotW = plotW / items.length;
    const grow = state.barGrow;

    const drawRoundTopBar = (x, y, w, h, color, active) => {
      if (h <= 0.5) return;
      const r = Math.min(4, w / 2, h);
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, color);
      grad.addColorStop(1, hexToRgba(color, active ? 0.82 : 0.55));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fill();
    };

    items.forEach((it, idx) => {
      const cx = pad.left + slotW * idx + slotW / 2;
      const hovered = idx === state.barHoverIdx;
      if (hovered) {
        ctx.fillStyle = hexToRgba(pal.accent, 0.08);
        ctx.fillRect(pad.left + slotW * idx + 2, pad.top, slotW - 4, plotH);
      }
      if (dual) {
        const bw = Math.min(18, Math.max(6, slotW * 0.28));
        const h1 = (it.v1 / maxVal) * plotH * grow;
        const h2 = (it.v2 / maxVal) * plotH * grow;
        drawRoundTopBar(cx - bw - 1.5, pad.top + plotH - h1, bw, h1, pal.series[0], hovered);
        drawRoundTopBar(cx + 1.5, pad.top + plotH - h2, bw, h2, pal.series[1], hovered);
      } else {
        const bw = Math.min(26, Math.max(10, slotW * 0.42));
        const h1 = (it.v1 / maxVal) * plotH * grow;
        drawRoundTopBar(cx - bw / 2, pad.top + plotH - h1, bw, h1, pal.series[idx % pal.series.length], hovered);
      }
      ctx.fillStyle = hovered ? pal.text : pal.textSub;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(it.label, cx, H - pad.bottom + 5);

      state.barHitboxes.push({
        x1: pad.left + slotW * idx,
        x2: pad.left + slotW * (idx + 1),
        item: it,
        legendNames,
      });
    });
  }

  function triggerBarGrow() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      state.barGrow = 1;
      drawBarCanvas();
      return;
    }
    cancelAnimationFrame(state.barAnimFrame);
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 480);
      state.barGrow = 1 - Math.pow(1 - p, 3);
      drawBarCanvas();
      if (p < 1) state.barAnimFrame = requestAnimationFrame(step);
    };
    state.barAnimFrame = requestAnimationFrame(step);
  }

  // ==================== 6. 多维动态水平棒图（纯 SVG 零内联 style，100% 兼容严格 CSP） ====================
  function svgBarMarkup(pct, color) {
    const w = Math.max(0, Math.min(100, Number(pct) || 0)).toFixed(1);
    return (
      `<svg class="dash-hbar-svg" viewBox="0 0 100 9" preserveAspectRatio="none" aria-hidden="true">` +
      `<rect class="dash-hbar-rect" x="0" y="0" width="${w}" height="9" rx="4.5" fill="${color}"></rect>` +
      `</svg>`
    );
  }

  function renderHorizontalBars(data) {
    const host = $("dash-hbar-host");
    if (!host) return;
    const pal = getPalette();
    const comp = data.component;

    if (state.hbarTab === "led") {
      const yxList = data.yx_matrix || [];
      const yx = data.yx_state || { zero: 0, one: 0, other: 0 };
      const yxTotal = yx.zero + yx.one + yx.other;
      if (!yxList.length) {
        host.innerHTML = `<div class="dash-empty">${esc(tr("暂无遥信测点"))}</div>`;
        return;
      }
      const cells = yxList
        .slice(0, 28)
        .map((pt) => {
          const cls = pt.value === 1 || pt.value === 1.0 ? "is-on" : pt.value === 0 || pt.value === 0.0 ? "" : "is-other";
          return `<div class="dash-led-cell ${cls}" title="RTU ${pt.rtu_id} #${pt.pnt_no} ${esc(pt.name)} = ${esc(pt.value ?? "—")}">` +
            `<i class="dash-led-lamp"></i><span class="dash-led-label">#${esc(pt.pnt_no)} ${esc(pt.name)}</span></div>`;
        })
        .join("");
      const p1 = yxTotal ? (yx.one / yxTotal) * 100 : 0;
      const p0 = yxTotal ? (yx.zero / yxTotal) * 100 : 0;
      const po = yxTotal ? (yx.other / yxTotal) * 100 : 0;
      host.innerHTML =
        `<div class="dash-led-grid">${cells}</div>` +
        `<div class="dash-hbar-row">` +
        `<div class="dash-hbar-head"><span class="dash-hbar-name">${esc(tr("合位(1) / 分位(0)"))}</span>` +
        `<span class="dash-hbar-num">${fmtCompact(yx.one)} / ${fmtCompact(yx.zero)}</span></div>` +
        `<div class="dash-yx-split"><svg class="dash-yx-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">` +
        `<rect x="0" y="0" width="${p1.toFixed(1)}" height="10" fill="${pal.ok}"></rect>` +
        `<rect x="${p1.toFixed(1)}" y="0" width="${p0.toFixed(1)}" height="10" fill="${pal.accent}" opacity="0.78"></rect>` +
        (po > 0 ? `<rect x="${(p1 + p0).toFixed(1)}" y="0" width="${po.toFixed(1)}" height="10" fill="${pal.warn}"></rect>` : "") +
        `</svg></div></div>`;
      return;
    }

    if (state.hbarTab === "live") {
      const ycs = data.top_yc || [];
      if (!ycs.length) {
        host.innerHTML = `<div class="dash-empty">${esc(tr("暂无实时遥测值"))}</div>`;
        return;
      }
      const maxAbs = Math.max(1, ...ycs.map((p) => Math.abs(Number(p.value || 0))));
      host.innerHTML = ycs
        .slice(0, 7)
        .map((p, idx) => {
          const val = Number(p.value || 0);
          const pct = Math.max(4, Math.min(100, (Math.abs(val) / maxAbs) * 100));
          const col = val < 0 ? pal.warn : pal.series[idx % pal.series.length];
          return `<div class="dash-hbar-row" title="RTU ${p.rtu_id} #${p.pnt_no}">
            <div class="dash-hbar-head">
              <span class="dash-hbar-name">${esc(p.name)}</span>
              <span class="dash-hbar-num">${Number.isInteger(val) ? val : val.toFixed(2)}</span>
            </div>
            <div class="dash-hbar-track">${svgBarMarkup(pct, col)}</div>
          </div>`;
        })
        .join("");
      return;
    }

    const pbk = data.points_by_kind || {};
    const kinds = [
      { key: "yc", label: "遥测 YC", color: pal.series[0] },
      { key: "yx", label: "遥信 YX", color: pal.series[1] },
      { key: "yt", label: "遥调 YT", color: pal.series[2] },
      { key: "yk", label: "遥控 YK", color: pal.series[3] },
    ];

    if (comp === "t") {
      const mbk = data.mapping_by_kind || {};
      const rows = kinds.map((k) => {
        const rec = mbk[k.key] || { total: 0, mapped: 0 };
        const pct = rec.total > 0 ? Math.min(100, (rec.mapped / rec.total) * 100) : 0;
        return `<div class="dash-hbar-row">
          <div class="dash-hbar-head">
            <span class="dash-hbar-name">${esc(tr(k.label))}</span>
            <span class="dash-hbar-num">${fmtCompact(rec.mapped)} / ${fmtCompact(rec.total)} (${pct.toFixed(0)}%)</span>
          </div>
          <div class="dash-hbar-track">${svgBarMarkup(Math.max(pct, rec.mapped ? 4 : 0), k.color)}</div>
        </div>`;
      });
      host.innerHTML = rows.join("");
      return;
    }

    const maxPts = Math.max(1, ...kinds.map((k) => Number(pbk[k.key] || 0)));
    const rows = kinds.map((k) => {
      const cnt = Number(pbk[k.key] || 0);
      const pct = cnt > 0 ? Math.max(4, (cnt / maxPts) * 100) : 0;
      return `<div class="dash-hbar-row">
        <div class="dash-hbar-head">
          <span class="dash-hbar-name">${esc(tr(k.label))}</span>
          <span class="dash-hbar-num">${fmtCompact(cnt)}</span>
        </div>
        <div class="dash-hbar-track">${svgBarMarkup(pct, k.color)}</div>
      </div>`;
    });

    // 追加 YX 合/分位双色 SVG 占比条
    const yx = data.yx_state || { zero: 0, one: 0, other: 0 };
    const yxTotal = yx.zero + yx.one + yx.other;
    if (yxTotal > 0) {
      const p1 = (yx.one / yxTotal) * 100;
      const p0 = (yx.zero / yxTotal) * 100;
      const po = (yx.other / yxTotal) * 100;
      rows.push(`<div class="dash-hbar-row">
        <div class="dash-hbar-head">
          <span class="dash-hbar-name">${esc(tr("遥信态分布"))}</span>
          <span class="dash-hbar-num">1:${fmtCompact(yx.one)} · 0:${fmtCompact(yx.zero)}</span>
        </div>
        <div class="dash-yx-split" title="合位(1): ${yx.one} / 分位(0): ${yx.zero}">
          <svg class="dash-yx-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="0" width="${p1.toFixed(1)}" height="10" fill="${pal.ok}"></rect>
            <rect x="${p1.toFixed(1)}" y="0" width="${p0.toFixed(1)}" height="10" fill="${pal.accent}" opacity="0.78"></rect>
            ${po > 0 ? `<rect x="${(p1 + p0).toFixed(1)}" y="0" width="${po.toFixed(1)}" height="10" fill="${pal.warn}"></rect>` : ""}
          </svg>
        </div>
      </div>`);
    }

    host.innerHTML = rows.join("");
  }

  // ==================== 7. 实时事件流与进程胶囊 ====================
  function renderFeed(data) {
    const procBar = $("dash-proc-bar");
    const list = $("dash-feed-list");
    const procs = data.processes || [];
    if (procBar) {
      if (procs.length) {
        procBar.hidden = false;
        procBar.innerHTML = procs
          .slice(0, 6)
          .map((p) => {
            const cls = p.status === 5 ? "is-err" : p.alive ? "is-ok" : "";
            return `<span class="dash-proc-pill ${cls}" title="PID ${p.pid || "—"} ${esc(p.error)}"><i></i>${esc(p.key)}</span>`;
          })
          .join("");
      } else {
        procBar.hidden = true;
      }
    }

    const evs = data.events || [];
    $("dash-feed-meta").textContent = `${evs.length} ${tr("条动态")}`;
    if (!evs.length) {
      list.innerHTML = `<div class="dash-empty">${esc(tr("运行平稳，暂无新动态"))}</div>`;
      return;
    }
    const relFn = window.scadaTableReconcile?.formatRelativeTime;
    list.innerHTML = evs
      .map((ev) => {
        const timeStr = relFn ? relFn(ev.time_ms, 0).text : new Date(ev.time_ms).toTimeString().slice(0, 8);
        return `<a class="dash-feed-item is-${esc(ev.severity || "info")}" href="${esc(ev.href || "/")}" data-feed-rtu="${esc(ev.rtu_id ?? "")}">
          <span class="dash-feed-cat">${esc(tr(ev.category || "动态"))}</span>
          <span class="dash-feed-main">
            <span class="dash-feed-title">${esc(ev.title || "")}</span>
            <span class="dash-feed-detail">${esc(ev.detail || "")}</span>
          </span>
          <span class="dash-feed-time">${esc(timeStr)}</span>
        </a>`;
      })
      .join("");
    list.querySelectorAll("[data-feed-rtu]").forEach((a) => {
      a.addEventListener("click", () => {
        const rid = a.dataset.feedRtu;
        if (rid && window.scadaFocusContext?.set) window.scadaFocusContext.set({ rtu_id: rid });
      });
    });
  }

  // ==================== 8. C 端专属：规约接入环形饼图（SVG Donut） ====================
  function renderProtocolDonut(data) {
    const svgHost = $("dash-donut-svg");
    const legHost = $("dash-donut-legend");
    if (!svgHost || !legHost) return;
    const pal = getPalette();
    const protos = data.protocols || [];
    const total = protos.reduce((acc, p) => acc + Number(p.count || 0), 0);
    if ($("dash-donut-meta")) $("dash-donut-meta").textContent = `${protos.length} ${tr("类规约")}`;
    if (!protos.length || !total) {
      svgHost.innerHTML = `<div class="dash-empty">—</div>`;
      legHost.innerHTML = "";
      return;
    }
    const r = 48;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const arcs = protos.slice(0, 5).map((p, idx) => {
      const share = Number(p.count || 0) / total;
      const len = Math.max(2, share * circ);
      const seg =
        `<circle cx="64" cy="64" r="${r}" fill="none" stroke="${pal.series[idx % pal.series.length]}" ` +
        `stroke-width="14" stroke-dasharray="${len.toFixed(1)} ${(circ - len).toFixed(1)}" ` +
        `stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 64 64)"></circle>`;
      offset += len;
      return seg;
    });
    svgHost.innerHTML =
      `<svg class="dash-donut-svg" viewBox="0 0 128 128" aria-label="规约分布">` +
      `<circle cx="64" cy="64" r="${r}" fill="none" stroke="${pal.bgSubtle}" stroke-width="14"></circle>` +
      arcs.join("") +
      `<text x="64" y="61" text-anchor="middle" fill="${pal.text}" font-size="20" font-weight="700" font-family="var(--font-mono)">${total}</text>` +
      `<text x="64" y="76" text-anchor="middle" fill="${pal.textSub}" font-size="9.5">${esc(tr("通道数"))}</text>` +
      `</svg>`;
    legHost.innerHTML = protos
      .slice(0, 5)
      .map((p, idx) => {
        const pct = Math.round((Number(p.count || 0) / total) * 100);
        return `<div class="dash-donut-row"><span class="dash-donut-name"><i class="dash-legend-swatch is-s${idx % 5}"></i>${esc(p.protocol.toUpperCase())}</span>` +
          `<span class="dash-donut-num">${p.count} (${pct}%)</span></div>`;
      })
      .join("");
  }

  // ==================== 9. S 端专属：多通道示波器 + 服务矩阵 + 客户端雷达 ====================
  function pushScopeSample(data) {
    if (!$("dash-scope-canvas")) return;
    const ycs = (data.top_yc || []).slice(0, 3);
    const sample = [0, 1, 2].map((i) => Number(ycs[i]?.value ?? 0));
    if (!state.scopeHistory.length) {
      for (let k = 0; k < 48; k++) state.scopeHistory.push(sample.slice());
    } else {
      state.scopeHistory.push(sample);
      if (state.scopeHistory.length > 60) state.scopeHistory.shift();
    }
  }

  function drawScopeCanvas() {
    const canvas = $("dash-scope-canvas");
    if (!canvas || !state.data) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 40) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const pal = getPalette();

    const ycs = (state.data.top_yc || []).slice(0, 3);
    const chLabels = [0, 1, 2].map((i) => ycs[i]?.name || `CH${i + 1}`);
    if ($("dash-scope-legend")) {
      $("dash-scope-legend").innerHTML = chLabels
        .map((n, i) => `<span class="dash-legend-item"><i class="dash-legend-swatch is-s${i}"></i>${esc(n.slice(0, 10))}</span>`)
        .join("");
    }
    if ($("dash-scope-readout")) {
      $("dash-scope-readout").innerHTML = [0, 1, 2]
        .map((i) => {
          const pt = ycs[i];
          const val = pt ? Number(pt.value || 0).toFixed(2) : "0.00";
          return `<span class="dash-scope-chip"><i class="dash-legend-swatch is-s${i}"></i>${esc(chLabels[i].slice(0, 12))} <b>${val}</b></span>`;
        })
        .join("");
    }

    ctx.clearRect(0, 0, W, H);
    const pad = { top: 10, right: 14, bottom: 14, left: 14 };
    const pw = Math.max(20, W - pad.left - pad.right);
    const ph = Math.max(20, H - pad.top - pad.bottom);

    // 精密示波器网格（8x4）
    ctx.strokeStyle = hexToRgba(pal.textMuted, pal.dark ? 0.16 : 0.22);
    ctx.lineWidth = 1;
    for (let x = 0; x <= 8; x++) {
      const gx = pad.left + (pw * x) / 8;
      ctx.beginPath();
      ctx.moveTo(gx, pad.top);
      ctx.lineTo(gx, pad.top + ph);
      ctx.stroke();
    }
    for (let y = 0; y <= 4; y++) {
      const gy = pad.top + (ph * y) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + pw, gy);
      ctx.stroke();
    }

    // 中央水平基准线
    ctx.strokeStyle = hexToRgba(pal.accent, 0.3);
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ph / 2);
    ctx.lineTo(pad.left + pw, pad.top + ph / 2);
    ctx.stroke();

    const N = 72;
    const hist = state.scopeHistory;
    const maxAbs = Math.max(1, ...hist.flat().map((v) => Math.abs(v)));
    const phase = state.scopePhase;

    [0, 1, 2].forEach((chIdx) => {
      const col = pal.series[chIdx];
      const baseVal = Number(ycs[chIdx]?.value ?? 0);
      const normBase = Math.max(-0.75, Math.min(0.75, baseVal / (maxAbs * 1.25)));
      ctx.beginPath();
      let lastX = pad.left;
      let lastY = pad.top + ph / 2;
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const x = pad.left + t * pw;
        let yNorm;
        if (state.scopeMode === "wave") {
          const freq = 1.6 + chIdx * 0.7;
          yNorm = Math.sin(t * Math.PI * 2 * freq - phase * (1 + chIdx * 0.25)) * (0.58 - chIdx * 0.12) + normBase * 0.25;
        } else {
          const hIdx = Math.min(hist.length - 1, Math.floor(t * Math.max(1, hist.length - 1)));
          const sampleVal = hist[hIdx]?.[chIdx] ?? baseVal;
          const micro = Math.sin(t * Math.PI * 6 - phase + chIdx * 2.1) * 0.035;
          yNorm = Math.max(-0.82, Math.min(0.82, sampleVal / (maxAbs * 1.2) + micro));
        }
        const y = pad.top + ph / 2 - yNorm * (ph * 0.44);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        lastX = x;
        lastY = y;
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(col, 0.28);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    });
  }

  function startScopeLoop() {
    if (!$("dash-scope-canvas")) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    let last = performance.now();
    const tick = (now) => {
      state.scopeAnimFrame = requestAnimationFrame(tick);
      if (document.hidden || !state.data) return;
      if (now - last < 45) return;
      const dt = (now - last) / 1000;
      last = now;
      state.scopePhase += dt * 1.8;
      drawScopeCanvas();
    };
    cancelAnimationFrame(state.scopeAnimFrame);
    state.scopeAnimFrame = requestAnimationFrame(tick);
  }

  function renderSimServiceMatrix(data) {
    const host = $("dash-svc-grid");
    if (!host) return;
    const chs = data.channels || [];
    const k = data.kpis || {};
    if ($("dash-svc-meta")) {
      $("dash-svc-meta").textContent = `${k.channels_running}/${k.channels_total} ${tr("运行中")}`;
    }
    if (!chs.length) {
      host.innerHTML = `<div class="dash-empty">${esc(tr("暂无仿真通道"))}</div>`;
      return;
    }
    host.innerHTML = chs
      .slice(0, 8)
      .map((c) => {
        const rid = c.rtu_id ?? c.id;
        return `<a class="dash-svc-card is-${esc(c.state)}" href="/test?rtu_id=${encodeURIComponent(rid)}" data-svc-rtu="${esc(rid)}">` +
          `<div class="dash-svc-head"><span class="dash-svc-name">${esc(c.name || `RTU ${rid}`)}</span>` +
          `<span class="dash-svc-proto">${esc(c.protocol || "—")}</span></div>` +
          `<div class="dash-svc-meta"><span>${fmtCompact(c.points)} ${esc(tr("点"))}</span><span>${c.clients} ${esc(tr("连接"))} · ${fmtCompact(c.rx + c.tx)}</span></div>` +
          `</a>`;
      })
      .join("");
    host.querySelectorAll("[data-svc-rtu]").forEach((a) => {
      a.addEventListener("click", () => {
        if (window.scadaFocusContext?.set) window.scadaFocusContext.set({ rtu_id: a.dataset.svcRtu });
      });
    });
  }

  function renderClientRadar(data) {
    const host = $("dash-radar-host");
    if (!host) return;
    const pal = getPalette();
    const cls = data.clients || [];
    const active = Number(data.kpis?.active_clients || 0);
    const blips = cls.slice(0, 6).map((c, idx) => {
      const ang = (idx * 62 + 25) * (Math.PI / 180);
      const rad = c.state === "online" ? 22 + (idx % 3) * 9 : 41;
      const bx = 55 + Math.cos(ang) * rad;
      const by = 55 + Math.sin(ang) * rad;
      const col = c.state === "online" ? pal.ok : pal.textMuted;
      return `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="3.2" fill="${col}"></circle>`;
    });
    host.innerHTML =
      `<svg class="dash-radar-svg" viewBox="0 0 110 110" aria-label="客户端雷达">` +
      `<circle cx="55" cy="55" r="48" fill="${pal.bgSubtle}" stroke="${pal.border}" stroke-width="1"></circle>` +
      `<circle cx="55" cy="55" r="32" fill="none" stroke="${pal.border}" stroke-dasharray="2 3"></circle>` +
      `<circle cx="55" cy="55" r="16" fill="none" stroke="${pal.border}" stroke-dasharray="2 3"></circle>` +
      `<line x1="7" y1="55" x2="103" y2="55" stroke="${pal.border}" stroke-width="0.8"></line>` +
      `<line x1="55" y1="7" x2="55" y2="103" stroke="${pal.border}" stroke-width="0.8"></line>` +
      `<path class="dash-radar-sweep" d="M 55 55 L 55 7 A 48 48 0 0 1 96 31 Z" fill="${hexToRgba(pal.ok, 0.2)}"></path>` +
      blips.join("") +
      `<circle cx="55" cy="55" r="3" fill="${pal.accent}"></circle>` +
      `</svg>` +
      `<span class="dash-radar-caption">${active} ${esc(tr("在线"))} / ${cls.length}</span>`;
  }

  // ==================== 10. T 端专属：桑基流量枢纽 + 双半圆保真仪 + 绿盾护航 ====================
  function renderSankeyHub(data) {
    const host = $("dash-sankey-host");
    if (!host) return;
    const pal = getPalette();
    const k = data.kpis || {};
    const sources = (data.source_rtus || []).slice(0, 5);
    const targets = (data.channels || []).slice(0, 5);
    if ($("dash-sankey-meta")) {
      $("dash-sankey-meta").textContent = `${sources.length} ${tr("源RTU")} → ${targets.length} ${tr("转发通道")} · ${fmtCompact(k.mapped_points)} ${tr("已映射")}`;
    }

    const W = 680;
    const H = 216;
    const leftX = 14;
    const boxW = 162;
    const midX = W / 2 - 22;
    const midW = 44;
    const rightX = W - boxW - 14;

    const leftList = sources.length
      ? sources.map((r) => ({
          title: `RTU ${r.rtu_id} ${r.name || ""}`.trim(),
          sub: `${(r.protocol || "—").toUpperCase()} · ${fmtCompact(r.points)}点`,
          weight: Math.max(1, r.points || 1),
          color: r.state === "error" ? pal.danger : r.state === "running" ? pal.ok : pal.accent,
          href: `/point-trace?rtu_id=${encodeURIComponent(r.rtu_id)}`,
          rtuId: r.rtu_id,
        }))
      : [{ title: tr("源采集池"), sub: `${fmtCompact(k.points_total)}点`, weight: 1, color: pal.accent, href: "/point-trace", rtuId: null }];

    const rightList = targets.length
      ? targets.map((ch) => ({
          title: ch.name || `转发通道 ${ch.id}`,
          sub: `${(ch.protocol || "iec104").toUpperCase()}${ch.bind_port ? ":" + ch.bind_port : ""} · ${fmtCompact(ch.mapped)}点`,
          weight: Math.max(1, ch.mapped || 1),
          color: ch.state === "error" ? pal.danger : ch.state === "running" ? pal.ok : pal.series[1],
          href: `/points?channel_id=${encodeURIComponent(ch.id)}`,
        }))
      : [
          { title: tr("待建转发通道"), sub: tr("点击前往通道数据"), weight: 1, color: pal.accent, href: "/channels" },
          { title: tr("全链路对账"), sub: `${fmtCompact(k.points_total)} ${tr("源测点")}`, weight: 1, color: pal.ok, href: "/point-trace" },
        ];

    const layoutCol = (arr) => {
      const gap = 8;
      const usable = H - 20 - gap * (arr.length - 1);
      const sumW = arr.reduce((a, b) => a + b.weight, 0);
      let curY = 10;
      return arr.map((it) => {
        const h = Math.max(28, Math.min(64, (it.weight / sumW) * usable));
        const res = { ...it, y: curY, h, cy: curY + h / 2 };
        curY += h + gap;
        return res;
      });
    };

    const L = layoutCol(leftList);
    const R = layoutCol(rightList);
    const midY = 24;
    const midH = H - 48;

    const ribbons = [];
    const boxes = [];

    L.forEach((n, i) => {
      const ty = midY + ((i + 0.5) / L.length) * midH;
      const bw = Math.max(3, Math.min(14, n.h * 0.28));
      const d = `M ${leftX + boxW} ${n.cy} C ${leftX + boxW + 68} ${n.cy}, ${midX - 68} ${ty}, ${midX} ${ty}`;
      ribbons.push(`<path d="${d}" fill="none" stroke="${hexToRgba(n.color, 0.24)}" stroke-width="${bw.toFixed(1)}" stroke-linecap="round"></path>`);
      ribbons.push(`<path class="dash-flow-pulse" d="${d}" stroke="${n.color}"></path>`);
      boxes.push(`
        <g class="dash-node-box" data-nav-href="${esc(n.href)}" data-nav-rtu="${esc(n.rtuId ?? "")}">
          <rect x="${leftX}" y="${n.y.toFixed(1)}" width="${boxW}" height="${n.h.toFixed(1)}" rx="7" fill="${pal.bgSubtle}" stroke="${n.color}" stroke-width="1.3"></rect>
          <text x="${leftX + 10}" y="${(n.y + n.h * 0.44).toFixed(1)}" fill="${pal.text}" font-size="11.5" font-weight="650">${esc(n.title.slice(0, 15))}</text>
          <text x="${leftX + 10}" y="${(n.y + n.h * 0.78).toFixed(1)}" fill="${pal.textSub}" font-size="9.8" font-family="var(--font-mono)">${esc(n.sub.slice(0, 22))}</text>
        </g>`);
    });

    R.forEach((n, i) => {
      const sy = midY + ((i + 0.5) / R.length) * midH;
      const bw = Math.max(3, Math.min(14, n.h * 0.28));
      const d = `M ${midX + midW} ${sy} C ${midX + midW + 68} ${sy}, ${rightX - 68} ${n.cy}, ${rightX} ${n.cy}`;
      ribbons.push(`<path d="${d}" fill="none" stroke="${hexToRgba(n.color, 0.24)}" stroke-width="${bw.toFixed(1)}" stroke-linecap="round"></path>`);
      ribbons.push(`<path class="dash-flow-pulse" d="${d}" stroke="${n.color}"></path>`);
      boxes.push(`
        <g class="dash-node-box" data-nav-href="${esc(n.href)}">
          <rect x="${rightX}" y="${n.y.toFixed(1)}" width="${boxW}" height="${n.h.toFixed(1)}" rx="7" fill="${pal.bgSubtle}" stroke="${n.color}" stroke-width="1.3"></rect>
          <text x="${rightX + 10}" y="${(n.y + n.h * 0.44).toFixed(1)}" fill="${pal.text}" font-size="11.5" font-weight="650">${esc(n.title.slice(0, 15))}</text>
          <text x="${rightX + 10}" y="${(n.y + n.h * 0.78).toFixed(1)}" fill="${pal.textSub}" font-size="9.8" font-family="var(--font-mono)">${esc(n.sub.slice(0, 22))}</text>
        </g>`);
    });

    host.innerHTML =
      `<svg class="dash-topo-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
      ribbons.join("") +
      `<rect x="${midX}" y="${midY}" width="${midW}" height="${midH}" rx="10" fill="${hexToRgba(pal.accent, 0.16)}" stroke="${pal.accent}" stroke-width="1.8"></rect>` +
      `<text x="${W / 2}" y="${H / 2 - 4}" text-anchor="middle" fill="${pal.text}" font-size="11" font-weight="700" font-family="var(--font-mono)">scdfe_t</text>` +
      `<text x="${W / 2}" y="${H / 2 + 12}" text-anchor="middle" fill="${pal.accent}" font-size="9.5" font-weight="600">${esc(tr("转发枢纽"))}</text>` +
      boxes.join("") +
      `</svg>`;

    host.querySelectorAll("[data-nav-href]").forEach((g) => {
      g.addEventListener("click", () => {
        const rid = g.dataset.navRtu;
        if (rid && window.scadaFocusContext?.set) window.scadaFocusContext.set({ rtu_id: rid });
        if (g.dataset.navHref) location.href = g.dataset.navHref;
      });
    });
  }

  function renderSemiGauges(data) {
    const host = $("dash-semi-svg");
    if (!host) return;
    const pal = getPalette();
    const k = data.kpis || {};
    const cov = k.points_total > 0 ? Math.min(100, Math.round((k.mapped_points / k.points_total) * 100)) : 0;
    const fid = k.mapped_points > 0 ? Math.max(0, Math.round(((k.mapped_points - k.diff_points) / k.mapped_points) * 100)) : 100;
    if ($("dash-semi-meta")) $("dash-semi-meta").textContent = `${fmtCompact(k.mapped_points)}/${fmtCompact(k.points_total)}`;

    const semi = (pct, label, color) => {
      const r = 46;
      const len = Math.PI * r;
      const off = len * (1 - Math.max(0, Math.min(100, pct)) / 100);
      return `<svg class="dash-semi-svg" viewBox="0 0 140 76" aria-label="${esc(label)} ${pct}%">` +
        `<path d="M 24 64 A 46 46 0 0 1 116 64" fill="none" stroke="${pal.bgSubtle}" stroke-width="10" stroke-linecap="round"></path>` +
        `<path class="dash-gauge-arc" d="M 24 64 A 46 46 0 0 1 116 64" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></path>` +
        `<text x="70" y="54" text-anchor="middle" fill="${pal.text}" font-size="18" font-weight="700" font-family="var(--font-mono)">${pct}%</text>` +
        `<text x="70" y="70" text-anchor="middle" fill="${pal.textSub}" font-size="10">${esc(tr(label))}</text>` +
        `</svg>`;
    };

    host.innerHTML =
      semi(cov, "映射覆盖率", pal.accent) +
      semi(fid, "零偏差保真度", k.diff_points > 0 ? pal.warn : pal.ok);

    if ($("dash-gauge-stats")) {
      $("dash-gauge-stats").innerHTML = [
        { val: k.channels_running, label: "监听通道", cls: "is-ok" },
        { val: k.diff_points, label: "偏差点", cls: k.diff_points ? "is-warn" : "is-ok" },
        { val: k.active_clients, label: "主站连接", cls: "" },
      ]
        .map((s) => `<div class="dash-mini-stat ${s.cls}"><b>${fmtCompact(s.val)}</b><span>${esc(tr(s.label))}</span></div>`)
        .join("");
    }
  }

  function renderShieldBanner(data) {
    const host = $("dash-shield-banner");
    if (!host) return;
    const k = data.kpis || {};
    const diffs = Number(k.diff_points || 0);
    if (diffs > 0) {
      host.className = "dash-shield-banner is-warn";
      host.innerHTML = `<span>⚠ ${esc(tr("发现对账偏差"))} ${diffs} ${esc(tr("点"))}</span><a class="dash-shield-link" href="/point-trace?anomaly_only=1">${esc(tr("排查 ↗"))}</a>`;
    } else {
      host.className = "dash-shield-banner";
      host.innerHTML = `<span>✓ ${esc(tr("全链路零偏差"))} · ${fmtCompact(k.mapped_points)} ${esc(tr("点已保真"))}</span><a class="dash-shield-link" href="/point-trace">${esc(tr("对账 ↗"))}</a>`;
    }
  }

  // ==================== 11. 全域三端融合总控大屏渲染器（S + C + T） ====================
  function renderAllDashboard(payload, firstPaint = false) {
    if (!payload) return;
    const pal = getPalette();
    const s = payload.s || {};
    const c = payload.c || {};
    const t = payload.t || {};
    const sk = s.kpis || {};
    const ck = c.kpis || {};
    const tk = t.kpis || {};
    const svcs = payload.services || {};

    // 1. 顶部全域 KPI 串
    const dot = $("dash-live-dot");
    const totalAlerts = Number(sk.alerts_total || 0) + Number(ck.alerts_total || 0);
    if (dot) dot.className = "dash-live-dot" + (totalAlerts > 0 ? " is-err" : "");
    const kpiItems = [
      { key: "score", label: "综合健康", val: payload.overall_score, cls: payload.overall_score >= 85 ? "is-ok" : "is-warn", raw: payload.overall_score, unit: "分" },
      { key: "s_ch", label: "仿真 S", val: `${sk.channels_running}/${sk.channels_total}`, cls: "is-accent", raw: null },
      { key: "c_ch", label: "采集 C", val: `${ck.channels_running}/${ck.channels_total}`, cls: ck.channels_error ? "is-err" : "is-ok", raw: null },
      { key: "t_ch", label: "转发 T", val: `${tk.channels_running}/${tk.channels_total}`, cls: "is-ok", raw: null },
      { key: "pts", label: "全域测点", val: ck.points_total + sk.points_total, cls: "is-accent", raw: ck.points_total + sk.points_total },
      { key: "diff", label: "对账偏差", val: tk.diff_points, cls: tk.diff_points > 0 ? "is-warn" : "is-ok", raw: tk.diff_points },
      { key: "alerts", label: "全域告警", val: totalAlerts, cls: totalAlerts > 0 ? "is-err" : "is-ok", raw: totalAlerts },
    ];
    const kpiHost = $("dash-kpis");
    if (kpiHost) {
      if (kpiHost.dataset.comp !== "all") {
        kpiHost.dataset.comp = "all";
        kpiHost.innerHTML = kpiItems
          .map(
            (it) =>
              `<div class="dash-kpi-item"><span class="dash-kpi-label">${esc(tr(it.label))}</span>` +
              `<span class="dash-kpi-val ${it.cls}" data-kpi-key="${it.key}">${esc(it.raw === null ? it.val : fmtCompact(it.raw))}</span>` +
              (it.unit ? `<span class="dash-kpi-unit">${esc(tr(it.unit))}</span>` : "") +
              `</div>`,
          )
          .join("");
      }
      kpiItems.forEach((it) => {
        const el = kpiHost.querySelector(`[data-kpi-key="${it.key}"]`);
        if (!el) return;
        el.className = `dash-kpi-val ${it.cls}`;
        if (it.raw === null) el.textContent = it.val;
        else animateElementNumber(el, `all:${it.key}`, it.raw);
      });
    }

    // 绑定三柱直达各端大屏链接
    if ($("dash-all-link-s") && svcs.s?.dashboard_url) $("dash-all-link-s").href = svcs.s.dashboard_url;
    if ($("dash-all-link-c") && svcs.c?.dashboard_url) $("dash-all-link-c").href = svcs.c.dashboard_url;
    if ($("dash-all-link-t") && svcs.t?.dashboard_url) $("dash-all-link-t").href = svcs.t.dashboard_url;

    // 2. 上左：S -> C -> T 全域端到端实时脉冲总线拓扑 SVG
    const busHost = $("dash-all-bus-host");
    if (busHost) {
      const onlineCount = ["s", "c", "t"].filter((k) => svcs[k]?.online).length;
      if ($("dash-all-bus-meta")) $("dash-all-bus-meta").textContent = `${onlineCount}/3 ${tr("服务在线")} · ${fmtCompact(ck.rx_total + sk.rx_total + tk.tx_total)} ${tr("总帧")}`;
      const W = 740;
      const H = 212;
      const cards = [
        {
          key: "s",
          x: 18,
          title: "scdfe_s · 规约仿真",
          sub1: `服务 ${sk.channels_running}/${sk.channels_total} · 测点 ${fmtCompact(sk.points_total)}`,
          sub2: `接入客户端 ${sk.active_clients} · 健康 ${s.health_score ?? 100}`,
          color: pal.series[0],
          online: Boolean(svcs.s?.online),
          href: svcs.s?.dashboard_url || "/dashboard",
        },
        {
          key: "c",
          x: 274,
          title: "scdfe_c · 实时采集",
          sub1: `RTU ${ck.channels_running}/${ck.channels_total} · 四遥 ${fmtCompact(ck.points_total)}`,
          sub2: `收 ${fmtCompact(ck.rx_total)} · 发 ${fmtCompact(ck.tx_total)} · 异常 ${ck.channels_error}`,
          color: ck.channels_error > 0 ? pal.warn : pal.ok,
          online: Boolean(svcs.c?.online),
          href: svcs.c?.dashboard_url || "/dashboard",
        },
        {
          key: "t",
          x: 530,
          title: "scdfe_t · 四遥转发",
          sub1: `通道 ${tk.channels_running}/${tk.channels_total} · 映射 ${fmtCompact(tk.mapped_points)}`,
          sub2: `偏差 ${tk.diff_points} · 在线主站 ${tk.active_clients}`,
          color: tk.diff_points > 0 ? pal.warn : pal.series[1],
          online: Boolean(svcs.t?.online),
          href: svcs.t?.dashboard_url || "/dashboard",
        },
      ];
      const cw = 192;
      const ch = 112;
      const cy = (H - ch) / 2;
      const midY = H / 2;
      const link1 = `M ${18 + cw} ${midY} C ${18 + cw + 22} ${midY - 18}, ${274 - 22} ${midY + 18}, 274 ${midY}`;
      const link2 = `M ${274 + cw} ${midY} C ${274 + cw + 22} ${midY - 18}, ${530 - 22} ${midY + 18}, 530 ${midY}`;
      const back1 = `M 274 ${midY + 26} C ${274 - 24} ${midY + 34}, ${18 + cw + 24} ${midY + 34}, ${18 + cw} ${midY + 26}`;
      const back2 = `M 530 ${midY + 26} C ${530 - 24} ${midY + 34}, ${274 + cw + 24} ${midY + 34}, ${274 + cw} ${midY + 26}`;

      busHost.innerHTML =
        `<svg class="dash-topo-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
        `<path d="${link1}" fill="none" stroke="${hexToRgba(pal.series[0], 0.25)}" stroke-width="10" stroke-linecap="round"></path>` +
        `<path class="dash-flow-pulse" d="${link1}" stroke="${pal.series[0]}"></path>` +
        `<path d="${link2}" fill="none" stroke="${hexToRgba(pal.ok, 0.25)}" stroke-width="10" stroke-linecap="round"></path>` +
        `<path class="dash-flow-pulse" d="${link2}" stroke="${pal.ok}"></path>` +
        `<path class="dash-flow-pulse is-slow" d="${back1}" stroke="${pal.warn}"></path>` +
        `<path class="dash-flow-pulse is-slow" d="${back2}" stroke="${pal.warn}"></path>` +
        `<text x="242" y="${midY - 22}" text-anchor="middle" fill="${pal.textSub}" font-size="9.5">${esc(tr("采集链路"))}</text>` +
        `<text x="498" y="${midY - 22}" text-anchor="middle" fill="${pal.textSub}" font-size="9.5">${esc(tr("转发映射"))}</text>` +
        `<text x="242" y="${midY + 46}" text-anchor="middle" fill="${pal.textMuted}" font-size="9">${esc(tr("遥控/遥调"))}</text>` +
        `<text x="498" y="${midY + 46}" text-anchor="middle" fill="${pal.textMuted}" font-size="9">${esc(tr("上行指令"))}</text>` +
        cards
          .map(
            (card) => `
          <g class="dash-node-box" data-nav-href="${esc(card.href)}">
            <rect x="${card.x}" y="${cy}" width="${cw}" height="${ch}" rx="12" fill="${pal.bgSubtle}" stroke="${card.color}" stroke-width="1.6"></rect>
            <rect x="${card.x}" y="${cy}" width="${cw}" height="28" rx="12" fill="${hexToRgba(card.color, 0.16)}"></rect>
            <circle cx="${card.x + 14}" cy="${cy + 14}" r="4" fill="${card.online ? pal.ok : pal.danger}"></circle>
            <text x="${card.x + 24}" y="${cy + 18}" fill="${pal.text}" font-size="11.5" font-weight="700">${esc(tr(card.title))}</text>
            <text x="${card.x + 12}" y="${cy + 52}" fill="${pal.text}" font-size="11" font-family="var(--font-mono)">${esc(card.sub1)}</text>
            <text x="${card.x + 12}" y="${cy + 74}" fill="${pal.textSub}" font-size="10.2" font-family="var(--font-mono)">${esc(card.sub2)}</text>
            <text x="${card.x + cw - 12}" y="${cy + 98}" text-anchor="end" fill="${card.color}" font-size="10" font-weight="600">${esc(tr("进入单端大屏 ↗"))}</text>
          </g>`,
          )
          .join("") +
        `</svg>`;
      busHost.querySelectorAll("[data-nav-href]").forEach((g) => {
        g.addEventListener("click", () => {
          if (g.dataset.navHref) location.href = g.dataset.navHref;
        });
      });
    }

    // 3. 上右：三端同心三环综合健康仪
    const ringHost = $("dash-all-ring-svg");
    if (ringHost) {
      const sScore = Number(s.health_score ?? 100);
      const cScore = Number(c.health_score ?? 100);
      const tScore = tk.mapped_points > 0 ? Math.max(0, Math.round(((tk.mapped_points - tk.diff_points) / tk.mapped_points) * 100)) : Number(t.health_score ?? 100);
      if ($("dash-all-ring-meta")) $("dash-all-ring-meta").textContent = `C ${cScore} · S ${sScore} · T ${tScore}`;
      const mkRing = (r, sw, pct, col) => {
        const len = 2 * Math.PI * r;
        const off = len * (1 - Math.max(0, Math.min(100, pct)) / 100);
        return (
          `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${pal.bgSubtle}" stroke-width="${sw}"></circle>` +
          `<circle class="dash-gauge-arc" cx="90" cy="90" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" ` +
          `stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 90 90)"></circle>`
        );
      };
      ringHost.innerHTML =
        `<svg class="dash-gauge-svg" viewBox="0 0 180 180" aria-label="三端综合健康">` +
        `<circle class="dash-gauge-orbit" cx="90" cy="90" r="82" fill="none" stroke="${pal.border}" stroke-width="1" stroke-dasharray="3 6"></circle>` +
        mkRing(70, 8, cScore, pal.ok) +
        mkRing(56, 7, sScore, pal.accent) +
        mkRing(43, 6, tScore, pal.warn) +
        `<text x="90" y="88" text-anchor="middle" fill="${pal.text}" font-size="26" font-weight="700" font-family="var(--font-mono)">${payload.overall_score}</text>` +
        `<text x="90" y="105" text-anchor="middle" fill="${pal.textSub}" font-size="10">${esc(tr("三端综合分"))}</text>` +
        `</svg>`;
    }
    const pillsHost = $("dash-all-svc-pills");
    if (pillsHost) {
      pillsHost.innerHTML = [
        { k: "s", label: "仿真 S", online: svcs.s?.online, href: svcs.s?.dashboard_url || "/dashboard" },
        { k: "c", label: "采集 C", online: svcs.c?.online, href: svcs.c?.dashboard_url || "/dashboard" },
        { k: "t", label: "转发 T", online: svcs.t?.online, href: svcs.t?.dashboard_url || "/dashboard" },
      ]
        .map(
          (p) =>
            `<a class="dash-mini-stat dash-all-svc-pill ${p.online ? "is-ok" : "is-err"}" href="${esc(p.href)}">` +
            `<b>${p.online ? "ON" : "OFF"}</b><span>${esc(tr(p.label))}</span></a>`,
        )
        .join("");
    }

    // 4. 下左柱：仿真端 S（迷你示波器 + 紧凑 LED 灯阵）
    state.data = s;
    pushScopeSample(s);
    drawScopeCanvas();
    const sSub = $("dash-all-s-summary");
    if (sSub) {
      const yxList = (s.yx_matrix || []).slice(0, 12);
      const yx = s.yx_state || { zero: 0, one: 0, other: 0 };
      const yxTotal = yx.zero + yx.one + yx.other;
      const p1 = yxTotal ? (yx.one / yxTotal) * 100 : 0;
      const p0 = yxTotal ? (yx.zero / yxTotal) * 100 : 0;
      sSub.innerHTML =
        `<div class="dash-all-led-mini">` +
        yxList
          .map((pt) => {
            const cls = pt.value === 1 || pt.value === 1.0 ? "is-on" : "";
            return `<div class="dash-led-cell ${cls}" title="${esc(pt.name)} = ${esc(pt.value ?? "—")}"><i class="dash-led-lamp"></i><span class="dash-led-label">#${pt.pnt_no}</span></div>`;
          })
          .join("") +
        `</div>` +
        `<div class="dash-hbar-row"><div class="dash-hbar-head"><span class="dash-hbar-name">${esc(tr("仿真遥信 1/0"))}</span>` +
        `<span class="dash-hbar-num">${fmtCompact(yx.one)} / ${fmtCompact(yx.zero)}</span></div>` +
        `<div class="dash-yx-split"><svg class="dash-yx-svg" viewBox="0 0 100 10" preserveAspectRatio="none">` +
        `<rect x="0" y="0" width="${p1.toFixed(1)}" height="10" fill="${pal.ok}"></rect>` +
        `<rect x="${p1.toFixed(1)}" y="0" width="${p0.toFixed(1)}" height="10" fill="${pal.accent}" opacity="0.78"></rect>` +
        `</svg></div></div>`;
    }

    // 5. 下中柱：采集端 C（实时吞吐双曲线 + 四遥 SVG 棒图）
    state.component = "c";
    pushTrendPoint(c);
    drawTrendCanvas();
    const cBars = $("dash-all-c-bars");
    if (cBars) {
      const pbk = c.points_by_kind || {};
      const kinds = [
        { k: "yc", l: "遥测 YC", col: pal.series[0] },
        { k: "yx", l: "遥信 YX", col: pal.series[1] },
        { k: "yt", l: "遥调 YT", col: pal.series[2] },
        { k: "yk", l: "遥控 YK", col: pal.series[3] },
      ];
      const maxP = Math.max(1, ...kinds.map((x) => Number(pbk[x.k] || 0)));
      cBars.innerHTML = kinds
        .map((x) => {
          const n = Number(pbk[x.k] || 0);
          const pct = n > 0 ? Math.max(4, (n / maxP) * 100) : 0;
          return `<div class="dash-hbar-row"><div class="dash-hbar-head"><span class="dash-hbar-name">${esc(tr(x.l))}</span>` +
            `<span class="dash-hbar-num">${fmtCompact(n)}</span></div><div class="dash-hbar-track">${svgBarMarkup(pct, x.col)}</div></div>`;
        })
        .join("");
    }

    // 6. 下右柱：转发端 T（保真绿盾 + 紧凑覆盖棒图 + 三端合并事件流）
    renderShieldBanner(t);
    const tBars = $("dash-all-t-bars");
    if (tBars) {
      const mbk = t.mapping_by_kind || {};
      tBars.innerHTML = [
        { k: "yc", l: "YC 映射", col: pal.series[0] },
        { k: "yx", l: "YX 映射", col: pal.series[1] },
      ]
        .map((x) => {
          const rec = mbk[x.k] || { total: 0, mapped: 0 };
          const pct = rec.total > 0 ? Math.min(100, (rec.mapped / rec.total) * 100) : 0;
          return `<div class="dash-hbar-row"><div class="dash-hbar-head"><span class="dash-hbar-name">${esc(tr(x.l))}</span>` +
            `<span class="dash-hbar-num">${fmtCompact(rec.mapped)} / ${fmtCompact(rec.total)} (${pct.toFixed(0)}%)</span></div>` +
            `<div class="dash-hbar-track">${svgBarMarkup(Math.max(pct, rec.mapped ? 4 : 0), x.col)}</div></div>`;
        })
        .join("");
    }
    const feedList = $("dash-feed-list");
    if (feedList) {
      const evs = payload.merged_events || [];
      const relFn = window.scadaTableReconcile?.formatRelativeTime;
      feedList.innerHTML = evs.length
        ? evs
            .slice(0, 6)
            .map((ev) => {
              const tStr = relFn ? relFn(ev.time_ms, 0).text : new Date(ev.time_ms).toTimeString().slice(0, 8);
              return `<a class="dash-feed-item is-${esc(ev.severity || "info")}" href="${esc(ev.href || "/")}">` +
                `<span class="dash-feed-cat">${esc(tr(ev.source_label || ev.category || "动态"))}</span>` +
                `<span class="dash-feed-main"><span class="dash-feed-title">${esc(ev.title || "")}</span>` +
                `<span class="dash-feed-detail">${esc(ev.detail || "")}</span></span>` +
                `<span class="dash-feed-time">${esc(tStr)}</span></a>`;
            })
            .join("")
        : `<div class="dash-empty">${esc(tr("三端运行平稳，暂无新动态"))}</div>`;
    }
  }

  function renderAll(firstPaint = false) {
    if (state.isAllMode) {
      if (state.allData) renderAllDashboard(state.allData, firstPaint);
      return;
    }
    if (!state.data) return;
    renderStrip(state.data);
    renderGauge(state.data);
    renderProtocolDonut(state.data);
    renderTopology(state.data);
    renderSimServiceMatrix(state.data);
    renderClientRadar(state.data);
    renderSankeyHub(state.data);
    renderSemiGauges(state.data);
    renderShieldBanner(state.data);
    drawScopeCanvas();
    drawTrendCanvas();
    if (firstPaint) triggerBarGrow();
    else drawBarCanvas();
    renderHorizontalBars(state.data);
    renderFeed(state.data);
  }

  async function loadOverview() {
    if (state.abort) state.abort.abort();
    state.abort = typeof AbortController === "function" ? new AbortController() : null;
    try {
      const endpoint = state.isAllMode ? "/api/dashboard-all" : "/api/dashboard-overview";
      const resp = await fetch(endpoint, {
        cache: "no-cache",
        signal: state.abort?.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (state.isAllMode) {
        const firstPaint = !state.allData;
        const payload = await resp.json();
        state.allData = payload;
        renderAllDashboard(payload, firstPaint);
        return;
      }
      const firstPaint = !state.data;
      const data = await resp.json();
      state.component = data.component || state.component;
      state.data = data;
      pushTrendPoint(data);
      pushScopeSample(data);
      renderAll(firstPaint);
    } catch (err) {
      if (err?.name === "AbortError") return;
      const meta = $("dash-all-bus-meta") || $("dash-topo-meta") || $("dash-sankey-meta") || $("dash-svc-meta");
      if (meta) meta.textContent = err.message || "加载失败";
    }
  }

  // ==================== Canvas 交互（十字准星 Tooltip & 点击穿透） ====================
  function bindCanvasInteractions() {
    const trendCanvas = $("dash-trend-canvas");
    const trendTip = $("dash-trend-tip");
    trendCanvas?.addEventListener("mousemove", (ev) => {
      const pts = state.trendHistory;
      if (!pts.length) return;
      const rect = trendCanvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const padL = 36;
      const padR = 12;
      const ratio = Math.max(0, Math.min(1, (x - padL) / Math.max(1, rect.width - padL - padR)));
      const idx = Math.round(ratio * (pts.length - 1));
      if (idx !== state.trendHoverIdx) {
        state.trendHoverIdx = idx;
        drawTrendCanvas();
      }
      const p = pts[idx];
      trendTip.hidden = false;
      trendTip.innerHTML = `<strong>${esc(p.label)}</strong><br>RX ${p.rx}/s · TX ${p.tx}/s`;
      trendTip.style.left = Math.min(rect.width - 135, Math.max(8, x + 10)) + "px";
      trendTip.style.top = Math.max(6, ev.clientY - rect.top - 36) + "px";
    });
    trendCanvas?.addEventListener("mouseleave", () => {
      state.trendHoverIdx = -1;
      if (trendTip) trendTip.hidden = true;
      drawTrendCanvas();
    });

    const barCanvas = $("dash-bar-canvas");
    const barTip = $("dash-bar-tip");
    barCanvas?.addEventListener("mousemove", (ev) => {
      const rect = barCanvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const hitIdx = state.barHitboxes.findIndex((b) => x >= b.x1 && x <= b.x2);
      if (hitIdx !== state.barHoverIdx) {
        state.barHoverIdx = hitIdx;
        drawBarCanvas();
      }
      if (hitIdx >= 0) {
        const h = state.barHitboxes[hitIdx];
        barTip.hidden = false;
        const n1 = h.legendNames[0] || "值1";
        const n2 = h.legendNames[1];
        barTip.innerHTML =
          `<strong>${esc(h.item.full || h.item.label)}</strong><br>` +
          `${esc(n1)}: ${fmtCompact(h.item.v1)}` +
          (n2 ? ` · ${esc(n2)}: ${fmtCompact(h.item.v2)}` : "");
        barTip.style.left = Math.min(rect.width - 150, Math.max(8, x + 10)) + "px";
        barTip.style.top = Math.max(6, ev.clientY - rect.top - 38) + "px";
      } else {
        barTip.hidden = true;
      }
    });
    barCanvas?.addEventListener("mouseleave", () => {
      state.barHoverIdx = -1;
      if (barTip) barTip.hidden = true;
      drawBarCanvas();
    });
    barCanvas?.addEventListener("click", () => {
      if (state.barHoverIdx < 0) return;
      const h = state.barHitboxes[state.barHoverIdx];
      if (!h) return;
      if (h.item.rtuId != null && window.scadaFocusContext?.set) {
        window.scadaFocusContext.set({ rtu_id: String(h.item.rtuId) });
      }
      if (h.item.href) location.href = h.item.href;
    });
  }

  // ==================== 大屏全屏模式 / 时钟 / 定时器 / 主题响应 ====================
  function toggleFullscreen() {
    const active = document.body.classList.toggle("dash-fullscreen");
    const btn = $("dash-fullscreen");
    if (btn) btn.textContent = tr(active ? "退出大屏" : "大屏模式");
    try {
      if (active && document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (!active && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      drawTrendCanvas();
      drawBarCanvas();
    }, 80);
  }

  function scheduleRefresh(ms) {
    state.intervalMs = Number(ms);
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.intervalMs > 0) {
      state.timer = setInterval(() => {
        if (!document.hidden) loadOverview();
      }, state.intervalMs);
    }
  }

  function tickClock() {
    const el = $("dash-clock");
    if (el) el.textContent = new Date().toTimeString().slice(0, 8);
  }

  function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    bindCanvasInteractions();

    $("dash-refresh")?.addEventListener("click", () => loadOverview());
    $("dash-fullscreen")?.addEventListener("click", toggleFullscreen);
    $("dash-interval")?.addEventListener("change", (ev) => scheduleRefresh(Number(ev.target.value)));

    $("dash-hbar-tabs")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-hbar-tab]");
      if (!btn) return;
      state.hbarTab = btn.dataset.hbarTab;
      $("dash-hbar-tabs").querySelectorAll("button").forEach((b) => {
        const act = b.dataset.hbarTab === state.hbarTab;
        b.classList.toggle("is-active", act);
        b.setAttribute("aria-selected", String(act));
      });
      if (state.data) renderHorizontalBars(state.data);
    });

    $("dash-scope-tabs")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-scope-mode]");
      if (!btn) return;
      state.scopeMode = btn.dataset.scopeMode;
      $("dash-scope-tabs").querySelectorAll("button").forEach((b) => {
        const act = b.dataset.scopeMode === state.scopeMode;
        b.classList.toggle("is-active", act);
        b.setAttribute("aria-selected", String(act));
      });
      drawScopeCanvas();
    });

    $("dash-t-left-tabs")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-tleft-tab]");
      if (!btn) return;
      state.tLeftTab = btn.dataset.tleftTab;
      $("dash-t-left-tabs").querySelectorAll("button").forEach((b) => {
        const act = b.dataset.tleftTab === state.tLeftTab;
        b.classList.toggle("is-active", act);
        b.setAttribute("aria-selected", String(act));
      });
      if ($("dash-hbar-host")) $("dash-hbar-host").hidden = state.tLeftTab !== "bars";
      if ($("dash-t-bar-box")) $("dash-t-bar-box").hidden = state.tLeftTab !== "cols";
      if (state.tLeftTab === "cols") triggerBarGrow();
    });

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && document.body.classList.contains("dash-fullscreen")) {
        document.body.classList.remove("dash-fullscreen");
        const btn = $("dash-fullscreen");
        if (btn) btn.textContent = tr("大屏模式");
      }
      drawScopeCanvas();
      drawTrendCanvas();
      drawBarCanvas();
    });

    document.addEventListener("keydown", (ev) => {
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.querySelector("dialog[open]")) return;
      if ((ev.key === "f" || ev.key === "F") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        toggleFullscreen();
      } else if (ev.key === "Escape" && document.body.classList.contains("dash-fullscreen")) {
        toggleFullscreen();
      }
    });

    document.addEventListener("scada:theme-change", () => renderAll(false));
    document.addEventListener("scada:lang-change", () => renderAll(false));

    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => {
        drawScopeCanvas();
        drawTrendCanvas();
        drawBarCanvas();
      });
      const root = $("dash-root");
      if (root) ro.observe(root);
    } else {
      window.addEventListener("resize", () => {
        drawScopeCanvas();
        drawTrendCanvas();
        drawBarCanvas();
      });
    }

    startScopeLoop();
    scheduleRefresh(2000);
    loadOverview();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
