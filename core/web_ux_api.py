"""Shared UX enhancement endpoints for C/S/T: operation audit, deep packet decode, C->T point trace, auth session, workbench links & WAL checkpoint."""
from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import struct

from core.connection_history import describe_packet
from core.web_http import send_static
from core.web_security import auth_status, clear_session_cookie, create_session_cookie, verify_operator_token
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
_IEC104_TYPE_NAMES = {
    1: "M_SP_NA_1(单点)",
    3: "M_DP_NA_1(双点)",
    5: "M_ST_NA_1(步位置)",
    9: "M_ME_NA_1(归一化)",
    11: "M_ME_NB_1(标度化)",
    13: "M_ME_NC_1(短浮点)",
    21: "M_ME_ND_1(无品质归一化)",
    30: "M_SP_TB_1(CP56单点)",
    31: "M_DP_TB_1(CP56双点)",
    34: "M_ME_TD_1(CP56归一化)",
    35: "M_ME_TE_1(CP56标度化)",
    36: "M_ME_TF_1(CP56短浮点)",
    45: "C_SC_NA_1(单点遥控)",
    46: "C_DC_NA_1(双点遥控)",
    48: "C_SE_NA_1(归一化设点)",
    49: "C_SE_NB_1(标度设点)",
    50: "C_SE_NC_1(短浮点设点)",
    100: "C_IC_NA_1(总召唤)",
    103: "C_CS_NA_1(时钟同步)",
}
_IEC104_COT_NAMES = {
    1: "周期/循环",
    2: "背景扫描",
    3: "突发",
    5: "请求",
    6: "激活",
    7: "激活确认",
    8: "停止激活",
    9: "停止激活确认",
    10: "激活终止",
    20: "响应站召唤",
    44: "未知类型",
    45: "未知传输原因",
    46: "未知公共地址",
    47: "未知信息体地址",
}
_MODBUS_FC_NAMES = {
    1: "读线圈",
    2: "读离散输入",
    3: "读保持寄存器",
    4: "读输入寄存器",
    5: "写单线圈",
    6: "写单寄存器",
    15: "写多线圈",
    16: "写多寄存器",
}


def _crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if (crc & 1) else (crc >> 1)
    return crc


def _csv_safe_cell(val) -> str:
    """防止导出 CSV 出现表格软件公式注入。"""
    if val is None:
        return ""
    text = str(val)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


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


def _format_qds(qds: int) -> str:
    flags = []
    if qds & 0x80:
        flags.append("IV无效")
    if qds & 0x40:
        flags.append("NT非当前")
    if qds & 0x20:
        flags.append("SB取代")
    if qds & 0x10:
        flags.append("BL闭锁")
    if qds & 0x01:
        flags.append("OV溢出")
    return "正常" if not flags else "|".join(flags)


