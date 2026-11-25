"use strict";
const $=s=>document.querySelector(s); const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
const statusName={0:"停止",1:"启动中",2:"运行",3:"停止中",4:"处理中",5:"错误"};
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});let v;try{v=await r.json()}catch(_){throw Error(`HTTP ${r.status}`)}if(!r.ok)throw Error(v.error?.message||r.statusText);return v}
let toastTimer=null;
function toast(s){const e=$("#toast");e.textContent=s;clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.textContent="",4000)}
function fmt(v,timeOnly=false){if(!v)return "—";const d=new Date(Number(v));if(Number.isNaN(d.valueOf()))return String(v);const p=n=>String(n).padStart(2,"0"),t=`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;return timeOnly?t:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${t}`}
function badge(x){const s=Number(x.process_status||0);return `<span class="status-badge ${s===2?"running":s===5?"error":""}">${esc(statusName[s]??s)}</span>`}
let pending=null,previousHtml=null;
function renderProcessTable(html){
  if(html===previousHtml)return;
  const body=$("#processes");
  if(body && body.rows && typeof document.createElement==="function"){
    const tpl=document.createElement("template");
    tpl.innerHTML="<table><tbody>"+html+"</tbody></table>";
    const nextRows=Array.from(tpl.content.querySelectorAll("tr"));
    if(nextRows.length && nextRows.length===body.rows.length && nextRows.every((r,i)=>r.cells.length===body.rows[i].cells.length)){
      nextRows.forEach((nextRow,i)=>{
        const curRow=body.rows[i];
        if(nextRow.outerHTML===curRow.outerHTML)return;
        Array.from(nextRow.cells).forEach((nextCell,column)=>{
          if(nextCell.outerHTML!==curRow.cells[column].outerHTML)curRow.cells[column].replaceWith(nextCell);
        });
      });
      previousHtml=html;
      return;
    }
  }
  if(body)body.innerHTML=html;
  previousHtml=html;
}
function load({fresh=false}={}){
  if(pending)return fresh?pending.catch(()=>{}).then(()=>load()):pending;
  pending=fetchProcesses().finally(()=>{pending=null});return pending;
}
async function fetchProcesses(){const rows=(await api("/api/trans/processes")).items||[];$("#summary").textContent=`运行 ${rows.filter(x=>x.alive).length} / 总数 ${rows.length}`;$("#connection").textContent="Web 已连接";$("#connection").classList.add("ok");const html=rows.length?rows.map(x=>`<tr><td>${esc(x.channel_id)} · ${esc(x.name||"")}</td><td>${esc(x.protocol)}</td><td>${badge(x)}</td><td>${esc(x.process_pid||"—")}</td><td>${esc(fmt(x.process_start_time))}</td><td>${esc(fmt(x.process_heartbeat_time,true))}</td><td title="${esc(x.process_error)}">${esc(x.process_error)||"—"}</td><td class="actions"><button data-action="start" data-id="${esc(x.channel_id)}">启动</button><button class="danger" data-action="stop" data-id="${esc(x.channel_id)}">停止</button><a href="/logs.html?channel_id=${encodeURIComponent(x.channel_id)}">日志报文</a></td></tr>`).join(""):"<tr><td colspan=8 class=muted>暂无转发通道</td></tr>";renderProcessTable(html)}
const controlBusy=new Set();
async function control(id,action,btn){
  if(controlBusy.has(id))return;
  if(action==="stop" && typeof window.scadaConfirm==="function"){
    if(!(await window.scadaConfirm(`确认停止转发通道 ${id}？`,{title:"确认停止",confirmText:"确认停止",danger:true})))return;
  }
  controlBusy.add(id);if(btn)btn.disabled=true;
  try{await api(`/api/trans/channels/${encodeURIComponent(id)}/${action}`,{method:"POST",body:"{}"});toast(action==="start"?"启动请求已发送":"停止请求已发送");await load({fresh:true})}
  finally{controlBusy.delete(id);if(btn)btn.disabled=false}
}
document.addEventListener("click",e=>{const b=e.target.closest("button[data-action]");if(b)control(b.dataset.id,b.dataset.action,b).catch(x=>toast(x.message))});$("#refresh").onclick=()=>load({fresh:true}).catch(x=>toast(x.message));load().catch(e=>{$("#connection").textContent="连接失败";toast(e.message)});setInterval(()=>{if(!document.hidden&&!document.querySelector("dialog[open]"))load().catch(()=>{})},5000);
