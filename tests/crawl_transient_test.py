"""scripts/weekly-crawl/crawl_probe.py 0.55.0 skip-reason tuning: 429 / WAF-challenge 403 / DNS error -> recheck with a
reason_code, exactly one DNS retry, a plain 403 unchanged, and the ~24 h fallback to skip across crawl runs.

Run: python3 tests/crawl_transient_test.py   (stdlib + requests; no network: DNS and HTTP are stubbed; synthetic data)
"""
import io
import os
import sys
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts", "weekly-crawl"))
os.environ["DNS_RETRY_DELAY_S"] = "0"
import crawl_probe as cp  # noqa: E402
from requests.structures import CaseInsensitiveDict  # noqa: E402

cp.DNS_RETRY_DELAY_S = 0.0
URL = "https://api.crawlfixture.dev/v1/data"


class FakeResp:
    def __init__(self, status, headers=None, body=b""):
        self.status_code, self.headers = status, CaseInsensitiveDict(headers or {})
        self.raw, self.content, self._content = io.BytesIO(body), body, body
        self.raw.read = (lambda f: (lambda n, decode_content=True: f(n)))(self.raw.read)

    def close(self):
        pass


def cand(url=URL):
    n = cp.norm_url(url)
    return dict(url=url, norm=n, also=[], source_list="agent402", listing={}, method="GET", query=None, body=None)


class Base(unittest.TestCase):
    def setUp(self):
        self._doh, self._req = cp._doh, cp.requests.request
        cp._DNS.clear()
        self.dns_calls, self.http_calls = [], []
        self.dns_answers = []  # popped per call; default: a public address
        def fake_doh(h):
            self.dns_calls.append(h)
            return self.dns_answers.pop(0) if self.dns_answers else {"93.184.216.34"}
        cp._doh = fake_doh
        self.resp = FakeResp(200)
        def fake_request(method, url, **kw):
            self.http_calls.append(url)
            return self.resp
        cp.requests.request = fake_request

    def tearDown(self):
        cp._doh, cp.requests.request = self._doh, self._req
        cp._DNS.clear()