def _decode_iec104_i_frame(data: bytes) -> tuple[str, list[str]]:
    """深度解析 IEC 104 I 帧 ASDU 与前 12 条信息体明细。"""
    if len(data) < 12 or data[0] != 0x68:
        return "", []
    ctrl = data[2:6]
    if ctrl[0] & 0x01:
        # S 帧或 U 帧，交由基础译码
        return "", []
    ns = ((ctrl[1] << 8) | ctrl[0]) >> 1
    nr = ((ctrl[3] << 8) | ctrl[2]) >> 1
    asdu = data[6:]
    if len(asdu) < 6:
        return f"I帧 N(S)={ns} N(R)={nr} (ASDU不完整)", []
    type_id = asdu[0]
    vsq = asdu[1]
    sq = bool(vsq & 0x80)
    count = vsq & 0x7F
    cot_low = asdu[2] & 0x3F
    cot_pn = "否定" if (asdu[2] & 0x40) else "肯定"
    ca = int.from_bytes(asdu[4:6], "little")
    type_name = _IEC104_TYPE_NAMES.get(type_id, f"Type={type_id}")
    cot_name = _IEC104_COT_NAMES.get(cot_low, str(cot_low))
    head = (
        f"I帧 N(S)={ns} N(R)={nr} · {type_name} · COT={cot_low}({cot_name},{cot_pn}) "
        f"· 公共地址CA={ca} · {'连续SQ=1' if sq else '离散SQ=0'} 共{count}条"
    )
    body = asdu[6:]
    details: list[str] = []
    # 单条信息体净负载长度（不含 3 字节 IOA）
    elem_sizes = {
        1: 1, 3: 1, 5: 2,
        9: 3, 11: 3, 13: 5, 21: 2,
        30: 8, 31: 8, 34: 10, 35: 10, 36: 12,
        45: 1, 46: 1, 48: 3, 49: 3, 50: 5,
        100: 1,
    }
    esize = elem_sizes.get(type_id)
    if esize is None or count == 0:
        return head, details
    pos = 0
    base_ioa = 0
    if sq:
        if len(body) < 3:
            return head, details
        base_ioa = body[0] | (body[1] << 8) | (body[2] << 16)
        pos = 3
    max_items = min(count, 12)
    for idx in range(max_items):
        if sq:
            ioa = base_ioa + idx
        else:
            if pos + 3 > len(body):
                break
            ioa = body[pos] | (body[pos + 1] << 8) | (body[pos + 2] << 16)
            pos += 3
        if pos + esize > len(body):
            break
        chunk = body[pos:pos + esize]
        pos += esize
        if type_id in (1, 30):
            siq = chunk[0]
            val = siq & 0x01
            qtxt = _format_qds(siq & 0xF0)
            details.append(f"IOA={ioa}: 单点={val} ({qtxt})")
        elif type_id in (3, 31):
            diq = chunk[0]
            val = diq & 0x03
            qtxt = _format_qds(diq & 0xF0)
            details.append(f"IOA={ioa}: 双点={val} ({qtxt})")
        elif type_id in (9, 34):
            raw_v = struct.unpack_from("<h", chunk, 0)[0]
            qtxt = _format_qds(chunk[2])
            details.append(f"IOA={ioa}: 归一化={raw_v/32768.0:.4f}(raw={raw_v}) ({qtxt})")
        elif type_id in (11, 35):
            raw_v = struct.unpack_from("<h", chunk, 0)[0]
            qtxt = _format_qds(chunk[2])
            details.append(f"IOA={ioa}: 标度={raw_v} ({qtxt})")
        elif type_id in (13, 36):
            fval = struct.unpack_from("<f", chunk, 0)[0]
            qtxt = _format_qds(chunk[4])
            details.append(f"IOA={ioa}: 短浮点={fval:.4g} ({qtxt})")
        elif type_id == 21:
            raw_v = struct.unpack_from("<h", chunk, 0)[0]
            details.append(f"IOA={ioa}: 归一化={raw_v/32768.0:.4f}(raw={raw_v})")
        elif type_id == 45:
            sco = chunk[0]
            se = "选择" if (sco & 0x80) else "执行"
            details.append(f"IOA={ioa}: 单点遥控={sco & 1} ({se})")
        elif type_id == 46:
            dco = chunk[0]
            se = "选择" if (dco & 0x80) else "执行"
            details.append(f"IOA={ioa}: 双点遥控={dco & 3} ({se})")
        elif type_id == 50:
            fval = struct.unpack_from("<f", chunk, 0)[0]
            se = "选择" if (chunk[4] & 0x80) else "执行"
            details.append(f"IOA={ioa}: 短浮点设点={fval:.4g} ({se})")
        elif type_id == 100:
            details.append(f"IOA={ioa}: QOI={chunk[0]}")
    if count > max_items:
        details.append(f"…其余 {count - max_items} 条省略")
    return head, details


