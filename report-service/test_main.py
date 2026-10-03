"""
Tests for main.py (the bug-report relay). stdlib unittest, no network: the GitHub call is replaced by a fake
urlopen that records what would have been sent. Run:  python -m unittest report-service/test_main.py -v
(from the repo root; or  cd report-service && python -m unittest test_main -v)
"""

import http.client
import json
import os
import socket
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sent = []  # what would have gone to GitHub

        def fake_urlopen(req, timeout=None):
            cls.sent.append(json.loads(req.data.decode("utf-8")))
            return FakeResponse({"number": len(cls.sent), "html_url": f"https://github.com/x/y/issues/{len(cls.sent)}"})

        cls.patches = [
            mock.patch.object(main.urllib.request, "urlopen", fake_urlopen),
            mock.patch.object(main, "GITHUB_TOKEN", "test-token"),
        ]
        for p in cls.patches:
            p.start()
        server_cls = getattr(main, "LimitedServer", main.ThreadingHTTPServer)
        kwargs = {"max_connections": 50} if hasattr(main, "LimitedServer") else {}
        cls.server = server_cls(("127.0.0.1", 0), main.Handler, **kwargs)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        for p in cls.patches:
            p.stop()

    def setUp(self):
        self.sent.clear()
        if hasattr(main, "_reset_limits"):
            main._reset_limits()
        else:
            main._request_times.clear()

    def post(self, body, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Content-Type": "application/json", "X-Client": main.EXPECTED_CLIENT_HEADER}
        h.update(headers or {})
        data = body if raw else json.dumps(body)
        try:
            conn.request("POST", "/report", body=data, headers=h)
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
        finally:
            conn.close()

    # ---- D3 ----
    def test_json_that_is_not_an_object_is_a_400_not_a_crash(self):
        for body in ("[]", "3", "null", '"text"', "[1, 2]"):
            status, payload = self.post(body, raw=True)
            self.assertEqual(status, 400, f"{body}: {payload}")
            self.assertFalse(payload["ok"])

    # ---- D2 ----
    def test_a_log_cannot_break_out_of_the_code_fence(self):
        evil = "line\n```\n@everyone\n# injected heading\n````\nmore"
        status, _ = self.post({"log": evil, "version": "0.6.25", "lang": "th"})
        self.assertEqual(status, 200)
        body = self.sent[-1]["body"]
        fence = None
        for line in body.splitlines():
            if set(line) == {"`"} and len(line) >= 3 and (fence is None or line == fence):
                fence = fence or line
        self.assertIsNotNone(fence)
        self.assertGreater(len(fence), 4, "longer than the longest backtick run (4) in the log")
        self.assertEqual(body.count("\n" + fence + "\n"), 2, "the fence opens and closes exactly once")
        self.assertIn(evil, body)

    def test_version_and_lang_are_plain_short_tokens(self):
        status, _ = self.post({"log": "x", "version": "1.0\n# pwned @someone", "lang": {"a": 1}})
        self.assertEqual(status, 200)
        sent = self.sent[-1]
        self.assertIn("- version: ?", sent["body"])
        self.assertIn("- UI language: ?", sent["body"])
        self.assertNotIn("pwned", sent["title"] + sent["body"])
        self.assertEqual(self.post({"log": "x", "version": "9" * 200, "lang": "th"})[0], 200)
        self.assertIn("- version: ?", self.sent[-1]["body"])
        self.assertEqual(self.post({"log": "x", "version": "0.6.25", "lang": "zh-TW"})[0], 200)
        self.assertIn("v0.6.25", self.sent[-1]["title"])
        self.assertIn("- UI language: zh-TW", self.sent[-1]["body"])

    # ---- D1 ----
    def test_invalid_requests_do_not_use_up_the_report_quota(self):
        for _ in range(30):
            self.post({"nope": 1})  # no log: invalid, must not count
            self.post("[]", raw=True)
        statuses = [self.post({"log": f"report {i}"})[0] for i in range(10)]
        self.assertEqual(statuses, [200] * 10, "thirty invalid requests did not eat the 10 valid ones")

    def test_the_limit_is_per_client_and_a_multi_part_report_counts_once(self):
        # five parts of ONE report = one report
        for i in range(1, 6):
            self.assertEqual(self.post({"log": f"=== bug report abc123 - part {i}/5 ===\nlines {i}"})[0], 200)
        # nine more single reports: ten reports in all - still allowed
        for i in range(9):
            self.assertEqual(self.post({"log": f"single {i}"})[0], 200, i)
        # the eleventh report from this client is refused ...
        self.assertEqual(self.post({"log": "one too many"})[0], 429)
        # ... but another client (seen through the trusted proxy's X-Forwarded-For) is not affected
        self.assertEqual(self.post({"log": "someone else"}, headers={"X-Forwarded-For": "203.0.113.9"})[0], 200)

    # ---- D4 ----
    def test_a_stalled_body_is_dropped_by_a_timeout(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=14)  # the server must give up before this
        s.sendall(b"POST /report HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Client: twitch-drop-claimer\r\nContent-Length: 500\r\n\r\n{\"log\": \"half")
        start = time.monotonic()
        try:
            data = s.recv(1024)  # the server gives up and closes: b"" (or an error), not a hang
        except (ConnectionResetError, socket.timeout) as e:
            data = e
        elapsed = time.monotonic() - start
        s.close()
        self.assertNotIsInstance(data, socket.timeout, "the connection was still open after 14 s: no server-side timeout")
        self.assertLess(elapsed, 13)


@unittest.skipUnless(hasattr(main, "LimitedServer"), "no connection cap in this version")
class ConnectionCapTest(unittest.TestCase):
    def test_connections_are_capped(self):
        with mock.patch.object(main.Handler, "timeout", 1.5):
            server = main.LimitedServer(("127.0.0.1", 0), main.Handler, max_connections=3)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            port = server.server_address[1]
            stalled = []
            try:
                for _ in range(3):  # the cap of this server is 3 at once
                    c = socket.create_connection(("127.0.0.1", port), timeout=3)
                    c.sendall(b"POST /report HTTP/1.1" + bytes([13, 10]) + b"Host: x" + bytes([13, 10]))  # never finishes
                    stalled.append(c)
                time.sleep(0.3)
                extra = socket.create_connection(("127.0.0.1", port), timeout=3)
                data = extra.recv(100)
                extra.close()
                self.assertTrue(data.startswith(b"HTTP/1.1 503"), data)
            finally:
                for c in stalled:
                    c.close()
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
