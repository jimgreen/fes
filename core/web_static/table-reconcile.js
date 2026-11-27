/* 共享表格单元格级增量更新、数值跳变微光反馈、相对时差与状态品质语义化工具。 */
(function () {
  "use strict";

  const FLASH_CLASSES = ["scada-flash-up", "scada-flash-down", "scada-flash-change", "scada-flash-warn"];

  function parseRowCells(trMarkup) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const tpl = document.createElement("template");
    tpl.innerHTML = "<table><tbody>" + trMarkup + "</tbody></table>";
    const tr = tpl.content?.querySelector("tr");
    return tr ? Array.from(tr.cells) : null;
  }

  function triggerFlash(cell, cls) {
    if (!cell || !cls || !cell.classList) return;
    cell.classList.remove(...FLASH_CLASSES);
    // 强制重排以重新触发短动画
    void cell.offsetWidth;
    cell.classList.add(cls);
  }

  function diffWatchKind(prevCell, nextCell) {
    const prevRaw = prevCell?.getAttribute?.("data-watch-val");
    const nextRaw = nextCell?.getAttribute?.("data-watch-val");
    if (prevRaw == null || nextRaw == null || prevRaw === nextRaw) return "";
    const mode = nextCell.getAttribute("data-watch-mode") || "auto";
    if (mode === "warn") {
      const a = Number(prevRaw);
      const b = Number(nextRaw);
      return Number.isFinite(a) && Number.isFinite(b) && b > a ? "scada-flash-warn" : "scada-flash-change";
    }
    const a = Number(prevRaw);
    const b = Number(nextRaw);
    if (prevRaw !== "" && nextRaw !== "" && Number.isFinite(a) && Number.isFinite(b)) {
      if (b > a) return "scada-flash-up";
      if (b < a) return "scada-flash-down";
    }
    return "scada-flash-change";
  }

  /**
   * 增量更新 tbody：尽量按单元格 diff 替换以保住焦点/滚动/文本选中，并对带 data-watch-val 的变化单元触发微光反馈。
   */
  function reconcileBody(body, rows, cache, options = {}) {
    if (!body) return;
    const patchCells = Boolean(options.patchCells);
    const flash = options.flash !== false;
    const prevRows = Array.isArray(cache.rows) ? cache.rows : [];
    const changed = [];
    if (rows.length === prevRows.length) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] !== prevRows[i]) changed.push(i);
      }
    }
    if (!changed.length && rows.length === prevRows.length) return;

    const canPatch =
      patchCells &&
      changed.length > 0 &&
      rows.length === prevRows.length &&
      body.rows &&
      body.rows.length === rows.length;

    let cellUpdates = null;
    if (canPatch) {
      const updates = [];
      let totalCells = 0;
      let valid = true;
      for (const index of changed) {
        const existingCells = Array.from(body.rows[index]?.cells || []);
        const nextCells = parseRowCells(rows[index]);
        if (!nextCells || !nextCells.length || nextCells.length !== existingCells.length) {
          valid = false;
          break;
        }
        totalCells += nextCells.length;
        for (let col = 0; col < nextCells.length; col++) {
          const cur = existingCells[col];
          const nxt = nextCells[col];
          // 忽略已附加的瞬态 flash class 比较
          const curClean = cur.outerHTML.replace(/\s*scada-flash-(?:up|down|change|warn)/g, "");
          const nxtClean = nxt.outerHTML;
          if (curClean !== nxtClean) {
            const flashCls = flash ? diffWatchKind(cur, nxt) : "";
            updates.push([index, col, nxt, flashCls]);
          }
        }
      }
      if (valid && totalCells > 0 && updates.length <= Math.max(8, totalCells / 2)) {
        cellUpdates = updates;
      }
    }

    if (cellUpdates) {
      for (const [row, col, cell, flashCls] of cellUpdates) {
        const target = body.rows[row]?.cells?.[col];
        if (!target) continue;
        target.replaceWith(cell);
        if (flashCls) triggerFlash(cell, flashCls);
      }
    } else if (rows.length !== prevRows.length || changed.length > rows.length / 3) {
      body.innerHTML = rows.join("");
    } else {
      for (const index of changed) {
        const oldRow = body.children[index];
        if (!oldRow) continue;
        const nextCells = flash ? parseRowCells(rows[index]) : null;
        const flashList = [];
        if (nextCells && oldRow.cells && oldRow.cells.length === nextCells.length) {
          for (let col = 0; col < nextCells.length; col++) {
            const cls = diffWatchKind(oldRow.cells[col], nextCells[col]);
            if (cls) flashList.push([col, cls]);
          }
        }
        oldRow.outerHTML = rows[index];
        const inserted = body.children[index];
        if (inserted && flashList.length) {
          for (const [col, cls] of flashList) {
            triggerFlash(inserted.cells?.[col], cls);
          }
        }
      }
    }
    cache.rows = rows.slice();
  }

  /** 将时间戳/日期字符串解析为毫秒时间戳。 */
  function parseTimestampMs(raw) {
    if (raw === null || raw === undefined || raw === "" || raw === 0 || raw === "0") return 0;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      if (raw <= 0) return 0;
      return raw < 1e11 ? raw * 1000 : raw;
    }
    const text = String(raw).trim();
    if (!text) return 0;
    if (/^\d{10,13}$/.test(text)) {
      const num = Number(text);
      return text.length <= 10 ? num * 1000 : num;
    }
    const parsed = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function formatFullTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    if (Number.isNaN(d.valueOf())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /**
   * 格式化相对时差（含超时陈旧判断）：返回 { text, full, stale, ageSec }。
   */
  function formatRelativeTime(raw, staleSec = 30) {
    const ms = parseTimestampMs(raw);
    if (!ms) return { text: "—", full: "—", stale: false, ageSec: null };
    const full = formatFullTime(ms);
    const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    let text;
    if (diffSec < 3) text = "刚刚";
    else if (diffSec < 60) text = `${diffSec}s 前`;
    else if (diffSec < 3600) text = `${Math.floor(diffSec / 60)}m${diffSec % 60 ? (diffSec % 60) + "s" : ""} 前`;
    else if (diffSec < 86400) text = `${Math.floor(diffSec / 3600)}h 前`;
    else text = `${Math.floor(diffSec / 86400)}d 前`;
    return { text, full, stale: staleSec > 0 && diffSec > staleSec, ageSec: diffSec };
  }

  /** 将测点状态/品质码语义化解码（支持 IEC104 QDS 位与通用状态码）。 */
  function decodePointStatus(status) {
    if (status === null || status === undefined || status === "") {
      return { label: "—", level: "muted", detail: "无状态数据" };
    }
    const code = Number(status);
    if (!Number.isFinite(code)) {
      return { label: String(status), level: "warn", detail: `原始状态: ${status}` };
    }
    if (code === 0) {
      return { label: "正常", level: "ok", detail: "状态码 0 (有效)" };
    }
    const flags = [];
    if (code & 0x01) flags.push("溢出");
    if (code & 0x10) flags.push("封锁");
    if (code & 0x20) flags.push("取代");
    if (code & 0x40) flags.push("非当前");
    if (code & 0x80) flags.push("无效");
    const label = flags.length ? flags.join("/") : `异常(${code})`;
    const level = (code & 0x80) || code < 0 ? "err" : "warn";
    return { label, level, detail: `原始状态码: ${code} (0x${(code >>> 0).toString(16).toUpperCase()})` };
  }

  /** 连接态英文/原始值中文语义映射。 */
  function decodeConnState(raw) {
    const text = String(raw || "").trim();
    if (!text) return { label: "—", level: "muted", raw: "" };
    const low = text.toLowerCase();
    const map = {
      connected: ["已连接", "ok"],
      online: ["在线", "ok"],
      running: ["运行中", "ok"],
      listening: ["监听中", "ok"],
      active: ["通信正常", "ok"],
      connecting: ["连接中", "warn"],
      reconnecting: ["重连中", "warn"],
      idle: ["空闲", "muted"],
      disconnected: ["已断开", "err"],
      offline: ["离线", "err"],
      error: ["连接异常", "err"],
      failed: ["失败", "err"],
      stopped: ["已停止", "muted"],
    };
    const hit = map[low];
    if (hit) return { label: hit[0], level: hit[1], raw: text };
    return { label: text, level: "muted", raw: text };
  }

  /** 通用剪贴板复制。 */
  async function copyText(text) {
    const str = String(text ?? "");
    if (!str) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch (_) { /* fallback */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = str;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return Boolean(ok);
    } catch (_) {
      return false;
    }
  }

  window.scadaTableReconcile = {
    reconcileBody,
    triggerFlash,
    parseTimestampMs,
    formatFullTime,
    formatRelativeTime,
    decodePointStatus,
    decodeConnState,
    copyText,
  };
})();
