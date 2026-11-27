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


def _existing_tables(con: sqlite3.Connection) -> set[str]:
    return {str(r[0]) for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}


def read_alerts_summary(store, component: str) -> dict:
    """统一聚合当前数据库的线程错误、进程异常、对账偏差与失败指令告警。"""
    counts = {
        "thread_errors": 0,
        "process_errors": 0,
        "trace_diffs": 0,
        "failed_commands": 0,
    }
    items: list[dict] = []
    try:
        with store.connection() as con:
            tables = _existing_tables(con)
            if "fes_rtu_define" in tables:
                rows = con.execute(
                    "SELECT rtu_id, name, channel_id, channel_type, process_status, process_error "
                    "FROM fes_rtu_define WHERE process_status = 5 OR (process_error IS NOT NULL AND TRIM(process_error) != '') "
                    "ORDER BY rtu_id ASC"
                ).fetchall()
                counts["thread_errors"] = len(rows)
                for r in rows[:6]:
                    rid = r["rtu_id"]
                    items.append({
                        "severity": "error",
                        "category": "通信线程",
                        "title": f"RTU {rid} ({r['name'] or '未命名'}) 通信异常",
                        "detail": str(r["process_error"] or "线程处于错误状态")[:120],
                        "href": "/#scdfe" if component == "c" else f"/communication?rtu_id={rid}",
                        "rtu_id": rid,
                        "channel_id": r["channel_id"],
                    })

            if "fes_process_define" in tables:
                rows = con.execute(
                    "SELECT process_key, target_rtu, process_status, process_error "
                    "FROM fes_process_define WHERE process_status = 5 ORDER BY process_key ASC"
                ).fetchall()
                counts["process_errors"] = len(rows)
                for r in rows[:4]:
                    items.append({
                        "severity": "error",
                        "category": "核心进程",
                        "title": f"进程 {r['process_key']} 异常退出",
                        "detail": str(r["process_error"] or "状态=5")[:120],
                        "href": "/#processes" if component == "c" else "/communication",
                        "rtu_id": r["target_rtu"] or None,
                    })

            if "fes_scdfe_t_point_define" in tables and "fes_yc_define" in tables:
                diff_rows = []
                for kind, tbl in (("yc", "fes_yc_define"), ("yx", "fes_yx_define")):
                    if tbl not in tables:
                        continue
                    qrows = con.execute(
                        f"SELECT tp.source_rtu_id, tp.source_pnt_no, tp.channel_id, tp.pnt_no AS fwd_pnt_no, "
                        f"s.name AS pnt_name, s.value AS src_value, tp.last_value AS fwd_value "
                        f"FROM fes_scdfe_t_point_define tp "
                        f"JOIN {tbl} s ON s.rtu_id = tp.source_rtu_id AND s.pnt_no = tp.source_pnt_no "
                        f"WHERE LOWER(tp.kind) = ? AND tp.enabled != 0 "
                        f"AND s.value IS NOT NULL AND tp.last_value IS NOT NULL "
                        f"AND ABS(CAST(s.value AS REAL) - CAST(tp.last_value AS REAL)) > 1e-4 "
                        f"LIMIT 20",
                        (kind,),
                    ).fetchall()
                    for qr in qrows:
                        diff_rows.append((kind, qr))
                counts["trace_diffs"] = len(diff_rows)
                for kind, qr in diff_rows[:4]:
                    items.append({
                        "severity": "warn",
                        "category": "全链路偏差",
                        "title": f"{kind.upper()} RTU {qr['source_rtu_id']}#{qr['source_pnt_no']} 采集与转发值不一致",
                        "detail": f"采集={qr['src_value']} / 转发={qr['fwd_value']} (转发通道 {qr['channel_id']})",
                        "href": f"/point-trace?kind={kind}&rtu_id={qr['source_rtu_id']}&anomaly_only=1",
                        "rtu_id": qr["source_rtu_id"],
                        "channel_id": qr["channel_id"],
                    })

            if "fes_command_trace" in tables:
                import time
                cutoff_ms = int((time.time() - 3600) * 1000)
                frows = con.execute(
                    "SELECT command_id, rtu_id, kind, pnt_no, stage, detail "
                    "FROM fes_command_trace WHERE stage = 'failed' AND created_at >= ? "
                    "ORDER BY created_at DESC LIMIT 10",
                    (cutoff_ms,),
                ).fetchall()
                counts["failed_commands"] = len(frows)
                for fr in frows[:4]:
                    items.append({
                        "severity": "error",
                        "category": "指令失败",
                        "title": f"指令 #{fr['command_id']} RTU {fr['rtu_id']} {str(fr['kind'] or '').upper()} {fr['pnt_no']} 失败",
                        "detail": str(fr["detail"] or "近 1 小时指令执行失败")[:120],
                        "href": f"/command-traces?rtu_id={fr['rtu_id']}",
                        "rtu_id": fr["rtu_id"],
                    })
    except sqlite3.Error:
        pass

    total = sum(counts.values())
    return {
        "component": component,
        "total": total,
        "counts": counts,
        "items": items[:16],
    }


