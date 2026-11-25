(() => {
  "use strict";
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const trendHost = $("#point-trend");
  const pointTrend = trendHost && globalThis.scadaPointTrend?.mount(trendHost);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const protocolMap = {
    iec104: {label:"IEC 60870-5-104", service:"iec104"},
    "modbus-tcp": {label:"Modbus TCP", service:"modbus-tcp"},
    "modbus-rtu": {label:"Modbus RTU", service:"modbus-rtu"},
    can: {label:"CAN / CAN-FD", service:"can"},
    bacnet: {label:"BACnet/IP", service:"bacnet-server"},
    opc: {label:"OPC UA", service:"opc-server"},
  };
  const pointLabels = {yc:"遥测 YC", yx:"遥信 YX", yk:"遥控 YK", yt:"遥调 YT"};
  const runtimeKeys = new Set(["_version", "raw_value", "raw_status", "raw_time", "refresh_time", "process_status", "process_pid", "process_start_time", "process_stop_time", "process_heartbeat_time", "process_exit_code", "process_error"]);
  const state = {rtus:[], rtu:null, channel:null, protocol:null, service:null, points:{yc:[],yx:[],yk:[],yt:[]}, pages:{yc:0,yx:0,yk:0,yt:0}, request:0, editingPoint:null, loading:false};
  const PAGE_SIZE = 25;
  state.totals = {yc:0,yx:0,yk:0,yt:0};
  state.unfilteredTotals = {yc:0,yx:0,yk:0,yt:0};
  state.pointRequests = {yc:0,yx:0,yk:0,yt:0};
  let pendingRtu = null;
  const commandKinds = new Set(["yk", "yt"]);
  const rawStatusKinds = new Set(["yc", "yt"]);
  function pointNameFilter() { return $("#point-search").value.trim(); }
  async function api(path, options = {}) {
    const response = await fetch(path, {cache:"no-cache", ...options, headers:{"Content-Type":"application/json", ...(options.headers || {})}});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
    return data;
  }
  function message(text, error = false) { const node = $("#test-message"); node.textContent = text || ""; node.className = "message" + (error ? " error" : ""); }
  function protocolFor(type) { return protocolMap[type] || {label:type || "未配置", service:null}; }
  function table(items, empty = "暂无数据") {
    if (!items || !items.length) return `<p class="muted">${esc(empty)}</p>`;
    return `<dl class="key-values">${items.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value === null || value === undefined || value === "" ? "—" : value)}</dd></div>`).join("")}</dl>`;
  }
  function channelRows(item) {
    return [["RTU 编号", item.rtu_id], ["通道号", item.channel_id], ["规约", protocolFor(item.channel_type).label], ["名称", item.name], ["保存报文", Number(item.packet_recording) ? "开启" : "关闭"], ["自动通信", Number(item.process_enable) ? "启用" : "停用"]];
  }
  function parameterRows(parameter, schema) {
    if (!parameter) return [];
    const columns = schema?.columns || Object.keys(parameter).map(eng_name => ({eng_name, chn_name:eng_name}));
    return columns.filter(column => !runtimeKeys.has(column.eng_name) && column.eng_name !== "id").map(column => [column.chn_name || column.eng_name, parameter[column.eng_name]]);
  }
  function formatPointTime(value) {
    if (!value) return "—";
    const date = new Date(Number(value));
    if (Number.isNaN(date.valueOf())) return String(value);
    const pad = part => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
      String(date.getMilliseconds()).padStart(3, "0");
  }
  function pointFields(kind) {
    return ["pnt_no", "name", "value", "status"]
      .concat(rawStatusKinds.has(kind) ? ["raw_status"] : [])
      .concat(["refresh_time"])
      .concat(commandKinds.has(kind) ? ["cmd_handle_time"] : []);
  }
  function renderSummary() {
    const item = state.channel?.item;
    if (!item) return;
    const protocol = state.protocol;
    $("#metric-protocol").textContent = protocol.label;
    $("#metric-channel").textContent = item.channel_id ?? "—";
    $("#metric-packet").textContent = Number(item.packet_recording) ? "开启" : "关闭";
    $("#metric-points").textContent = Object.values(state.unfilteredTotals).reduce((n, total) => n + total, 0);
    $("#channel-table").innerHTML = table(channelRows(item));
    $("#parameter-table").innerHTML = table(parameterRows(state.channel.parameter, state.channel.parameter_schema), "该规约尚未配置参数");
  }
  function renderPointKind(kind) {
    const rows = state.points[kind] || [];
    const page = state.pages[kind] || 0;
    const slice = rows;
    const total = state.totals[kind];
    const body = $(`[data-point-body="${kind}"]`);
    const command = commandKinds.has(kind);
    const rawStatus = rawStatusKinds.has(kind);
    const html = slice.length ? slice.map(point => {
      const states = [point.status];
      if (rawStatus) states.push(point.raw_status);
      const times = [formatPointTime(point.refresh_time)];
      if (command) times.push(formatPointTime(point.cmd_handle_time));
      return `<tr><td>${esc(point.pnt_no)}</td><td>${esc(point.name || "")}</td><td class="val-cell-editable" data-inline-kind="${esc(kind)}" data-inline-no="${esc(point.pnt_no)}" data-inline-val="${esc(point.value ?? "")}" title="双击就地修改">${esc(point.value)}</td>` +
        states.map(value => `<td>${esc(value)}</td>`).join("") +
        times.map(value => `<td>${esc(value)}</td>`).join("") +
        `<td><button type="button" data-point-action="${esc(kind)}" data-point-no="${esc(point.pnt_no)}">${command ? "下发" : "更新"}</button>${kind === "yx" ? ` <button type="button" data-yx-flip="${esc(point.pnt_no)}">翻转</button>` : ""}</td></tr>`;
    }).join("") : `<tr><td colspan="${6 + (rawStatus ? 1 : 0) + (command ? 1 : 0)}" class="muted">${pointNameFilter() ? "没有匹配的测点" : "暂无定义"}</td></tr>`;
    const rtuId = state.rtu ? String(state.rtu.rtu_id) : "";
    const rebuilt = body._pointHtml !== html || body._pointRtu !== rtuId;
    if (body._pointHtml !== html) { body.innerHTML = html; body._pointHtml = html; }
    body._pointRtu = rtuId;
    if (pointTrend && rtuId && slice.length) {
      if (rebuilt) {
        slice.forEach((point, index) => {
          const row = body.rows[index];
          if (!row) return;
          pointTrend.bindRow?.(row, {kind, rtu_id:rtuId, pnt_no:point.pnt_no, name:point.name}, row.cells[0]);
        });
      } else {
        pointTrend.syncCheckboxes?.();
      }
    }
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    $(`[data-point-pager="${kind}"]`).innerHTML = total > PAGE_SIZE ? `<button type="button" data-point-page="prev" data-point-kind="${kind}" ${page === 0 ? "disabled" : ""}>上一页</button><span>第 ${page + 1} / ${pages} 页，共 ${total} 点</span><button type="button" data-point-page="next" data-point-kind="${kind}" ${page + 1 >= pages ? "disabled" : ""}>下一页</button>` : `<span>${total} 点</span>`;
  }
  function renderPoints() { ["yc","yx","yk","yt"].forEach(renderPointKind); renderSummary(); syncSimTargets(); }
  function renderService(status) {
    const item = status || {};
    $("#metric-running").textContent = item.running ? "运行中" : "已停止";
    $("#metric-connections").textContent = item.open_connections ?? item.connections?.length ?? 0;
    $("#service-status").innerHTML = table([["服务", item.label || state.service], ["运行状态", item.running ? "运行中" : "已停止"], ["绑定 RTU", item.rtu_id ?? item.config?.effective_rtu_id ?? "—"], ["连接数", item.open_connections ?? item.connections?.length ?? 0], ["四遥点数", item.point_count ?? "—"], ["最近错误", item.last_error || "无"]]);
    $("#connection-list").innerHTML = (item.connections || []).map(connection => `<div>[${esc(connection.time || "")}] ${esc(connection.ip || connection.peer || connection.client || "连接")} ${connection.accepted === false ? "已断开" : "已连接"}</div>`).join("") || "暂无连接";
    $("#service-start").disabled = !state.service || !!item.running;
    $("#service-stop").disabled = !state.service || !item.running;
    $("#service-poll").disabled = !state.service || !item.running || !["modbus-tcp","modbus-rtu","can"].includes(state.service);
  }
  async function fetchPointPage(rtuId, kind, page, nameFilter = pointNameFilter()) {
    const fields = pointFields(kind).join(",");
    const read = (offset, filter = nameFilter, limit = PAGE_SIZE, projection = fields) => {
      const query = new URLSearchParams({limit:String(limit), offset:String(offset), fields:projection, name_contains:filter});
      return api(`/api/rtus/${encodeURIComponent(rtuId)}/points/${kind}?${query}`);
    };
    let [result, unfiltered] = await Promise.all([
      read(page * PAGE_SIZE),
      nameFilter ? read(0, "", 1, "pnt_no") : null,
    ]);
    const last = Math.max(0, Math.ceil((result.total || 0) / PAGE_SIZE) - 1);
    if (page > last) { page = last; result = await read(page * PAGE_SIZE); }
    const total = result.total ?? (result.items || []).length;
    return {items:result.items || [], total, unfilteredTotal:unfiltered?.total ?? total, page};
  }
  function acceptPointPage(kind, result) {
    state.points[kind] = result.items; state.totals[kind] = result.total; state.pages[kind] = result.page;
    state.unfilteredTotals[kind] = result.unfilteredTotal;
  }
  async function changePointPage(kind, direction) {
    if (!state.rtu) return;
    const id = state.rtu.rtu_id, scope = state.request, request = ++state.pointRequests[kind];
    const page = Math.max(0, state.pages[kind] + direction);
    try {
      const result = await fetchPointPage(id, kind, page);
      if (scope !== state.request || request !== state.pointRequests[kind]) return;
      acceptPointPage(kind, result); renderPointKind(kind); renderSummary();
    } catch (error) {
      if (scope === state.request && request === state.pointRequests[kind]) message(error.message, true);
    }
  }
  function refreshStatus(text, active = false, error = false) {
    const node = $("#test-refresh-status");
    if (!node) return;
    node.textContent = text;
    node.className = `refresh-status${active ? " is-active" : ""}${error ? " is-error" : ""}`;
  }
  function activeTestSection() {
    const requested = location.hash.slice(1);
    return ["channel", "points", "connection", "logs"].includes(requested) ? requested : "channel";
  }
  function activePointTab() {
    return document.querySelector("[data-point-tab][aria-selected='true']")?.dataset.pointTab || "yc";
  }
  function loadRtu(id, {fresh = false, background = false} = {}) {
    const nameFilter = pointNameFilter();
    if (pendingRtu && String(pendingRtu.id) === String(id) && pendingRtu.nameFilter === nameFilter && pendingRtu.request === state.request) {
      return fresh ? pendingRtu.promise.then(() => String($("#rtu-select").value) === String(id) ? loadRtu(id) : undefined) : pendingRtu.promise;
    }
    const pending = {id, nameFilter};
    pending.promise = performLoadRtu(id, {background}).finally(() => { if (pendingRtu === pending) pendingRtu = null; });
    pending.request = state.request;
    pendingRtu = pending;
    return pending.promise;
  }
  async function performLoadRtu(id, {background = false} = {}) {
    const request = ++state.request;
    const nameFilter = pointNameFilter();
    const switchedRtu = String(state.rtu?.rtu_id) !== String(id);
    if (switchedRtu) {
      stopSimulation("已切换 RTU");
      state.pages = {yc:0,yx:0,yk:0,yt:0}; state.points = {yc:[],yx:[],yk:[],yt:[]};
      state.totals = {yc:0,yx:0,yk:0,yt:0}; state.channel = null;
      state.unfilteredTotals = {yc:0,yx:0,yk:0,yt:0};
      closePointUpdate(); renderPoints(); renderService({});
    }
    state.rtu = state.rtus.find(item => String(item.rtu_id) === String(id)) || null;
    if (!state.rtu) { state.loading = false; refreshStatus("请选择 RTU"); return; }
    if (typeof window.scadaFocusContext?.set === "function") {
      window.scadaFocusContext.set({ rtu_id: state.rtu.rtu_id, channel_id: state.rtu.channel_id ?? null });
    }
    state.loading = true;
    const protocol = protocolFor(state.rtu.channel_type);
    state.protocol = protocol; state.service = protocol.service;
    refreshStatus("正在刷新…", true);
    try {
      const section = activeTestSection();
      // 搜索过滤和后台轮询仅刷新当前激活 Tab，避免同时发出 10 个并发点表请求。
      const kindsToFetch = switchedRtu
        ? Object.keys(state.points)
        : (section === "points" ? [activePointTab()] : (!background ? Object.keys(state.points) : []));
      const pointRequests = Object.fromEntries(kindsToFetch.map(kind => [kind, ++state.pointRequests[kind]]));
      const [channel, points, communications] = await Promise.all([
        (!background || switchedRtu || section === "channel" || !state.channel)
          ? api(`/api/rtus/${encodeURIComponent(id)}/channel`)
          : Promise.resolve(state.channel),
        kindsToFetch.length
          ? Promise.all(kindsToFetch.map(async kind => [kind, await fetchPointPage(id, kind, state.pages[kind], nameFilter)]))
          : Promise.resolve([]),
        api(`/api/monitor/communications?rtu_id=${encodeURIComponent(id)}`),
      ]);
      if (request !== state.request) return;
      state.channel = channel;
      for (const [kind, result] of points) if (pointRequests[kind] === state.pointRequests[kind]) acceptPointPage(kind, result);
      const match = (communications.items || []).find(item => String(item.rtu_id) === String(id));
      renderPoints(); renderService(match || {rtu_id:id, last_error:"未取得当前 RTU 的运行状态"});
      // Scope the shared log browser to the RTU currently selected above.
      // The protocol process remains a fallback for manager-only logs, while
      // channel files are preferred whenever they exist.
      document.dispatchEvent(new CustomEvent("scada:log-process", {
        detail: {
          process: state.rtu.channel_id != null
            ? `scdfe_s-channel-${state.rtu.channel_id}`
            : (protocol.service ? `scdfe_s-${protocol.service}` : ""),
          // The RTU list already carries the canonical channel_id.  Prefer it
          // so the default is available even if a protocol endpoint omits the
          // field in its channel response.
          channel_id: state.rtu.channel_id ?? state.channel?.item?.channel_id ?? "",
        },
      }));
      message("");
      refreshStatus(`已刷新 ${formatPointTime(Date.now())}`);
    } catch (error) {
      // 网络抖动时保留既有 channel 信息，仅提示错误而不清空页面内容。
      if (request === state.request) { message(error.message, true); refreshStatus("刷新失败", false, true); }
    } finally {
      if (request === state.request) state.loading = false;
    }
  }
  async function loadRtus() {
    try {
      state.rtus = [];
      for (let offset = 0; ; offset += 500) {
        const data = await api(`/api/rtus?limit=500&offset=${offset}&fields=rtu_id,channel_id,channel_type,name`);
        state.rtus.push(...(data.items || []));
        if (!(data.items || []).length || state.rtus.length >= (data.total ?? state.rtus.length)) break;
      }
      const select = $("#rtu-select");
      select.innerHTML = state.rtus.map(item => `<option value="${esc(item.rtu_id)}">RTU ${esc(item.rtu_id)} · ${esc(item.name || "未命名")} · ${esc(protocolFor(item.channel_type).label)}</option>`).join("");
      if (!state.rtus.length) { select.innerHTML = '<option value="">暂无 RTU</option>'; return; }
      const queryId = new URLSearchParams(location.search).get("rtu_id");
      select.value = state.rtus.some(item => String(item.rtu_id) === queryId) ? queryId : String(state.rtus[0].rtu_id);
      await loadRtu(select.value);
    } catch (error) { message(error.message, true); refreshStatus("刷新失败", false, true); }
  }
  let actionBusy = false;
  async function serviceAction(action) {
    if (!state.service || !state.rtu || actionBusy) return;
    if (action === "stop" && typeof window.scadaConfirm === "function") {
      const targetName = state.rtu.name || `RTU ${state.rtu.rtu_id}`;
      if (!(await window.scadaConfirm(`确认停止 ${targetName} 的规约服务？`, { title: "确认停止", confirmText: "确认停止", danger: true }))) return;
    }
    const id = state.rtu.rtu_id;
    const btn = $(action === "start" ? "#service-start" : "#service-stop");
    actionBusy = true;
    if (btn) btn.disabled = true;
    try {
      await api(`/api/rtus/${encodeURIComponent(id)}/service/${action}`, {method:"POST", body:"{}"});
      if (String(state.rtu?.rtu_id) !== String(id)) return;
      await loadRtu(id, {fresh:true});
      if (String(state.rtu?.rtu_id) === String(id)) message(action === "start" ? "规约服务已启动" : "规约服务已停止");
    }
    catch (error) { if (String(state.rtu?.rtu_id) === String(id)) message(error.message, true); }
    finally { actionBusy = false; if (btn) btn.disabled = false; }
  }
  async function poll() {
    if (!state.rtu || actionBusy) return;
    const id = state.rtu.rtu_id;
    const btn = $("#service-poll");
    actionBusy = true;
    if (btn) btn.disabled = true;
    try {
      await api(`/api/rtus/${encodeURIComponent(id)}/service/poll`, {method:"POST", body:"{}"});
      if (String(state.rtu?.rtu_id) !== String(id)) return;
      await loadRtu(id, {fresh:true});
      if (String(state.rtu?.rtu_id) === String(id)) message("采集已完成");
    }
    catch (error) { if (String(state.rtu?.rtu_id) === String(id)) message(error.message, true); }
    finally { actionBusy = false; if (btn) btn.disabled = false; }
  }
  function closePointUpdate() {
    const dialog = $("#point-update-dialog");
    state.editingPoint = null;
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    if ($("#point-update-error")) $("#point-update-error").textContent = "";
  }
  function openPointUpdate(kind, pointNo) {
    const current = (state.points[kind] || []).find(point => String(point.pnt_no) === String(pointNo)) || {};
    state.editingPoint = {kind, pointNo, current, rtuId:state.rtu.rtu_id};
    $("#point-update-title").textContent = `${pointLabels[kind]} ${pointNo} · ${commandKinds.has(kind) ? "下发" : "更新"}`;
    $("#point-update-value").value = current.value ?? 0;
    $("#point-update-status").value = current.status ?? 0;
    $("#point-update-status-field").hidden = commandKinds.has(kind);
    $("#point-update-error").textContent = "";
    const dialog = $("#point-update-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
    $("#point-update-value").focus();
    $("#point-update-value").select();
  }
  async function submitPointUpdate() {
    const edit = state.editingPoint;
    if (!edit || actionBusy) return;
    const {kind, pointNo, rtuId} = edit;
    const number = Number($("#point-update-value").value);
    if (!Number.isFinite(number)) { $("#point-update-error").textContent = "请输入有限数字"; return; }
    const value = kind === "yx" || kind === "yk" ? (number ? 1 : 0) : number;
    let status = Number($("#point-update-status").value);
    if (!commandKinds.has(kind) && (!Number.isInteger(status) || !Number.isFinite(status))) {
      $("#point-update-error").textContent = "状态必须是整数";
      return;
    }
    const submitBtn = $("#point-update-form button[type='submit']");
    actionBusy = true;
    if (submitBtn) submitBtn.disabled = true;
    $("#point-update-error").textContent = "";
    try {
      const path = commandKinds.has(kind) ? `/api/rtus/${rtuId}/commands/${kind}/${encodeURIComponent(pointNo)}` : `/api/rtus/${rtuId}/points/${kind}/${encodeURIComponent(pointNo)}`;
      const result = await api(path, {method:commandKinds.has(kind) ? "POST" : "PATCH", body:JSON.stringify(commandKinds.has(kind) ? {value} : {value, status})});
      if (String(state.rtu?.rtu_id) === String(rtuId)) {
        closePointUpdate();
        await loadRtu(rtuId, {fresh:true});
        message(commandKinds.has(kind) ? (result.command_status === "applied" ? "仿真模型已接受指令" : "指令已提交") : "点值已更新");
        if (commandKinds.has(kind) && typeof window.scadaTrackCommand === "function") {
          window.scadaTrackCommand({ rtu_id: rtuId, kind, pnt_no: pointNo, value });
        }
      }
    } catch (error) {
      $("#point-update-error").textContent = error.message || "提交失败";
      $("#point-update-value")?.focus();
    } finally {
      actionBusy = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  }
  function initTabs() {
    const showSection = () => {
      const requested = location.hash.slice(1);
      const section = ["channel", "points", "connection", "logs"].includes(requested) ? requested : "channel";
      $$("[data-test-page]").forEach(link => {
        if (link.dataset.testPage === section) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      $$("[data-tab-panel]").forEach(panel => { panel.hidden = panel.dataset.tabPanel !== section; });
    };
    window.addEventListener("hashchange", () => {
      showSection();
      if (state.rtu && !state.loading && activeTestSection() === "points") loadRtu(state.rtu.rtu_id, {background:true});
    });
    showSection();
    $$("[data-point-tab]").forEach(tab => tab.addEventListener("click", () => {
      $$("[data-point-tab]").forEach(node => node.setAttribute("aria-selected", String(node === tab)));
      $$("[data-point-panel]").forEach(panel => panel.hidden = panel.dataset.pointPanel !== tab.dataset.pointTab);
      if (state.rtu && !state.loading) loadRtu(state.rtu.rtu_id, {background:true});
    }));
  }
  $("#rtu-select").addEventListener("change", event => loadRtu(event.target.value));
  $("#test-refresh").addEventListener("click", () => loadRtu($("#rtu-select").value));
  $("#points-refresh").addEventListener("click", () => loadRtu($("#rtu-select").value));
  let pointSearchTimer;
  $("#point-search").addEventListener("input", () => {
    clearTimeout(pointSearchTimer);
    ++state.request;
    for (const kind of Object.keys(state.points)) {
      ++state.pointRequests[kind]; state.pages[kind] = 0;
    }
    pointSearchTimer = setTimeout(() => loadRtu($("#rtu-select").value), 250);
  });
  $("#service-start").addEventListener("click", () => serviceAction("start"));
  $("#service-stop").addEventListener("click", () => serviceAction("stop"));
  $("#service-poll").addEventListener("click", poll);
  async function quickApplyPointValue(kind, pointNo, rawNumber, {silent = false} = {}) {
    if (!state.rtu) return false;
    const rtuId = state.rtu.rtu_id;
    const number = Number(rawNumber);
    if (!Number.isFinite(number)) { if (!silent) message("请输入有效数字", true); return false; }
    const value = (kind === "yx" || kind === "yk") ? (number ? 1 : 0) : number;
    const current = (state.points[kind] || []).find(p => String(p.pnt_no) === String(pointNo));
    const status = Number.isInteger(Number(current?.status)) ? Number(current.status) : 0;
    const isCmd = commandKinds.has(kind);
    const path = isCmd
      ? `/api/rtus/${rtuId}/commands/${kind}/${encodeURIComponent(pointNo)}`
      : `/api/rtus/${rtuId}/points/${kind}/${encodeURIComponent(pointNo)}`;
    const result = await api(path, {
      method: isCmd ? "POST" : "PATCH",
      body: JSON.stringify(isCmd ? {value} : {value, status}),
    });
    if (isCmd && typeof window.scadaTrackCommand === "function") {
      window.scadaTrackCommand({ rtu_id: rtuId, kind, pnt_no: pointNo, value });
    }
    if (!silent && String(state.rtu?.rtu_id) === String(rtuId)) {
      await loadRtu(rtuId, {fresh:true, background:true});
      message(isCmd ? (result.command_status === "applied" ? "仿真模型已接受指令" : "指令已提交") : `已更新 ${pointLabels[kind]} #${pointNo} = ${value}`);
    }
    return true;
  }

  function startInlineEdit(cell) {
    if (!cell || cell.classList.contains("val-cell-editing") || !state.rtu) return;
    const kind = cell.dataset.inlineKind;
    const pointNo = cell.dataset.inlineNo;
    const oldVal = cell.dataset.inlineVal ?? cell.textContent.trim();
    cell.classList.add("val-cell-editing");
    cell.innerHTML = `<input class="inline-val-input" type="number" step="${(kind === "yx" || kind === "yk") ? "1" : "any"}" value="${esc(oldVal)}" aria-label="修改当前值">`;
    const input = cell.querySelector("input");
    if (!input) return;
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const nextVal = input.value.trim();
      if (!commit || nextVal === "" || nextVal === String(oldVal)) {
        cell.classList.remove("val-cell-editing");
        cell.textContent = oldVal;
        return;
      }
      if (!Number.isFinite(Number(nextVal))) {
        done = false;
        input.classList.add("is-invalid");
        return;
      }
      cell.classList.remove("val-cell-editing");
      cell.textContent = nextVal;
      try {
        await quickApplyPointValue(kind, pointNo, nextVal);
      } catch (err) {
        cell.textContent = oldVal;
        message(err.message || "更新失败", true);
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  const sim = { timer: null, step: 0, count: 0, busy: false, lastToggle: 0 };
  function syncSimTargets() {
    const sel = $("#sim-target");
    if (!sel) return;
    const prev = sel.value;
    const opts = [];
    for (const k of ["yc", "yx"]) {
      for (const p of (state.points[k] || [])) {
        opts.push(`<option value="${esc(k)}:${esc(p.pnt_no)}">${esc(k.toUpperCase())} #${esc(p.pnt_no)} · ${esc(p.name || "未命名")}</option>`);
      }
    }
    sel.innerHTML = opts.length ? opts.join("") : '<option value="">当前页无 YC/YX 测点</option>';
    if (prev && opts.some(o => o.includes(`value="${esc(prev)}"`))) sel.value = prev;
  }
  function updateSimUi(text) {
    const startBtn = $("#sim-start");
    const stopBtn = $("#sim-stop");
    const status = $("#sim-status");
    const running = Boolean(sim.timer);
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
    if (status && text !== undefined) status.textContent = text;
  }
  function stopSimulation(reason = "已停止") {
    if (sim.timer) { clearInterval(sim.timer); sim.timer = null; }
    sim.busy = false;
    updateSimUi(reason);
  }
  async function runSimTick() {
    if (!sim.timer || sim.busy || !state.rtu) return;
    const target = ($("#sim-target")?.value || "").split(":");
    if (target.length !== 2 || !target[0] || !target[1]) { stopSimulation("请选择目标测点"); return; }
    const [kind, pointNo] = target;
    const wave = $("#sim-wave")?.value || "sine";
    const base = Number($("#sim-base")?.value ?? 50);
    const amp = Number($("#sim-amp")?.value ?? 10);
    let nextVal;
    if (kind === "yx" || wave === "toggle") {
      sim.lastToggle = sim.lastToggle ? 0 : 1;
      nextVal = sim.lastToggle;
    } else if (wave === "ramp") {
      const phase = (sim.step % 20) / 10;
      const tri = phase <= 1 ? (phase * 2 - 1) : ((2 - phase) * 2 - 1);
      nextVal = Number((base + amp * tri).toFixed(3));
    } else if (wave === "random") {
      nextVal = Number((base + (Math.random() * 2 - 1) * amp).toFixed(3));
    } else {
      nextVal = Number((base + amp * Math.sin(sim.step * Math.PI / 6)).toFixed(3));
    }
    sim.step += 1;
    sim.busy = true;
    try {
      await quickApplyPointValue(kind, pointNo, nextVal, {silent: true});
      sim.count += 1;
      updateSimUi(`运行中 · 第 ${sim.count} 次 · ${kind.toUpperCase()} #${pointNo} = ${nextVal}`);
      if (!document.hidden && !document.querySelector(".inline-val-input") && !state.loading) {
        loadRtu(state.rtu.rtu_id, {background: true});
      }
    } catch (err) {
      stopSimulation(`激励中止：${err.message}`);
    } finally {
      sim.busy = false;
    }
  }
  function startSimulation() {
    if (!state.rtu) { message("请先选择 RTU", true); return; }
    const target = $("#sim-target")?.value || "";
    if (!target) { message("当前页无可用 YC/YX 测点", true); return; }
    stopSimulation();
    sim.step = 0;
    sim.count = 0;
    const intervalMs = Math.max(1000, Number($("#sim-interval")?.value || 2000));
    sim.timer = setInterval(runSimTick, intervalMs);
    updateSimUi("启动中…");
    runSimTick();
  }

  $("#sim-toggle")?.addEventListener("click", () => {
    const bar = $("#sim-bar");
    const btn = $("#sim-toggle");
    if (!bar) return;
    const nextHidden = !bar.hidden;
    bar.hidden = nextHidden;
    if (btn) btn.setAttribute("aria-expanded", String(!nextHidden));
    if (!nextHidden) syncSimTargets();
  });
  $("#sim-start")?.addEventListener("click", startSimulation);
  $("#sim-stop")?.addEventListener("click", () => stopSimulation("已手动停止"));

  $("#point-panels").addEventListener("click", async event => {
    const flip = event.target.closest("[data-yx-flip]");
    if (flip && state.rtu) {
      const no = flip.dataset.yxFlip;
      const cur = (state.points.yx || []).find(p => String(p.pnt_no) === String(no));
      const next = Number(cur?.value) ? 0 : 1;
      try { await quickApplyPointValue("yx", no, next); } catch (err) { message(err.message, true); }
      return;
    }
    const action = event.target.closest("[data-point-action]");
    if (action) openPointUpdate(action.dataset.pointAction, action.dataset.pointNo);
    const page = event.target.closest("[data-point-page]");
    if (page) changePointPage(page.dataset.pointKind, page.dataset.pointPage === "next" ? 1 : -1);
  });
  $("#point-panels").addEventListener("dblclick", event => {
    const cell = event.target.closest("td.val-cell-editable");
    if (cell) startInlineEdit(cell);
  });
  $("#point-update-form").addEventListener("submit", event => { event.preventDefault(); submitPointUpdate(); });
  $("#point-update-close").addEventListener("click", closePointUpdate);
  $("#point-update-cancel").addEventListener("click", closePointUpdate);
  $("#point-update-dialog").addEventListener("cancel", () => { state.editingPoint = null; });
  initTabs(); loadRtus(); setInterval(() => {
    if (!document.hidden && !document.querySelector("dialog[open]") && !document.querySelector(".inline-val-input") && state.rtu && !state.loading && activeTestSection() !== "logs") {
      loadRtu(state.rtu.rtu_id, {background:true});
    }
  }, 10000);
})();
