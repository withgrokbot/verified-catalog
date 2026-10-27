"""scripts/weekly-crawl/term_history.py: change-only per-endpoint term history (migration 0019).

Run: python3 tests/term_history_test.py   (stdlib only; synthetic crawl records, in-memory SQLite, no network, no wrangler)
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts", "weekly-crawl"))
import term_history as th  # noqa: E402

MIG = open(os.path.join(ROOT, "worker", "migrations", "0019_term_history.sql")).read()
SELLER = "0x" + "Aa" * 20
OTHER = "0x" + "bb" * 20
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
SOL_PAY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
U1 = "https://a.fixture-sellers.example/v1/search"


def rec(url=U1, ts="2026-10-12T15:00:00Z", amount="10000", pay_to=SELLER, network="eip155:8453", asset=USDC, **kw):
    r = dict(id="x", url=url, norm_url=url, timestamp=ts, network=network, asset=asset, pay_to=pay_to, verdict="pay",
             quoted_price_usd=None if amount is None else int(amount) / 1e6, amount_atomic=amount, http_status=402)
    r.update(kw)
    return r


def crawl(*recs):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    for r in recs: f.write(json.dumps(r) + "\n")
    f.close()
    return f.name


def db():
    d = sqlite3.connect(":memory:"); d.row_factory = sqlite3.Row; d.executescript(MIG); return d


def apply(d, opened, path):
    ins, bumps = th.diff(opened, th.observations(path))
    d.executescript("\n".join(th.sql_statements(ins, bumps)))
    return ins, bumps


def rows(d, url=U1):
    return [dict(r) for r in d.execute("SELECT * FROM term_history WHERE endpoint_key = ? ORDER BY first_seen", (th.endpoint_key(url),))]


class TermHistory(unittest.TestCase):
    def test_migration_additive_idempotent(self):
        body = "\n".join(l for l in MIG.splitlines() if not l.strip().startswith("--"))
        for bad in ("ALTER", "DROP", "UPDATE", "DELETE", "INSERT"): self.assertNotIn(bad, body.upper())
        d = db(); d.executescript(MIG); d.executescript(MIG)
        cols = [c["name"] for c in d.execute("PRAGMA table_info(term_history)")]
        self.assertEqual(cols, ["endpoint_key", "first_seen", "last_seen", "amount", "pay_to", "network", "asset"])

    def test_key_matches_worker_history_key(self):
        # same as lib.js historyKey: "h:" + sha256(normalized URL)
        self.assertEqual(th.endpoint_key("https://x.example/a"), "h:" + __import__("hashlib").sha256(b"https://x.example/a").hexdigest())

    def test_unchanged_terms_only_move_last_seen(self):
        d, o = db(), {}
        apply(d, o, crawl(rec(ts="2026-10-12T15:00:00Z")))
        ins, bumps = apply(d, o, crawl(rec(ts="2026-10-19T15:00:00Z")))
        self.assertEqual((len(ins), len(bumps)), (0, 1))
        ins, bumps = apply(d, o, crawl(rec(ts="2026-10-26T15:00:00Z")))
        r = rows(d)
        self.assertEqual(len(r), 1)
        self.assertEqual((r[0]["first_seen"], r[0]["last_seen"], r[0]["amount"], r[0]["pay_to"]), ("2026-10-12T15:00:00Z", "2026-10-26T15:00:00Z", "10000", SELLER.lower()))

    def test_each_terms_field_change_appends_a_row(self):
        for field, val in (("amount", "20000"), ("pay_to", OTHER), ("network", "eip155:84532"), ("asset", "0x" + "cc" * 20)):
            d, o = db(), {}
            apply(d, o, crawl(rec(ts="2026-10-12T15:00:00Z")))
            ins, _ = apply(d, o, crawl(rec(ts="2026-10-19T15:00:00Z", **{field: val})))
            self.assertEqual(len(ins), 1, field)
            r = rows(d)
            self.assertEqual(len(r), 2, field)
            self.assertEqual(r[0]["last_seen"], "2026-10-12T15:00:00Z")  # old run closed where it was last seen
            self.assertEqual(r[1]["first_seen"], "2026-10-19T15:00:00Z")

    def test_flip_back_is_a_new_row_and_rerun_is_noop(self):
        d, o = db(), {}
        a, b, c = crawl(rec(ts="2026-10-05T00:00:00Z")), crawl(rec(ts="2026-10-12T00:00:00Z", amount="30000")), crawl(rec(ts="2026-10-19T00:00:00Z"))
        for p in (a, b, c): apply(d, o, p)
        self.assertEqual([r["amount"] for r in rows(d)], ["10000", "30000", "10000"])
        # re-running the same crawl (fresh read of open rows, as the script does) writes nothing new
        opened = th.open_from_rows([dict(r) for r in d.execute(th.OPEN_SQL)])
        ins, bumps = apply(d, opened, c)
        self.assertEqual((ins, bumps), ([], []))
        self.assertEqual(len(rows(d)), 3)

    def test_no_terms_records_change_nothing(self):
        d, o = db(), {}
        apply(d, o, crawl(rec(ts="2026-10-12T00:00:00Z")))
        down = rec(ts="2026-10-19T00:00:00Z", network=None, pay_to=None, asset=None, amount=None, verdict="recheck", http_status=None)
        noquote = {"id": "y", "url": U1, "verdict": "recheck", "reason": "not probed this run", "timestamp": "2026-10-19T00:00:00Z"}
        ins, bumps = apply(d, o, crawl(down, noquote))
        self.assertEqual((ins, bumps), ([], []))
        self.assertEqual(rows(d)[0]["last_seen"], "2026-10-12T00:00:00Z")

    def test_address_case(self):
        # EVM hex: case-insensitive (checksum vs lower is not a change); Solana base58 kept exactly
        d, o = db(), {}
        apply(d, o, crawl(rec(ts="2026-10-12T00:00:00Z", pay_to=SELLER)))
        ins, _ = apply(d, o, crawl(rec(ts="2026-10-19T00:00:00Z", pay_to=SELLER.lower(), asset=USDC.lower())))
        self.assertEqual(ins, [])
        sol = "https://s.fixture-sellers.example/v1/x"
        apply(d, o, crawl(rec(url=sol, ts="2026-10-12T00:00:00Z", pay_to=SOL_PAY, network="solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset=SOL_USDC)))
        self.assertEqual((rows(d, sol)[0]["pay_to"], rows(d, sol)[0]["asset"]), (SOL_PAY, SOL_USDC))

    def test_amount_from_older_crawls(self):
        # older crawl files have no amount_atomic; quoted_price_usd (USDC, 6 decimals) gives the same atomic string
        old = rec(ts="2026-10-12T00:00:00Z"); del old["amount_atomic"]
        d, o = db(), {}
        apply(d, o, crawl(old))
        ins, bumps = apply(d, o, crawl(rec(ts="2026-10-19T00:00:00Z")))
        self.assertEqual((len(ins), len(bumps)), (0, 1))
        odd = rec(ts="2026-10-26T00:00:00Z", amount=None); odd["amount_atomic"] = "1e4"
        self.assertIsNone(th.terms_of(odd)[2]["amount"])

    def test_duplicate_url_in_one_crawl_counts_once(self):
        obs = th.observations(crawl(rec(ts="2026-10-12T00:00:00Z", amount="10000"), rec(ts="2026-10-12T00:05:00Z", amount="20000")))
        self.assertEqual(len(obs), 1)
        self.assertEqual(list(obs.values())[0][1]["amount"], "20000")

    def test_no_buyer_or_payment_fields_stored(self):
        r = rec(ts="2026-10-12T00:00:00Z", payer="0x" + "b1" * 20, transaction="0x" + "c7" * 32, ip="198.51.100.23")
        d, o = db(), {}
        apply(d, o, crawl(r))
        blob = json.dumps(rows(d))
        for bad in ("b1b1b1", "c7c7c7", "198.51.100.23", U1): self.assertNotIn(bad, blob)

    def test_sql_quoting_and_chunking(self):
        ins = [{"endpoint_key": "h:k", "first_seen": "t", "last_seen": "t", "amount": "1", "pay_to": "o'brien", "network": "n", "asset": None}]
        d = db(); d.executescript("\n".join(th.sql_statements(ins, [])))
        self.assertEqual(d.execute("SELECT pay_to, asset FROM term_history").fetchone()[:], ("o'brien", None))
        files = th.chunk(["x" * 100] * 50, limit=1000)
        self.assertTrue(all(sum(len(s) + 1 for s in f) <= 1000 for f in files))
        self.assertEqual(sum(len(f) for f in files), 50)

    def test_estimate_on_fixtures(self):
        a = crawl(rec(ts="2026-10-12T00:00:00Z"), rec(url=U1 + "2", ts="2026-10-12T00:00:00Z"))
        b = crawl(rec(ts="2026-10-19T00:00:00Z"), rec(url=U1 + "2", ts="2026-10-19T00:00:00Z", amount="50000"))
        e = th.estimate([a, b])
        self.assertEqual(e["rows"], 3)
        self.assertEqual([(r["new_rows"], r["last_seen_updates"]) for r in e["runs"]], [(2, 0), (1, 1)])


if __name__ == "__main__":
    unittest.main(verbosity=1)