def read_quick_search(store, component: str, query: dict) -> dict:
    """为全局 Ctrl+K 命令面板提供 RTU、转发通道与四遥测点快速模糊检索。"""
    q = str(query.get("q") or "").strip()
    like = f"%{q}%"
    rtus: list[dict] = []
    trans_channels: list[dict] = []
    points: list[dict] = []
    try:
        with store.connection() as con:
            tables = _existing_tables(con)
            if "fes_rtu_define" in tables:
                if q:
                    rows = con.execute(
                        "SELECT rtu_id, name, channel_id, channel_type, process_status FROM fes_rtu_define "
                        "WHERE CAST(rtu_id AS TEXT) LIKE ? OR COALESCE(name,'') LIKE ? OR COALESCE(channel_type,'') LIKE ? "
                        "ORDER BY rtu_id ASC LIMIT 12",
                        (like, like, like),
                    ).fetchall()
                else:
                    rows = con.execute(
                        "SELECT rtu_id, name, channel_id, channel_type, process_status FROM fes_rtu_define "
                        "ORDER BY rtu_id ASC LIMIT 12"
                    ).fetchall()
                rtus = [
                    {
                        "rtu_id": r["rtu_id"],
                        "name": r["name"] or "",
                        "channel_id": r["channel_id"],
                        "channel_type": r["channel_type"] or "",
                        "process_status": r["process_status"],
                    }
                    for r in rows
                ]
            if "fes_scdfe_t_define" in tables:
                try:
                    if q:
                        rows = con.execute(
                            "SELECT channel_id, name, protocol, bind_port, process_enable FROM fes_scdfe_t_define "
                            "WHERE CAST(channel_id AS TEXT) LIKE ? OR COALESCE(name,'') LIKE ? OR COALESCE(protocol,'') LIKE ? "
                            "ORDER BY channel_id ASC LIMIT 10",
                            (like, like, like),
                        ).fetchall()
                    else:
                        rows = con.execute(
                            "SELECT channel_id, name, protocol, bind_port, process_enable FROM fes_scdfe_t_define "
                            "ORDER BY channel_id ASC LIMIT 10"
                        ).fetchall()
                    trans_channels = [
                        {
                            "channel_id": r["channel_id"],
                            "name": r["name"] or "",
                            "protocol": r["protocol"] or "",
                            "bind_port": r["bind_port"],
                            "enabled": r["process_enable"],
                        }
                        for r in rows
                    ]
                except sqlite3.Error:
                    pass
            if q:
                for kind, tbl in _KIND_TABLES.items():
                    if tbl not in tables:
                        continue
                    prows = con.execute(
                        f"SELECT rtu_id, pnt_no, name, value FROM {tbl} "
                        f"WHERE CAST(pnt_no AS TEXT) LIKE ? OR COALESCE(name,'') LIKE ? "
                        f"ORDER BY rtu_id ASC, pnt_no ASC LIMIT 4",
                        (like, like),
                    ).fetchall()
                    for pr in prows:
                        points.append({
                            "kind": kind,
                            "rtu_id": pr["rtu_id"],
                            "pnt_no": pr["pnt_no"],
                            "name": pr["name"] or "",
                            "value": pr["value"],
                        })
    except sqlite3.Error:
        pass
    return {
        "component": component,
        "q": q,
        "rtus": rtus,
        "trans_channels": trans_channels,
        "points": points[:12],
    }


