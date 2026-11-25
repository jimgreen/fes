"""Shared UX enhancement endpoints for C/S/T: operation audit, packet decode, and C->T point trace."""
from __future__ import annotations

import json
from pathlib import Path
import re
import sqlite3

from core.connection_history import describe_packet
from core.web_http import send_static
from core.web_workbench import render_workbench


_AUDIT_MARKER = "操作审计 "
_HEX_RUN_RE = re.compile(r"(?<![0-9a-zA-Z])[0-9a-fA-F]{2}(?:\s+[0-9a-fA-F]{2}){2,}(?![0-9a-zA-Z])")
_HEX_COMPACT_RE = re.compile(r"(?<![0-9a-zA-Z])([0-9a-fA-F]{6,})(?![0-9a-zA-Z])")
_KIND_TABLES = {
    "yc": "fes_yc_define",
    "yx": "fes_yx_define",
    "yk": "fes_yk_define",
    "yt": "fes_yt_define",
}


def _crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if (crc & 1) else (crc >> 1)
    return crc


def _extract_packet_info(payload: dict) -> tuple[str, str, bytes]:
    line = str(payload.get("line") or "")
    protocol = str(payload.get("protocol") or "").strip()
    direction = str(payload.get("direction") or "").strip().upper()
    raw_hex = str(payload.get("hex") or "").strip()

    upper_line = line.upper()
    if not direction:
        if " RX " in upper_line or "[RX]" in upper_line or "接收" in line or "<-" in line:
            direction = "RX"
        elif " TX " in upper_line or "[TX]" in upper_line or "发送" in line or "->" in line:
            direction = "TX"

    if not raw_hex and line:
        # 优先匹配带空格的连续 HEX 字节序列（如 68 04 07 00 00 00）
        matches = _HEX_RUN_RE.findall(line)
        if matches:
            raw_hex = max(matches, key=len)
        else:
            compact = _HEX_COMPACT_RE.findall(line)
            if compact:
                raw_hex = max(compact, key=len)

    cleaned = re.sub(r"[^0-9a-fA-F]", "", raw_hex)
    if len(cleaned) < 4 or len(cleaned) % 2 != 0:
        raise ValueError("未能从该行识别出有效的偶数长度 HEX 报文")
    data = bytes.fromhex(cleaned)

    if not protocol:
        if "IEC104" in upper_line or "104" in upper_line or (len(data) >= 6 and data[0] == 0x68 and data[1] == len(data) - 2):
            protocol = "IEC104"
        elif "MODBUS-RTU" in upper_line or "RTU" in upper_line:
            protocol = "Modbus-RTU"
        elif "MODBUS" in upper_line or (len(data) >= 8 and data[2:4] == b"\x00\x00" and int.from_bytes(data[4:6], "big") == len(data) - 6):
            protocol = "Modbus-TCP"
        elif "CAN" in upper_line:
            protocol = "CAN"
        else:
            protocol = "RAW"
    return protocol, direction or "RX", data


def decode_packet_payload(payload: dict) -> dict:
    """将原始日志行或 HEX 字节流译码为易读的规约中文结构。"""
    protocol, direction, data = _extract_packet_info(payload)
    decoded = ""
    if protocol in ("IEC104", "Modbus-TCP"):
        decoded = describe_packet(protocol, direction, data)
    elif protocol == "Modbus-RTU" and len(data) >= 4:
        unit, fc = data[0], data[1]
        expected_crc = _crc16_modbus(data[:-2])
        actual_crc = int.from_bytes(data[-2:], "little")
        crc_ok = expected_crc == actual_crc
        body = data[2:-2]
        parts = [f"站号={unit}", f"功能码=0x{fc:02X}({fc})", f"CRC={'校验通过' if crc_ok else f'失败(期望 {expected_crc:04X})'}"]
        if fc & 0x80 and body:
            parts.append(f"异常码=0x{body[0]:02X}")
        elif len(body) >= 4 and (direction == "TX" or fc in (5, 6, 15, 16)):
            parts.append(f"起始地址(0基)={int.from_bytes(body[0:2], 'big')}")
            parts.append(f"数量/值={int.from_bytes(body[2:4], 'big')}")
        elif body:
            parts.append(f"负载={body.hex(' ')}")
        decoded = " ".join(parts)
    elif protocol == "CAN":
        decoded = f"CAN 帧负载 {len(data)} 字节 · HEX={data.hex(' ')}"
    else:
        decoded = f"原始字节 {len(data)} B · HEX={data.hex(' ')}"
    return {
        "protocol": protocol,
        "direction": direction,
        "byte_count": len(data),
        "hex": data.hex(" "),
        "decoded": decoded or "未能识别的报文格式",
    }


