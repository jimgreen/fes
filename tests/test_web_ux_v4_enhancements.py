"""Web 综合体验、可视化、逻辑与性能提升专项回归测试。"""
from __future__ import annotations

from contextlib import closing
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from core.web_workbench import ASSETS, render_workbench
from scdfe_c.web.process_control import ProcessController
from scdfe_c.web.server import make_server as make_c_server
from scdfe_c.web.service import ScadaStore
from scdfe_t.web.service import TransStore


ROOT = Path(__file__).resolve().parents[1]


class WebUxV4EnhancementTests(unittest.TestCase):
    def test_batch_points_update_and_delete_single_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "batch.db"
            with closing(ScadaStore(db)) as store:
                store.create_row("fes_rtu_define", {"rtu_id": 1, "name": "R1", "channel_id": 1, "channel_type": "iec104"})
                for i in range(1, 51):
                    store.create_row("fes_yc_define", {"rtu_id": 1, "pnt_no": i, "name": f"YC{i}", "raw_scale": 1.0, "raw_base": 0.0})
                rows = store.list_rows("fes_yc_define", limit=100)["items"]
                keys = [{"rtu_id": r["rtu_id"], "pnt_no": r["pnt_no"], "_version": r["_version"]} for r in rows]
                # 故意制造 1 条版本不匹配
                keys[-1]["_version"] = 99999
                res = store.batch_points("yc", "update", keys, {"raw_scale": 0.1, "raw_base": 5.0})
                self.assertEqual(res["succeeded"], 49)
                self.assertEqual(res["failed"], 1)
                p1 = store.get_row("fes_yc_define", [1, 1])
                self.assertAlmostEqual(p1["raw_scale"], 0.1)
                self.assertAlmostEqual(p1["raw_base"], 5.0)

                # 单事务批量删除前 10 条（不传 _version）
                del_res = store.batch_points("yc", "delete", [[1, i] for i in range(1, 11)])
                self.assertEqual(del_res["succeeded"], 10)
                self.assertEqual(del_res["failed"], 0)
                self.assertEqual(store.list_rows("fes_yc_define", limit=100)["total"], 40)

    def test_points_csv_export_formula_escape_and_dry_run_import(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "csv.db"
            with closing(ScadaStore(db)) as store:
                store.create_row("fes_rtu_define", {"rtu_id": 1, "name": "R1", "channel_id": 1, "channel_type": "iec104"})
                store.create_row("fes_yc_define", {"rtu_id": 1, "pnt_no": 1, "name": "=CMD()", "raw_scale": 0.5, "raw_base": 0.0})
                raw_csv = store.export_points_csv("yc", rtu_id=1)
                self.assertTrue(raw_csv.startswith(b"\xef\xbb\xbf"))
                text = raw_csv.decode("utf-8-sig")
                self.assertIn("'=CMD()", text)

                # 预检：1 条已存在冲突 + 1 条新建 + 1 条不存在 RTU 错误
                csv_in = "rtu_id,pnt_no,name,raw_scale\n1,1,覆盖测试,2.5\n1,2,新增点,1.2\n99,1,无效RTU,1.0\n"
                preview = store.import_points_csv("yc", csv_in, dry_run=True, on_conflict="overwrite")
                self.assertTrue(preview["dry_run"])
                self.assertEqual(preview["would_create"], 1)
                self.assertEqual(preview["would_update"], 1)
                self.assertEqual(preview["conflict_count"], 1)
                self.assertEqual(preview["error_count"], 1)

                # 去掉错误行实际写入
                csv_ok = "rtu_id,pnt_no,name,raw_scale\n1,1,覆盖测试,2.5\n1,2,新增点,1.2\n"
                applied = store.import_points_csv("yc", csv_ok, dry_run=False, on_conflict="overwrite")
                self.assertEqual(applied["created"], 1)
                self.assertEqual(applied["updated"], 1)
                self.assertAlmostEqual(store.get_row("fes_yc_define", [1, 1])["raw_scale"], 2.5)
                self.assertEqual(store.get_row("fes_yc_define", [1, 2])["name"], "新增点")

    def test_process_controller_snapshot_ttl_cache_and_invalidation(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "proc.db"
            with closing(ScadaStore(db)) as store:
                pc = ProcessController(store, snapshot_ttl=2.0)
                first = pc.snapshot()
                self.assertIsNotNone(pc._snapshot_cache)
                second = pc.snapshot()
                self.assertEqual(len(first["items"]), len(second["items"]))
                # 修改返回对象不污染内部缓存
                second["items"].clear()
                third = pc.snapshot()
                self.assertGreaterEqual(len(third["items"]), 3)
                # 主动失效与 fresh=True
                pc.invalidate_snapshot()
                self.assertIsNone(pc._snapshot_cache)
                fourth = pc.snapshot(fresh=True)
                self.assertGreaterEqual(len(fourth["items"]), 3)

    def test_ux_v4_http_endpoints_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "web.db"
            with closing(ScadaStore(db)) as store:
                store.create_row("fes_rtu_define", {"rtu_id": 1, "name": "一号站", "channel_id": 1, "channel_type": "iec104"})
                store.create_row("fes_yc_define", {"rtu_id": 1, "pnt_no": 1, "name": "母线电压", "value": 10.5, "raw_scale": 1.0})
                with store.connection() as con:
                    con.execute("UPDATE fes_rtu_define SET process_status=5, process_error='连接超时' WHERE rtu_id=1")
                    con.commit()
            trans = TransStore(db)
            try:
                trans.create_channel({"channel_id": 10, "name": "上行104", "protocol": "iec104", "bind_host": "127.0.0.1", "bind_port": 2404})
                trans.create_points_batch(10, {"items": [{"kind": "yc", "pnt_no": 1, "source_rtu_id": 1, "source_pnt_no": 1}]})
            finally:
                trans.store.close()

            server = make_c_server("127.0.0.1", 0, db_path=db, workspace_root=Path(td))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    # 1. 异常汇总
                    conn.request("GET", "/api/alerts-summary")
                    r1 = conn.getresponse()
                    d1 = json.loads(r1.read().decode("utf-8"))
                    self.assertEqual(r1.status, 200)
                    self.assertGreaterEqual(d1["counts"]["thread_errors"], 1)
                    self.assertGreaterEqual(d1["total"], 1)

                    # 2. 快速检索
                    conn.request("GET", "/api/quick-search?q=1")
                    r2 = conn.getresponse()
                    d2 = json.loads(r2.read().decode("utf-8"))
                    self.assertEqual(r2.status, 200)
                    self.assertEqual(len(d2["rtus"]), 1)
                    self.assertEqual(len(d2["points"]), 1)

                    # 3. 端到端链路概览
                    conn.request("GET", "/api/chain-overview?rtu_id=1")
                    r3 = conn.getresponse()
                    d3 = json.loads(r3.read().decode("utf-8"))
                    self.assertEqual(r3.status, 200)
                    self.assertEqual(d3["source"]["error_count"], 1)
                    self.assertEqual(d3["forward"]["mapped_points"], 1)

                    # 4. 四遥批量更新 HTTP 端点
                    body = json.dumps({"action": "update", "items": [[1, 1]], "values": {"raw_scale": 0.25}}).encode("utf-8")
                    conn.request("POST", "/api/points/yc/batch", body=body, headers={"Content-Type": "application/json"})
                    r4 = conn.getresponse()
                    d4 = json.loads(r4.read().decode("utf-8"))
                    self.assertEqual(r4.status, 200)
                    self.assertEqual(d4["succeeded"], 1)

                    # 5. CSV 导出与新增共享静态文件
                    for path in ("/api/points/yc/csv?rtu_id=1", "/static/theme-init.js", "/static/ui-i18n-dict.js", "/static/table-reconcile.js"):
                        conn.request("GET", path)
                        rx = conn.getresponse()
                        rx.read()
                        self.assertEqual(rx.status, 200, path)
                finally:
                    conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)

    def test_i18n_lazy_split_fouc_init_and_workbench_injection(self):
        for asset in ("theme-init.js", "ui-i18n-dict.js", "table-reconcile.js"):
            self.assertIn(asset, ASSETS)
        theme_init = (ROOT / "core" / "web_static" / "theme-init.js").read_text(encoding="utf-8")
        self.assertLess(len(theme_init.encode("utf-8")), 1536)
        self.assertIn("scada_ui_theme", theme_init)

        i18n_core = (ROOT / "core" / "web_static" / "ui-i18n.js").read_text(encoding="utf-8")
        i18n_dict = (ROOT / "core" / "web_static" / "ui-i18n-dict.js").read_text(encoding="utf-8")
        self.assertLess(len(i18n_core.encode("utf-8")), 25 * 1024, "核心 ui-i18n.js 必须已瘦身")
        self.assertIn("THEME_GROUPS", i18n_core)
        self.assertIn("ui-prefs-trigger", i18n_core)
        self.assertIn("ui-prefs-popover", i18n_core)
        self.assertIn("/static/ui-i18n-dict.js", i18n_core)
        self.assertGreater(len(i18n_dict.encode("utf-8")), 50 * 1024)

        rendered = render_workbench(b"<!doctype html><html lang='zh-CN'><head></head><body><main></main></body></html>", "c", "diagnostics.html").decode("utf-8")
        self.assertIn('<script src="/static/theme-init.js"></script>', rendered)
        self.assertIn('<script defer src="/static/table-reconcile.js"></script>', rendered)

        c_index = (ROOT / "scdfe_c" / "web" / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn('/static/theme-init.js', c_index)
        self.assertIn('id="auto-refresh-interval"', c_index)

        wb_js = (ROOT / "core" / "web_static" / "workbench.js").read_text(encoding="utf-8")
        theme_css = (ROOT / "core" / "web_static" / "ui-theme.css").read_text(encoding="utf-8")
        resizer_js = (ROOT / "core" / "web_static" / "layout-resizer.js").read_text(encoding="utf-8")
        self.assertIn("initAutoHideSidebar", wb_js)
        self.assertIn("ui-sidebar-edge", wb_js)
        self.assertIn("ui-sidebar-toggle", wb_js)
        self.assertIn("scada_sidebar_mode", wb_js)
        self.assertIn("is-sidebar-peek", theme_css)
        self.assertIn('data-sidebar-mode="dock"', theme_css)
        self.assertIn('data-sidebar-hidden="1"', theme_css)
        self.assertNotIn('selector: ".workbench-shell"', resizer_js)
        self.assertNotIn('selector: ".shell"', resizer_js)


if __name__ == "__main__":
    unittest.main()