def read_chain_overview(store, component: str, query: dict) -> dict:
    """汇总 S -> C -> T 端到端链路态势（支持按 rtu_id 聚焦或全局统计）。"""
    rtu_raw = str(query.get("rtu_id") or "").strip()
    rtu_id = int(rtu_raw) if rtu_raw.isdigit() else None
    source = {
        "rtu_count": 0,
        "running_count": 0,
        "error_count": 0,
        "point_total": 0,
        "focus": None,
    }
    forward = {
        "channel_count": 0,
        "enabled_channels": 0,
        "mapped_points": 0,
        "diff_points": 0,
    }
    simulator = {
        "available": False,
        "rtu_count": 0,
        "running_count": 0,
    }
    try:
        with store.connection() as con:
            tables = _existing_tables(con)
            if "fes_rtu_define" in tables:
                where = "WHERE rtu_id = ?" if rtu_id is not None else ""
                params = (rtu_id,) if rtu_id is not None else ()
                rrows = con.execute(
                    f"SELECT rtu_id, name, channel_id, channel_type, process_status, process_enable, process_heartbeat_time "
                    f"FROM fes_rtu_define {where} ORDER BY rtu_id ASC",
                    params,
                ).fetchall()
                source["rtu_count"] = len(rrows)
                source["running_count"] = sum(1 for r in rrows if int(r["process_status"] or 0) == 2)
                source["error_count"] = sum(1 for r in rrows if int(r["process_status"] or 0) == 5)
                if rtu_id is not None and rrows:
                    r0 = rrows[0]
                    source["focus"] = {
                        "rtu_id": r0["rtu_id"],
                        "name": r0["name"] or "",
                        "channel_id": r0["channel_id"],
                        "channel_type": r0["channel_type"] or "",
                        "process_status": r0["process_status"],
                        "process_enable": r0["process_enable"],
                        "heartbeat_time": r0["process_heartbeat_time"],
                    }
            for tbl in _KIND_TABLES.values():
                if tbl in tables:
                    if rtu_id is not None:
                        c_row = con.execute(f"SELECT COUNT(*) FROM {tbl} WHERE rtu_id = ?", (rtu_id,)).fetchone()
                    else:
                        c_row = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()
                    source["point_total"] += int(c_row[0]) if c_row else 0

            if "fes_scdfe_t_define" in tables:
                try:
                    t_all = con.execute("SELECT COUNT(*), SUM(CASE WHEN COALESCE(process_enable, 0) != 0 THEN 1 ELSE 0 END) FROM fes_scdfe_t_define").fetchone()
                    forward["channel_count"] = int(t_all[0] or 0)
                    forward["enabled_channels"] = int(t_all[1] or 0)
                except sqlite3.Error:
                    pass
            if "fes_scdfe_t_point_define" in tables:
                if rtu_id is not None:
                    mp = con.execute(
                        "SELECT COUNT(*), COUNT(DISTINCT channel_id) FROM fes_scdfe_t_point_define WHERE source_rtu_id = ?",
                        (rtu_id,),
                    ).fetchone()
                    forward["mapped_points"] = int(mp[0] or 0)
                    forward["channel_count"] = int(mp[1] or 0)
                else:
                    mp = con.execute("SELECT COUNT(*) FROM fes_scdfe_t_point_define").fetchone()
                    forward["mapped_points"] = int(mp[0] or 0)
                for kind, tbl in (("yc", "fes_yc_define"), ("yx", "fes_yx_define")):
                    if tbl not in tables:
                        continue
                    w_rtu = "AND tp.source_rtu_id = ?" if rtu_id is not None else ""
                    p_rtu = (kind, rtu_id) if rtu_id is not None else (kind,)
                    dc = con.execute(
                        f"SELECT COUNT(*) FROM fes_scdfe_t_point_define tp "
                        f"JOIN {tbl} s ON s.rtu_id = tp.source_rtu_id AND s.pnt_no = tp.source_pnt_no "
                        f"WHERE LOWER(tp.kind) = ? AND tp.enabled != 0 {w_rtu} "
                        f"AND s.value IS NOT NULL AND tp.last_value IS NOT NULL "
                        f"AND ABS(CAST(s.value AS REAL) - CAST(tp.last_value AS REAL)) > 1e-4",
                        p_rtu,
                    ).fetchone()
                    forward["diff_points"] += int(dc[0] or 0)
    except sqlite3.Error:
        pass

    # 只读探测同目录仿真库 scdfe_s.db（不加锁、不干扰主库）
    try:
        sim_db = Path(store.db_path).parent / "scdfe_s.db"
        if sim_db.is_file():
            scon = sqlite3.connect(f"file:{sim_db}?mode=ro", uri=True, timeout=0.5)
            try:
                stables = _existing_tables(scon)
                if "fes_rtu_define" in stables:
                    simulator["available"] = True
                    if rtu_id is not None:
                        sr = scon.execute(
                            "SELECT COUNT(*), SUM(CASE WHEN process_status = 2 THEN 1 ELSE 0 END) "
                            "FROM fes_rtu_define WHERE rtu_id = ?",
                            (rtu_id,),
                        ).fetchone()
                    else:
                        sr = scon.execute(
                            "SELECT COUNT(*), SUM(CASE WHEN process_status = 2 THEN 1 ELSE 0 END) FROM fes_rtu_define"
                        ).fetchone()
                    simulator["rtu_count"] = int(sr[0] or 0)
                    simulator["running_count"] = int(sr[1] or 0)
            finally:
                scon.close()
    except Exception:
        pass

    return {
        "component": component,
        "rtu_id": rtu_id,
        "simulator": simulator,
        "source": source,
        "forward": forward,
    }