def read_operation_audit(log_root: Path, component: str, query: dict) -> dict:
    """倒序读取当前组件最近的操作审计 JSON 行，支持关键字与阶段筛选。"""
    q = str(query.get("q") or "").strip().lower()[:120]
    phase_filter = str(query.get("phase") or "").strip().lower()[:80]
    try:
        limit = int(query.get("limit") or 80)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit 必须是整数") from exc
    limit = max(1, min(200, limit))

    items: list[dict] = []
    if not log_root.is_dir():
        return {"component": component, "items": items, "total": 0}

    pattern = f"scdfe_{component}-operations-*.log"
    files = sorted(log_root.rglob(pattern), key=lambda p: str(p), reverse=True)[:24]
    for path in files:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for raw_line in reversed(lines):
            idx = raw_line.find(_AUDIT_MARKER)
            if idx < 0:
                continue
            raw_json = raw_line[idx + len(_AUDIT_MARKER):].strip()
            try:
                rec = json.loads(raw_json)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            phase = str(rec.get("phase") or "")
            if phase_filter and phase_filter not in phase.lower():
                continue
            if q and q not in raw_json.lower():
                continue
            detail_keys = [
                k for k in rec
                if k not in ("time", "trace_id", "component", "phase", "pid", "thread_id",
                             "method", "path", "status", "remote", "client_ip", "user_agent")
            ]
            summary = " · ".join(f"{k}={rec[k]}" for k in detail_keys[:6])
            items.append({
                "time": rec.get("time") or "",
                "phase": phase,
                "trace_id": rec.get("trace_id") or "",
                "method": rec.get("method") or "",
                "path": rec.get("path") or "",
                "status": rec.get("status"),
                "remote": rec.get("remote") or rec.get("client_ip") or "",
                "summary": summary[:320],
                "file": path.name,
            })
            if len(items) >= limit:
                return {"component": component, "items": items, "total": len(items)}
    return {"component": component, "items": items, "total": len(items)}