def _decode_modbus_pdu(fc: int, body: bytes, direction: str) -> tuple[str, list[str]]:
    """深度解析 Modbus PDU 请求与响应中的地址、线圈位和寄存器数值。"""
    details: list[str] = []
    if fc & 0x80:
        exc = body[0] if body else 0
        exc_names = {1: "非法功能码", 2: "非法数据地址", 3: "非法数据值", 4: "从站设备故障", 6: "从站忙"}
        return f"异常响应 0x{exc:02X}({exc_names.get(exc, '未知')})", details
    fc_name = _MODBUS_FC_NAMES.get(fc, f"FC={fc}")
    # 读请求 (TX, 4 字节: addr + qty)
    if fc in (1, 2, 3, 4) and len(body) == 4 and direction == "TX":
        addr = int.from_bytes(body[0:2], "big")
        qty = int.from_bytes(body[2:4], "big")
        return f"{fc_name} 起始地址(0基)={addr} 数量={qty}", details
    # 读线圈/离散量响应 (1 字节长度 + 位字节)
    if fc in (1, 2) and len(body) >= 2 and body[0] == len(body) - 1:
        byte_cnt = body[0]
        bits = []
        for bi in range(min(byte_cnt, 4)):
            b = body[1 + bi]
            for bit in range(8):
                bits.append(str((b >> bit) & 1))
        suffix = f"…共{byte_cnt * 8}位" if byte_cnt > 4 else ""
        details.append(f"位值[0..]: {''.join(bits)}{suffix}")
        return f"{fc_name}响应 {byte_cnt}字节", details
    # 读寄存器响应 (1 字节长度 + N*2 字节寄存器)
    if fc in (3, 4) and len(body) >= 3 and body[0] == len(body) - 1 and body[0] % 2 == 0:
        reg_cnt = body[0] // 2
        for i in range(min(reg_cnt, 16)):
            u16 = int.from_bytes(body[1 + 2 * i:3 + 2 * i], "big")
            s16 = u16 - 65536 if u16 >= 32768 else u16
            val_txt = f"{u16}(0x{u16:04X})" if u16 == s16 else f"{u16}/s16={s16}(0x{u16:04X})"
            details.append(f"reg[{i}]={val_txt}")
        if reg_cnt > 16:
            details.append(f"…其余 {reg_cnt - 16} 个寄存器省略")
        return f"{fc_name}响应 共{reg_cnt}个寄存器", details
    # 写单线圈 / 写单寄存器
    if fc in (5, 6) and len(body) >= 4:
        addr = int.from_bytes(body[0:2], "big")
        raw_v = int.from_bytes(body[2:4], "big")
        if fc == 5:
            state = "合/ON(FF00)" if raw_v == 0xFF00 else ("分/OFF(0000)" if raw_v == 0 else f"0x{raw_v:04X}")
            return f"{fc_name} 地址={addr} 值={state}", details
        s16 = raw_v - 65536 if raw_v >= 32768 else raw_v
        return f"{fc_name} 地址={addr} 值={raw_v}(s16={s16}, 0x{raw_v:04X})", details
    # 写多寄存器 (16)
    if fc == 16 and len(body) >= 4:
        addr = int.from_bytes(body[0:2], "big")
        qty = int.from_bytes(body[2:4], "big")
        if len(body) >= 5 and body[4] == len(body) - 5 and body[4] % 2 == 0:
            for i in range(min(qty, 12)):
                u16 = int.from_bytes(body[5 + 2 * i:7 + 2 * i], "big")
                details.append(f"addr[{addr + i}]={u16}(0x{u16:04X})")
        return f"{fc_name} 起始地址={addr} 数量={qty}", details
    if fc == 15 and len(body) >= 4:
        addr = int.from_bytes(body[0:2], "big")
        qty = int.from_bytes(body[2:4], "big")
        return f"{fc_name} 起始地址={addr} 数量={qty}", details
    return f"{fc_name} 负载={body.hex(' ')}", details


def decode_packet_payload(payload: dict) -> dict:
    """将原始日志行或 HEX 字节流译码为易读的规约中文结构（含多 IOA / 寄存器值展开）。"""
    protocol, direction, data = _extract_packet_info(payload)
    decoded = ""
    details: list[str] = []
    if protocol == "IEC104":
        deep_head, details = _decode_iec104_i_frame(data)
        decoded = deep_head or describe_packet(protocol, direction, data)
    elif protocol == "Modbus-TCP" and len(data) >= 8:
        tid = int.from_bytes(data[0:2], "big")
        unit = data[6]
        fc = data[7]
        pdu_desc, details = _decode_modbus_pdu(fc, data[8:], direction)
        decoded = f"事务={tid} 站号={unit} FC=0x{fc:02X} · {pdu_desc}"
    elif protocol == "Modbus-RTU" and len(data) >= 4:
        unit, fc = data[0], data[1]
        expected_crc = _crc16_modbus(data[:-2])
        actual_crc = int.from_bytes(data[-2:], "little")
        crc_ok = expected_crc == actual_crc
        body = data[2:-2]
        pdu_desc, details = _decode_modbus_pdu(fc, body, direction)
        crc_txt = "校验通过" if crc_ok else f"失败(实得 {actual_crc:04X} / 期望 {expected_crc:04X})"
        decoded = f"站号={unit} 功能码=0x{fc:02X}({fc}) CRC={crc_txt} · {pdu_desc}"
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
        "details": details,
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