def read_dashboard_overview(store, component: str) -> dict:
    """为 C / S / T 三端大屏主页面提供单次高密度实时业务聚合快照。"""
    import time

    now_ms = int(time.time() * 1000)
    points_by_kind = {"yc": 0, "yx": 0, "yk": 0, "yt": 0}
    yx_state = {"zero": 0, "one": 0, "other": 0}
    yx_matrix: list[dict] = []
    diff_samples: list[dict] = []
    mapping_by_kind = {k: {"total": 0, "mapped": 0} for k in ("yc", "yx", "yk", "yt")}
    channels: list[dict] = []
    source_rtus: list[dict] = []
    protocols_map: dict[str, dict] = {}
    top_yc: list[dict] = []
    processes: list[dict] = []
    clients: list[dict] = []
    events: list[dict] = []
    alerts = read_alerts_summary(store, component)

    rx_total = 0
    tx_total = 0
    err_total = 0
    active_clients = 0
    mapped_points_total = 0
    diff_points_total = 0

    def _add_proto(proto: str, state: str, pts: int) -> None:
        key = (proto or "unknown").lower()
        rec = protocols_map.setdefault(key, {"protocol": key, "count": 0, "running": 0, "error": 0, "points": 0})
        rec["count"] += 1
        if state == "running":
            rec["running"] += 1
        elif state == "error":
            rec["error"] += 1
        rec["points"] += int(pts or 0)

    try:
        with store.connection() as con:
            tables = _existing_tables(con)

            # 1. 四遥点总数与 YX 分/合位比例
            per_rtu_points: dict[int, int] = {}
            for kind, tbl in _KIND_TABLES.items():
                if tbl not in tables:
                    continue
                try:
                    c_row = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()
                    cnt = int(c_row[0] or 0) if c_row else 0
                    points_by_kind[kind] = cnt
                    mapping_by_kind[kind]["total"] = cnt
                    for grp in con.execute(f"SELECT rtu_id, COUNT(*) FROM {tbl} GROUP BY rtu_id").fetchall():
                        rid = int(grp[0])
                        per_rtu_points[rid] = per_rtu_points.get(rid, 0) + int(grp[1] or 0)
                except sqlite3.Error:
                    pass

            if "fes_yx_define" in tables:
                try:
                    for yr in con.execute("SELECT value, COUNT(*) FROM fes_yx_define GROUP BY value").fetchall():
                        v, cnt = yr[0], int(yr[1] or 0)
                        if v == 0 or v == 0.0:
                            yx_state["zero"] += cnt
                        elif v == 1 or v == 1.0:
                            yx_state["one"] += cnt
                        else:
                            yx_state["other"] += cnt
                    for ym in con.execute(
                        "SELECT rtu_id, pnt_no, name, value FROM fes_yx_define ORDER BY rtu_id ASC, pnt_no ASC LIMIT 32"
                    ).fetchall():
                        yx_matrix.append({
                            "rtu_id": ym["rtu_id"],
                            "pnt_no": ym["pnt_no"],
                            "name": ym["name"] or f"YX#{ym['pnt_no']}",
                            "value": ym["value"],
                        })
                except sqlite3.Error:
                    pass

            # 2. 重点 YC 实时工程值快照（取绝对值/活跃靠前的 Top 10）
            if "fes_yc_define" in tables:
                try:
                    yc_rows = con.execute(
                        "SELECT rtu_id, pnt_no, name, value, status, refresh_time FROM fes_yc_define "
                        "WHERE value IS NOT NULL "
                        "ORDER BY COALESCE(refresh_time, 0) DESC, ABS(CAST(value AS REAL)) DESC, rtu_id ASC, pnt_no ASC LIMIT 10"
                    ).fetchall()
                    for yr in yc_rows:
                        try:
                            fval = float(yr["value"])
                        except (TypeError, ValueError):
                            fval = 0.0
                        top_yc.append({
                            "rtu_id": yr["rtu_id"],
                            "pnt_no": yr["pnt_no"],
                            "name": yr["name"] or f"YC#{yr['pnt_no']}",
                            "value": round(fval, 4),
                            "status": int(yr["status"] or 0),
                        })
                except sqlite3.Error:
                    pass

            # 3. 运行态流量快照（fes_channel_runtime_status）
            rt_by_ch: dict[int, dict] = {}
            if "fes_channel_runtime_status" in tables:
                try:
                    svc_filter = {
                        "c": "service_name = 'scdfe_c'",
                        "t": "service_name = 'scdfe_t'",
                        "s": "service_name LIKE 'scdfe_s%'",
                    }.get(component, "1=1")
                    for r in con.execute(
                        f"SELECT channel_id, service_name, state, running, connection_state, process_status, "
                        f"rx_count, tx_count, error_count, process_heartbeat_time, last_error "
                        f"FROM fes_channel_runtime_status WHERE {svc_filter}"
                    ).fetchall():
                        cid = int(r["channel_id"])
                        rt_by_ch[cid] = dict(r)
                except sqlite3.Error:
                    pass

            # 4. 核心进程状态
            if "fes_process_define" in tables:
                try:
                    for pr in con.execute(
                        "SELECT process_key, kind, target_rtu, process_status, process_pid, process_error "
                        "FROM fes_process_define ORDER BY CASE kind WHEN 'main' THEN 0 WHEN 'writer' THEN 1 WHEN 'command-server' THEN 2 ELSE 3 END, target_rtu"
                    ).fetchall():
                        processes.append({
                            "key": pr["process_key"],
                            "kind": pr["kind"],
                            "status": int(pr["process_status"] or 0),
                            "pid": int(pr["process_pid"] or 0),
                            "alive": bool(pr["process_pid"]),
                            "error": pr["process_error"] or "",
                        })
                except sqlite3.Error:
                    pass

            # 5. 客户端连接历史（只读探测对应组件的 .connections.db）
            clients_per_ch: dict[int, int] = {}
            try:
                from core.connection_history import history_path
                conn_db = history_path(store.db_path, component)
                if conn_db.is_file():
                    ccon = sqlite3.connect(f"file:{conn_db}?mode=ro", uri=True, timeout=0.5)
                    ccon.row_factory = sqlite3.Row
                    try:
                        crows = ccon.execute(
                            "SELECT peer, protocol, channel_id, rtu_id, state, closed, rx_count, tx_count, updated "
                            "FROM connection_session WHERE removed = 0 ORDER BY (closed IS NULL) DESC, updated DESC LIMIT 12"
                        ).fetchall()
                        for cr in crows:
                            is_open = cr["closed"] is None
                            if is_open:
                                active_clients += 1
                                cid_key = cr["channel_id"] if cr["channel_id"] is not None else cr["rtu_id"]
                                if cid_key is not None:
                                    clients_per_ch[int(cid_key)] = clients_per_ch.get(int(cid_key), 0) + 1
                            clients.append({
                                "peer": cr["peer"] or "—",
                                "protocol": cr["protocol"] or "—",
                                "channel_id": cr["channel_id"] if cr["channel_id"] is not None else cr["rtu_id"],
                                "state": "online" if is_open else "closed",
                                "rx": int(cr["rx_count"] or 0),
                                "tx": int(cr["tx_count"] or 0),
                                "updated_ms": int((cr["updated"] or 0) * 1000),
                            })
                    finally:
                        ccon.close()
            except Exception:
                pass

            # 6. 通道/RTU 列表与专属指标
            if component == "t":
                # 源 RTU 简要池（拓扑左侧）
                if "fes_rtu_define" in tables:
                    try:
                        for rr in con.execute(
                            "SELECT rtu_id, name, channel_type, process_status FROM fes_rtu_define ORDER BY rtu_id ASC LIMIT 12"
                        ).fetchall():
                            p_st = int(rr["process_status"] or 0)
                            source_rtus.append({
                                "rtu_id": rr["rtu_id"],
                                "name": rr["name"] or f"RTU {rr['rtu_id']}",
                                "protocol": rr["channel_type"] or "—",
                                "state": "error" if p_st == 5 else ("running" if p_st == 2 else "stopped"),
                                "points": per_rtu_points.get(int(rr["rtu_id"]), 0),
                            })
                    except sqlite3.Error:
                        pass

                mapped_per_ch: dict[int, int] = {}
                if "fes_scdfe_t_point_define" in tables:
                    try:
                        for mr in con.execute(
                            "SELECT channel_id, COUNT(*) FROM fes_scdfe_t_point_define GROUP BY channel_id"
                        ).fetchall():
                            mapped_per_ch[int(mr[0])] = int(mr[1] or 0)
                            mapped_points_total += int(mr[1] or 0)
                        for kr in con.execute(
                            "SELECT LOWER(kind), COUNT(*) FROM fes_scdfe_t_point_define GROUP BY LOWER(kind)"
                        ).fetchall():
                            k = str(kr[0] or "")
                            if k in mapping_by_kind:
                                mapping_by_kind[k]["mapped"] = int(kr[1] or 0)
                        for kind, tbl in (("yc", "fes_yc_define"), ("yx", "fes_yx_define")):
                            if tbl not in tables:
                                continue
                            dc = con.execute(
                                f"SELECT COUNT(*) FROM fes_scdfe_t_point_define tp "
                                f"JOIN {tbl} s ON s.rtu_id = tp.source_rtu_id AND s.pnt_no = tp.source_pnt_no "
                                f"WHERE LOWER(tp.kind) = ? AND tp.enabled != 0 "
                                f"AND s.value IS NOT NULL AND tp.last_value IS NOT NULL "
                                f"AND ABS(CAST(s.value AS REAL) - CAST(tp.last_value AS REAL)) > 1e-4",
                                (kind,),
                            ).fetchone()
                            diff_points_total += int(dc[0] or 0) if dc else 0
                            for dr in con.execute(
                                f"SELECT tp.channel_id, tp.source_rtu_id, tp.source_pnt_no, s.name, s.value AS src_val, tp.last_value AS fwd_val "
                                f"FROM fes_scdfe_t_point_define tp "
                                f"JOIN {tbl} s ON s.rtu_id = tp.source_rtu_id AND s.pnt_no = tp.source_pnt_no "
                                f"WHERE LOWER(tp.kind) = ? AND tp.enabled != 0 "
                                f"AND s.value IS NOT NULL AND tp.last_value IS NOT NULL "
                                f"AND ABS(CAST(s.value AS REAL) - CAST(tp.last_value AS REAL)) > 1e-4 LIMIT 6",
                                (kind,),
                            ).fetchall():
                                diff_samples.append({
                                    "kind": kind,
                                    "channel_id": dr["channel_id"],
                                    "rtu_id": dr["source_rtu_id"],
                                    "pnt_no": dr["source_pnt_no"],
                                    "name": dr["name"] or f"{kind.upper()}#{dr['source_pnt_no']}",
                                    "src_value": dr["src_val"],
                                    "fwd_value": dr["fwd_val"],
                                })
                    except sqlite3.Error:
                        pass

                if "fes_scdfe_t_define" in tables:
                    try:
                        trows = con.execute(
                            "SELECT channel_id, name, protocol, bind_port, process_enable, process_status, process_heartbeat_time, process_error "
                            "FROM fes_scdfe_t_define ORDER BY channel_id ASC"
                        ).fetchall()
                        for tr in trows:
                            cid = int(tr["channel_id"])
                            rt = rt_by_ch.get(cid, {})
                            p_st = int(rt.get("process_status") if rt.get("process_status") is not None else (tr["process_status"] or 0))
                            st = "error" if (p_st == 5 or tr["process_error"]) else ("running" if (p_st == 2 or rt.get("running")) else "stopped")
                            rx = int(rt.get("rx_count") or 0)
                            tx = int(rt.get("tx_count") or 0)
                            err = int(rt.get("error_count") or 0)
                            pts = mapped_per_ch.get(cid, 0)
                            rx_total += rx
                            tx_total += tx
                            err_total += err
                            _add_proto(tr["protocol"] or "iec104", st, pts)
                            channels.append({
                                "id": cid,
                                "rtu_id": None,
                                "name": tr["name"] or f"转发通道 {cid}",
                                "protocol": tr["protocol"] or "iec104",
                                "state": st,
                                "enabled": int(tr["process_enable"] or 0),
                                "rx": rx,
                                "tx": tx,
                                "err": err,
                                "points": pts,
                                "mapped": pts,
                                "clients": clients_per_ch.get(cid, 0),
                                "bind_port": tr["bind_port"],
                                "heartbeat_ms": int(rt.get("process_heartbeat_time") or tr["process_heartbeat_time"] or 0),
                                "last_error": str(rt.get("last_error") or tr["process_error"] or ""),
                            })
                    except sqlite3.Error:
                        pass
            else:
                # C 端与 S 端均基于 fes_rtu_define
                if "fes_rtu_define" in tables:
                    try:
                        rrows = con.execute(
                            "SELECT rtu_id, name, channel_id, channel_type, process_enable, process_status, process_heartbeat_time, process_error "
                            "FROM fes_rtu_define ORDER BY rtu_id ASC"
                        ).fetchall()
                        for rr in rrows:
                            rid = int(rr["rtu_id"])
                            cid = int(rr["channel_id"]) if rr["channel_id"] is not None else rid
                            rt = rt_by_ch.get(cid) or rt_by_ch.get(rid) or {}
                            p_st = int(rt.get("process_status") if rt.get("process_status") is not None else (rr["process_status"] or 0))
                            st = "error" if (p_st == 5 or rr["process_error"]) else ("running" if (p_st == 2 or rt.get("running")) else "stopped")
                            rx = int(rt.get("rx_count") or 0)
                            tx = int(rt.get("tx_count") or 0)
                            err = int(rt.get("error_count") or 0)
                            pts = per_rtu_points.get(rid, 0)
                            rx_total += rx
                            tx_total += tx
                            err_total += err
                            _add_proto(rr["channel_type"] or "unknown", st, pts)
                            channels.append({
                                "id": cid,
                                "rtu_id": rid,
                                "name": rr["name"] or f"RTU {rid}",
                                "protocol": rr["channel_type"] or "unknown",
                                "state": st,
                                "enabled": int(rr["process_enable"] or 0),
                                "rx": rx,
                                "tx": tx,
                                "err": err,
                                "points": pts,
                                "mapped": 0,
                                "clients": clients_per_ch.get(cid, 0) or clients_per_ch.get(rid, 0),
                                "bind_port": None,
                                "heartbeat_ms": int(rt.get("process_heartbeat_time") or rr["process_heartbeat_time"] or 0),
                                "last_error": str(rt.get("last_error") or rr["process_error"] or ""),
                            })
                    except sqlite3.Error:
                        pass

            # 7. 动态实时事件流（聚合告警 + 最近 SOE + 最近指令 + 最近客户端连接）
            for al in alerts.get("items", [])[:6]:
                events.append({
                    "time_ms": now_ms,
                    "category": al.get("category") or "告警",
                    "severity": "err" if al.get("severity") == "error" else "warn",
                    "title": al.get("title") or "",
                    "detail": al.get("detail") or "",
                    "href": al.get("href") or "/",
                    "rtu_id": al.get("rtu_id"),
                })

            if "fes_soe_event" in tables:
                try:
                    for sr in con.execute(
                        "SELECT id, rtu_id, pnt_no, value, event_time, received_at FROM fes_soe_event ORDER BY id DESC LIMIT 6"
                    ).fetchall():
                        events.append({
                            "time_ms": int(sr["received_at"] or sr["event_time"] or now_ms),
                            "category": "SOE 变位",
                            "severity": "info",
                            "title": f"RTU {sr['rtu_id']} YX#{sr['pnt_no']} → {sr['value']}",
                            "detail": f"事件 #{sr['id']}",
                            "href": f"/soe?rtu_id={sr['rtu_id']}",
                            "rtu_id": sr["rtu_id"],
                        })
                except sqlite3.Error:
                    pass

            if "fes_command_trace" in tables:
                try:
                    for cr in con.execute(
                        "SELECT command_id, rtu_id, kind, pnt_no, stage, detail, created_at FROM fes_command_trace ORDER BY created_at DESC LIMIT 6"
                    ).fetchall():
                        st = str(cr["stage"] or "")
                        events.append({
                            "time_ms": int(cr["created_at"] or now_ms),
                            "category": "指令追踪",
                            "severity": "err" if st == "failed" else ("ok" if st in ("protocol_confirmed", "driver_completed", "received") else "info"),
                            "title": f"#{cr['command_id']} RTU {cr['rtu_id']} {str(cr['kind'] or '').upper()}#{cr['pnt_no']}",
                            "detail": f"{st} {cr['detail'] or ''}".strip()[:80],
                            "href": f"/command-traces?rtu_id={cr['rtu_id']}",
                            "rtu_id": cr["rtu_id"],
                        })
                except sqlite3.Error:
                    pass

            for cl in clients[:4]:
                events.append({
                    "time_ms": cl["updated_ms"] or now_ms,
                    "category": "客户端连接",
                    "severity": "ok" if cl["state"] == "online" else "info",
                    "title": f"{cl['protocol'].upper()} · {cl['peer']}",
                    "detail": f"{'在线' if cl['state'] == 'online' else '已断开'} · 收 {cl['rx']} / 发 {cl['tx']}",
                    "href": "/connections",
                    "rtu_id": None,
                })
    except sqlite3.Error:
        pass

    ch_total = len(channels)
    ch_running = sum(1 for c in channels if c["state"] == "running")
    ch_error = sum(1 for c in channels if c["state"] == "error")
    ch_stopped = ch_total - ch_running - ch_error
    points_total = sum(points_by_kind.values())

    # 综合健康度评分（0~100）
    score = 100
    if ch_total > 0:
        score -= int(round((ch_error / ch_total) * 45))
        if ch_running == 0 and ch_error == 0:
            score -= 15
    proc_err = sum(1 for p in processes if p["status"] == 5)
    score -= min(25, proc_err * 8)
    score -= min(20, diff_points_total * 2)
    score = max(0, min(100, score))

    events.sort(key=lambda e: int(e.get("time_ms") or 0), reverse=True)
    protocols = sorted(protocols_map.values(), key=lambda x: (-x["points"], -x["count"], x["protocol"]))

    return {
        "component": component,
        "timestamp_ms": now_ms,
        "health_score": score,
        "kpis": {
            "channels_total": ch_total,
            "channels_running": ch_running,
            "channels_error": ch_error,
            "channels_stopped": ch_stopped,
            "points_total": points_total,
            "rx_total": rx_total,
            "tx_total": tx_total,
            "err_total": err_total,
            "active_clients": active_clients,
            "alerts_total": int(alerts.get("total") or 0),
            "mapped_points": mapped_points_total,
            "diff_points": diff_points_total,
        },
        "points_by_kind": points_by_kind,
        "yx_state": yx_state,
        "yx_matrix": yx_matrix,
        "diff_samples": diff_samples[:8],
        "mapping_by_kind": mapping_by_kind,
        "protocols": protocols,
        "channels": channels[:24],
        "source_rtus": source_rtus[:12],
        "top_yc": top_yc,
        "processes": processes[:12],
        "clients": clients[:12],
        "events": events[:14],
    }


