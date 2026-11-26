"""针对 1~8 项增强（深度报文译码、对账异常筛选与导出、T 端 CSV 预检导入、三端互跳、权限守护、WAL 监控整理、Modbus 合包读）的回归测试。"""
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch

from client.modbus_tcp import ModbusTcpMaster
from core.web_ux_api import decode_packet_payload, read_operation_audit
from scdfe_c.web.server import make_server as make_c_server
from scdfe_t.web.server import make_server as make_t_server
from scdfe_t.web.service import TransStore


class WebUxEnhancementsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "ux_test.db"
        self.t_service = TransStore(self.db)
        with self.t_service.store.connection() as con:
            con.execute(
                "INSERT INTO fes_rtu_define (rtu_id, name, channel_id, channel_type) VALUES (1, '主站测试RTU', 10, 'iec104')"
            )
            con.execute(
                "INSERT INTO fes_yc_define (rtu_id, pnt_no, name, raw_value, value, status, refresh_time) "
                "VALUES (1, 1, '母线电压', 220.5, 220.5, 0, '2026-11-26 01:00:00')"
            )
            con.execute(
                "INSERT INTO fes_yc_define (rtu_id, pnt_no, name, raw_value, value, status, refresh_time) "
                "VALUES (1, 2, '=异常电流', 15.2, 15.2, 128, '2026-11-26 01:00:00')"
            )
            con.commit()
        self.t_service.create_channel({
            "channel_id": 100,
            "name": "转发通道100",
            "protocol": "iec104",
            "bind_host": "127.0.0.1",
            "bind_port": self._free_port(),
            "scan_interval_ms": 100,
        })
        self.t_service.create_point(100, {
            "pnt_no": 1,
            "kind": "yc",
            "source_rtu_id": 1,
            "source_pnt_no": 1,
            "name": "转发母线电压",
            "io_address": 4001,
        })

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _start_server(self, server):
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(3)))
        return server

    @staticmethod
    def _req(server, path: str, method: str = "GET", body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        hdrs = dict(headers or {})
        if body is not None:
            hdrs.setdefault("Content-Type", "application/json")
        payload = None if body is None else json.dumps(body)
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        raw = resp.read()
        resp_headers = dict(resp.getheaders())
        conn.close()
        return resp.status, raw, resp_headers

    def test_deep_packet_decode_iec104_and_modbus(self):
        # 1. IEC 104 STARTDT ACT U 帧
        res_u = decode_packet_payload({"line": "2026-11-26 [PACKET] TX IEC104 68 04 07 00 00 00"})
        self.assertEqual(res_u["protocol"], "IEC104")
        self.assertEqual(res_u["direction"], "TX")
        self.assertEqual(res_u["byte_count"], 6)

        # 2. IEC 104 I 帧：短浮点遥测 (Type 13, SQ=1, 2 条, IOA=4001..4002, 第二条带 IV 无效位)
        f1 = struct.pack("<f", 220.5) + b"\x00"
        f2 = struct.pack("<f", 15.25) + b"\x80"
        asdu = bytes([13, 0x82, 20, 0, 1, 0]) + (4001).to_bytes(3, "little") + f1 + f2
        apdu = bytes([0x68, 4 + len(asdu), 0x02, 0x00, 0x04, 0x00]) + asdu
        res_i = decode_packet_payload({"line": "RX IEC104 " + apdu.hex(" ")})
        self.assertIn("M_ME_NC_1", res_i["decoded"])
        self.assertEqual(len(res_i["details"]), 2)
        self.assertIn("IOA=4001", res_i["details"][0])
        self.assertIn("IV无效", res_i["details"][1])

        # 3. Modbus-TCP 03 响应解析多个寄存器值
        mb_tcp = bytes.fromhex("00 01 00 00 00 07 01 03 04 00 64 FF CE")
        res_tcp = decode_packet_payload({"line": "RX Modbus-TCP " + mb_tcp.hex(" ")})
        self.assertEqual(res_tcp["protocol"], "Modbus-TCP")
        self.assertEqual(len(res_tcp["details"]), 2)
        self.assertIn("reg[0]=100", res_tcp["details"][0])
        self.assertIn("s16=-50", res_tcp["details"][1])

        # 4. Modbus-RTU 读保持寄存器（含正确 CRC16）
        res_rtu = decode_packet_payload({"line": "2026-11-26 [PACKET] TX Modbus-RTU 01 03 00 00 00 0A C5 CD"})
        self.assertEqual(res_rtu["protocol"], "Modbus-RTU")
        self.assertIn("校验通过", res_rtu["decoded"])
        self.assertIn("数量=10", res_rtu["decoded"])

        with self.assertRaises(ValueError):
            decode_packet_payload({"line": "没有报文"})

    def test_operation_audit_and_point_trace_anomaly_and_export(self):
        log_dir = self.db.parent / "logs" / "2026" / "11" / "26"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / "scdfe_c-operations-20261126-01.log").write_text(
            "2026-11-26 01:00:05 INFO 操作审计 "
            + json.dumps({"time": "2026-11-26 01:00:05", "phase": "command.send", "method": "POST", "path": "/api/rtus/1/commands/yk/1", "status": 200}, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        direct = read_operation_audit(self.db.parent / "logs", "c", {"q": "command"})
        self.assertEqual(direct["total"], 1)

        c_server = self._start_server(make_c_server("127.0.0.1", 0, db_path=self.db))
        # 全链路对账页与异常筛选（点 #2 status=128，点 #1 有采集值 220.5 但转发值 0.0 -> 两者都异常）
        st, raw, _ = self._req(c_server, "/api/point-trace?kind=yc&anomaly_only=1")
        self.assertEqual(st, 200)
        anomalies = json.loads(raw)
        self.assertEqual(anomalies["total"], 2)

        # CSV 导出带 UTF-8 BOM 且防止公式注入（=异常电流 -> '=异常电流）
        st, csv_bytes, hdrs = self._req(c_server, "/api/point-trace/export?kind=yc")
        self.assertEqual(st, 200)
        self.assertTrue(csv_bytes.startswith(b"\xef\xbb\xbf"))
        csv_text = csv_bytes.decode("utf-8-sig")
        self.assertIn("'=异常电流", csv_text)
        self.assertIn("IOA 4001", csv_text)

        # 诊断页包含 storage 健康字段，且支持 WAL checkpoint
        st, diag_raw, _ = self._req(c_server, "/api/diagnostics")
        self.assertEqual(st, 200)
        diag = json.loads(diag_raw)
        self.assertIn("storage", diag)
        self.assertIn(diag["storage"]["wal_state"], ("ok", "warn", "critical"))
        st, ck_raw, _ = self._req(c_server, "/api/diagnostics/wal-checkpoint", "POST", {"mode": "PASSIVE"})
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(ck_raw)["mode"], "PASSIVE")

        # 三端互跳接口
        st, links_raw, _ = self._req(c_server, "/api/workbench-links")
        self.assertEqual(st, 200)
        links = json.loads(links_raw)
        self.assertEqual([x["key"] for x in links["links"]], ["c", "s", "t"])
        self.assertTrue(links["links"][0]["active"])

    def test_t_csv_export_dry_run_and_import_and_clean_routes(self):
        t_server = self._start_server(make_t_server("127.0.0.1", 0, db_path=self.db))
        for route in ("/communication", "/processes", "/logs", "/channels", "/points", "/point-trace"):
            st, body, _ = self._req(t_server, route)
            self.assertEqual(st, 200, route)
            self.assertIn("<!doctype html>", body.decode("utf-8").lower())

        # 导出 CSV 模板
        st, raw_csv, _ = self._req(t_server, "/api/trans/channels/100/points/export-csv")
        self.assertEqual(st, 200)
        self.assertIn("io_address", raw_csv.decode("utf-8-sig"))

        # Dry-run 预检：包含 1 条冲突（IOA 4001 已占用）和 1 条正常但源点缺失预警
        csv_conflict = "kind,pnt_no,name,source_rtu_id,source_pnt_no,io_address\nyc,2,重复IOA,1,2,4001\nyc,3,预配置点,9,99,4002\n"
        st, raw, _ = self._req(t_server, "/api/trans/channels/100/points/import-csv", "POST", {"csv_text": csv_conflict, "dry_run": True})
        self.assertEqual(st, 200)
        rep = json.loads(raw)
        self.assertEqual(rep["conflict_count"], 1)
        self.assertEqual(rep["warning_count"], 1)

        # 正式导入有冲突应返回 409
        st, _, _ = self._req(t_server, "/api/trans/channels/100/points/import-csv", "POST", {"csv_text": csv_conflict, "dry_run": False})
        self.assertEqual(st, 409)

        # 修正后正式导入成功
        csv_ok = "kind,pnt_no,name,source_rtu_id,source_pnt_no,io_address\nyc,2,电流转发,1,2,4002\n"
        st, raw, _ = self._req(t_server, "/api/trans/channels/100/points/import-csv", "POST", {"csv_text": csv_ok, "dry_run": False})
        self.assertEqual(st, 201)
        self.assertEqual(json.loads(raw)["imported_count"], 1)

    def test_optional_web_security_readonly_and_operator_token(self):
        t_server = self._start_server(make_t_server("127.0.0.1", 0, db_path=self.db))
        # 1. 全局只读模式拦截写请求，但放行 GET 与 /api/packet-decode
        with patch.dict(os.environ, {"SCADA_WEB_READONLY": "1"}, clear=False):
            st, _, _ = self._req(t_server, "/api/trans/channels", "GET")
            self.assertEqual(st, 200)
            st, _, _ = self._req(t_server, "/api/packet-decode", "POST", {"line": "TX IEC104 68 04 07 00 00 00"})
            self.assertEqual(st, 200)
            st, _, _ = self._req(t_server, "/api/trans/channels", "POST", {"channel_id": 200, "name": "x", "protocol": "iec104", "bind_host": "127.0.0.1", "bind_port": 2405})
            self.assertEqual(st, 403)

        # 2. 运维口令保护模式：未登录 401 -> 登录拿 Cookie -> 写请求 201
        with patch.dict(os.environ, {"SCADA_WEB_OPERATOR_TOKEN": "secret-ops-2026"}, clear=False):
            st, _, _ = self._req(t_server, "/api/trans/channels", "POST", {"channel_id": 200, "name": "x", "protocol": "iec104", "bind_host": "127.0.0.1", "bind_port": 2405})
            self.assertEqual(st, 401)
            st, _, _ = self._req(t_server, "/api/auth/session", "POST", {"token": "wrong"})
            self.assertEqual(st, 401)
            st, _, hdrs = self._req(t_server, "/api/auth/session", "POST", {"token": "secret-ops-2026"})
            self.assertEqual(st, 200)
            cookie = hdrs.get("Set-Cookie", "").split(";", 1)[0]
            self.assertTrue(cookie.startswith("scada_op_session="))
            st, _, _ = self._req(
                t_server, "/api/trans/channels", "POST",
                {"channel_id": 201, "name": "解锁创建", "protocol": "iec104", "bind_host": "127.0.0.1", "bind_port": self._free_port()},
                headers={"Cookie": cookie},
            )
            self.assertEqual(st, 201)

    def test_modbus_poll_plan_coalesces_adjacent_calls_and_preserves_seq(self):
        calls = [
            {"rtu_id": 1, "call_seq": 1, "iplace": 0, "inum": 2, "icode": 3, "irtuaddr": 1},
            {"rtu_id": 1, "call_seq": 2, "iplace": 2, "inum": 2, "icode": 3, "irtuaddr": 1},
            # 存在空洞（地址 10），不应跨越空洞合并
            {"rtu_id": 1, "call_seq": 3, "iplace": 10, "inum": 1, "icode": 3, "irtuaddr": 1},
        ]
        points = [
            {"rtu_id": 1, "call_seq": 1, "cnt": 1, "reg_addr": 0, "trans_type": 2, "if_yx": 0},
            {"rtu_id": 1, "call_seq": 2, "cnt": 2, "reg_addr": 2, "trans_type": 2, "if_yx": 0},
            {"rtu_id": 1, "call_seq": 3, "cnt": 3, "reg_addr": 10, "trans_type": 2, "if_yx": 0},
        ]
        master = ModbusTcpMaster("127.0.0.1", 502, unit_id=1, rtu_id=1, calls=calls, points=points, coalesce_reads=True)
        # 原本 3 条召唤合并为 2 次读（0..3 共 4 寄存器 + 10 共 1 寄存器）
        self.assertEqual(len(master._poll_plan), 2)
        self.assertEqual(master._poll_plan[0][2:4], (0, 4))
        self.assertEqual(master._poll_plan[1][2:4], (10, 1))

        invoked = []
        def fake_invoke(name, address, count, unit):
            invoked.append((name, address, count, unit))
            return [100, 200, 300, 400] if address == 0 else [999]

        with patch.object(master, "_invoke", side_effect=fake_invoke):
            vals = master.collect_once()
        self.assertEqual(len(invoked), 2)
        self.assertEqual([(v.call_seq, v.point_no, v.value) for v in vals], [(1, 1, 100), (2, 2, 300), (3, 3, 999)])


if __name__ == "__main__":
    unittest.main()