def read_point_trace(store, component: str, query: dict, *, max_limit: int = 300) -> dict:
    """联查 C 采集四遥点与 T 转发点映射，提供单行全链路对账视图（支持异常/偏差过滤）。"""
    kind = str(query.get("kind") or "yc").strip().lower()
    if kind not in _KIND_TABLES:
        raise ValueError("kind 必须是 yc / yx / yk / yt")
    table = _KIND_TABLES[kind]
    q = str(query.get("q") or "").strip()
    mapped_only = str(query.get("mapped_only") or "0") == "1"
    anomaly_only = str(query.get("anomaly_only") or "0") == "1"
    rtu_raw = str(query.get("rtu_id") or "").strip()
    rtu_id = None
    if rtu_raw:
        rtu_id = int(rtu_raw)
    limit = max(1, min(max_limit, int(query.get("limit") or 100)))
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
            if anomaly_only:
                if has_t:
                    where_parts.append(
                        "(COALESCE(s.status, -1) != 0 "
                        "OR (tp.channel_id IS NOT NULL AND ("
                        "  COALESCE(tp.enabled, 1) = 0 "
                        "  OR (s.value IS NOT NULL AND tp.value IS NOT NULL AND ABS(CAST(s.value AS REAL) - CAST(tp.value AS REAL)) > 1e-4)"
                        ")))"
                    )
                else:
                    where_parts.append("COALESCE(s.status, -1) != 0")

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


def export_point_trace_csv(store, component: str, query: dict) -> bytes:
    """导出当前筛选条件下的全链路测点对账单 CSV（带 UTF-8 BOM）。"""
    export_q = {**query, "offset": "0", "limit": "50000"}
    data = read_point_trace(store, component, export_q, max_limit=50000)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "类型", "源RTU", "RTU名称", "源通道", "源规约", "源点号", "测点名称",
        "原始值", "采集工程值", "采集状态", "采集刷新时刻",
        "转发通道", "转发通道名", "转发规约", "转发点号", "目标地址",
        "转发值", "转发状态", "转发时刻", "启用状态",
    ])
    for it in data["items"]:
        writer.writerow([
            _csv_safe_cell(it["kind"].upper()),
            _csv_safe_cell(it["rtu_id"]),
            _csv_safe_cell(it["rtu_name"]),
            _csv_safe_cell(it["src_channel_id"]),
            _csv_safe_cell(it["src_protocol"]),
            _csv_safe_cell(it["pnt_no"]),
            _csv_safe_cell(it["pnt_name"]),
            _csv_safe_cell(it["raw_value"]),
            _csv_safe_cell(it["src_value"]),
            _csv_safe_cell(it["src_status"]),
            _csv_safe_cell(it["src_refresh_time"]),
            _csv_safe_cell(it["fwd_channel_id"]),
            _csv_safe_cell(it["fwd_channel_name"]),
            _csv_safe_cell(it["fwd_protocol"]),
            _csv_safe_cell(it["fwd_pnt_no"]),
            _csv_safe_cell(it["fwd_addr"]),
            _csv_safe_cell(it["fwd_value"]),
            _csv_safe_cell(it["fwd_status"]),
            _csv_safe_cell(it["forward_time"]),
            "" if it["fwd_enabled"] is None else ("启用" if it["fwd_enabled"] else "停用"),
        ])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def run_wal_checkpoint(store, mode: str = "PASSIVE") -> dict:
    """执行受控 SQLite WAL checkpoint，并返回整理前后 WAL 体积变化。"""
    mode_norm = str(mode or "PASSIVE").strip().upper()
    if mode_norm not in ("PASSIVE", "FULL", "RESTART", "TRUNCATE"):
        raise ValueError("checkpoint mode 必须是 PASSIVE / FULL / RESTART / TRUNCATE")
    db_path = Path(store.db_path)
    wal_path = Path(str(db_path) + "-wal")
    before = wal_path.stat().st_size if wal_path.is_file() else 0
    with store.connection() as con:
        row = con.execute(f"PRAGMA wal_checkpoint({mode_norm})").fetchone()
    after = wal_path.stat().st_size if wal_path.is_file() else 0
    return {
        "mode": mode_norm,
        "busy": int(row[0]) if row else 0,
        "log_frames": int(row[1]) if row else 0,
        "checkpointed_frames": int(row[2]) if row else 0,
        "wal_bytes_before": before,
        "wal_bytes_after": after,
    }


