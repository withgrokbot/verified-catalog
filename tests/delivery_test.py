"""scripts/delivery.py + x402_probe delivery hook: post-payment delivery check heuristics on fixtures.

Run: python3 tests/delivery_test.py   (stdlib only; synthetic responses, fake signer/guard, no network, no keys)
"""
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import delivery  # noqa: E402
import x402_probe as xp  # noqa: E402

CASES = json.load(open(os.path.join(ROOT, "tests", "fixtures", "delivery", "cases.json")))["cases"]


class Heuristics(unittest.TestCase):
    def test_fixtures(self):
        for c in CASES:
            with self.subTest(c["name"]):
                got = delivery.classify(c["status"], {"Content-Type": c["ctype"]}, c["body"].encode(), expect_html=c.get("expect_html", False))
                self.assertEqual(got["delivery_reason"], c["want"], c["name"])
                self.assertEqual(got["delivery_flag"], "failed" if c["want"] else "ok", c["name"])

    def test_fixture_mix(self):
        self.assertGreaterEqual(sum(1 for c in CASES if c["want"]), 15)
        self.assertGreaterEqual(sum(1 for c in CASES if not c["want"]), 12)

    def test_html_sniffed_without_content_type(self):
        cf = next(c for c in CASES if c["name"] == "200 cloudflare challenge")["body"]
        self.assertEqual(delivery.classify(200, {}, cf.encode())["delivery_reason"], "challenge_page")

    def test_non_utf8_and_binary_body_is_ok(self):
        self.assertEqual(delivery.classify(200, {"content-type": "image/png"}, b"\x89PNG\r\n\x1a\n\x00\x00")["delivery_flag"], "ok")


SVC = {"id": "fixture-svc", "endpoint": "https://seller.fixture.invalid/v1/data", "advertised_price": {"amount_usd": "0.01"},
       "sample_request": {"method": "GET"}}
OPT = {"scheme": "exact", "network": "eip155:8453", "amount": "10000", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
       "payTo": "0x" + "aa" * 20, "maxTimeoutSeconds": 60, "extra": {"name": "USD Coin", "version": "2"}}
CHALLENGE = {"x402Version": 2, "accepts": [OPT], "resource": {"url": SVC["endpoint"], "mimeType": "application/json"}}


class Guard:
    def authorize(self, amount): pass
    def record(self, *a, **k): pass
    def update_last(self, **k): pass


def run(paid_resp):
    first = {"ok": True, "status": 402, "headers": {"content-type": "application/json"}, "body": json.dumps(CHALLENGE).encode(), "latency_ms": 1}
    calls = iter([first, paid_resp])
    with mock.patch.object(xp, "http_call", lambda *a, **k: next(calls)), mock.patch.object(xp, "build_payment_header", lambda *a, **k: ("PAYMENT-SIGNATURE", "x")):
        res, _ = xp.check_service(SVC, signer=object(), guard=Guard())
    return res


def settle_hdr(success=True):
    import base64
    return base64.b64encode(json.dumps({"success": success, "transaction": "0x" + "c7" * 32, "network": "eip155:8453"}).encode()).decode()


