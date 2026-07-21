#!/usr/bin/env python3
"""VivaTEQ server edition for the BCA envelope thermal calculator."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import datetime as dt
import hmac
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from typing import Callable


class AppState:
    def __init__(self, root: Path, update_interval: int = 21600, admin_token: str = "", update_on_startup: bool = True, updater: Callable[[], int] | None = None, manifest_path: Path | None = None):
        self.root = Path(root).resolve()
        self.manifest_path = Path(manifest_path).resolve() if manifest_path else self.root / "standards.json"
        self._manifest_validator = self._load_manifest_validator()
        if not self.manifest_path.exists():
            self._install_verified_seed()
        try:
            self._manifest = self._read_manifest()
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self._install_verified_seed()
            self._manifest = self._read_manifest()
        self.update_interval = max(300, int(update_interval))
        self.admin_token = admin_token
        self.update_on_startup = update_on_startup
        self.app_version = os.environ.get("APP_VERSION", "development")
        self.git_sha = os.environ.get("APP_GIT_SHA", "unknown")
        self.repository = os.environ.get("APP_REPOSITORY", "https://github.com/VivATA-Pte-Ltd/building-envelope-thermal-calculator")
        self._lock = threading.Lock()
        self.last_update_check_utc: str | None = None
        self.last_update_error: str | None = None
        self.updater_running = False
        self._updater = updater or self._run_updater_process

    def _load_manifest_validator(self):
        spec = importlib.util.spec_from_file_location(
            "vivateq_update_validation", self.root / "scripts" / "update_data.py"
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("manifest_validator_unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.validate_manifest

    def _install_verified_seed(self) -> None:
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=self.manifest_path.parent, prefix=f".{self.manifest_path.name}.",
            suffix=".seed.tmp", delete=False,
        ) as handle:
            seed_tmp = Path(handle.name)
        try:
            shutil.copyfile(self.root / "standards.json", seed_tmp)
            seed_tmp.replace(self.manifest_path)
        finally:
            seed_tmp.unlink(missing_ok=True)

    def _read_manifest(self) -> dict:
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self._manifest_validator(manifest)
        return manifest

    def health(self) -> dict:
        return {
            "status": "ok" if self._manifest.get("status") == "validated" else "degraded",
            "app_version": self.app_version,
            "git_sha": self.git_sha,
            "repository": self.repository,
            "standards_status": self._manifest.get("status"),
            "source_sha256": self._manifest.get("source_sha256"),
            "last_update_check_utc": self.last_update_check_utc,
            "last_update_error": self.last_update_error,
            "updater_running": self.updater_running,
            "update_interval_seconds": self.update_interval,
        }

    def _run_updater_process(self) -> int:
        completed = subprocess.run(
            [sys.executable, str(self.root / "scripts" / "update_data.py")],
            cwd=self.root,
            env={**os.environ, "STANDARDS_PATH": str(self.manifest_path)},
            timeout=300,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if completed.returncode != 0:
            print("Updater subprocess failed.", file=sys.stderr, flush=True)
        return completed.returncode

    def run_update(self) -> tuple[bool, str | None]:
        if not self._lock.acquire(blocking=False):
            return False, "update_already_running"
        self.updater_running = True
        try:
            code = self._updater()
            self.last_update_check_utc = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
            if code != 0:
                self.last_update_error = f"updater_exit_{code}"
                return False, self.last_update_error
            self._manifest = self._read_manifest()
            self.last_update_error = None
            return True, None
        except Exception:
            self.last_update_check_utc = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
            print("Updater failed with an internal exception.", file=sys.stderr, flush=True)
            self.last_update_error = "updater_exception"
            return False, self.last_update_error
        finally:
            self.updater_running = False
            self._lock.release()

    def start_scheduler(self, stop_event: threading.Event) -> threading.Thread:
        def loop() -> None:
            if self.update_on_startup and not stop_event.is_set():
                self.run_update()
            while not stop_event.wait(self.update_interval):
                self.run_update()
        thread = threading.Thread(target=loop, name="bca-standards-updater", daemon=True)
        thread.start()
        return thread


def create_handler(state: AppState):
    class Handler(BaseHTTPRequestHandler):
        server_version = "VivaTEQEnvelopeServer/1.0.3"

        def log_message(self, format: str, *args) -> None:
            return

        def send_json(self, payload: dict, status: int = 200, *, head_only: bool = False, extra_headers: dict[str, str] | None = None) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def send_file(self, path: Path, content_type: str, cache_control: str, head_only: bool = False) -> None:
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache_control)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/api/health":
                self.send_json(state.health())
                return
            if path == "/api/standards":
                self.send_json(state._manifest)
                return
            if path in ("/", "/index.html"):
                self.send_file(state.root / "index.html", "text/html; charset=utf-8", "no-cache")
                return
            if path in ("/shading.js", "/shading-data.js", "/ifc-shading.js", "/ifc-loader.js", "/drawing-import.js", "/drawing-dxf-worker.js", "/vendor/web-ifc/web-ifc-api.js", "/vendor/sheetjs/xlsx.full.min.js", "/vendor/html2pdf/html2pdf.bundle.min.js", "/vendor/dxf-parser/dxf-parser.js", "/vendor/pdfjs/pdf.min.mjs", "/vendor/pdfjs/pdf.worker.min.mjs"):
                self.send_file(state.root / path.lstrip("/"), "text/javascript; charset=utf-8", "public, max-age=31536000, immutable" if path.startswith("/vendor/") else "no-cache")
                return
            if path == "/vendor/web-ifc/web-ifc.wasm":
                self.send_file(state.root / "vendor" / "web-ifc" / "web-ifc.wasm", "application/wasm", "public, max-age=31536000, immutable")
                return
            if path == "/standards.json":
                self.send_json(state._manifest)
                return
            self.send_json({"error": "not_found"}, 404)

        def do_POST(self) -> None:
            path = self.path.split("?", 1)[0]
            if path != "/api/update":
                self.send_json({"error": "not_found"}, 404)
                return
            if not state.admin_token:
                self.send_json({"error": "manual_update_disabled"}, 503)
                return
            supplied = self.headers.get("Authorization", "")
            scheme, separator, token = supplied.partition(" ")
            authorized = separator == " " and scheme.lower() == "bearer" and hmac.compare_digest(token, state.admin_token)
            if not authorized:
                self.send_json(
                    {"error": "unauthorized"}, 401,
                    extra_headers={"WWW-Authenticate": 'Bearer realm="manual-update"'},
                )
                return
            ok, error = state.run_update()
            if ok:
                self.send_json({"status": "updated", "health": state.health()})
            elif error == "update_already_running":
                self.send_json({"error": error}, 409)
            else:
                self.send_json({"error": "update_failed", "detail": error, "health": state.health()}, 500)

        def do_HEAD(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/api/health":
                self.send_json(state.health(), head_only=True)
                return
            if path == "/api/standards":
                self.send_json(state._manifest, head_only=True)
                return
            if path in ("/", "/index.html"):
                self.send_file(state.root / "index.html", "text/html; charset=utf-8", "no-cache", head_only=True)
                return
            if path in ("/shading.js", "/shading-data.js", "/ifc-shading.js", "/ifc-loader.js", "/drawing-import.js", "/drawing-dxf-worker.js", "/vendor/web-ifc/web-ifc-api.js", "/vendor/sheetjs/xlsx.full.min.js", "/vendor/html2pdf/html2pdf.bundle.min.js", "/vendor/dxf-parser/dxf-parser.js", "/vendor/pdfjs/pdf.min.mjs", "/vendor/pdfjs/pdf.worker.min.mjs"):
                self.send_file(state.root / path.lstrip("/"), "text/javascript; charset=utf-8", "public, max-age=31536000, immutable" if path.startswith("/vendor/") else "no-cache", head_only=True)
                return
            if path == "/vendor/web-ifc/web-ifc.wasm":
                self.send_file(state.root / "vendor" / "web-ifc" / "web-ifc.wasm", "application/wasm", "public, max-age=31536000, immutable", head_only=True)
                return
            if path == "/standards.json":
                self.send_json(state._manifest, head_only=True)
                return
            self.send_response(404)
            self.end_headers()

    return Handler


def create_server(host: str, port: int, state: AppState) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), create_handler(state))


def config_from_env(root: Path) -> dict:
    startup = os.environ.get("UPDATE_ON_STARTUP", "true").strip().lower()
    return {
        "root": Path(root).resolve(),
        "host": os.environ.get("HOST", "0.0.0.0"),
        "port": int(os.environ.get("PORT", "8080")),
        "update_interval": int(os.environ.get("UPDATE_INTERVAL_SECONDS", "21600")),
        "update_on_startup": startup not in {"0", "false", "no", "off"},
        "admin_token": os.environ.get("ADMIN_UPDATE_TOKEN", ""),
        "manifest_path": Path(os.environ.get("STANDARDS_PATH", str(Path(root) / "standards.json"))),
    }


def install_signal_handlers(server: ThreadingHTTPServer, stop_event: threading.Event) -> None:
    """Translate termination signals into graceful server and scheduler shutdown."""
    def request_shutdown(signum, frame) -> None:
        del signum, frame
        stop_event.set()
        threading.Thread(target=server.shutdown, name="http-shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)


def main() -> int:
    config = config_from_env(Path(__file__).resolve().parents[1])
    state = AppState(
        root=config["root"],
        update_interval=config["update_interval"],
        admin_token=config["admin_token"],
        update_on_startup=config["update_on_startup"],
        manifest_path=config["manifest_path"],
    )
    stop = threading.Event()
    scheduler = state.start_scheduler(stop)
    server = create_server(config["host"], config["port"], state)
    install_signal_handlers(server, stop)
    print(f"VivaTEQ envelope server listening on http://{config['host']}:{config['port']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        scheduler.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
