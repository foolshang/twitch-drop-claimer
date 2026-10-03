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

Hardening (0.6.25 review): per-client rate limits that count only VALID reports
(and a multi-part report once), strict type/length checks of what is copied into
the issue, a code fence no log can break out of, socket timeouts and a cap on
concurrent connections.
"""

import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore, Lock

PORT = int(os.environ.get("PORT", "8090"))
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "foolshang/twitch-drop-claimer")
EXPECTED_CLIENT_HEADER = "twitch-drop-claimer"  # not a secret - just filters blind scanners

MAX_BODY_BYTES = 60_000  # a 1000-line debug log is nowhere near this
MAX_LOG_CHARS = 60_000

# ---- rate limits (rolling hour, in memory; reset on restart, fine at this scale) ----------
# The X-Client header is public (it is in the extension's source), so it is no protection by itself.
RATE_WINDOW_S = 3600
PER_IP_MAX = 10          # reports per client per hour (a multi-part report counts once)
GLOBAL_MAX = 60          # reports per hour overall - a backstop above the per-client limit
INVALID_PER_IP_MAX = 120 # malformed requests per client per hour (they cost nothing on GitHub, but not nothing)
MAX_PARTS_PER_REPORT = 20
# peers whose X-Forwarded-For is believed (Caddy on the same VM); anything else is its own client address
TRUSTED_PROXIES = {"127.0.0.1", "::1"}

_rate_lock = Lock()
_valid_times = defaultdict(list)   # ip -> times of counted reports
_all_valid_times = []              # times of counted reports, any client
_invalid_times = defaultdict(list) # ip -> times of rejected requests
_seen_reports = {}                 # (ip, report id) -> parts accepted so far
_seen_reports_at = {}              # (ip, report id) -> first time (for pruning)

REPORT_HEADER = re.compile(r"^=== bug report (\S{1,40}) - part (\d{1,3})/(\d{1,3}) ===")


def _prune(times, now):
    while times and times[0] < now - RATE_WINDOW_S:
        times.pop(0)


def _note_invalid(ip, now=None):
    """Count a malformed request; True when this client has sent too many of them."""
    now = time.time() if now is None else now
    with _rate_lock:
        times = _invalid_times[ip]
        _prune(times, now)
        times.append(now)
        return len(times) > INVALID_PER_IP_MAX


def _rate_limited(ip, report_id=None, now=None):
    """Called only for a VALID report. A part of a multi-part report whose report id this client already
    started counts as part of the same report (up to MAX_PARTS_PER_REPORT parts). True = refuse."""
    now = time.time() if now is None else now
    with _rate_lock:
        for key in [k for k, t in _seen_reports_at.items() if t < now - RATE_WINDOW_S]:
            _seen_reports.pop(key, None)
            _seen_reports_at.pop(key, None)
        key = (ip, report_id)
        if report_id is not None and key in _seen_reports:
            if _seen_reports[key] >= MAX_PARTS_PER_REPORT:
                return True
            _seen_reports[key] += 1
            return False
        _prune(_valid_times[ip], now)
        _prune(_all_valid_times, now)
        if len(_valid_times[ip]) >= PER_IP_MAX or len(_all_valid_times) >= GLOBAL_MAX:
            return True
        _valid_times[ip].append(now)
        _all_valid_times.append(now)
        if report_id is not None:
            _seen_reports[key] = 1
            _seen_reports_at[key] = now
        return False


def _reset_limits():
    with _rate_lock:
        _valid_times.clear()
        _all_valid_times.clear()
        _invalid_times.clear()
        _seen_reports.clear()
        _seen_reports_at.clear()


# ---- what goes into the issue -----------------------------------------------------------------
VERSION_RE = re.compile(r"^[A-Za-z0-9._+-]{1,32}$")
LANG_RE = re.compile(r"^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})?$")


def _clean(value, pattern):
    """Only a short plain token is copied into the issue's title/body outside the code fence."""
    return value if isinstance(value, str) and pattern.match(value) else "?"