def workbench_links_payload(handler, component: str) -> dict:
    """返回 C/S/T 三端服务快捷跳转配置及当前安全权限态。"""
    host = "127.0.0.1"
    raw_host = handler.headers.get("Host") if handler.headers else ""
    if raw_host:
        host = raw_host.split(":", 1)[0] or "127.0.0.1"
    default_ports = {"c": "8977", "s": "8978", "t": "8979"}
    links = {}
    for key, label in (("c", "采集 C"), ("s", "仿真 S"), ("t", "转发 T")):
        env_url = os.environ.get(f"SCADA_WEB_{key.upper()}_URL", "").strip()
        if env_url:
            url = env_url.rstrip("/")
        else:
            port = os.environ.get(f"SCADA_WEB_{key.upper()}_PORT", default_ports[key]).strip() or default_ports[key]
            url = f"http://{host}:{port}"
        links[key] = {"key": key, "label": label, "url": url, "active": key == component}
    return {
        "component": component,
        "links": [links["c"], links["s"], links["t"]],
        "auth": auth_status(handler),
    }


def handle_ux_api(handler, parts, query, method, store, component):
    """统一分发操作审计、深度报文译码、全链路对账、三端互跳、权限会话与 WAL 整理路由。"""
    from scdfe_c.web.service import ApiError

    assets = Path(__file__).with_name("web_static")

    if parts == ["api", "workbench-links"]:
        if method != "GET":
            raise ApiError(405, "只支持 GET")
        return handler._json(200, workbench_links_payload(handler, component))

    if parts == ["api", "auth", "session"]:
        if method == "GET":
            return handler._json(200, auth_status(handler))
        if method == "POST":
            body = handler._body()
            token = str(body.get("token") or "")
            if not verify_operator_token(token):
                raise ApiError(401, "运维口令不正确", code="unauthorized")
            cookie = create_session_cookie()
            data = json.dumps(auth_status(handler, unlocked_override=True), ensure_ascii=False).encode("utf-8")
            handler._send(200, "application/json; charset=utf-8", data, {"Set-Cookie": cookie})
            return True
        if method == "DELETE":
            cookie = clear_session_cookie()
            data = json.dumps(auth_status(handler, unlocked_override=False), ensure_ascii=False).encode("utf-8")
            handler._send(200, "application/json; charset=utf-8", data, {"Set-Cookie": cookie})
            return True
        raise ApiError(405, "会话接口只支持 GET/POST/DELETE")

    if parts == ["api", "diagnostics", "wal-checkpoint"]:
        if method != "POST":
            raise ApiError(405, "WAL 整理接口只支持 POST")
        body = handler._body() if handler.headers and int(handler.headers.get("Content-Length") or "0") > 0 else {}
        mode = body.get("mode") if isinstance(body, dict) else "PASSIVE"
        return handler._json(200, run_wal_checkpoint(store, mode or "PASSIVE"))

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

    if parts == ["api", "point-trace", "export"]:
        if method != "GET":
            raise ApiError(405, "全链路对账导出只支持 GET")
        kind = str(query.get("kind") or "yc").strip().lower()
        raw_csv = export_point_trace_csv(store, component, query)
        headers = {
            "Content-Disposition": f'attachment; filename="point-trace-{kind}.csv"',
            "Cache-Control": "no-store",
        }
        handler._send(200, "text/csv; charset=utf-8", raw_csv, headers)
        return True

    return False
