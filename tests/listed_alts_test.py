"""scripts/weekly-crawl/crawl_probe.py 0.79.0: listed payTo alternatives (listed_pay_tos) per endpoint and per site.

Run: python3 tests/listed_alts_test.py   (stdlib + requests import only; no network; synthetic hosts and wallets)
"""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts", "weekly-crawl"))
import crawl_probe as cp  # noqa: E402

A, B, C, D = ("0x" + h * 20 for h in ("a1", "b2", "c3", "d4"))
BASE, SOL = "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"


def item(url, *accepts):
    return {"type": "http", "resource": url, "accepts": [dict(scheme="exact", network=n, asset="0xusdc", maxAmountRequired="1000", payTo=p) for n, p in accepts]}


class SiteKey(unittest.TestCase):
    def test_registrable_name(self):
        self.assertEqual(cp.site_key("api.seller-fixture.dev"), "seller-fixture.dev")
        self.assertEqual(cp.site_key("ledger.seller-fixture.dev"), "seller-fixture.dev")

    def test_shared_hosting_never_groups_strangers(self):
        self.assertEqual(cp.site_key("one.alice.workers.dev"), "alice.workers.dev")
        self.assertNotEqual(cp.site_key("alice.workers.dev"), cp.site_key("bob.workers.dev"))
        self.assertNotEqual(cp.site_key("app-a.onrender.com"), cp.site_key("app-b.onrender.com"))
        self.assertEqual(cp.site_key("x.shop.co.uk"), "shop.co.uk")
        self.assertEqual(cp.site_key("10.1.2.3"), "10.1.2.3")


class LoadCandidates(unittest.TestCase):
    def run_with(self, payai, cdp):
        d = tempfile.mkdtemp()
        json.dump({"items": payai}, open(os.path.join(d, "payai_0.json"), "w"))
        json.dump({"items": cdp}, open(os.path.join(d, "cdp_0.json"), "w"))
        old = cp.CRAWL
        cp.CRAWL = d
        try:
            return {c["url"]: c for c in cp.load_candidates()}
        finally:
            cp.CRAWL = old

    def test_endpoint_entries_from_both_bazaars_and_site_wallets(self):
        u1, u2 = "https://api.seller-fixture.dev/v1/a", "https://data.seller-fixture.dev/v1/b"
        out = self.run_with([item(u1, (BASE, A), (SOL, "So1Wa11et"))], [item(u1, (BASE, B)), item(u2, (BASE, C), ("eip155:137", D))])
        alts = out[u1]["listed_alts"]
        self.assertEqual([(a["pay_to"], a["scope"]) for a in alts if a["network"] == BASE], [(A, "endpoint"), (B, "endpoint"), (C, "site")])
        self.assertIn(("So1Wa11et", "endpoint"), [(a["pay_to"], a["scope"]) for a in alts])
        self.assertNotIn(D, [a["pay_to"] for a in alts], "site wallets only on networks the endpoint lists")
        self.assertTrue(all(set(a) == {"network", "pay_to", "scope"} for a in alts))

    def test_single_wallet_adds_nothing(self):
        u = "https://solo.seller-fixture.dev/v1/a"
        out = self.run_with([item(u, (BASE, A))], [item(u, (BASE, A.upper().replace("0X", "0x")))])
        self.assertNotIn("listed_alts", out[u])

    def test_strangers_on_shared_hosting_do_not_share(self):
        u1, u2 = "https://alice.workers.dev/v1/a", "https://bob.workers.dev/v1/b"
        out = self.run_with([item(u1, (BASE, A)), item(u2, (BASE, B))], [])
        self.assertNotIn("listed_alts", out[u1])

    def test_cap(self):
        u = "https://many.seller-fixture.dev/v1/a"
        wallets = ["0x" + ("%02x" % i) * 20 for i in range(1, 15)]
        out = self.run_with([item(u, *[(BASE, w) for w in wallets])], [])
        self.assertEqual(len(out[u]["listed_alts"]), cp.LISTED_ALTS_CAP)

    def test_probe_record_carries_listed_pay_tos(self):
        c = {"url": "https://x.seller-fixture.dev/t/:id", "norm": "https://x.seller-fixture.dev/t/:id", "also": [], "source_list": "cdp-bazaar", "method": "GET",
             "listing": {"payTo": A, "network": BASE}, "listed_alts": [{"network": BASE, "pay_to": A, "scope": "endpoint"}, {"network": BASE, "pay_to": B, "scope": "site"}]}
        rec = cp.probe(c)  # a path template answers before any request is made
        self.assertEqual(rec["listed_pay_tos"][1]["pay_to"], B)
        self.assertEqual(rec["listed_pay_to"], A)


if __name__ == "__main__":
    unittest.main()