def _fence_for(text):
    """A code fence longer than any run of backticks in the text - nothing in it can close the fence."""
    longest = max((len(m.group(0)) for m in re.finditer(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def _issue_payload(log_text, extra, now=None):
    extra = extra if isinstance(extra, dict) else {}
    version = _clean(extra.get("version"), VERSION_RE)
    lang = _clean(extra.get("lang"), LANG_RE)
    ts = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now))
    fence = _fence_for(log_text)
    title = f"[auto-report] debug log from v{version} ({ts})"
    body = (
        f"Auto-submitted from the extension's \"send bug report\" button.\n\n"
        f"- version: {version}\n"
        f"- UI language: {lang}\n"
        f"- submitted at: {ts}\n\n"
        f"{fence}\n{log_text}\n{fence}\n"
    )
    return {"title": title, "body": body, "labels": ["auto-report"]}


def _create_github_issue(log_text, extra):
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN not set on the server")

    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/issues",
        data=json.dumps(_issue_payload(log_text, extra)).encode("utf-8"),
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


# ---- the server ----------------------------------------------------------------------------------
SOCKET_TIMEOUT_S = 10   # no single read/write may stall longer than this
BODY_DEADLINE_S = 15    # the whole body must arrive within this (a trickle of bytes does not reset it)
MAX_CONNECTIONS = 32    # concurrent connections being served


def _client_ip(handler):
    peer = handler.client_address[0]
    if peer in TRUSTED_PROXIES:
        forwarded = (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            pass
    return peer


class Handler(BaseHTTPRequestHandler):
    server_version = "report-service/1.1"
    timeout = SOCKET_TIMEOUT_S  # socket timeout for every read of the request

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

    def _read_body(self, length):
        """The body, or None when it does not arrive in full within BODY_DEADLINE_S."""
        deadline = time.monotonic() + BODY_DEADLINE_S
        chunks = []
        remaining = length
        while remaining > 0:
            if time.monotonic() > deadline:
                return None
            try:
                chunk = self.rfile.read1(min(remaining, 8192)) if hasattr(self.rfile, "read1") else self.rfile.read(min(remaining, 8192))
            except OSError:  # includes socket.timeout
                return None
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Client")
        self.end_headers()

    def do_GET(self):
        # plain health check - no log/issue side effects
        self._send_json(200, {"ok": True, "service": "report-service"})

    def _reject(self, ip, status, error):
        if _note_invalid(ip):
            self._send_json(429, {"ok": False, "error": "rate limited, try again later"})
        else:
            self._send_json(status, {"ok": False, "error": error})

    def do_POST(self):
        ip = _client_ip(self)
        if self.path != "/report":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        if self.headers.get("X-Client") != EXPECTED_CLIENT_HEADER:
            self._reject(ip, 400, "missing/invalid client header")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._reject(ip, 413, "body too large or empty")
            return

        raw = self._read_body(length)
        if raw is None:
            self.close_connection = True
            return  # a stalled or truncated body: drop the connection, nothing to answer
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._reject(ip, 400, "invalid JSON")
            return

        # valid JSON that is not an object ("[]", "3", "null") has no .get - it used to crash the handler
        if not isinstance(payload, dict):
            self._reject(ip, 400, "the body must be a JSON object")
            return

        log_text = payload.get("log")
        if not isinstance(log_text, str) or not log_text.strip():
            self._reject(ip, 400, "'log' must be a non-empty string")
            return
        log_text = log_text[:MAX_LOG_CHARS]

        # only a valid report counts toward the limits; the parts of one multi-part report count once
        header = REPORT_HEADER.match(log_text)
        report_id = header.group(1) if header else None
        if report_id is not None and int(header.group(3)) > MAX_PARTS_PER_REPORT:
            self._reject(ip, 400, "too many parts")
            return
        if _rate_limited(ip, report_id):
            self._send_json(429, {"ok": False, "error": "rate limited, try again later"})
            return

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

        self.log_message("created issue #%s (%s) from %s", number, html_url, ip)
        self._send_json(200, {"ok": True, "issue": number, "url": html_url})


class LimitedServer(ThreadingHTTPServer):
    """One thread per connection, but never more than MAX_CONNECTIONS at once: a flood of slow
    connections gets an immediate 503 instead of piling up threads."""
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, *args, max_connections=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._slots = BoundedSemaphore(max_connections or MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def main():
    server = LimitedServer(("0.0.0.0", PORT), Handler)
    print(f"report-service listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
