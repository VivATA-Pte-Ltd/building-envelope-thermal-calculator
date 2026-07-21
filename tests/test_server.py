from contextlib import redirect_stderr
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("server_app", ROOT / "server" / "app.py")
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.update_calls = 0
        def fake_update():
            self.update_calls += 1
            return 0
        self.state = app.AppState(root=ROOT, update_interval=3600, admin_token="test-secret", update_on_startup=False, updater=fake_update)
        self.httpd = app.create_server("127.0.0.1", 0, self.state)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        conn.close()
        return result

    def test_health_reports_validated_manifest(self):
        self.assertEqual(app.create_handler(self.state).server_version, "VivaTEQEnvelopeServer/1.0.3")
        status, headers, body = self.request("GET", "/api/health")
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["standards_status"], "validated")
        self.assertEqual(payload["app_version"], os.environ.get("APP_VERSION", "development"))
        self.assertEqual(payload["git_sha"], os.environ.get("APP_GIT_SHA", "unknown"))
        self.assertEqual(payload["repository"], os.environ.get("APP_REPOSITORY", "https://github.com/VivATA-Pte-Ltd/building-envelope-thermal-calculator"))
        self.assertRegex(payload["source_sha256"], r"^[a-f0-9]{64}$")

    def test_serves_calculator_and_manifest_with_safe_cache_headers(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"BCA Envelope Thermal", body)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-cache")

        status, headers, body = self.request("HEAD", "/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")

        status, headers, body = self.request("GET", "/standards.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "validated")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_serves_shading_and_ifc_engines_for_get_and_head(self):
        resources = {
            "/shading.js": b"calculateStandardSC2",
            "/shading-data.js": b'"schemaVersion":1',
            "/ifc-shading.js": b"analyzeIfcGeometry",
            "/ifc-loader.js": b"loadIfcFile",
        }
        for path, marker in resources.items():
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn(marker, body)
                self.assertEqual(headers["Content-Type"], "text/javascript; charset=utf-8")
                self.assertEqual(headers["Cache-Control"], "no-cache")

                head_status, head_headers, head_body = self.request("HEAD", path)
                self.assertEqual(head_status, 200)
                self.assertEqual(head_headers["Content-Length"], headers["Content-Length"])
                self.assertEqual(head_body, b"")

    def test_serves_local_pinned_web_ifc_runtime(self):
        resources = {
            "/vendor/web-ifc/web-ifc-api.js": (b"IfcAPI", "text/javascript; charset=utf-8"),
            "/vendor/web-ifc/web-ifc.wasm": (b"\x00asm", "application/wasm"),
            "/vendor/sheetjs/xlsx.full.min.js": (b"XLSX", "text/javascript; charset=utf-8"),
            "/vendor/html2pdf/html2pdf.bundle.min.js": (b"html2pdf", "text/javascript; charset=utf-8"),
        }
        for path, (marker, content_type) in resources.items():
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn(marker, body)
                self.assertEqual(headers["Content-Type"], content_type)
                self.assertEqual(headers["Cache-Control"], "public, max-age=31536000, immutable")
                head_status, head_headers, head_body = self.request("HEAD", path)
                self.assertEqual(head_status, 200)
                self.assertEqual(head_headers["Content-Length"], headers["Content-Length"])
                self.assertEqual(head_body, b"")

    def test_api_standards_returns_current_manifest(self):
        status, headers, body = self.request("GET", "/api/standards")
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "validated")
        self.assertEqual(payload["source_sha256"], self.state.health()["source_sha256"])

    def test_manual_update_requires_bearer_token_and_runs_updater(self):
        status, headers, body = self.request("POST", "/api/update")
        self.assertEqual(status, 401)
        self.assertEqual(headers["WWW-Authenticate"], 'Bearer realm="manual-update"')
        self.assertEqual(self.update_calls, 0)

        status, _, body = self.request("POST", "/api/update", headers={"Authorization": "bearer test-secret"})
        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "updated")
        self.assertEqual(self.update_calls, 1)
        self.assertIsNotNone(self.state.health()["last_update_check_utc"])

    def test_head_matches_api_get_resources(self):
        for path in ("/api/health", "/api/standards"):
            get_status, get_headers, get_body = self.request("GET", path)
            head_status, head_headers, head_body = self.request("HEAD", path)
            self.assertEqual(head_status, get_status)
            self.assertEqual(head_headers["Content-Type"], get_headers["Content-Type"])
            self.assertEqual(int(head_headers["Content-Length"]), len(get_body))
            self.assertEqual(head_body, b"")

    def test_updater_exception_is_not_exposed_publicly(self):
        def broken_updater():
            raise RuntimeError(r"C:\\private\\deployment\\secret.txt")
        state = app.AppState(root=ROOT, update_on_startup=False, updater=broken_updater)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            ok, error = state.run_update()
        self.assertFalse(ok)
        self.assertEqual(error, "updater_exception")
        self.assertEqual(state.health()["last_update_error"], "updater_exception")
        self.assertNotIn("private", json.dumps(state.health()).lower())
        self.assertEqual(stderr.getvalue(), "Updater failed with an internal exception.\n")

    def test_real_updater_subprocess_does_not_leak_child_stderr(self):
        state = app.AppState(root=ROOT, update_on_startup=False)
        with tempfile.TemporaryDirectory() as td:
            child_root = Path(td)
            script = child_root / "scripts" / "update_data.py"
            script.parent.mkdir(parents=True)
            script.write_text(
                'raise RuntimeError(r"C:\\\\private\\\\child-updater-secret.txt")\n',
                encoding="utf-8",
            )
            state.root = child_root
            with tempfile.TemporaryFile(mode="w+b") as captured:
                original_stderr = os.dup(2)
                os.dup2(captured.fileno(), 2)
                try:
                    code = state._run_updater_process()
                finally:
                    os.dup2(original_stderr, 2)
                    os.close(original_stderr)
                captured.seek(0)
                stderr = captured.read().decode(errors="replace")
        self.assertNotEqual(code, 0)
        self.assertEqual(stderr.splitlines(), ["Updater subprocess failed."])
        self.assertNotIn("child-updater-secret", stderr)

    def test_invalid_persistent_manifest_falls_back_to_verified_seed(self):
        with tempfile.TemporaryDirectory() as td:
            runtime_manifest = Path(td) / "standards.json"
            runtime_manifest.write_text('{"status":"validated"}', encoding="utf-8")
            state = app.AppState(root=ROOT, manifest_path=runtime_manifest, update_on_startup=False)
            self.assertEqual(state.health()["status"], "ok")
            self.assertRegex(state.health()["source_sha256"], r"^[a-f0-9]{64}$")

    def test_signal_handlers_request_graceful_shutdown(self):
        stop = threading.Event()
        shutdown_called = threading.Event()
        server = Mock()
        server.shutdown.side_effect = shutdown_called.set
        registered = {}
        with patch.object(app.signal, "signal", side_effect=lambda sig, fn: registered.__setitem__(sig, fn)):
            app.install_signal_handlers(server, stop)
        registered[app.signal.SIGTERM](app.signal.SIGTERM, None)
        self.assertTrue(stop.is_set())
        self.assertTrue(shutdown_called.wait(2))

    def test_concurrent_update_is_rejected(self):
        entered = threading.Event()
        release = threading.Event()
        def slow_updater():
            entered.set()
            release.wait(2)
            return 0
        state = app.AppState(root=ROOT, update_on_startup=False, updater=slow_updater)
        first = threading.Thread(target=state.run_update)
        first.start()
        self.assertTrue(entered.wait(1))
        self.assertEqual(state.run_update(), (False, "update_already_running"))
        release.set()
        first.join(timeout=2)
        self.assertFalse(first.is_alive())

    def test_failed_updater_preserves_validated_manifest(self):
        state = app.AppState(root=ROOT, update_on_startup=False, updater=lambda: 9)
        before = state.health()["source_sha256"]
        self.assertEqual(state.run_update(), (False, "updater_exit_9"))
        self.assertEqual(state.health()["source_sha256"], before)
        self.assertEqual(state.health()["status"], "ok")

    def test_background_scheduler_checks_on_startup_and_stops(self):
        called = threading.Event()
        def updater():
            called.set()
            return 0
        state = app.AppState(root=ROOT, update_interval=300, update_on_startup=True, updater=updater)
        stop = threading.Event()
        thread = state.start_scheduler(stop)
        self.assertTrue(called.wait(2), "startup update did not run")
        stop.set()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())

    def test_server_configuration_reads_environment(self):
        with patch.dict("os.environ", {
            "HOST": "0.0.0.0",
            "PORT": "9090",
            "UPDATE_INTERVAL_SECONDS": "7200",
            "UPDATE_ON_STARTUP": "false",
            "ADMIN_UPDATE_TOKEN": "secret",
        }, clear=True):
            config = app.config_from_env(ROOT)
        self.assertEqual(config["host"], "0.0.0.0")
        self.assertEqual(config["port"], 9090)
        self.assertEqual(config["update_interval"], 7200)
        self.assertFalse(config["update_on_startup"])
        self.assertEqual(config["admin_token"], "secret")

    def test_runtime_manifest_is_seeded_for_persistent_volume(self):
        with tempfile.TemporaryDirectory() as td:
            runtime_manifest = Path(td) / "runtime" / "standards.json"
            state = app.AppState(
                root=ROOT,
                manifest_path=runtime_manifest,
                update_on_startup=False,
                updater=lambda: 0,
            )
            self.assertTrue(runtime_manifest.exists())
            self.assertEqual(state.health()["source_sha256"], self.state.health()["source_sha256"])


if __name__ == "__main__":
    unittest.main()