def read_point_trace(store, component: str, query: dict) -> dict:
    """联查 C 采集四遥点与 T 转发点映射，提供单行全链路对账视图。"""
    kind = str(query.get("kind") or "yc").strip().lower()
    if kind not in _KIND_TABLES:
        raise ValueError("kind 必须是 yc / yx / yk / yt")
    table = _KIND_TABLES[kind]
    q = str(query.get("q") or "").strip()
    mapped_only = str(query.get("mapped_only") or "0") == "1"
    rtu_raw = str(query.get("rtu_id") or "").strip()
    rtu_id = None
    if rtu_raw:
        rtu_id = int(rtu_raw)
    limit = max(1, min(300, int(query.get("limit") or 100)))
    offset = max(0, int(query.get("offset") or 0))

    has_raw = kind == "yc"
    raw_col = "s.raw_value" if has_raw else "NULL AS raw_value"

    with store.connection() as con:
        con.execute("BEGIN")
        try:
            rtus = [
                {"rtu_id": int(r[0]), "name": r[1] or "", "channel_id": r[2], "channel_type": r[3] or ""}
                for r in con.execute(
                    "SELECT rtu_id, name, channel_id, channel_type FROM fes_rtu_define ORDER BY rtu_id"
                )
            ]
            has_t = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='fes_scdfe_t_point_define'"
            ).fetchone() is not None

            where_parts = ["1=1"]
            params: list = []
            if rtu_id is not None:
                where_parts.append("s.rtu_id = ?")
                params.append(rtu_id)
            if q:
                like = f"%{q}%"
                if q.isdigit():
                    where_parts.append("(s.name LIKE ? OR s.pnt_no = ? OR r.name LIKE ?)")
                    params.extend([like, int(q), like])
                else:
                    where_parts.append("(s.name LIKE ? OR r.name LIKE ?)")
                    params.extend([like, like])
            if mapped_only and has_t:
                where_parts.append("tp.channel_id IS NOT NULL")

            where_sql = " AND ".join(where_parts)
            if has_t:
                join_sql = (
                    f"FROM {table} s "
                    "LEFT JOIN fes_rtu_define r ON r.rtu_id = s.rtu_id "
                    "LEFT JOIN fes_scdfe_t_point_define tp "
                    "  ON tp.source_rtu_id = s.rtu_id AND tp.source_pnt_no = s.pnt_no AND tp.kind = ? "
                    "LEFT JOIN fes_scdfe_t_define td ON td.channel_id = tp.channel_id "
                )
                base_params = [kind, *params]
                total, mapped_total = con.execute(
                    f"SELECT COUNT(*), SUM(CASE WHEN tp.channel_id IS NOT NULL THEN 1 ELSE 0 END) "
                    f"{join_sql} WHERE {where_sql}",
                    base_params,
                ).fetchone()
                rows = con.execute(
                    f"SELECT s.rtu_id, COALESCE(r.name, '') AS rtu_name, r.channel_id AS src_channel_id, "
                    f"  COALESCE(r.channel_type, '') AS src_protocol, s.pnt_no, COALESCE(s.name, '') AS pnt_name, "
                    f"  {raw_col}, s.value AS src_value, s.status AS src_status, s.refresh_time AS src_refresh_time, "
                    f"  tp.channel_id AS fwd_channel_id, COALESCE(td.name, '') AS fwd_channel_name, "
                    f"  COALESCE(td.protocol, '') AS fwd_protocol, tp.pnt_no AS fwd_pnt_no, "
                    f"  tp.io_address, tp.register_area, tp.address, tp.value AS fwd_value, "
                    f"  tp.status AS fwd_status, tp.forward_time, tp.enabled AS fwd_enabled "
                    f"{join_sql} WHERE {where_sql} "
                    f"ORDER BY s.rtu_id, s.pnt_no, tp.channel_id LIMIT ? OFFSET ?",
                    [*base_params, limit, offset],
                ).fetchall()
            else:
                join_sql = f"FROM {table} s LEFT JOIN fes_rtu_define r ON r.rtu_id = s.rtu_id "
                total = con.execute(f"SELECT COUNT(*) {join_sql} WHERE {where_sql}", params).fetchone()[0]
                mapped_total = 0
                rows = con.execute(
                    f"SELECT s.rtu_id, COALESCE(r.name, '') AS rtu_name, r.channel_id AS src_channel_id, "
                    f"  COALESCE(r.channel_type, '') AS src_protocol, s.pnt_no, COALESCE(s.name, '') AS pnt_name, "
                    f"  {raw_col}, s.value AS src_value, s.status AS src_status, s.refresh_time AS src_refresh_time, "
                    f"  NULL, '', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL "
                    f"{join_sql} WHERE {where_sql} ORDER BY s.rtu_id, s.pnt_no LIMIT ? OFFSET ?",
                    [*params, limit, offset],
                ).fetchall()
            con.rollback()
        except sqlite3.Error:
            if con.in_transaction:
                con.rollback()
            raise

    items = []
    for row in rows:
        fwd_proto = (row[12] or "").lower()
        fwd_addr = "—"
        if row[10] is not None:
            if fwd_proto == "iec104":
                fwd_addr = f"IOA {row[14]}" if row[14] is not None else "—"
            else:
                fwd_addr = f"{row[15] or '—'} / {row[16] if row[16] is not None else '—'}"
        items.append({
            "kind": kind,
            "rtu_id": row[0],
            "rtu_name": row[1],
            "src_channel_id": row[2],
            "src_protocol": row[3],
            "pnt_no": row[4],
            "pnt_name": row[5],
            "raw_value": row[6],
            "src_value": row[7],
            "src_status": row[8],
            "src_refresh_time": row[9],
            "fwd_channel_id": row[10],
            "fwd_channel_name": row[11],
            "fwd_protocol": row[12],
            "fwd_pnt_no": row[13],
            "fwd_addr": fwd_addr,
            "fwd_value": row[17],
            "fwd_status": row[18],
            "forward_time": row[19],
            "fwd_enabled": row[20],
        })
    return {
        "component": component,
        "kind": kind,
        "items": items,
        "total": int(total or 0),
        "mapped_total": int(mapped_total or 0),
        "limit": limit,
        "offset": offset,
        "rtus": rtus,
    }


def handle_ux_api(handler, parts, query, method, store, component):
    """统一分发操作审计、报文译码与全链路测点对账路由。"""
    from scdfe_c.web.service import ApiError

    assets = Path(__file__).with_name("web_static")

    if parts == ["api", "operation-audit"]:
        if method != "GET":
            raise ApiError(405, "操作审计查询只支持 GET")
        log_root = Path(store.db_path).parent / "logs"
        return handler._json(200, read_operation_audit(log_root, component, query))

    if parts == ["api", "packet-decode"]:
        if method != "POST":
            raise ApiError(405, "报文译码只支持 POST")
        body = handler._body()
        return handler._json(200, decode_packet_payload(body))

    if parts in (["point-trace"], ["static", "point-trace.css"], ["static", "point-trace.js"]):
        if method != "GET":
            raise ApiError(405, "只支持 GET")
        if parts[0] == "static":
            mime = "text/css" if parts[1].endswith(".css") else "application/javascript"
            return send_static(handler, assets / parts[1], mime + "; charset=utf-8")
        if component in ("c", "t", "s"):
            return send_static(
                handler,
                assets / "point-trace.html",
                "text/html; charset=utf-8",
                transform=lambda raw: render_workbench(raw, component, "point-trace.html"),
                cache_key=f"workbench:{component}:point-trace.html",
            )
        return send_static(handler, assets / "point-trace.html", "text/html; charset=utf-8")

    if parts == ["api", "point-trace"]:
        if method != "GET":
            raise ApiError(405, "全链路对账接口只支持 GET")
        return handler._json(200, read_point_trace(store, component, query))

    return False
