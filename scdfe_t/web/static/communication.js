(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const statuses = {0:"停止",1:"启动中",2:"运行",3:"停止中",4:"处理中",5:"错误"};
  let loading = false;
  let lastMarkup = "";
  let lastKeys = "", lastRows = [];
  const statusText = (runtime, fallback) => {
    const names = {unknown:"未知", stopped:"已停止", starting:"启动中", running:"运行中", stopping:"停止中", error:"错误", degraded:"降级"};
    return names[runtime.state] || fallback;
  };
  const clock = value => value ? new Date(Number(value)).toLocaleString() : "—";
  async function load() {
    if (loading) return;
    loading = true;
    try {
      // The status projection is read-only and already contains the persisted
      // runtime/diagnostic snapshot. It avoids process lease checks on every
      // five-second HMI refresh while exposing protocol counters.
      const response = await fetch("/api/trans/status", { cache: "no-cache" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
      const rows = data.items || [];
      const running = rows.filter(x => {
        const runtime = x.runtime_status || {};
        return Boolean(Number(runtime.running)) || Number(runtime.process_status ?? x.process_status) === 2;
      }).length;
      const errors = rows.filter(x => {
        const runtime = x.runtime_status || {};
        return runtime.state === "error" || Number(runtime.process_status ?? x.process_status) === 5;
      }).length;
      $("#channel-total").textContent = rows.length;
      $("#channel-running").textContent = running;
      $("#channel-errors").textContent = errors;
      const markup = rows.map(x => {
        const runtime = x.runtime_status || {};
        const status = Number(runtime.process_status ?? x.process_status ?? 0);
        const state = statusText(runtime, statuses[status] || String(status));
        const isRunning = Boolean(Number(runtime.running)) || status === 2;
        const isError = runtime.state === "error" || status === 5;
        const pid = runtime.process_pid || x.process_pid || "";
        const cid = encodeURIComponent(x.channel_id);
        const counts = [runtime.rx_count ?? 0, runtime.tx_count ?? 0, runtime.error_count ?? 0].join(" / ");
        const diagnostic = runtime.diagnostic || {};
        const diagnosticText = Object.keys(diagnostic).length ? `诊断 ${Object.keys(diagnostic).length} 项` : "—";
        const error = runtime.last_error || runtime.process_error || x.process_error || "—";
        const ctlBtn = isRunning
          ? `<button type="button" class="danger" data-trans-action="stop" data-id="${esc(x.channel_id)}" data-name="${esc(x.name || "")}">停止</button>`
          : `<button type="button" data-trans-action="start" data-id="${esc(x.channel_id)}" data-name="${esc(x.name || "")}">启动</button>`;
return `<tr><td>${esc(x.channel_id)} · ${esc(x.name)}</td><td>${esc(x.protocol)}</td><td>${esc(x.bind_host)}:${esc(x.bind_port)}</td><td><span class="status-badge ${isRunning ? "running" : isError ? "error" : ""}">${esc(state)}</span>${pid ? `<small class="cell-sub mono">PID ${esc(pid)}</small>` : ""}</td><td>${esc(runtime.connection_state || "未知")}</td><td>${esc(x.scan_interval_ms)} ms</td><td class="mono">${esc(counts)}</td><td>${esc(clock(runtime.process_heartbeat_time || x.process_heartbeat_time))}</td><td title="${esc(JSON.stringify(diagnostic))}"><span>${esc(diagnosticText)}</span><small class="cell-sub">${esc(error)}</small></td><td class="actions">${ctlBtn}<a href="/connections?channel_id=${cid}">连接</a><a href="/points?channel_id=${cid}">四遥</a><a href="/logs?channel_id=${cid}">日志</a></td></tr>`;
      }).join("") || '<tr><td colspan="10" class="muted">暂无转发通道</td></tr>';
      if (lastMarkup !== markup) {
        const body = $("#communication-rows"), keys = rows.map(x => String(x.channel_id)).join(',');
        if (rows.length && keys === lastKeys && body.rows && body.rows.length === rows.length && typeof document.createElement === "function") {
          const tpl = document.createElement("template");
          tpl.innerHTML = "<table><tbody>" + markup + "</tbody></table>";
          const nextRows = Array.from(tpl.content.querySelectorAll("tr"));
          if (nextRows.length === rows.length) {
            nextRows.forEach((nextRow, i) => {
              const curRow = body.rows[i];
              if (nextRow.outerHTML === curRow.outerHTML) return;
              if (nextRow.cells.length !== curRow.cells.length) { curRow.replaceWith(nextRow); return; }
              Array.from(nextRow.cells).forEach((nextCell, j) => {
                if (nextCell.outerHTML !== curRow.cells[j].outerHTML) curRow.cells[j].replaceWith(nextCell);
              });
            });
          } else body.innerHTML = markup;
        } else body.innerHTML = markup;
        lastKeys = keys;
        lastMarkup = markup;
      }
      $("#message").textContent = "";
      $("#message").className = "muted";
    } catch (error) { $("#message").textContent = error.message; $("#message").className = "error"; }
    finally { loading = false; }
  }
  const pendingCtl = new Set();
  document.addEventListener("click", async event => {
    const btn = event.target.closest("button[data-trans-action]");
    if (!btn || btn.disabled) return;
    const id = btn.dataset.id, act = btn.dataset.transAction, name = btn.dataset.name;
    if (pendingCtl.has(id)) return;
    if (act === "stop" && typeof window.scadaConfirm === "function") {
      if (!(await window.scadaConfirm(`确认停止转发通道 ${id}${name ? " · " + name : ""}？`, { title: "确认停止", confirmText: "确认停止", danger: true }))) return;
    }
    pendingCtl.add(id);
    btn.disabled = true;
    try {
      const resp = await fetch(`/api/trans/channels/${encodeURIComponent(id)}/${act}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
      $("#message").textContent = act === "start" ? "启动请求已发送" : "停止请求已发送";
      $("#message").className = "muted";
      await load();
    } catch (err) {
      $("#message").textContent = err.message;
      $("#message").className = "error";
    } finally {
      pendingCtl.delete(id);
      btn.disabled = false;
    }
  });
  $("#refresh").onclick = load;
  load();
  setInterval(() => { if (!document.hidden && !loading && !document.querySelector("dialog[open]")) load(); }, 5000);
})();