class _ReadOnlyDbStore:
    """只读访问同工作区兄弟数据库（如从 C/T 端只读 scdfe_s.db），零写锁冲突。"""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def connection(self):
        from contextlib import contextmanager

        @contextmanager
        def _ctx():
            con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=0.5)
            con.row_factory = sqlite3.Row
            try:
                yield con
            finally:
                con.close()

        return _ctx()


def _empty_dashboard_snapshot(role: str, now_ms: int) -> dict:
    return {
        "component": role,
        "timestamp_ms": now_ms,
        "health_score": 100,
        "kpis": {
            "channels_total": 0, "channels_running": 0, "channels_error": 0, "channels_stopped": 0,
            "points_total": 0, "rx_total": 0, "tx_total": 0, "err_total": 0,
            "active_clients": 0, "alerts_total": 0, "mapped_points": 0, "diff_points": 0,
        },
        "points_by_kind": {"yc": 0, "yx": 0, "yk": 0, "yt": 0},
        "yx_state": {"zero": 0, "one": 0, "other": 0},
        "yx_matrix": [],
        "diff_samples": [],
        "mapping_by_kind": {k: {"total": 0, "mapped": 0} for k in ("yc", "yx", "yk", "yt")},
        "protocols": [],
        "channels": [],
        "source_rtus": [],
        "top_yc": [],
        "processes": [],
        "clients": [],
        "events": [],
    }


