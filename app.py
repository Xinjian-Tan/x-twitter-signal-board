#!/usr/bin/env python3
"""
Local sync server for the X analyst board.

- Serves the static dashboard at http://127.0.0.1:8787
- Accepts a token from the page and keeps it in memory only
- /api/check  -> scripts/check_x_api.py
- /api/sync   -> scripts/sync_x.py
- /api/status -> server/token/source status
- /api/token  -> set/clear token (DELETE)
- /api/posts  -> current history (read-only)

The token is never written to disk, data.js, localStorage, or logs.
Do not expose this server to the public internet.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
HISTORY_FILE = ROOT / "data" / "history.json"
CHECK_SCRIPT = ROOT / "scripts" / "check_x_api.py"
SYNC_SCRIPT = ROOT / "scripts" / "sync_x.py"

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/api.js": ("api.js", "application/javascript; charset=utf-8"),
    "/data.js": ("data.js", "application/javascript; charset=utf-8"),
    "/preview.png": ("preview.png", "image/png"),
}

TOKEN = None
TOKEN_LOCK = threading.Lock()
SYNC_LOCK = threading.Lock()


def read_history_status() -> dict:
    if not HISTORY_FILE.exists():
        return {"source": None, "lastSync": None, "postCount": 0}
    try:
        history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"source": None, "lastSync": None, "postCount": 0}
    posts = history.get("posts") if isinstance(history.get("posts"), list) else []
    return {
        "source": history.get("source"),
        "lastSync": history.get("updatedAt"),
        "postCount": len(posts),
    }


def get_token() -> str:
    with TOKEN_LOCK:
        return TOKEN or ""


def set_token(token: str) -> None:
    global TOKEN
    with TOKEN_LOCK:
        TOKEN = token or None


def clear_token() -> None:
    global TOKEN
    with TOKEN_LOCK:
        TOKEN = None


def run_script(script: Path, token: str, timeout: int = 180) -> tuple[int, str]:
    env = os.environ.copy()
    env["X_BEARER_TOKEN"] = token
    env.pop("MOCK_SYNC", None)
    try:
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 124, "timed out after %ss" % timeout
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    return result.returncode, output


class Handler(BaseHTTPRequestHandler):
    server_version = "Signal8Local/1.0"

    def log_message(self, fmt, *args):
        # Never log headers/body; only method + path.
        sys.stderr.write("[server] %s %s\n" % (self.command, self.path))

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, path: str) -> None:
        entry = STATIC_FILES.get(path)
        if not entry:
            self._send_json({"error": "not found"}, 404)
            return
        filename, content_type = entry
        file_path = ROOT / filename
        if not file_path.is_file():
            self._send_json({"error": "file missing"}, 404)
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True  # curl / same-origin requests without Origin
        port = self.server.server_address[1]
        allowed = {
            "http://127.0.0.1:%d" % port,
            "http://localhost:%d" % port,
            "http://[::1]:%d" % port,
        }
        return origin in allowed

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._send_json({"error": "invalid content length"}, 400)
            return None
        if length > 8192:
            self._send_json({"error": "request body too large"}, 413)
            return None
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"error": "invalid JSON"}, 400)
            return None
        return data if isinstance(data, dict) else None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/status":
            payload = read_history_status()
            payload.update({"server": True, "tokenConfigured": bool(get_token())})
            self._send_json(payload)
            return
        if path == "/api/posts":
            if not HISTORY_FILE.exists():
                self._send_json({"posts": [], "source": None})
                return
            try:
                history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self._send_json({"error": "history unavailable"}, 500)
                return
            self._send_json({
                "source": history.get("source"),
                "updatedAt": history.get("updatedAt"),
                "posts": history.get("posts", []),
            })
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        self._send_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._origin_ok():
            self._send_json({"error": "origin not allowed"}, 403)
            return
        if not (self.headers.get("Content-Type", "") or "").lower().startswith("application/json"):
            self._send_json({"error": "Content-Type must be application/json"}, 415)
            return
        data = self._read_json()
        if data is None:
            return

        if path == "/api/token":
            token = str(data.get("token") or "").strip()
            if not token:
                self._send_json({"error": "token is required"}, 400)
                return
            set_token(token)
            self._send_json({"ok": True, "tokenConfigured": True, "message": "token 已保存到本机服务内存。"})
            return

        if path == "/api/check":
            token = str(data.get("token") or "").strip() or get_token()
            if not token:
                self._send_json({"error": "token is required"}, 400)
                return
            code, output = run_script(CHECK_SCRIPT, token, timeout=30)
            self._send_json({"ok": code == 0, "output": output or "no output"})
            return

        if path == "/api/sync":
            token = get_token()
            if not token:
                self._send_json({"error": "token not configured"}, 400)
                return
            if not SYNC_LOCK.acquire(blocking=False):
                self._send_json({"error": "sync already running"}, 409)
                return
            try:
                code, output = run_script(SYNC_SCRIPT, token, timeout=180)
                if code != 0:
                    self._send_json({"ok": False, "error": "sync failed", "output": output}, 502)
                    return
                payload = read_history_status()
                payload.update({"ok": True, "output": output})
                self._send_json(payload)
            finally:
                SYNC_LOCK.release()
            return

        self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not self._origin_ok():
            self._send_json({"error": "origin not allowed"}, 403)
            return
        if path == "/api/token":
            clear_token()
            self._send_json({"ok": True, "message": "已清除本机内存中的 token。"})
            return
        self._send_json({"error": "not found"}, 404)


def main() -> None:
    parser = argparse.ArgumentParser(description="Local sync server for the X analyst board")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="open the dashboard in the default browser")
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("[server] WARNING: binding to a non-local address exposes the token endpoint.", file=sys.stderr)

    url = "http://127.0.0.1:%d/" % args.port
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print("[server] cannot bind %s:%s (%s)" % (args.host, args.port, exc), file=sys.stderr)
        sys.exit(1)

    print("[server] serving %s" % ROOT)
    print("[server] dashboard: %s" % url)
    print("[server] token is kept in memory only; Ctrl+C to stop.")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