class Classify(Base):
    def test_429_is_recheck_rate_limited(self):
        self.resp = FakeResp(429, {"retry-after": "60"}, b"slow down")
        r = cp.probe(cand())
        self.assertEqual((r["verdict"], r.get("reason_code")), ("recheck", "rate_limited"))
        self.assertIn("HTTP 429", r["reason"])

    def test_plain_403_unchanged(self):
        for headers, body in (({"server": "cloudflare", "content-type": "application/json"}, b'{"error":"forbidden"}'),
                              ({"server": "nginx"}, b"<html><title>403 Forbidden</title></html>"),
                              ({"server": "AkamaiGHost"}, b"Forbidden"),
                              ({}, b"Just a moment...")):  # challenge text without a Cloudflare server header
            cp._DNS.clear()
            self.resp = FakeResp(403, headers, body)
            r = cp.probe(cand())
            self.assertEqual(r["verdict"], "skip", headers)
            self.assertEqual(r["reason"], "no x402 payment request (HTTP 403)")
            self.assertNotIn("reason_code", r)

    def test_waf_403_is_recheck(self):
        cases = [({"cf-mitigated": "challenge", "server": "cloudflare"}, b"", "cloudflare"),
                 ({"x-amzn-waf-action": "captcha"}, b"", "aws"),
                 ({"server": "cloudflare"}, b"<html><head><title>Just a moment...</title></head><script src='/cdn-cgi/challenge-platform/x'></script>", "cloudflare"),
                 ({"server": "cloudflare"}, b"<h1>Sorry, you have been blocked</h1> ... Cloudflare Ray ID: 8abc", "cloudflare"),
                 ({"server": "AkamaiGHost"}, b"<HTML><H1>Access Denied</H1>You don't have permission. Reference&#32;&#35;18.1234.5678.abcd" .replace(b"&#35;", b"#"), "akamai")]
        for headers, body, vendor in cases:
            cp._DNS.clear()
            self.resp = FakeResp(403, headers, body)
            r = cp.probe(cand())
            self.assertEqual((r["verdict"], r.get("reason_code")), ("recheck", "waf_challenge"), headers)
            self.assertEqual(r["waf"]["vendor"], vendor)

    def test_402_terms_unaffected(self):
        import base64, json
        ch = {"x402Version": 2, "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "1000", "asset": cp.USDC_MAINNET["eip155:8453"], "payTo": "0x" + "bb" * 20}]}
        self.resp = FakeResp(402, {"payment-required": base64.b64encode(json.dumps(ch).encode()).decode()}, b"{}")
        r = cp.probe(cand())
        self.assertEqual(r["verdict"], "pay")
        self.assertNotIn("reason_code", r)


class DnsRetry(Base):
    def test_one_retry_then_recheck_dns_error(self):
        self.dns_answers = [None, None, None]
        r = cp.probe(cand())
        self.assertEqual(self.dns_calls, ["api.crawlfixture.dev", "api.crawlfixture.dev"], "exactly one retry")
        self.assertEqual(self.http_calls, [], "never fetched")
        self.assertEqual((r["verdict"], r.get("reason_code")), ("recheck", "dns_error"))
        self.assertIn("retried once", r["reason"])

    def test_retry_that_resolves_probes_normally(self):
        self.dns_answers = [None, {"93.184.216.34"}]
        self.resp = FakeResp(429)
        r = cp.probe(cand())
        self.assertEqual(len(self.dns_calls), 2)
        self.assertEqual(len(self.http_calls), 1)
        self.assertEqual(r.get("reason_code"), "rate_limited")

    def test_first_answer_ok_no_retry(self):
        self.resp = FakeResp(429)
        cp.probe(cand())
        self.assertEqual(len(self.dns_calls), 1)

    def test_private_address_still_skip(self):
        self.dns_answers = [{"10.0.0.5"}]
        r = cp.probe(cand())
        self.assertEqual(r["verdict"], "skip")
        self.assertIn("private or local address", r["reason"])
        self.assertEqual(len(self.dns_calls), 1)


class Guard(unittest.TestCase):
    NOW = "2026-10-27T12:00:00Z"

    def rec(self, code="rate_limited"):
        return {"verdict": "recheck", "reason_code": code, "reason": "x", "timestamp": self.NOW}

    def test_falls_back_after_24h(self):
        for code, p in cp.PERSISTENT_OF.items():
            r = cp.transient_guard(self.rec(code), {"verdict": "recheck", "reason_code": "dns_error", "timestamp": "2026-10-26T11:00:00Z"}, 24)
            self.assertEqual((r["verdict"], r["reason_code"], r["transient_code"]), ("skip", p, code))
            self.assertEqual(r["transient_since"], "2026-10-26T11:00:00Z")

    def test_stays_recheck_under_24h_and_on_first_sight(self):
        r = cp.transient_guard(self.rec(), {"verdict": "recheck", "reason_code": "waf_challenge", "timestamp": "2026-10-26T13:00:00Z"}, 24)
        self.assertEqual((r["verdict"], r["transient_since"]), ("recheck", "2026-10-26T13:00:00Z"))
        r = cp.transient_guard(self.rec(), None, 24)
        self.assertEqual((r["verdict"], r["transient_since"]), ("recheck", self.NOW))

    def test_streak_carries_and_breaks(self):
        # the previous run was itself a fallback skip: the streak keeps its original start
        r = cp.transient_guard(self.rec(), {"verdict": "skip", "reason_code": "rate_limited_persistent", "transient_since": "2026-10-13T12:00:00Z", "timestamp": "2026-10-20T12:00:00Z"}, 24)
        self.assertEqual((r["verdict"], r["transient_since"]), ("skip", "2026-10-13T12:00:00Z"))
        # anything else in the previous run (or a pre-0.55.0 record without reason_code) starts a new streak
        for prev in ({"verdict": "pay", "timestamp": "2026-10-20T12:00:00Z"},
                     {"verdict": "skip", "timestamp": "2026-10-20T12:00:00Z"},  # pre-0.55.0 "no x402 payment request (HTTP 429)"
                     {"verdict": "recheck", "timestamp": "2026-10-20T12:00:00Z"}):  # e.g. a timeout
            r = cp.transient_guard(self.rec(), prev, 24)
            self.assertEqual((r["verdict"], r["transient_since"]), ("recheck", self.NOW), prev)

    def test_threshold_configurable(self):
        prev = {"verdict": "recheck", "reason_code": "rate_limited", "timestamp": "2026-10-26T00:00:00Z"}  # 36 h before
        self.assertEqual(cp.transient_guard(self.rec(), dict(prev), 48)["verdict"], "recheck")
        self.assertEqual(cp.transient_skip_after_hours({"TRANSIENT_SKIP_AFTER_HOURS": "48"}), 48.0)
        for bad in ("0", "-1", "abc", "", "1e9"):
            self.assertEqual(cp.transient_skip_after_hours({"TRANSIENT_SKIP_AFTER_HOURS": bad}), 24.0, bad)
        self.assertEqual(cp.transient_skip_after_hours({}), 24.0)

    def test_other_records_untouched(self):
        for r in ({"verdict": "pay", "reason": "ok", "timestamp": self.NOW}, {"verdict": "recheck", "reason": "timeout", "timestamp": self.NOW},
                  {"verdict": "skip", "reason": "no x402 payment request (HTTP 403)", "timestamp": self.NOW}):
            self.assertEqual(cp.transient_guard(dict(r), {"verdict": "recheck", "reason_code": "rate_limited", "timestamp": "2026-10-01T00:00:00Z"}, 24), r)

    def test_run_lane_uses_previous_run(self):
        b = Base("setUp"); b.setUp()
        try:
            b.resp = FakeResp(429)
            cp.PREV.clear(); cp.PREV[cp.rid(cp.norm_url(URL))] = {"verdict": "recheck", "reason_code": "rate_limited", "timestamp": "2026-10-01T00:00:00Z"}
            (r,) = cp.run_lane([cand()])
            self.assertEqual((r["verdict"], r["reason_code"]), ("skip", "rate_limited_persistent"))
            cp.PREV.clear(); cp._DNS.clear()
            (r,) = cp.run_lane([cand()])
            self.assertEqual((r["verdict"], r["reason_code"]), ("recheck", "rate_limited"))
        finally:
            b.tearDown(); cp.PREV.clear()

    def test_two_consecutive_weekly_runs(self):
        """Review: the crawl falls back on the 2nd consecutive weekly run with the same transient result (default 24 h)."""
        week1 = cp.transient_guard({"id": "x", "verdict": "recheck", "reason_code": "waf_challenge", "reason": "r", "timestamp": "2026-10-20T13:30:00Z"}, None)
        self.assertEqual(week1["verdict"], "recheck")
        prev = {k: week1.get(k) for k in ("verdict", "reason_code", "transient_since", "timestamp")}  # what load_prev keeps
        week2 = cp.transient_guard({"id": "x", "verdict": "recheck", "reason_code": "waf_challenge", "reason": "r", "timestamp": "2026-10-27T13:30:00Z"}, prev)
        self.assertEqual((week2["verdict"], week2["reason_code"]), ("skip", "waf_blocked_persistent"))
        prev = {k: week2.get(k) for k in ("verdict", "reason_code", "transient_since", "timestamp")}
        week3 = cp.transient_guard({"id": "x", "verdict": "recheck", "reason_code": "rate_limited", "reason": "r", "timestamp": "2026-11-03T13:30:00Z"}, prev)
        self.assertEqual((week3["verdict"], week3["reason_code"], week3["transient_since"]), ("skip", "rate_limited_persistent", "2026-10-20T13:30:00Z"))
        # a recovery in between restarts the count: two more consecutive runs are needed
        ok = {"verdict": "pay", "timestamp": "2026-11-10T13:30:00Z"}
        week5 = cp.transient_guard({"id": "x", "verdict": "recheck", "reason_code": "dns_error", "reason": "r", "timestamp": "2026-11-17T13:30:00Z"}, ok)
        self.assertEqual(week5["verdict"], "recheck")

    def test_load_prev(self):
        import tempfile, json
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write(json.dumps({"id": "abc", "verdict": "recheck", "reason_code": "dns_error", "timestamp": self.NOW, "pay_to": "x"}) + "\nnot json\n")
        try:
            self.assertEqual(cp.load_prev(f.name), {"abc": {"verdict": "recheck", "reason_code": "dns_error", "transient_since": None, "timestamp": self.NOW}})
            self.assertEqual(cp.load_prev(""), {})
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main(verbosity=1)
