"use strict";
const $=s=>document.querySelector(s);
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
const state={channels:[],points:[],selected:new URLSearchParams(location.search).get("channel_id")||null,logs:[],log:null,logRecord:"runtime",page:"channels",edit:null,batch:false,batchExisting:[],sourceCatalog:null,pointOffset:0,pointLimit:100,pointTotal:0,pointRequest:0,pointLoading:false,pointReloadPending:false};
const kindName={yc:"遥测",yx:"遥信",yk:"遥控",yt:"遥调"};
const pointKinds=Object.keys(kindName);
function activePointKind(){return $("#kind-filter")?.value||"yc"}
function pointTableBody(kind=activePointKind()){
  if(typeof document.querySelectorAll==="function")for(const page of document.querySelectorAll("[data-point-page]"))if(page.dataset.pointPage===kind)return page.querySelector("[data-points-body]");
  return $("#points");
}
function pointTableHead(kind=activePointKind()){
  if(typeof document.querySelectorAll==="function")for(const page of document.querySelectorAll("[data-point-page]"))if(page.dataset.pointPage===kind)return page.querySelector("[data-points-head]");
  return $("#points-head");
}
function setPointTab(kind){
  if(!pointKinds.includes(kind))kind="yc";
  const filter=$("#kind-filter");if(filter)filter.value=kind;
  if(typeof document.querySelectorAll!=="function")return;
  document.querySelectorAll("[data-point-tab]").forEach(tab=>{const active=tab.dataset.pointTab===kind;tab.setAttribute("aria-selected",active?"true":"false");tab.classList.toggle("active",active)});
  document.querySelectorAll("[data-point-page]").forEach(page=>{const active=page.dataset.pointPage===kind;page.hidden=!active;page.classList.toggle("active",active);const body=page.querySelector("[data-points-body]");if(body){if(active)body.id="points";else if(body.id==="points")body.removeAttribute("id")} });
}
const statusName={0:"停止",1:"启动中",2:"运行",3:"停止中",4:"处理中",5:"错误"};
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});let v;try{v=await r.json()}catch(_){throw Error(`HTTP ${r.status}`)}if(!r.ok)throw Error(v.error?.message||r.statusText);return v}
const versionHeaders=v=>v==null?{}:{"If-Match":String(v)};
const send=(path,method,body,version)=>api(path,{method,headers:versionHeaders(version),body:JSON.stringify(body)});
function toast(m){const e=$("#toast");e.textContent=m;clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>e.textContent="",4500)}
function fmt(v,timeOnly=false){if(!v)return "—";const d=new Date(Number(v));if(Number.isNaN(d.valueOf()))return String(v);const p=n=>String(n).padStart(2,"0"),t=`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;return timeOnly?t:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${t}`}
function id(r){return String(r.channel_id)}
function selected(){return state.channels.find(x=>id(x)===state.selected)}
function badge(r){const s=Number(r.process_status||0);return `<span class="status-badge ${s===2?"running":s===5?"error":""}">${esc(statusName[s]||s)}</span>`}
function runtimeBadge(r){const names={unknown:"未知",stopped:"停止",starting:"启动中",running:"运行中",stopping:"停止中",error:"错误",degraded:"降级"};const state=String(r?.state||"unknown");return `<span class="status-badge ${state==="running"?"running":state==="error"?"error":""}">${esc(names[state]||state)}</span>`}
function setPage(p){state.page=p;document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active",x.id===`page-${p}`));document.querySelectorAll("nav button[data-page]").forEach(x=>x.classList.toggle("active",x.dataset.page===p));if(p==="processes")loadProcesses().catch(e=>toast(e.message));if(p==="logs")loadLogs().catch(e=>toast(e.message))}
function setOptions(node,markup){if(node._optionsMarkup!==markup){node.innerHTML=markup;node._optionsMarkup=markup;}}
function renderSelects(){const s=$("#selected-channel"),l=$("#log-channel"),old=l?.value||"";if(s)setOptions(s,'<option value="">请选择</option>'+state.channels.map(x=>`<option value="${id(x)}">${id(x)} · ${esc(x.name||"")} · ${esc(x.protocol||"")}</option>`).join(""));if(s)s.value=state.selected||"";if(!l)return;setOptions(l,'<option value="">全部通道</option>'+state.channels.map(x=>`<option value="${id(x)}">${id(x)} · ${esc(x.name||"")}</option>`).join(""));l.value=state.logsChannel||old}
function renderChannels() {
  const body = $("#channels");
  if (!body) { renderSelects(); return; }
  const rows = state.channels;
  $("#channel-count").textContent = `${rows.length} 个通道`;
  $("#summary").textContent = `运行 ${rows.filter(x => x.runtime_status?.state === "running" || Number(x.runtime_status?.running) === 1 || Number(x.process_status) === 2).length} / 总数 ${rows.length}`;
  const markup = rows.length ? rows.map(x => { const r=x.runtime_status||{}; const d=r.diagnostic||{}; return `<tr class="${id(x) === state.selected ? "selected" : ""}" data-select="${id(x)}"><td>${id(x)}</td><td>${esc(x.name)}</td><td>${esc(x.protocol)}</td><td>${runtimeBadge(r)}</td><td>${esc(r.connection_state || "—")}</td><td class="mono">${esc([r.rx_count||0,r.tx_count||0,r.error_count||0,r.reconnect_count||0].join(" / "))}</td><td class="mono">${esc(fmt(r.process_heartbeat_time||x.process_heartbeat_time,true))}<small class="cell-sub">${esc(fmt(r.sampled_at,true))}</small></td><td title="${esc(JSON.stringify(d))}">${esc(Object.keys(d).length ? `${Object.keys(d).length} 项` : "—")}<small class="cell-sub">${esc(r.last_error||x.process_error||"")}</small></td><td class="actions"><a href="/points?channel_id=${id(x)}">四遥数据</a><a href="/logs?channel_id=${id(x)}">日志报文</a><button data-edit="${id(x)}">编辑</button><button data-version="${esc(x._version)}" data-delete="${id(x)}" class="danger">删除</button></td></tr>`; }).join("") : '<tr><td colspan="9" class="muted">暂无转发通道</td></tr>';
  // Heartbeats and counters change on every poll. Preserve action nodes and
  // their focus while updating cells; a changed row identity rebuilds safely.
  if (body._channelMarkup !== markup) {
    const keys = rows.map(id).join(',');
    const canPatch = rows.length && keys === body._channelKeys && body.rows && body.rows.length === rows.length && typeof document.createElement === "function";
    if (canPatch) {
      const tpl = document.createElement("template");
      tpl.innerHTML = "<table><tbody>" + markup + "</tbody></table>";
      const nextRows = Array.from(tpl.content.querySelectorAll("tr"));
      if (nextRows.length === rows.length) {
        nextRows.forEach((nextRow, i) => {
          const curRow = body.rows[i];
          if (nextRow.outerHTML === curRow.outerHTML) return;
          const nextCells = Array.from(nextRow.cells);
          if (nextCells.length !== curRow.cells.length) { curRow.replaceWith(nextRow); return; }
          nextCells.forEach((nextCell, j) => {
            if (nextCell.outerHTML === curRow.cells[j].outerHTML) return;
            if (j === 8) {
              const del = curRow.cells[j].querySelector('[data-delete]');
              if (del) { del.dataset.version = String(rows[i]._version); return; }
            }
            curRow.cells[j].replaceWith(nextCell);
          });
          curRow.classList.toggle('selected', id(rows[i]) === state.selected);
        });
      } else body.innerHTML = markup;
    } else body.innerHTML = markup;
    body._channelKeys = keys; body._channelMarkup = markup;
  }
  renderSelects(); renderDetail();
}
function renderDetail(){if(!$("#channel-detail"))return;const x=selected();if(!x){$("#channel-detail").innerHTML='<dt>通道</dt><dd>未选择</dd>';return}const protocol=String(x.protocol||"").toLowerCase(),r=x.runtime_status||{};const common={channel_id:"编号",name:"名称",protocol:"规约",bind_host:"监听地址",bind_port:"监听端口",scan_interval_ms:"读取周期(ms)",log_retention_hours:"日志保留小时",packet_recording:"保存报文",process_enable:"自动运行",process_pid:"进程号",process_start_time:"启动时间",process_stop_time:"停止时间",process_heartbeat_time:"心跳",process_error:"错误"};const specific=protocol==="iec104"?{common_address:"IEC104 公共地址",report_interval_ms:"全量上送周期(ms)"}:{unit_id:"Modbus 从站地址"};const n={...common,...specific};const fields=Object.entries(n).filter(([k])=>k in x).map(([k,v])=>`<dt>${v}</dt><dd>${k.includes("time")?esc(fmt(x[k],k.includes("heartbeat"))):k==="process_enable"||k==="packet_recording"?(Number(x[k])?"是":"否"):esc(x[k])||"—"}</dd>`).join("");$("#channel-detail").innerHTML=fields+`<dt>运行状态</dt><dd>${runtimeBadge(r)}</dd><dt>连接状态</dt><dd>${esc(r.connection_state||"—")}</dd><dt>收/发/错/重连</dt><dd class="mono">${esc([r.rx_count||0,r.tx_count||0,r.error_count||0,r.reconnect_count||0].join(" / "))}</dd><dt>最近错误</dt><dd>${esc(r.last_error||"—")}</dd><dt>诊断</dt><dd class="mono">${esc(JSON.stringify(r.diagnostic||{}))}</dd>`}
function pno(x){return x.pnt_no??0}
const pointTrendHost = $("#point-trend");
const pointTrend = pointTrendHost ? window.scadaPointTrend?.mount(pointTrendHost) : null;
const pointColumnOffset = 0;
const pointColumnCount = 13;

function renderPointTrendRow(row, point) {
  const identity = `通道 ${point.owner} · ${point.kind.toUpperCase()} ${point.no}`;
  const name = point.cells[4] ? `${identity} · ${point.cells[4]}` : identity;
  const definition = {channel_id: point.owner, pnt_no: point.no, kind: point.kind, name};
  pointTrend.bindRow?.(row, definition, row.cells[0]);
}

let previousRows = null;
function renderPoints(){
  const r=state.points, kind=activePointKind(), body=pointTableBody(kind), protocol=String(selected()?.protocol||"iec104").toLowerCase();
  if(!body)return;
  const head=pointTableHead(kind);
  if (head) {
    const headings = ["类型", "转发点号", "源 RTU", "源点号", "名称",
      protocol === "iec104" ? "IEC IOA" : "Modbus 区/地址", "实时值", "状态", "刷新时间",
      "指令接收时间", "最后转发", "启用", "操作"];
    const markup = headings.map(label => `<th>${label}</th>`).join("");
    if (head._pointMarkup !== markup) {
      head.innerHTML = markup;
      head._pointMarkup = markup;
    }
  }
  const rows=r.map(x=>({owner:String(x.channel_id),kind:x.kind,no:String(pno(x)),version:String(x._version),
    cells:[kindName[x.kind]||x.kind,pno(x),x.source_rtu_id,x.source_pnt_no,x.name,
      protocol==="iec104"?(x.io_address??"—"):(x.register_area??"—")+" / "+(x.address??"—"),
      x.value??"—",x.status??"—",fmt(x.refresh_time),fmt(x.command_receive_time),fmt(x.forward_time),
      Number(x.enabled??1)?"是":"否"].map(v=>String(v??""))}));
  const same=previousRows && rows.length===previousRows.length && rows.every((x,i)=>{
    const old=previousRows[i];return x.owner===old.owner && x.kind===old.kind && x.no===old.no;
  });
  if (!same) {
    body.innerHTML = rows.map(point => `<tr>${point.cells.map(value => `<td>${esc(value)}</td>`).join("")}
      <td class="actions"><button data-point-edit="${esc(point.no)}" data-point-kind="${esc(point.kind)}">编辑</button><button
        data-owner="${esc(point.owner)}" data-version="${esc(point.version)}" data-point-delete="${esc(point.no)}"
        data-point-kind="${esc(point.kind)}" class="danger">删除</button></td></tr>`).join("")
      || `<tr><td colspan="${pointColumnCount}" class="muted">暂无点映射</td></tr>`;
    if (pointTrend) rows.forEach((point, index) => renderPointTrendRow(body.rows[index], point));
  } else {
    rows.forEach((x,i)=>{
      const old=previousRows[i];
      x.cells.forEach((value,j)=>{if(value!==old.cells[j]) body.rows[i].cells[j + pointColumnOffset].textContent=value;});
      if (pointTrend && x.cells[4] !== old.cells[4]) renderPointTrendRow(body.rows[i], x);
      if(x.version!==old.version) body.rows[i].querySelector("[data-point-delete]").dataset.version=x.version;
    });
  }
  previousRows=rows;
  if($("#point-page-summary"))$("#point-page-summary").textContent=`共 ${state.pointTotal} 条 · 当前 ${r.length?state.pointOffset+1:0}–${state.pointOffset+r.length} 条`;if($("#point-prev"))$("#point-prev").disabled=state.pointOffset===0;if($("#point-next"))$("#point-next").disabled=state.pointOffset+r.length>=state.pointTotal}
let channelRequest = 0, pendingChannels = 0, channelRead = null;
function loadChannels({loadSelectedPoints = false, fresh = false} = {}) {
  if (channelRead) {
    if (fresh) return channelRead.promise.catch(() => {}).then(() => loadChannels({loadSelectedPoints}));
    channelRead.loadSelectedPoints ||= loadSelectedPoints;
    return channelRead.promise;
  }
  const pending = {loadSelectedPoints};
  pending.promise = performLoadChannels(pending).finally(() => { if (channelRead === pending) channelRead = null; });
  channelRead = pending;
  return pending.promise;
}
async function performLoadChannels(pending) {
  const request = ++channelRequest;
  pendingChannels++;
  try {
    const v = await api(pointTableBody() && !$("#channels") ? "/api/trans/channels?view=selector" : "/api/trans/status");
    if (request !== channelRequest) return;
    const previous = state.selected;
    state.channels = v.items || [];
    if (state.selected && !state.channels.some(x => id(x) === state.selected)) state.selected = null;
    const requested = new URLSearchParams(location.search).get("channel_id");
    if (!state.selected) state.selected = requested ? (state.channels.some(x => id(x) === requested) ? requested : null) : (state.channels.length ? id(state.channels[0]) : null);
    if (previous !== state.selected) state.pointOffset = 0;
    renderChannels();
    if (pending.loadSelectedPoints || previous !== state.selected) await loadPoints();
  } catch (error) { if (request === channelRequest) throw error; }
  finally { pendingChannels--; }
}
async function loadPoints({background=false}={}){
  // Polls join the current read; explicit edits/navigation still request one
  // trailing read, so a save during an in-flight GET cannot lose its refresh.
  if(state.pointLoading){if(!background)state.pointReloadPending=true;return}
  state.pointLoading=true;
  try{
    const kind=activePointKind(),body=pointTableBody(kind);if(!body)return;setPointTab(kind);
    const request=++state.pointRequest;
    if(!state.selected){state.points=[];state.pointTotal=0;state.pointOffset=0;renderPoints();return}
    const nameFilter=$("#point-search")?.value.trim()||"";
    const cid=state.selected,offset=state.pointOffset,limit=state.pointLimit,q=new URLSearchParams({limit:String(limit),offset:String(offset),kind,name_contains:nameFilter});
    const current=()=>request===state.pointRequest&&cid===state.selected&&kind===activePointKind()&&offset===state.pointOffset&&limit===state.pointLimit&&nameFilter===($("#point-search")?.value.trim()||"");
    const scope=JSON.stringify([cid,kind,nameFilter]);
    if(state.pointScope!==scope){state.pointScope=scope;state.points=[];state.pointTotal=0;renderPoints();previousRows=null;body.innerHTML=`<tr><td colspan="${pointColumnCount}">正在读取点映射…</td></tr>`}
    let page;
    try{page=await api(`/api/trans/channels/${cid}/points?${q}`)}catch(error){if(!current())return;throw error}
    if(!current())return;
    state.pointTotal=page.total??0;
    if(offset>0&&offset>=state.pointTotal){state.pointOffset=Math.max(0,Math.floor((state.pointTotal-1)/state.pointLimit)*state.pointLimit);state.pointReloadPending=true;return}
    state.points=page.items||[];renderPoints()
  }finally{
    state.pointLoading=false;
    if(state.pointReloadPending){state.pointReloadPending=false;queueMicrotask(()=>loadPoints().catch(e=>toast(e.message)))}
  }
}
async function control(cid,a){await api(`/api/trans/channels/${cid}/${a}`,{method:"POST",body:"{}"});toast(a==="start"?"启动请求已发送":"停止请求已发送");await loadChannels({loadSelectedPoints:true,fresh:true});if(state.page==="processes")await loadProcesses({fresh:true})}
let pendingProcesses=null, previousProcessesHtml=null;
function loadProcesses({fresh=false}={}){
  if(pendingProcesses)return fresh?pendingProcesses.catch(()=>{}).then(()=>loadProcesses()):pendingProcesses;
  pendingProcesses=fetchProcesses().finally(()=>{pendingProcesses=null});
  return pendingProcesses;
}
async function fetchProcesses(){const r=(await api("/api/trans/processes")).items||[];$("#process-summary").textContent=`运行 ${r.filter(x=>x.alive).length} / 总数 ${r.length}`;const html=r.length?r.map(x=>`<tr><td>${esc(id(x))} · ${esc(x.name||"")}</td><td>${esc(x.protocol)}</td><td>${badge(x)}</td><td>${esc(x.process_pid||"—")}</td><td>${esc(fmt(x.process_start_time))}</td><td>${esc(fmt(x.process_heartbeat_time,true))}</td><td title="${esc(x.process_error)}">${esc(x.process_error)||"—"}</td><td class="actions"><button data-control="start" data-id="${esc(id(x))}">启动</button><button class="danger" data-control="stop" data-id="${esc(id(x))}">停止</button><button data-log-channel="${esc(id(x))}">日志</button></td></tr>`).join(""):'<tr><td colspan="8" class="muted">暂无通道</td></tr>';if(html!==previousProcessesHtml){$("#processes").innerHTML=html;previousProcessesHtml=html}}
async function loadLogs(){const c=$("#log-channel")?.value||"";state.logsChannel=c;const q=new URLSearchParams({record:state.logRecord||"runtime"});if(c)q.set("channel_id",c);const v=await api(`/api/trans/logs?${q}`);state.logs=v.items||[];$("#log-count").textContent=`${v.total||0} 个文件`;$("#log-files").innerHTML=state.logs.map(x=>`<button class="log-file ${state.log===x.filename?"active":""}" data-log="${esc(x.filename)}">${esc(x.filename)}<small>${(x.size/1024).toFixed(1)} KB · ${esc(fmt(x.mtime))}</small></button>`).join("")||'<div class="muted">暂无日志</div>';if(state.log&&!state.logs.some(x=>x.filename===state.log))state.log=null;if(!state.log&&state.logs.length)state.log=state.logs[0].filename;if(state.log)await loadLog();else {$("#log-name").textContent="请选择日志文件";$("#log-content").textContent="—"}}
async function loadLog(){if(!state.log)return;const q=new URLSearchParams({filename:state.log,tail:"2000",record:state.logRecord||"runtime"}),v=await api(`/api/trans/log?${q}`),k=$("#log-keyword")?.value.trim().toLowerCase()||"";$("#log-name").textContent=state.log;$("#log-content").textContent=(v.lines||[]).filter(x=>!k||x.toLowerCase().includes(k)).join("\n")||"（没有匹配内容）";document.querySelectorAll(".log-file").forEach(e=>e.classList.toggle("active",e.dataset.log===state.log))}
const channelCommonFields=[["name","名称","text"],["protocol","规约","protocol"],["bind_host","监听地址","text"],["bind_port","监听端口","number"],["scan_interval_ms","读取周期(ms)","number"],["log_retention_hours","日志保留小时","number"],["packet_recording","保存报文","bool"],["process_enable","自动运行","bool"]];
const channelProtocolFields={"iec104":[["common_address","IEC104 公共地址","number"],["report_interval_ms","全量上送周期(ms)","number"],["k","发送窗口 k","number"],["w","接收确认窗口 w","number"],["t1","确认超时 t1(s)","float"],["t2","延迟确认 t2(s)","float"],["t3","空闲测试 t3(s)","float"],["max_asdu_length","ASDU 长度阈值","number"]],"modbus-tcp":[["unit_id","Modbus 从站地址","number"]]};
const pointCommonFields=[["pnt_no","转发点号","number"],["name","名称","text"],["kind","转发类型","kind"],["source_rtu_id","源 RTU","number"],["source_pnt_no","源点号","number"],["enabled","启用","bool"]];
const pointProtocolFields={"iec104":[["io_address","IEC IOA","number"],["type_id","IEC 类型号","iec_type"],["time_tag","时间标签","time_tag"],["command_mode","命令方式","mode"]],"modbus-tcp":[["register_area","Modbus 数据区","area"],["address","Modbus 地址","number"],["address_base","地址基准","addr_base"],["data_type","数据类型","dtype"],["byte_order","字节序","order"],["word_order","字序","order"],["scale","比例","float"],["offset","偏移","float"]]};
const defaults={protocol:"iec104",bind_host:"0.0.0.0",bind_port:2404,common_address:1,unit_id:1,scan_interval_ms:200,report_interval_ms:1000,log_retention_hours:720,packet_recording:0,process_enable:0,kind:"yc",enabled:1,io_address:0,type_id:0,command_mode:"DIRECT",register_area:"holding",address:0,data_type:"float32",byte_order:"big",word_order:"big",scale:1,offset:0};
Object.assign(defaults,{k:12,w:8,t1:15,t2:10,t3:20,max_asdu_length:249,time_tag:"NONE",address_base:0});
const iecTypeOptions={
  yc:[[0,"0 · 自动默认"],[9,"9 · 归一化测量值"],[11,"11 · 标度化测量值"],[13,"13 · 短浮点测量值"],[21,"21 · 不带品质归一化"],[34,"34 · 带 CP56 归一化"],[35,"35 · 带 CP56 标度化"],[36,"36 · 带 CP56 短浮点"]],
  yx:[[0,"0 · 自动默认"],[1,"1 · 单点信息"],[3,"3 · 双点信息"],[5,"5 · 步位置信息"],[30,"30 · 带 CP56 单点"],[31,"31 · 带 CP56 双点"],[32,"32 · 带 CP56 步位置"]],
  yk:[[0,"0 · 自动默认"],[45,"45 · 单点遥控"],[46,"46 · 双点遥控"],[58,"58 · 带 CP56 单点遥控"],[59,"59 · 带 CP56 双点遥控"]],
  yt:[[0,"0 · 自动默认"],[48,"48 · 归一化设点"],[49,"49 · 标度化设点"],[50,"50 · 短浮点设点"],[61,"61 · 带 CP56 归一化设点"],[62,"62 · 带 CP56 标度化设点"],[63,"63 · 带 CP56 短浮点设点"]],
};
function iecTypeOptionsMarkup(kind,value){
  const list=[...(iecTypeOptions[kind]||iecTypeOptions.yc)];
  const num=Number(value??0);
  if(Number.isFinite(num)&&!list.some(([v])=>v===num))list.push([num,`${num} · 自定义/历史类型`]);
  return list.map(([v,label])=>`<option value="${v}" ${num===v?"selected":""}>${esc(label)}</option>`).join("");
}
function timeTagInput(value){const tags=["NONE","CP56Time2a"];if(value&&!tags.includes(value))tags.push(value);return `<select name="time_tag">${tags.map(tag=>`<option value="${esc(tag)}" ${value===tag?"selected":""}>${esc(tag)}${["NONE","CP56Time2a"].includes(tag)?"":"（不受支持）"}</option>`).join("")}</select>`}
function input(k,t,v,disabled,pointKind="yc"){const d=disabled?" disabled":"";if(t==="protocol")return `<select name="${k}"><option value="iec104" ${v==="iec104"?"selected":""}>IEC104</option><option value="modbus-tcp" ${v==="modbus-tcp"?"selected":""}>Modbus TCP</option></select>`;if(t==="kind")return `<select name="${k}"${d}>${Object.entries(kindName).map(([x,n])=>`<option value="${x}" ${v===x?"selected":""}>${n}</option>`).join("")}</select>`;if(t==="bool")return `<select name="${k}"><option value="1" ${Number(v)?"selected":""}>是</option><option value="0" ${!Number(v)?"selected":""}>否</option></select>`;if(t==="mode")return `<select name="${k}"><option value="DIRECT" ${v==="DIRECT"?"selected":""}>直接执行</option><option value="SELECT_AND_EXECUTE" ${v==="SELECT_AND_EXECUTE"?"selected":""}>选择并执行</option></select>`;if(t==="area")return `<select name="${k}">${["coil","discrete","holding","input"].map(x=>`<option value="${x}" ${v===x?"selected":""}>${x}</option>`).join("")}</select>`;if(t==="addr_base"){const bases=[0,1,10001,30001,40001];const cur=Number(v??0);if(!bases.includes(cur))bases.push(cur);return `<select name="${k}">${bases.map(x=>`<option value="${x}" ${cur===x?"selected":""}>${x}</option>`).join("")}</select>`}if(t==="iec_type")return `<select name="${k}">${iecTypeOptionsMarkup(pointKind,v)}</select>`;if(t==="dtype")return `<select name="${k}">${["bool","uint16","int16","uint32","int32","float32","float64","uint64","int64"].map(x=>`<option value="${x}" ${v===x?"selected":""}>${x}</option>`).join("")}</select>`;if(t==="order")return `<select name="${k}"><option value="big" ${v==="big"?"selected":""}>big</option><option value="little" ${v==="little"?"selected":""}>little</option></select>`;return `<input name="${k}" type="${t==="float"?"number":t}" step="${t==="float"?"any":"1"}" value="${esc(v)}"${d}>`}
function editorProtocol(){const select=$("#editor-fields [name=\"protocol\"]");return String(select?.value||selected()?.protocol||defaults.protocol).toLowerCase()}
function editorFields(type){const protocol=editorProtocol();return type==="channel"?[...channelCommonFields,...channelProtocolFields.iec104,...channelProtocolFields["modbus-tcp"]]:[...pointCommonFields,...pointProtocolFields.iec104,...pointProtocolFields["modbus-tcp"]]}
function setEditorProtocolVisibility(){const protocol=editorProtocol();if(typeof document.querySelectorAll!=="function")return;document.querySelectorAll("#editor-fields [data-protocol-field]").forEach(label=>{label.hidden=label.dataset.protocolField!==protocol})}
function sourceKind(){return String($("#editor-fields [name=\"kind\"]")?.value||"yc").toLowerCase()}
let sourceCatalogRequest=0, sourcePointRequest=0;
async function loadSourceCatalog(){
  const edit=state.edit;
  if(edit?.type!=="point")return;
  const kind=sourceKind(), request=++sourceCatalogRequest;
  ++sourcePointRequest;
  const rtu=$("#editor-fields [name=\"source_rtu_id\"]"), point=$("#editor-fields [name=\"source_pnt_no\"]");
  if(!rtu||!point)return;
  const currentRtu=rtu.value||String(edit.item?.source_rtu_id||"");
  const current=()=>request===sourceCatalogRequest&&state.edit===edit&&sourceKind()===kind&&rtu.isConnected&&$("#editor").open;
  rtu.disabled=point.disabled=true;
  point.innerHTML='<option value="">正在加载源点…</option>';
  try{
    const response=await api(`/api/trans/source-catalog?kind=${encodeURIComponent(kind)}`);
    if(!current())return;
    state.sourceCatalog=response;
    rtu.innerHTML='<option value="">请选择源 RTU</option>'+response.rtus.map(x=>`<option value="${esc(x.rtu_id)}">${esc(x.rtu_id)} · ${esc(x.name||"")} · ${esc(x.channel_type||"")}（${esc(x.point_count)}点）</option>`).join("");
    rtu.value=response.rtus.some(x=>String(x.rtu_id)===currentRtu)?currentRtu:"";
    rtu.disabled=false;
    const refreshPoints=async(initial=false)=>{
      const selectedRtu=rtu.value, pointRequest=++sourcePointRequest;
      const valid=()=>current()&&pointRequest===sourcePointRequest&&rtu.value===selectedRtu;
      point.disabled=true;point.innerHTML='<option value="">'+(selectedRtu?'正在加载源点…':'请选择源 RTU 后加载源点')+'</option>';
      if(!selectedRtu)return;
      try{
        const detail=await api(`/api/trans/source-catalog?kind=${encodeURIComponent(kind)}&rtu_id=${encodeURIComponent(selectedRtu)}&include_rtus=0`);
        if(!valid())return;
        state.sourceCatalog=detail;
        point.innerHTML=(point.multiple?'':'<option value="">请选择源点</option>')+(detail.items||[]).map(x=>`<option value="${esc(x.pnt_no)}">${esc(x.pnt_no)} · ${esc(x.name||"")}（值 ${esc(x.value??"")}）</option>`).join("");
        if(initial&&String(edit.item?.source_rtu_id)===selectedRtu&&edit.item?.kind===kind)
          Array.from(point.options).forEach(o=>o.selected=o.value===String(edit.item.source_pnt_no));
        point.disabled=false;
        $("#editor-error").textContent="";
      }catch(err){if(valid()){$("#editor-error").textContent=err.message;point.innerHTML='<option value="">源点加载失败，请重新选择 RTU</option>';}}
    };
    rtu.onchange=()=>refreshPoints();
    await refreshPoints(true);
  }catch(err){if(current()){$("#editor-error").textContent=err.message;rtu.disabled=false;}}
}
function setPointSourceControls(batch){
  const rtu=$("#editor-fields [name=\"source_rtu_id\"]"), point=$("#editor-fields [name=\"source_pnt_no\"]");
  if(!rtu||!point)return;
  rtu.outerHTML='<select name="source_rtu_id" required></select>';
  point.outerHTML=`<select name="source_pnt_no" ${batch?'multiple size="8" required':'required'}></select>`;
}
function modbusWordWidth(dtype){
  const t=String(dtype||"").toLowerCase();
  if(["float64","int64","uint64"].includes(t))return 4;
  if(["float32","int32","uint32"].includes(t))return 2;
  return 1;
}
function defaultBatchStep(){
  const protocol=editorProtocol();
  if(protocol==="iec104")return 1;
  const area=String($("#editor-fields [name=\"register_area\"]")?.value||"holding").toLowerCase();
  if(area==="coil"||area==="discrete")return 1;
  return modbusWordWidth($("#editor-fields [name=\"data_type\"]")?.value);
}
async function loadBatchExisting(){
  state.batchExisting=[];
  if(!state.batch||!state.selected)return;
  try{
    const res=await api(`/api/trans/channels/${state.selected}/points?limit=2000&offset=0`);
    state.batchExisting=res.items||[];
    updateBatchPreview();
  }catch(_){state.batchExisting=[];}
}
function buildBatchPlan(values){
  const pointSelect=$("#editor-fields [name=\"source_pnt_no\"]");
  const selectedOpts=Array.from(pointSelect?.selectedOptions||[]).filter(o=>o.value);
  const protocol=editorProtocol();
  const stepInput=$("#batch-addr-step");
  const stepRaw=stepInput?Number(stepInput.value):defaultBatchStep();
  const step=Number.isFinite(stepRaw)&&stepRaw>=0?Math.trunc(stepRaw):defaultBatchStep();
  const startPntRaw=$("#batch-start-pnt")?.value?.trim()||"";
  const startPnt=startPntRaw!==""&&Number.isFinite(Number(startPntRaw))?Math.trunc(Number(startPntRaw)):null;
  const autoName=Boolean($("#batch-auto-name")?.checked);
  const startAddr=protocol==="iec104"?Number(values.io_address??0):Number(values.address??0);
  const width=protocol==="iec104"?1:(["coil","discrete"].includes(String(values.register_area||"holding"))?1:modbusWordWidth(values.data_type));
  const area=String(values.register_area||"holding").toLowerCase();
  const catalogByNo=new Map((state.sourceCatalog?.items||[]).map(x=>[String(x.pnt_no),x]));
  const items=[];
  const plannedKeys=new Map();
  const conflicts=[];
  const existingMap=new Map();
  for(const row of state.batchExisting){
    if(protocol==="iec104"){
      if(row.io_address!=null)existingMap.set(`ioa:${row.io_address}`,row);
    }else{
      const rArea=String(row.register_area||"holding").toLowerCase();
      const rWidth=["coil","discrete"].includes(rArea)?1:modbusWordWidth(row.data_type);
      const base=Number(row.address);
      if(Number.isFinite(base)){
        for(let w=0;w<rWidth;w++)existingMap.set(`${rArea}:${base+w}`,row);
      }
    }
  }
  selectedOpts.forEach((opt,idx)=>{
    const srcNo=opt.value;
    const addr=Number.isFinite(startAddr)?startAddr+idx*step:0;
    const item={...values,source_rtu_id:values.source_rtu_id,source_pnt_no:srcNo};
    delete item.pnt_no;
    if(startPnt!==null&&startPnt>0)item.pnt_no=startPnt+idx;
    if(protocol==="iec104")item.io_address=addr;
    else item.address=addr;
    if(autoName&&!values.name){
      const srcInfo=catalogByNo.get(String(srcNo));
      if(srcInfo&&srcInfo.name)item.name=srcInfo.name;
    }
    if(protocol==="iec104"){
      const key=`ioa:${addr}`;
      if(plannedKeys.has(key))conflicts.push(`批次内 IOA ${addr} 重复`);
      else if(existingMap.has(key))conflicts.push(`IOA ${addr} 已被点 #${existingMap.get(key).pnt_no} 占用`);
      plannedKeys.set(key,idx);
    }else{
      for(let w=0;w<width;w++){
        const key=`${area}:${addr+w}`;
        if(plannedKeys.has(key)){conflicts.push(`批次内 ${area} 地址 ${addr+w} 重叠`);break;}
        if(existingMap.has(key)){conflicts.push(`${area} 地址 ${addr+w} 已被点 #${existingMap.get(key).pnt_no} 占用`);break;}
        plannedKeys.set(key,idx);
      }
    }
    items.push(item);
  });
  return {items,conflicts,protocol,step,startAddr,area};
}
function applyNextFreeBatchAddress(){
  if(!state.batch)return;
  const protocol=editorProtocol();
  const kind=sourceKind();
  const step=defaultBatchStep();
  const stepEl=$("#batch-addr-step");
  if(stepEl)stepEl.value=String(step);
  let maxPnt=0;
  for(const row of state.batchExisting){
    if(row.kind===kind)maxPnt=Math.max(maxPnt,Number(row.pnt_no||0));
  }
  const startPntEl=$("#batch-start-pnt");
  if(startPntEl)startPntEl.value=String(maxPnt+1);
  if(protocol==="iec104"){
    let maxIoa=-1;
    for(const row of state.batchExisting){
      if(row.io_address!=null)maxIoa=Math.max(maxIoa,Number(row.io_address));
    }
    const ioaEl=$("#editor-fields [name=\"io_address\"]");
    if(ioaEl)ioaEl.value=String(maxIoa>=0?maxIoa+1:1);
  }else{
    const area=String($("#editor-fields [name=\"register_area\"]")?.value||"holding").toLowerCase();
    let nextAddr=0;
    for(const row of state.batchExisting){
      if(String(row.register_area||"holding").toLowerCase()!==area)continue;
      const w=["coil","discrete"].includes(area)?1:modbusWordWidth(row.data_type);
      nextAddr=Math.max(nextAddr,Number(row.address||0)+w);
    }
    const addrEl=$("#editor-fields [name=\"address\"]");
    if(addrEl)addrEl.value=String(nextAddr);
  }
  updateBatchPreview();
}
function updateBatchPreview(){
  const box=$("#batch-addr-preview");
  if(!box||!state.batch)return;
  const fields=editorFields("point");
  const values=readEditorValues(fields);
  const plan=buildBatchPlan(values);
  const count=plan.items.length;
  if(!count){
    box.className="batch-preview";
    box.textContent="按住 Ctrl / Shift 多选源点后，自动按步长顺延目标地址并实时校验冲突";
    return;
  }
  const first=plan.startAddr;
  const last=first+(count-1)*plan.step;
  const addrText=plan.protocol==="iec104"?`IOA ${first} → ${last}`:`${plan.area} ${first} → ${last}`;
  if(plan.conflicts.length){
    box.className="batch-preview is-conflict";
    box.textContent=`发现 ${plan.conflicts.length} 处地址冲突：${plan.conflicts.slice(0,3).join("；")}${plan.conflicts.length>3?"…":""}`;
  }else{
    box.className="batch-preview is-ok";
    box.textContent=`就绪 · 共 ${count} 点 · 连续编址 ${addrText}（步长 ${plan.step}，无地址冲突）`;
  }
}
async function openEditor(type,item,batch=false){
  state.edit={type,item,channel:item ? id(item) : state.selected};state.batch=Boolean(batch);state.sourceCatalog=null;state.batchExisting=[];
    const protocol=String(item?.protocol||selected()?.protocol||defaults.protocol).toLowerCase();
    const pointKind = item?.kind || activePointKind();
  const fields=type==="channel"?[...channelCommonFields,...channelProtocolFields.iec104,...channelProtocolFields["modbus-tcp"]]:[...pointCommonFields,...pointProtocolFields.iec104,...pointProtocolFields["modbus-tcp"]];
  $("#editor-title").textContent=batch?"批量新增点映射":`${item?"编辑":"新建"}${type==="channel"?"转发通道":"点映射"}`;
  $("#editor-error").textContent="";
  const batchBar=batch&&type==="point"?`<div class="batch-addr-bar" id="batch-addr-bar">
    <label>起始转发点号<input id="batch-start-pnt" type="number" min="1" step="1" placeholder="自动顺延"></label>
    <label>地址步长<select id="batch-addr-step"><option value="1">1 (连续)</option><option value="2">2 (32位)</option><option value="4">4 (64位)</option><option value="0">0 (不递增)</option></select></label>
    <label class="batch-check"><input id="batch-auto-name" type="checkbox" checked>沿用源点名称</label>
    <button type="button" id="batch-auto-fill">一键连续编址</button>
    <div id="batch-addr-preview" class="batch-preview">正在读取已有映射…</div>
  </div>`:"";
  $("#editor-fields").innerHTML=batchBar+fields.map(([k,l,t])=>{
    const group=type==="channel"?(channelProtocolFields.iec104.some(x=>x[0]===k)?"iec104":channelProtocolFields["modbus-tcp"].some(x=>x[0]===k)?"modbus-tcp":""):(pointProtocolFields.iec104.some(x=>x[0]===k)?"iec104":pointProtocolFields["modbus-tcp"].some(x=>x[0]===k)?"modbus-tcp":"");
    const hidden=batch&&type==="point"&&k==="pnt_no";
    const value = k === "kind" && type === "point" ? pointKind : (item?.[k] ?? defaults[k] ?? "");
    return `<label data-field="${k}"${group?` data-protocol-field="${group}"`:""}${hidden?' hidden':''}>${l}${t==="time_tag"?timeTagInput(value):input(k,t,value,Boolean(item&&type==="point"&&["pnt_no","kind"].includes(k)),pointKind)}</label>`;
  }).join("");
  if(type==="point")setPointSourceControls(batch);
  $("#editor").classList.toggle("batch-editor", Boolean(batch));
  $("#editor").showModal();
  $("#editor-fields [name=\"protocol\"]")?.addEventListener("change",setEditorProtocolVisibility);
  $("#editor-fields [name=\"kind\"]")?.addEventListener("change",()=>{
    const typeSelect=$("#editor-fields [name=\"type_id\"]");
    if(typeSelect&&typeSelect.tagName==="SELECT")typeSelect.innerHTML=iecTypeOptionsMarkup(sourceKind(),0);
    loadSourceCatalog().catch(err=>$("#editor-error").textContent=err.message);
  });
  setEditorProtocolVisibility();
  if(batch&&type==="point"){
    const stepEl=$("#batch-addr-step");
    if(stepEl)stepEl.value=String(defaultBatchStep());
    $("#batch-auto-fill")?.addEventListener("click",applyNextFreeBatchAddress);
    const fieldsEl=$("#editor-fields");
    if(fieldsEl){
      fieldsEl.oninput=()=>{if(state.batch)updateBatchPreview()};
      fieldsEl.onchange=e=>{
        if(!state.batch)return;
        if(e.target?.name==="data_type"||e.target?.name==="register_area"){
          const s=$("#batch-addr-step");
          if(s)s.value=String(defaultBatchStep());
        }
        updateBatchPreview();
      };
    }
    loadBatchExisting();
  }else{
    const fieldsEl=$("#editor-fields");
    if(fieldsEl){fieldsEl.oninput=null;fieldsEl.onchange=null;}
  }
  if(type==="point")try{await loadSourceCatalog();if(batch)updateBatchPreview()}catch(err){$("#editor-error").textContent=err.message}
}
function readEditorValues(fields){const values={};for(const [k,,t]of fields){const el=$("#editor-fields [name=\""+k+"\"]");if(!el||el.disabled||el.value===""||el.closest("label")?.hidden)continue;values[k]=["source_rtu_id","source_pnt_no","pnt_no"].includes(k)?el.value:["number","float","bool","addr_base","iec_type"].includes(t)?Number(el.value):el.value}return values}
async function saveEditor(e){
  e.preventDefault();
  const {type,item,channel}=state.edit,fields=editorFields(type),values=readEditorValues(fields);
  try{
    if(type==="channel"){
      if(item)await send(`/api/trans/channels/${id(item)}`,"PATCH",values,item._version);else await send("/api/trans/channels","POST",values);
      await loadChannels({loadSelectedPoints:true,fresh:true});
    }else{
      if(!channel||channel!==state.selected)throw Error("通道已切换，请重新选择测点");
      if($("#editor-fields [name=\"source_rtu_id\"]")?.disabled||$("#editor-fields [name=\"source_pnt_no\"]")?.disabled)throw Error("请等待源点加载完成后再保存");
      if(state.batch){
        const rtu=values.source_rtu_id;
        const plan=buildBatchPlan(values);
        if(!rtu||!plan.items.length)throw Error("请选择源 RTU 和至少一个源点");
        if(plan.conflicts.length)throw Error(`目标地址冲突，请点击“一键连续编址”或调整起始地址：${plan.conflicts.slice(0,3).join("；")}`);
        await send(`/api/trans/channels/${channel}/points/batch`,"POST",{items:plan.items});
      }else if(item)await send(`/api/trans/channels/${channel}/points/${encodeURIComponent(item.kind)}/${pno(item)}`,"PATCH",values,item._version);else await send(`/api/trans/channels/${channel}/points`,"POST",values);
      await loadPoints();
    }
    $("#editor").close();toast("已保存");
  }catch(err){$("#editor-error").textContent=err.message}
}
document.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;try{if(b.dataset.pointTab){state.pointOffset=0;state.pointScope="";previousRows=null;setPointTab(b.dataset.pointTab);await loadPoints({fresh:true});return}if(b.dataset.page)return setPage(b.dataset.page);if(b.dataset.control){if(b.dataset.control==="stop"&&typeof window.scadaConfirm==="function"&&!(await window.scadaConfirm(`确认停止转发通道 ${b.dataset.id}？`,{title:"确认停止",confirmText:"确认停止",danger:true})))return;return await control(b.dataset.id,b.dataset.control)}if(b.dataset.edit){state.selected=b.dataset.edit;renderChannels();return openEditor("channel",selected())}if(b.dataset.delete){if(await window.scadaConfirm(`删除转发通道 ${b.dataset.delete} 及全部点映射？`,{title:"确认删除",confirmText:"确认删除",danger:true})){await api(`/api/trans/channels/${b.dataset.delete}`,{method:"DELETE",headers:versionHeaders(b.dataset.version)});state.selected=null;await loadChannels({loadSelectedPoints:true,fresh:true})}return}if(b.dataset.pointEdit)return openEditor("point",state.points.find(x=>String(pno(x))===b.dataset.pointEdit&&x.kind===b.dataset.pointKind));if(b.dataset.pointDelete){if(b.dataset.owner!==state.selected)return;if(await window.scadaConfirm(`删除点映射 ${b.dataset.pointDelete}？`,{title:"确认删除",confirmText:"确认删除",danger:true})){await api(`/api/trans/channels/${b.dataset.owner}/points/${encodeURIComponent(b.dataset.pointKind)}/${b.dataset.pointDelete}`,{method:"DELETE",headers:versionHeaders(b.dataset.version)});await loadPoints()}return}if(b.dataset.log){state.log=b.dataset.log;return loadLog()}if(b.dataset.logChannel){$("#log-channel").value=b.dataset.logChannel;state.log=null;return setPage("logs")}}catch(err){toast(err.message)}});
$("#channels")?.addEventListener("click",async e=>{if(e.target.closest("button"))return;const r=e.target.closest("tr[data-select]");if(r){state.selected=r.dataset.select;state.pointOffset=0;renderChannels();await loadPoints()}});$("#selected-channel")?.addEventListener("change",async e=>{state.selected=e.target.value||null;state.pointOffset=0;const url=new URL(location.href);if(state.selected)url.searchParams.set("channel_id",state.selected);else url.searchParams.delete("channel_id");history.replaceState(null,"",url);if(window.scadaFocusContext?.set)window.scadaFocusContext.set({channel_id:state.selected});renderChannels();await loadPoints()});$("#kind-filter")?.addEventListener("change",()=>{state.pointOffset=0;state.pointScope="";previousRows=null;setPointTab(activePointKind());loadPoints().catch(e=>toast(e.message))});$("#point-limit")?.addEventListener("change",e=>{state.pointLimit=Number(e.target.value);state.pointOffset=0;loadPoints().catch(e=>toast(e.message))});$("#point-prev")?.addEventListener("click",()=>{state.pointOffset=Math.max(0,state.pointOffset-state.pointLimit);loadPoints().catch(e=>toast(e.message))});$("#point-next")?.addEventListener("click",()=>{state.pointOffset+=state.pointLimit;loadPoints().catch(e=>toast(e.message))});$("#log-channel")?.addEventListener("change",()=>{state.log=null;loadLogs().catch(e=>toast(e.message))});$("#log-keyword")?.addEventListener("input",()=>loadLog().catch(e=>toast(e.message)));if($("#new-channel"))$("#new-channel").onclick=()=>openEditor("channel");if($("#edit-channel"))$("#edit-channel").onclick=()=>selected()?openEditor("channel",selected()):toast("请选择通道");if($("#new-point"))$("#new-point").onclick=()=>state.selected?openEditor("point"):toast("请选择通道");if($("#batch-point"))$("#batch-point").onclick=()=>state.selected?openEditor("point",null,true):toast("请选择通道");if($("#refresh"))$("#refresh").onclick=()=>loadChannels({loadSelectedPoints:true}).catch(e=>toast(e.message));if($("#refresh-processes"))$("#refresh-processes").onclick=()=>loadProcesses().catch(e=>toast(e.message));if($("#refresh-logs"))$("#refresh-logs").onclick=()=>loadLogs().catch(e=>toast(e.message));if($("#reload-log"))$("#reload-log").onclick=()=>loadLog().catch(e=>toast(e.message));if($("#close-editor"))$("#close-editor").onclick=$("#cancel-editor").onclick=()=>$("#editor").close();if($("#editor-form"))$("#editor-form").addEventListener("submit",saveEditor);
setPointTab(activePointKind());
let pointSearchTimer;
$("#point-search")?.addEventListener("input",()=>{
  clearTimeout(pointSearchTimer);
  ++state.pointRequest;state.pointOffset=0;
  pointSearchTimer=setTimeout(()=>loadPoints().catch(e=>toast(e.message)),250);
});
$("#point-live-refresh")?.addEventListener("change",()=>loadPoints().catch(e=>toast(e.message)));
async function boot(){try{await api("/api/health");$("#connection").textContent="Web 已连接";$("#connection").classList.add("ok");await loadChannels({loadSelectedPoints:true,fresh:true})}catch(e){$("#connection").textContent="连接失败";$("#connection").classList.add("bad");toast(e.message)}}boot();setInterval(()=>{if(document.hidden||pendingChannels||$("#editor")?.open)return;if(state.page==="channels"&&!$("#channels"))return;(state.page==="channels"?loadChannels:state.page==="processes"?loadProcesses:loadLogs)().catch(e=>toast(e.message))},5000);
setInterval(()=>{if(document.hidden||pendingChannels||$("#editor")?.open)return;if(pointTableBody()&&$("#point-live-refresh")?.checked)loadPoints({background:true}).catch(e=>toast(e.message))},2000);