def _probe_port_open(url: str) -> bool:
    import socket
    from urllib.parse import urlsplit

    try:
        sp = urlsplit(url)
        host = sp.hostname or "127.0.0.1"
        port = sp.port or (443 if sp.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=0.12):
            return True
    except OSError:
        return False


def read_dashboard_all(handler, store, component: str) -> dict:
    """一次只读聚合 S / C / T 三端实时大屏快照与服务在线态（零跨域问题）。"""
    import time

    now_ms = int(time.time() * 1000)
    db_dir = Path(store.db_path).parent
    wb = workbench_links_payload(handler, component)
    link_map = {item["key"]: item["url"] for item in wb.get("links", [])}

    if component == "s":
        s_data = read_dashboard_overview(store, "s")
        c_db = db_dir / "scdfe_c.db"
        if c_db.is_file():
            ro_c = _ReadOnlyDbStore(c_db)
            c_data = read_dashboard_overview(ro_c, "c")
            t_data = read_dashboard_overview(ro_c, "t")
        else:
            c_data = _empty_dashboard_snapshot("c", now_ms)
            t_data = _empty_dashboard_snapshot("t", now_ms)
    else:
        c_data = read_dashboard_overview(store, "c")
        t_data = read_dashboard_overview(store, "t")
        s_db = db_dir / "scdfe_s.db"
        if s_db.is_file():
            s_data = read_dashboard_overview(_ReadOnlyDbStore(s_db), "s")
        else:
            s_data = _empty_dashboard_snapshot("s", now_ms)

    services = {}
    for key in ("s", "c", "t"):
        url = link_map.get(key, "")
        services[key] = {
            "url": url,
            "dashboard_url": (url.rstrip("/") + "/dashboard") if url else "/dashboard",
            "online": True if key == component else _probe_port_open(url),
        }

    # 合并三端最近动态流（标注来源端并指向对应端 URL）
    merged_events: list[dict] = []
    for role_key, role_tag, snap in (("c", "采集 C", c_data), ("s", "仿真 S", s_data), ("t", "转发 T", t_data)):
        base = link_map.get(role_key, "").rstrip("/")
        for ev in (snap.get("events") or [])[:6]:
            href = ev.get("href") or "/"
            if base and role_key != component and href.startswith("/"):
                href = base + href
            merged_events.append({**ev, "source": role_key, "source_label": role_tag, "href": href})
    merged_events.sort(key=lambda x: int(x.get("time_ms") or 0), reverse=True)

    scores = [int(s_data.get("health_score", 100)), int(c_data.get("health_score", 100)), int(t_data.get("health_score", 100))]
    overall_score = int(round(sum(scores) / len(scores)))

    return {
        "component": component,
        "timestamp_ms": now_ms,
        "overall_score": overall_score,
        "services": services,
        "s": s_data,
        "c": c_data,
        "t": t_data,
        "merged_events": merged_events[:14],
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

    if parts == ["api", "alerts-summary"]:
        if method != "GET":
            raise ApiError(405, "异常汇总接口只支持 GET")
        return handler._json(200, read_alerts_summary(store, component))

    if parts == ["api", "quick-search"]:
        if method != "GET":
            raise ApiError(405, "快速检索接口只支持 GET")
        return handler._json(200, read_quick_search(store, component, query))

    if parts == ["api", "chain-overview"]:
        if method != "GET":
            raise ApiError(405, "端到端链路概览接口只支持 GET")
        return handler._json(200, read_chain_overview(store, component, query))

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

    if parts == ["dashboard-all"]:
        if method != "GET":
            raise ApiError(405, "只支持 GET")
        tpl_path = assets / "dashboard-all.html"
        if component in ("c", "t", "s"):
            return send_static(
                handler,
                tpl_path,
                "text/html; charset=utf-8",
                transform=lambda raw: render_workbench(raw, component, "dashboard-all.html"),
                cache_key=f"workbench:{component}:dashboard-all.html",
            )
        return send_static(handler, tpl_path, "text/html; charset=utf-8")

    if parts == ["api", "dashboard-all"]:
        if method != "GET":
            raise ApiError(405, "三端合屏总览接口只支持 GET")
        return handler._json(200, read_dashboard_all(handler, store, component))

    if parts in (["dashboard"], ["static", "dashboard.css"], ["static", "dashboard.js"]):
        if method != "GET":
            raise ApiError(405, "只支持 GET")
        if parts[0] == "static":
            mime = "text/css" if parts[1].endswith(".css") else "application/javascript"
            return send_static(handler, assets / parts[1], mime + "; charset=utf-8")
        tpl_name = f"dashboard-{component}.html" if component in ("c", "s", "t") else "dashboard.html"
        tpl_path = assets / tpl_name if (assets / tpl_name).is_file() else assets / "dashboard.html"
        if component in ("c", "t", "s"):
            return send_static(
                handler,
                tpl_path,
                "text/html; charset=utf-8",
                transform=lambda raw: render_workbench(raw, component, "dashboard.html"),
                cache_key=f"workbench:{component}:{tpl_name}",
            )
        return send_static(handler, tpl_path, "text/html; charset=utf-8")

    if parts == ["api", "dashboard-overview"]:
        if method != "GET":
            raise ApiError(405, "大屏总览接口只支持 GET")
        return handler._json(200, read_dashboard_overview(store, component))

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
