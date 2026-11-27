"""scdfe_c / scdfe_s / scdfe_t 三端动态大屏主页面端到端回归测试。"""
from __future__ import annotations

from contextlib import closing
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from scdfe_c.web.server import make_server as make_c_server
from scdfe_c.web.service import ScadaStore
from scdfe_s.database import SimulatorStore
from scdfe_s.web.server import make_server as make_s_server
from scdfe_t.web.server import make_server as make_t_server
from scdfe_t.web.service import TransStore


ROOT = Path(__file__).resolve().parents[1]


class ThreeWebDashboardTests(unittest.TestCase):
    def _seed_c_and_t(self, db: Path) -> None:
        with closing(ScadaStore(db)) as store:
            store.create_row("fes_rtu_define", {"rtu_id": 1, "name": "秦岭一号站", "channel_id": 1, "channel_type": "iec104"})
            store.create_row("fes_rtu_define", {"rtu_id": 2, "name": "Modbus采集", "channel_id": 2, "channel_type": "modbus-tcp"})
            store.create_row("fes_yc_define", {"rtu_id": 1, "pnt_no": 1, "name": "有功功率", "value": 128.6})
            store.create_row("fes_yx_define", {"rtu_id": 1, "pnt_no": 1, "name": "断路器位置", "value": 1})
            store.create_row("fes_yx_define", {"rtu_id": 1, "pnt_no": 2, "name": "刀闸位置", "value": 0})
            store.create_row("fes_yk_define", {"rtu_id": 1, "pnt_no": 1, "name": "开关遥控"})
            store.create_row("fes_yt_define", {"rtu_id": 1, "pnt_no": 1, "name": "功率定值"})
            with store.connection() as con:
                con.execute("UPDATE fes_rtu_define SET process_status=2, process_enable=1 WHERE rtu_id=1")
                con.execute("UPDATE fes_rtu_define SET process_status=5, process_error='超时' WHERE rtu_id=2")
                con.commit()
        trans = TransStore(db)
        try:
            trans.create_channel({"channel_id": 10, "name": "地调上送104", "protocol": "iec104", "bind_host": "127.0.0.1", "bind_port": 2404})
            trans.create_points_batch(10, {"items": [
                {"kind": "yc", "pnt_no": 1, "source_rtu_id": 1, "source_pnt_no": 1},
                {"kind": "yx", "pnt_no": 1, "source_rtu_id": 1, "source_pnt_no": 1},
            ]})
        finally:
            trans.store.close()

    def _seed_s(self, db: Path) -> None:
        with closing(SimulatorStore(db)) as store:
            store.create_row("fes_rtu_define", {"rtu_id": 1, "name": "IEC104仿真站", "channel_id": 1, "channel_type": "iec104"})
            store.create_row("fes_yc_define", {"rtu_id": 1, "pnt_no": 1, "name": "仿真电压", "value": 220.5})
            store.create_row("fes_yx_define", {"rtu_id": 1, "pnt_no": 1, "name": "仿真状态", "value": 1})

    def _verify_server(self, server, expected_component: str) -> dict:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=6)
            try:
                # 1. HTML 主页与首位导航入口
                conn.request("GET", "/dashboard")
                r = conn.getresponse()
                html = r.read().decode("utf-8")
                self.assertEqual(r.status, 200)
                self.assertIn('data-dashboard="1"', html)
                self.assertIn(f'data-dash-role="{expected_component}"', html)
                self.assertIn(f'dash-layout-{expected_component}', html)
                role_markers = {
                    "c": ("dash-donut-svg", "dash-topo-host"),
                    "s": ("dash-scope-canvas", "dash-svc-grid", "dash-radar-host"),
                    "t": ("dash-sankey-host", "dash-semi-svg", "dash-shield-banner"),
                }[expected_component]
                for marker in role_markers:
                    self.assertIn(marker, html, f"{expected_component} 端缺少专属大屏组件 {marker}")
                self.assertIn("/static/dashboard.css", html)
                self.assertIn("/static/dashboard.js", html)
                self.assertIn("/static/theme-init.js", html)
                self.assertIn("总览大屏", html)
                self.assertEqual(r.getheader("X-Frame-Options"), "DENY")

                # 2. 静态资产 ETag/304 与零外链
                for asset in ("/static/dashboard.css", "/static/dashboard.js"):
                    conn.request("GET", asset)
                    ra = conn.getresponse()
                    body = ra.read().decode("utf-8")
                    self.assertEqual(ra.status, 200, asset)
                    self.assertNotIn("https://", body)
                    if asset.endswith(".js"):
                        self.assertNotIn('style="', body, "严禁写入内联 style 属性以免触发严格 CSP 拦截")
                    etag = ra.getheader("ETag")
                    self.assertTrue(etag)
                    conn.request("GET", asset, headers={"If-None-Match": etag})
                    r304 = conn.getresponse()
                    r304.read()
                    self.assertEqual(r304.status, 304, asset)

                # 3. 实时聚合接口
                conn.request("GET", "/api/dashboard-overview")
                ro = conn.getresponse()
                data = json.loads(ro.read().decode("utf-8"))
                self.assertEqual(ro.status, 200)
                self.assertEqual(data["component"], expected_component)
                self.assertTrue(data.get("source_db", "").endswith(".db"))
                self.assertTrue(0 <= data["health_score"] <= 100)
                for key in ("kpis", "points_by_kind", "yx_state", "protocols", "channels", "top_yc", "events"):
                    self.assertIn(key, data)
                if data["top_yc"]:
                    self.assertIn("refresh_time", data["top_yc"][0])
                    self.assertIn("unit", data["top_yc"][0])
                # 4. 三端合屏页面与同源聚合接口
                conn.request("GET", "/dashboard-all")
                rall = conn.getresponse()
                html_all = rall.read().decode("utf-8")
                self.assertEqual(rall.status, 200)
                self.assertIn('data-dash-role="all"', html_all)
                self.assertIn("dash-layout-all", html_all)
                self.assertIn("dash-all-bus-host", html_all)
                self.assertIn("dash-all-ring-svg", html_all)

                conn.request("GET", "/api/dashboard-all")
                ra_api = conn.getresponse()
                all_payload = json.loads(ra_api.read().decode("utf-8"))
                self.assertEqual(ra_api.status, 200)
                for key in ("overall_score", "services", "s", "c", "t", "merged_events"):
                    self.assertIn(key, all_payload)
                self.assertTrue(all_payload["services"][expected_component]["online"])
                return data
            finally:
                conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_three_ends_dashboard_routes_and_payloads(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            c_db = root / "scdfe_c.db"
            s_db = root / "scdfe_s.db"
            self._seed_c_and_t(c_db)
            self._seed_s(s_db)

            c_data = self._verify_server(make_c_server("127.0.0.1", 0, db_path=c_db, workspace_root=root), "c")
            self.assertEqual(c_data["kpis"]["channels_total"], 2)
            self.assertEqual(c_data["kpis"]["channels_running"], 1)
            self.assertEqual(c_data["kpis"]["channels_error"], 1)
            self.assertEqual(c_data["kpis"]["points_total"], 5)
            self.assertEqual(c_data["yx_state"]["one"], 1)
            self.assertEqual(c_data["yx_state"]["zero"], 1)
            self.assertEqual(len(c_data["top_yc"]), 1)

            s_data = self._verify_server(make_s_server("127.0.0.1", 0, db_path=s_db, workspace_root=root), "s")
            self.assertEqual(s_data["kpis"]["channels_total"], 1)
            self.assertEqual(s_data["kpis"]["points_total"], 2)

            t_data = self._verify_server(make_t_server("127.0.0.1", 0, db_path=c_db, workspace_root=root), "t")
            self.assertEqual(t_data["kpis"]["channels_total"], 1)
            self.assertEqual(t_data["kpis"]["mapped_points"], 2)
            self.assertEqual(t_data["mapping_by_kind"]["yc"]["mapped"], 1)
            self.assertEqual(t_data["mapping_by_kind"]["yx"]["mapped"], 1)
            self.assertEqual(len(t_data["source_rtus"]), 2)

    def test_c_root_keeps_original_workbench_with_dashboard_first_in_sidebar(self):
        html = (ROOT / "scdfe_c" / "web" / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="/dashboard"', html)
        self.assertLess(html.index('href="/dashboard"'), html.index('data-resource="scdfe"'))

    def test_topbar_sibling_buttons_route_to_each_dashboard(self):
        js = (ROOT / "core" / "web_static" / "workbench.js").read_text(encoding="utf-8")
        self.assertIn('u.pathname = "/dashboard";', js)
        self.assertIn('if (item.active && onOwnDashboard) return;', js)

    def test_dashboards_have_no_synthetic_wave_or_decorative_spin_animations(self):
        js = (ROOT / "core" / "web_static" / "dashboard.js").read_text(encoding="utf-8")
        css = (ROOT / "core" / "web_static" / "dashboard.css").read_text(encoding="utf-8")
        html_s = (ROOT / "core" / "web_static" / "dashboard-s.html").read_text(encoding="utf-8")
        self.assertNotIn("Math.sin", js)
        self.assertNotIn("startScopeLoop", js)
        self.assertNotIn("激励参考波", html_s)
        self.assertNotIn("dashOrbitSpin", css)
        self.assertNotIn("dashHubBreath", css)
        self.assertIn("fes_yc_define", js)


if __name__ == "__main__":
    unittest.main()
