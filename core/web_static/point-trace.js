(() => {
  'use strict';

  const state = {
    component: '',
    kind: 'yc',
    rtuId: '',
    q: '',
    mappedOnly: false,
    anomalyOnly: false,
    limit: 100,
    offset: 0,
    total: 0,
    mappedTotal: 0,
    timer: null,
    searchTimer: null,
    loading: false,
    rtuPopulated: false,
    pendingCmd: null,
  };

  const els = {
    kindBtns: Array.from(document.querySelectorAll('.pt-kind-btn')),
    rtu: document.getElementById('pt-rtu'),
    query: document.getElementById('pt-query'),
    mappedOnly: document.getElementById('pt-mapped-only'),
    anomalyOnly: document.getElementById('pt-anomaly-only'),
    auto: document.getElementById('pt-auto'),
    refresh: document.getElementById('pt-refresh'),
    exportBtn: document.getElementById('pt-export'),
    summary: document.getElementById('pt-summary'),
    tbody: document.getElementById('pt-tbody'),
    footInfo: document.getElementById('pt-foot-info'),
    prev: document.getElementById('pt-prev'),
    next: document.getElementById('pt-next'),
    pageLabel: document.getElementById('pt-page-label'),
    dialog: document.getElementById('pt-cmd-dialog'),
    form: document.getElementById('pt-cmd-form'),
    cmdTitle: document.getElementById('pt-cmd-title'),
    cmdMeta: document.getElementById('pt-cmd-meta'),
    cmdValue: document.getElementById('pt-cmd-value'),
    cmdError: document.getElementById('pt-cmd-error'),
    cmdClose: document.getElementById('pt-cmd-close'),
    cmdCancel: document.getElementById('pt-cmd-cancel'),
    cmdSubmit: document.getElementById('pt-cmd-submit'),
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtVal(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
    }
    return String(v);
  }

  function fmtTime(t) {
    if (t === null || t === undefined || t === '' || t === 0 || t === '0') return '—';
    const raw = String(t).trim();
    if (/^\d{10,13}$/.test(raw)) {
      const ms = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
      const d = new Date(ms);
      if (!Number.isNaN(d.valueOf())) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      }
    }
    return raw.length > 19 ? raw.slice(0, 19) : raw;
  }

  function isValueDiff(srcVal, fwdVal) {
    if (srcVal === null || srcVal === undefined || fwdVal === null || fwdVal === undefined) return false;
    const a = Number(srcVal);
    const b = Number(fwdVal);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) > 1e-4;
    return String(srcVal) !== String(fwdVal);
  }

  function syncUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const kind = (params.get('kind') || '').toLowerCase();
    if (['yc', 'yx', 'yk', 'yt'].includes(kind)) state.kind = kind;
    const rtu = (params.get('rtu_id') || '').trim();
    if (rtu) state.rtuId = rtu;
    const q = (params.get('q') || '').trim();
    if (q) {
      state.q = q;
      if (els.query) els.query.value = q;
    }
    if (params.get('mapped_only') === '1') {
      state.mappedOnly = true;
      if (els.mappedOnly) els.mappedOnly.checked = true;
    }
    if (params.get('anomaly_only') === '1') {
      state.anomalyOnly = true;
      if (els.anomalyOnly) els.anomalyOnly.checked = true;
    }
    updateKindTabs();
  }

  function updateKindTabs() {
    els.kindBtns.forEach((btn) => {
      const active = btn.dataset.kind === state.kind;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function populateRtus(rtus) {
    if (!els.rtu || !Array.isArray(rtus)) return;
    const current = state.rtuId;
    const opts = ['<option value="">全部 RTU</option>'];
    rtus.forEach((r) => {
      const id = String(r.rtu_id);
      const label = `RTU ${id}${r.name ? ' · ' + r.name : ''}${r.channel_id != null ? ' (通道 ' + r.channel_id + ')' : ''}`;
      opts.push(`<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(label)}</option>`);
    });
    els.rtu.innerHTML = opts.join('');
    state.rtuPopulated = true;
  }

  function renderRows(items) {
    if (!els.tbody) return;
    if (!items || !items.length) {
      els.tbody.innerHTML = '<tr><td colspan="8" class="pt-empty">当前筛选下无匹配测点</td></tr>';
      return;
    }
    const canCommand = state.component === 'c' && (state.kind === 'yk' || state.kind === 'yt');
    const html = items.map((item) => {
      const hasFwd = item.fwd_channel_id !== null && item.fwd_channel_id !== undefined;
      const diff = hasFwd && isValueDiff(item.src_value, item.fwd_value);
      const srcValCell = state.kind === 'yc' && item.raw_value !== null && item.raw_value !== undefined
        ? `<span class="pt-main-val">${esc(fmtVal(item.src_value))}</span><span class="pt-sub">原值 ${esc(fmtVal(item.raw_value))}</span>`
        : `<span class="pt-main-val">${esc(fmtVal(item.src_value))}</span>`;

      const srcStatusBadge = item.src_status === 0
        ? '<span class="pt-badge ok">正常</span>'
        : (item.src_status == null ? '<span class="pt-badge">—</span>' : `<span class="pt-badge warn">状态 ${esc(item.src_status)}</span>`);

      const fwdChanCell = hasFwd
        ? `<span>通道 ${esc(item.fwd_channel_id)}${item.fwd_channel_name ? ' · ' + esc(item.fwd_channel_name) : ''}</span>`
          + `<span class="pt-sub">${esc(item.fwd_protocol || '—')}${item.fwd_enabled === 0 ? ' · 已停用' : ''}</span>`
        : '<span class="muted">未映射</span>';

      const fwdAddrCell = hasFwd
        ? `<span>#${esc(item.fwd_pnt_no)}</span><span class="pt-sub">${esc(item.fwd_addr || '—')}</span>`
        : '<span class="muted">—</span>';

      const fwdValCell = hasFwd
        ? `<span class="pt-main-val">${esc(fmtVal(item.fwd_value))}</span>`
          + (diff ? ' <span class="pt-badge warn" title="采集值与转发值不一致">偏差</span>' : '')
          + `<span class="pt-sub">${esc(fmtTime(item.forward_time))}</span>`
        : '<span class="muted">—</span>';

      const actions = [];
      if (canCommand) {
        actions.push(
          `<button type="button" class="pt-act-btn primary" data-cmd-rtu="${esc(item.rtu_id)}" data-cmd-pnt="${esc(item.pnt_no)}" data-cmd-name="${esc(item.pnt_name || '')}" data-cmd-val="${esc(item.src_value ?? '')}">下发</button>`
        );
      }
      if (item.src_channel_id != null) {
        actions.push(`<a class="pt-link" href="/logs?channel_id=${encodeURIComponent(item.src_channel_id)}">日志</a>`);
      }
      actions.push(`<a class="pt-link" href="/command-traces?rtu_id=${encodeURIComponent(item.rtu_id)}">指令</a>`);

      return `<tr>
        <td><span>RTU ${esc(item.rtu_id)}${item.rtu_name ? ' · ' + esc(item.rtu_name) : ''}</span><span class="pt-sub">通道 ${esc(item.src_channel_id ?? '—')} · ${esc(item.src_protocol || '—')}</span></td>
        <td><span class="pt-main-val">#${esc(item.pnt_no)}</span> ${esc(item.pnt_name || '—')}</td>
        <td class="col-num">${srcValCell}</td>
        <td>${srcStatusBadge}<span class="pt-sub">${esc(fmtTime(item.src_refresh_time))}</span></td>
        <td>${fwdChanCell}</td>
        <td>${fwdAddrCell}</td>
        <td class="col-num">${fwdValCell}</td>
        <td><div class="pt-actions">${actions.join('')}</div></td>
      </tr>`;
    }).join('');
    els.tbody.innerHTML = html;
  }

  function updatePager() {
    const page = Math.floor(state.offset / state.limit) + 1;
    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    if (els.pageLabel) els.pageLabel.textContent = `${page} / ${totalPages}`;
    if (els.prev) els.prev.disabled = state.offset <= 0;
    if (els.next) els.next.disabled = state.offset + state.limit >= state.total;
    if (els.footInfo) {
      const start = state.total === 0 ? 0 : state.offset + 1;
      const end = Math.min(state.total, state.offset + state.limit);
      els.footInfo.textContent = `显示 ${start}–${end} / 共 ${state.total} 条（已转发映射 ${state.mappedTotal} 条）`;
    }
  }

  async function loadData(silent = false) {
    if (state.loading) return;
    state.loading = true;
    if (!silent && els.summary) els.summary.textContent = '刷新中…';
    try {
      const qs = new URLSearchParams({
        kind: state.kind,
        limit: String(state.limit),
        offset: String(state.offset),
        mapped_only: state.mappedOnly ? '1' : '0',
        anomaly_only: state.anomalyOnly ? '1' : '0',
      });
      if (state.rtuId) qs.set('rtu_id', state.rtuId);
      if (state.q) qs.set('q', state.q);
      const res = await fetch(`/api/point-trace?${qs.toString()}`, { cache: 'no-cache' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.component = data.component || state.component;
      state.total = Number(data.total || 0);
      state.mappedTotal = Number(data.mapped_total || 0);
      if (!state.rtuPopulated && Array.isArray(data.rtus)) {
        populateRtus(data.rtus);
      }
      renderRows(data.items || []);
      updatePager();
      const now = new Date().toTimeString().slice(0, 8);
      if (els.summary) {
        els.summary.textContent = `共 ${state.total} 条 · 已映射 ${state.mappedTotal} 条 · ${now}`;
      }
    } catch (err) {
      if (els.summary) els.summary.textContent = `加载失败：${err.message}`;
      if (!silent && els.tbody) {
        els.tbody.innerHTML = `<tr><td colspan="8" class="pt-empty">${esc(err.message)}</td></tr>`;
      }
    } finally {
      state.loading = false;
    }
  }

  function scheduleAuto() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (els.auto && els.auto.checked) {
      state.timer = setInterval(() => {
        if (!document.hidden) loadData(true);
      }, 5000);
    }
  }

  function openCmdDialog(btn) {
    if (!els.dialog) return;
    const rtuId = btn.dataset.cmdRtu;
    const pntNo = btn.dataset.cmdPnt;
    const name = btn.dataset.cmdName || '';
    const val = btn.dataset.cmdVal || '0';
    state.pendingCmd = { rtu_id: Number(rtuId), pnt_no: Number(pntNo), kind: state.kind };
    if (els.cmdTitle) els.cmdTitle.textContent = `${state.kind.toUpperCase()} 快捷下发`;
    if (els.cmdMeta) els.cmdMeta.textContent = `RTU ${rtuId} · 点 #${pntNo}${name ? ' · ' + name : ''}`;
    if (els.cmdValue) {
      els.cmdValue.step = state.kind === 'yk' ? '1' : 'any';
      els.cmdValue.value = val;
    }
    if (els.cmdError) els.cmdError.textContent = '';
    els.dialog.showModal();
  }

  function closeCmdDialog() {
    if (els.dialog && els.dialog.open) els.dialog.close();
    state.pendingCmd = null;
  }

  async function submitCmd(event) {
    event.preventDefault();
    if (!state.pendingCmd || !els.cmdValue) return;
    const numVal = Number(els.cmdValue.value);
    if (!Number.isFinite(numVal)) {
      if (els.cmdError) els.cmdError.textContent = '请输入有效数值';
      return;
    }
    if (els.cmdSubmit) els.cmdSubmit.disabled = true;
    if (els.cmdError) els.cmdError.textContent = '';
    try {
      const { rtu_id, kind, pnt_no } = state.pendingCmd;
      const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const res = await fetch(`/api/rtus/${encodeURIComponent(rtu_id)}/points/${encodeURIComponent(kind)}/${encodeURIComponent(pnt_no)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: numVal, cmd_time: nowIso }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      closeCmdDialog();
      if (window.scadaTrackCommand) {
        window.scadaTrackCommand({ rtu_id, kind, pnt_no, value: numVal });
      }
      loadData(true);
    } catch (err) {
      if (els.cmdError) els.cmdError.textContent = err.message || '下发失败';
    } finally {
      if (els.cmdSubmit) els.cmdSubmit.disabled = false;
    }
  }

  els.kindBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.kind;
      if (!k || k === state.kind) return;
      state.kind = k;
      state.offset = 0;
      updateKindTabs();
      loadData();
    });
  });

  if (els.rtu) {
    els.rtu.addEventListener('change', () => {
      state.rtuId = els.rtu.value;
      state.offset = 0;
      if (window.scadaFocusContext && typeof window.scadaFocusContext.set === 'function') {
        window.scadaFocusContext.set({ rtu_id: state.rtuId || null });
      }
      loadData();
    });
  }

  if (els.query) {
    els.query.addEventListener('input', () => {
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.q = els.query.value.trim();
        state.offset = 0;
        loadData();
      }, 260);
    });
  }

  if (els.mappedOnly) {
    els.mappedOnly.addEventListener('change', () => {
      state.mappedOnly = els.mappedOnly.checked;
      state.offset = 0;
      loadData();
    });
  }

  if (els.anomalyOnly) {
    els.anomalyOnly.addEventListener('change', () => {
      state.anomalyOnly = els.anomalyOnly.checked;
      state.offset = 0;
      loadData();
    });
  }

  if (els.exportBtn) {
    els.exportBtn.addEventListener('click', () => {
      const qs = new URLSearchParams({
        kind: state.kind,
        mapped_only: state.mappedOnly ? '1' : '0',
        anomaly_only: state.anomalyOnly ? '1' : '0',
      });
      if (state.rtuId) qs.set('rtu_id', state.rtuId);
      if (state.q) qs.set('q', state.q);
      const a = document.createElement('a');
      a.href = `/api/point-trace/export?${qs.toString()}`;
      a.download = `point-trace-${state.kind}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  if (els.auto) els.auto.addEventListener('change', scheduleAuto);
  if (els.refresh) els.refresh.addEventListener('click', () => loadData());
  if (els.prev) {
    els.prev.addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - state.limit);
      loadData();
    });
  }
  if (els.next) {
    els.next.addEventListener('click', () => {
      if (state.offset + state.limit < state.total) {
        state.offset += state.limit;
        loadData();
      }
    });
  }

  if (els.tbody) {
    els.tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmd-rtu]');
      if (btn) openCmdDialog(btn);
    });
  }

  if (els.cmdClose) els.cmdClose.addEventListener('click', closeCmdDialog);
  if (els.cmdCancel) els.cmdCancel.addEventListener('click', closeCmdDialog);
  if (els.form) els.form.addEventListener('submit', submitCmd);

  syncUrlParams();
  loadData();
  scheduleAuto();
})();
