"""针对 1~3 期页面整合与交互增强（操作审计、报文译码、全链路对账、无后缀路由）的回归测试。"""
from __future__ import annotations

import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from core.web_ux_api import decode_packet_payload, read_operation_audit
from scdfe_c.web.server import make_server as make_c_server
from scdfe_t.web.server import make_server as make_t_server
from scdfe_t.web.service import TransStore


class WebUxEnhancementsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "ux_test.sqlite3"
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
                "VALUES (1, 2, '母线电流', 15.2, 15.2, 0, '2026-11-26 01:00:00')"
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
    def _req(server, path: str, method: str = "GET", body=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        payload = None if body is None else json.dumps(body)
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, raw

    def test_packet_decode_iec104_and_modbus(self):
        # IEC 104 STARTDT ACT U 帧
        res_104 = decode_packet_payload({"line": "2026-11-26 [PACKET] TX IEC104 68 04 07 00 00 00"})
        self.assertEqual(res_104["protocol"], "IEC104")
        self.assertEqual(res_104["direction"], "TX")
        self.assertEqual(res_104["byte_count"], 6)
        self.assertTrue(res_104["decoded"])

        # Modbus-RTU 读保持寄存器（含正确 CRC16）
        res_rtu = decode_packet_payload({"line": "2026-11-26 [PACKET] TX Modbus-RTU 01 03 00 00 00 0A C5 CD"})
        self.assertEqual(res_rtu["protocol"], "Modbus-RTU")
        self.assertIn("校验通过", res_rtu["decoded"])
        self.assertIn("站号=1", res_rtu["decoded"])

        # 非法短文本应抛出 ValueError
        with self.assertRaises(ValueError):
            decode_packet_payload({"line": "没有报文"})

    def test_operation_audit_reader_and_api(self):
        log_dir = self.db.parent / "logs" / "2026" / "11" / "26"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "scdfe_c-operations-20261126-01.log"
        log_file.write_text(
            "2026-11-26 01:00:01 INFO 操作审计 "
            + json.dumps({"time": "2026-11-26 01:00:01", "phase": "point.update", "method": "PATCH", "path": "/api/rtus/1/points/yc/1", "status": 200}, ensure_ascii=False)
            + "\n"
            + "2026-11-26 01:00:05 INFO 操作审计 "
            + json.dumps({"time": "2026-11-26 01:00:05", "phase": "command.send", "method": "POST", "path": "/api/rtus/1/commands/yk/1", "status": 200, "value": 1}, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        direct = read_operation_audit(self.db.parent / "logs", "c", {"q": "command"})
        self.assertEqual(direct["total"], 1)
        self.assertEqual(direct["items"][0]["phase"], "command.send")

        c_server = self._start_server(make_c_server("127.0.0.1", 0, db_path=self.db))
        status, raw = self._req(c_server, "/api/operation-audit?limit=10")
        self.assertEqual(status, 200)
        payload = json.loads(raw)
        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["items"][0]["phase"], "command.send")

        # 测试 POST /api/packet-decode 接口
        status, raw = self._req(c_server, "/api/packet-decode", "POST", {"line": "RX IEC104 68 04 0B 00 00 00"})
        self.assertEqual(status, 200)
        decoded = json.loads(raw)
        self.assertEqual(decoded["protocol"], "IEC104")

    def test_point_trace_api_and_html_and_t_clean_routes(self):
        c_server = self._start_server(make_c_server("127.0.0.1", 0, db_path=self.db))
        status, raw = self._req(c_server, "/point-trace")
        self.assertEqual(status, 200)
        html = raw.decode("utf-8")
        self.assertIn("全链路对账", html)
        self.assertIn("/static/point-trace.js", html)

        status, raw = self._req(c_server, "/api/point-trace?kind=yc&rtu_id=1")
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["mapped_total"], 1)
        mapped = [row for row in data["items"] if row["fwd_channel_id"] is not None]
        self.assertEqual(len(mapped), 1)
        self.assertEqual(mapped[0]["fwd_addr"], "IOA 4001")

        status, raw = self._req(c_server, "/api/point-trace?kind=yc&mapped_only=1")
        self.assertEqual(status, 200)
        only_mapped = json.loads(raw)
        self.assertEqual(only_mapped["total"], 1)

        # 验证 scdfe_t 无 .html 后缀路由别名均返回 200
        t_server = self._start_server(make_t_server("127.0.0.1", 0, db_path=self.db))
        for route in ("/communication", "/processes", "/logs", "/channels", "/points", "/point-trace"):
            st, body = self._req(t_server, route)
            self.assertEqual(st, 200, f"路由 {route} 应返回 200")
            self.assertIn("<!doctype html>", body.decode("utf-8").lower())


if __name__ == "__main__":
    unittest.main()