class Hook(unittest.TestCase):
    def test_settled_200_refusal_is_flagged(self):
        res = run({"ok": True, "status": 200, "headers": {"content-type": "text/plain", "payment-response": settle_hdr()}, "body": b"I can't help with that.", "latency_ms": 1})
        self.assertEqual((res["delivery_flag"], res["delivery_reason"]), ("failed", "canned_refusal"))
        self.assertTrue(res["delivered_valid"])  # the existing field is unchanged: HTTP-level validity only

    def test_settled_5xx_is_server_error(self):
        res = run({"ok": True, "status": 502, "headers": {"payment-response": settle_hdr()}, "body": b"", "latency_ms": 1})
        self.assertEqual(res["charged_price_usd"], "0.01")
        self.assertEqual(res["delivery_reason"], "server_error")

    def test_unsettled_failure_has_no_flag(self):
        res = run({"ok": True, "status": 500, "headers": {}, "body": b"", "latency_ms": 1})
        self.assertIsNone(res["charged_price_usd"])
        self.assertEqual((res["delivery_flag"], res["delivery_reason"]), (None, None))

    def test_normal_delivery_ok(self):
        res = run({"ok": True, "status": 200, "headers": {"content-type": "application/json", "payment-response": settle_hdr()}, "body": b'{"rows":[{"subscribe":true}],"n":1}', "latency_ms": 1})
        self.assertEqual((res["delivery_flag"], res["delivery_reason"]), ("ok", None))

    def test_free_check_has_no_flag(self):
        first = {"ok": True, "status": 402, "headers": {}, "body": json.dumps(CHALLENGE).encode(), "latency_ms": 1}
        with mock.patch.object(xp, "http_call", lambda *a, **k: first):
            res, _ = xp.check_service(SVC)
        self.assertEqual((res["delivery_flag"], res["delivery_reason"]), (None, None))

    def test_expects_html(self):
        self.assertFalse(xp.expects_html(SVC, {"resource": {"mimeType": "application/json"}}, OPT))
        self.assertTrue(xp.expects_html(SVC, {"resource": {"mimeType": "text/html"}}, OPT))
        self.assertTrue(xp.expects_html(dict(SVC, expect_html=True), None))


import delivery_upload as du  # noqa: E402
import sqlite3  # noqa: E402


class Upload(unittest.TestCase):
    def test_rows_only_settled_paid_with_flag_and_no_secrets(self):
        hist = [
            {"service_id": "a", "checked_at": "2026-10-27T10:00:00Z", "paid": True, "charged_price_usd": "0.01", "delivered_status": 200,
             "delivery_flag": "failed", "delivery_reason": "canned_refusal", "settlement_tx": "0x" + "c7" * 32, "pay_to": "0x" + "aa" * 20,
             "request": {"method": "GET", "url": "https://Seller.Fixture.invalid:443/v1/data/?b=2&a=1"}},
            {"service_id": "b", "checked_at": "2026-10-27T10:01:00Z", "paid": True, "charged_price_usd": "0.01", "delivered_status": 200,
             "delivery_flag": "ok", "delivery_reason": None, "request": {"url": "https://seller.fixture.invalid/v1/other"}},
            {"service_id": "c", "checked_at": "2026-10-27T10:02:00Z", "paid": True, "charged_price_usd": None, "delivery_flag": None, "request": {"url": "https://x.invalid/"}},
            {"service_id": "d", "checked_at": "2026-10-27T10:03:00Z", "paid": False, "request": {"url": "https://x.invalid/"}},
        ]
        rows = du.rows_from([json.dumps(h) for h in hist])
        self.assertEqual([(r["flag"], r["reason"]) for r in rows], [("failed", "canned_refusal"), ("ok", None)])
        self.assertEqual(rows[0]["hkey"], du.hkey("https://seller.fixture.invalid/v1/data?a=1&b=2"))
        self.assertEqual(rows[0]["host"], "seller.fixture.invalid")
        stmts = du.sql(rows)
        blob = "\n".join(stmts)
        for bad in ("c7c7c7", "aaaaaa", "/v1/data"): self.assertNotIn(bad, blob)
        d = sqlite3.connect(":memory:")
        mig = open(os.path.join(ROOT, "worker", "migrations", "0020_delivery_checks.sql")).read()
        d.executescript(mig); d.executescript(mig)  # idempotent
        d.executescript(blob); d.executescript(blob)  # re-upload is a no-op
        self.assertEqual(d.execute("SELECT COUNT(*) FROM delivery_checks").fetchone()[0], 2)

    def test_norm_url_matches_worker_semantics(self):
        self.assertEqual(du.norm_url("HTTPS://User@Host.Example.:443/a/b/?z=1&a=2#f"), "https://host.example/a/b?a=2&z=1")
        self.assertEqual(du.norm_url("http://h.example:80"), "http://h.example/")


if __name__ == "__main__":
    unittest.main(verbosity=1)
