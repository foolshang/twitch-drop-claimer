"""
report-service - tiny HTTP endpoint that turns a POST'd debug log into a
GitHub issue on foolshang/twitch-drop-claimer.

Exists so the Twitch Drop Auto-Claimer Firefox extension's "send bug report"
button can create a GitHub issue in one click, without ever shipping a
GitHub token inside the extension's own (fully public/inspectable) source.
The token lives only in this process's environment, on this VM.

stdlib only - no pip install needed, matches poe-bot.service's simplicity
(see report-service.service for how this is run).

Not part of the extension - excluded from AMO submissions by
scripts/submit-amo.js's EXTENSION_FILES whitelist. Deployed on the same GCE
VM (poe-bot-vm, project poe-discord-bot-501417) as the poe-discord-bot,
behind Caddy (TLS termination, see report-service.service), reached by the
extension at the https://35-188-24-245.sslip.io name baked into REPORT_BUG_URL
in background.js. Plain http on :8090 is still open for extension versions
before 0.6.15, which used it (and which Firefox's HTTPS-Only Mode blocks).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

PORT = int(os.environ.get("PORT", "8090"))
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "foolshang/twitch-drop-claimer")
EXPECTED_CLIENT_HEADER = "twitch-drop-claimer"  # not a secret - just filters blind scanners

MAX_BODY_BYTES = 60_000  # a 1000-line debug log is nowhere near this
MAX_LOG_CHARS = 60_000

# rolling-hour global rate limit - blunts abuse of the endpoint without
# needing a database; resets on process restart, which is fine at this scale
RATE_LIMIT_MAX = 20
RATE_LIMIT_WINDOW_S = 3600
_request_times = []
_rate_lock = Lock()


def _rate_limited():
    now = time.time()
    with _rate_lock:
        while _request_times and _request_times[0] < now - RATE_LIMIT_WINDOW_S:
            _request_times.pop(0)
        if len(_request_times) >= RATE_LIMIT_MAX:
            return True
        _request_times.append(now)
        return False


def _create_github_issue(log_text, extra):
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN not set on the server")

    version = (extra or {}).get("version", "?")
    lang = (extra or {}).get("lang", "?")
    ts = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())

    title = f"[auto-report] debug log from v{version} ({ts})"
    body = (
        f"Auto-submitted from the extension's \"send bug report\" button.\n\n"
        f"- version: {version}\n"
        f"- UI language: {lang}\n"
        f"- submitted at: {ts}\n\n"
        f"```\n{log_text}\n```\n"
    )

    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/issues",
        data=json.dumps({"title": title, "body": body, "labels": ["auto-report"]}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "twitch-drop-claimer-report-service",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("number"), data.get("html_url")


class Handler(BaseHTTPRequestHandler):
    server_version = "report-service/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Client")
        self.end_headers()

    def do_GET(self):
        # plain health check - no log/issue side effects
        self._send_json(200, {"ok": True, "service": "report-service"})

    def do_POST(self):
        if self.path != "/report":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        if self.headers.get("X-Client") != EXPECTED_CLIENT_HEADER:
            self._send_json(400, {"ok": False, "error": "missing/invalid client header"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "error": "body too large or empty"})
            return

        if _rate_limited():
            self._send_json(429, {"ok": False, "error": "rate limited, try again later"})
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "invalid JSON"})
            return

        log_text = payload.get("log")
        if not isinstance(log_text, str) or not log_text.strip():
            self._send_json(400, {"ok": False, "error": "'log' must be a non-empty string"})
            return
        log_text = log_text[:MAX_LOG_CHARS]

        try:
            number, html_url = _create_github_issue(log_text, payload)
        except urllib.error.HTTPError as e:
            self.log_message("github issue creation failed: %s %s", e.code, e.read()[:300])
            self._send_json(502, {"ok": False, "error": "GitHub rejected the request"})
            return
        except Exception as e:  # noqa: BLE001 - report to the client, keep serving
            self.log_message("github issue creation failed: %r", e)
            self._send_json(502, {"ok": False, "error": "could not create the issue"})
            return

        self.log_message("created issue #%s (%s) from %s", number, html_url, self.address_string())
        self._send_json(200, {"ok": True, "issue": number, "url": html_url})


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"report-service listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
