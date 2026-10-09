#!/usr/bin/env python3
"""Weekly demand report for the reliability-lookup test -> results/demand_weekly.json.

Reads the lookup Worker's Analytics Engine dataset (one data point per lookup; see worker/src/lib.js dataPoint()):
  blob1 client id, blob6 why not qualifying ("" = qualifying), blob7 payer, blob8 returned vendor pay_to list,
  double1 qualifying (1/0), timestamp.
  Paid lookups (Worker 0.3.0+): blob13 access ("paid"), blob14 settlement tx, blob15 paying wallet, blob11 ref,
  blob6 "self" for our own test clients, double5 USD charged.

Live:     CF_ACCOUNT_ID=... CF_API_TOKEN=... python3 scripts/demand_weekly.py --start 2026-10-05
          (API token needs only "Account Analytics: Read"; never commit it)
Offline:  python3 scripts/demand_weekly.py --start 2026-10-05 --rows rows.json [--paid-rows paid.json] [--no-payer-check]

The report also shows paid lookups and revenue (x402, $0.02 USDC each after 5 free per client per UTC day): count,
USD, distinct paying clients, by ref and test week, with our own self-test payments shown separately.

Verdict (DEMAND_TEST.md section 5), days counted from --start (day 1 = the day the first listing went live):
  pass          >= 10 distinct qualifying clients in days 8-14, and >= 3 of them active on >= 2 separate days
  inconclusive  3-9 in days 8-14 (one 14-day extension only if week 2 beat week 1)
  kill          < 3 in days 8-14, or no repeat client in 14 days, or test spend >= $5
Before day 14 the verdict is "running". The payer check (reported, not gating) looks on Base for a USDC transfer,
sent by the payer wallet given in the lookup, to a returned vendor within 30 minutes, using a free public RPC.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import x402_probe as xp  # noqa: E402

DATASET = "vc_lookups"
TEST_SPEND_CAP = Decimal("5")
BASE_RPC = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
BASE_BLOCK_S = 2
PAYER_WINDOW_S = 30 * 60


def sql_rows(since):
    return f"""SELECT blob1 AS client, blob7 AS payer, blob8 AS pay_to, double1 AS qualifying, blob11 AS ref, blob12 AS referer,
  blob6 AS reason, blob3 AS task, blob4 AS endpoint, blob5 AS max_price, blob9 AS ua, blob13 AS access,
  toUInt32(timestamp) AS ts, _sample_interval AS weight
FROM {DATASET}
WHERE timestamp >= toDateTime('{since.strftime('%Y-%m-%d %H:%M:%S')}')
ORDER BY ts
LIMIT 100000"""


def sql_paid(since):
    return f"""SELECT blob1 AS client, blob6 AS reason, blob11 AS ref, blob14 AS tx, blob15 AS payer, double5 AS amount_usd,
  toUInt32(timestamp) AS ts, _sample_interval AS weight
FROM {DATASET}
WHERE timestamp >= toDateTime('{since.strftime('%Y-%m-%d %H:%M:%S')}') AND blob13 = 'paid'
ORDER BY ts
LIMIT 100000"""


def paid_summary(rows, start):
    """Paid lookups and revenue. Outside = not our own test clients (reason != "self")."""
    def block(rs):
        usd_total = sum((Decimal(str(r.get("amount_usd") or 0)) for r in rs), Decimal("0"))
        return {"paid_lookups": len(rs), "revenue_usd": format(usd_total.normalize(), "f") if usd_total else "0",
                "distinct_paying_clients": len({r["client"] for r in rs})}
    outside = [r for r in rows if (r.get("reason") or "") != "self"]
    self_rows = [r for r in rows if (r.get("reason") or "") == "self"]
    by_ref = {}
    for r in outside:
        by_ref.setdefault(r.get("ref") or "none", []).append(r)
    week = lambda lo, hi: [r for r in outside if lo <= test_day(r["ts"], start) <= hi]
    return {"price_usd": "0.02", "free_per_client_per_day": 5,
            "outside": block(outside), "self_test": block(self_rows),
            "week1": block(week(1, 7)), "week2": block(week(8, 14)),
            "by_ref": {k: block(v) for k, v in sorted(by_ref.items())},
            "payments": [{"at": xp.iso_z(dt.datetime.fromtimestamp(int(float(r["ts"])), dt.timezone.utc)), "client": r["client"],
                          "ref": r.get("ref") or "", "amount_usd": str(r.get("amount_usd")), "tx": r.get("tx") or "",
                          "self_test": (r.get("reason") or "") == "self"} for r in rows][-200:]}


def query_ae(since, sql=sql_rows):
    acct, tok = os.environ.get("CF_ACCOUNT_ID"), os.environ.get("CF_API_TOKEN")
    if not (acct and tok):
        raise SystemExit("set CF_ACCOUNT_ID and CF_API_TOKEN, or pass --rows")
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/analytics_engine/sql"
    import urllib.request, urllib.error  # no body cap: a week of rows is several MB
    req = urllib.request.Request(url, data=sql(since).encode(), headers={"Authorization": "Bearer " + tok, "Content-Type": "text/plain"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8")).get("data", [])
    except urllib.error.URLError as e:
        raise SystemExit(f"Analytics Engine query failed: {e}")


# Bots are not demand (ANALYTICS_2026-10-09.md). Worker 0.11.0+ tags them in blob6; older rows get the same rules here.
NOT_REAL = {"self", "uptime", "crawler", "scanner", "example-param", "indexer", "ssrf-probe"}
INDEXER_UA = re.compile(r"(bazaar|indexer|index-bot|probe|verifier|scout|x402watch|collector|doctor|x402lens|lens\b|conformance|discovery|registry|trustindex|agenstry|brickblue|pennywise|allow402|easy402|x402scan|settled|observer|touchstone|catalog-bot|directory)", re.I)
EXAMPLE_HOST = re.compile(r"^(?:[^/]*\.)?(?:example\.(?:com|org|net)|[^/]+\.example|[^/]+\.test|[^/]+\.invalid|localhost)$", re.I)
OUR_CLIENT = re.compile(r"^c:(wgb-|router-selftest|mx|maxverify|hermes-probe|withgrokbot|discovery-seed|sam-selftest|agent$|hint-|ship-|beacon|daily-review|selftest|test)")
OUR_REF = re.compile(r"^(selftest|e2e-test|discovery-seed|ship-|x402-spotcheck$)")  # our own test refs (via-x402-spotcheck is real use)
KNOWN_INDEXER_CLIENT = {"c:payapi"}  # marketplace listing verifier + its monitors (ANALYTICS_2026-10-09.md)


def bot_tag(r):
    """'' for a possibly real caller, else why not (self/uptime/crawler/scanner/example-param/indexer)."""
    reason = r.get("reason") or ""
    if reason in NOT_REAL:
        return reason
    if OUR_CLIENT.match(r.get("client") or "") or OUR_REF.match(r.get("ref") or ""):
        return "self"
    if (r.get("access") or "") == "spot-ssrf":
        return "ssrf-probe"
    if (r.get("client") or "") == "c:vc-mcp" and (r.get("reason") or "") == "bad-params":
        return "indexer"  # registry inspection of our MCP package (task=x402-probe)
    if INDEXER_UA.search(r.get("ua") or "") or (r.get("client") or "") in KNOWN_INDEXER_CLIENT:
        return "indexer"
    if r.get("ref") or str(r.get("client") or "").startswith("c:"):
        return ""
    ep = r.get("endpoint") or ""
    if ep:
        try:
            from urllib.parse import urlparse
            if EXAMPLE_HOST.match(urlparse(ep).hostname or ""):
                return "example-param"
        except ValueError:
            pass
    elif (r.get("task") or "") == "web-search" and str(r.get("max_price") or "") in ("0.01", "0.010"):
        return "example-param"
    if not ep and not (r.get("task") or "") and reason in ("bad-params", "missing-task-or-price", "payment-required", "spot-bad-params") or (r.get("access") or "") == "spot-bad-params" and not ep:
        return "scanner"
    return ""


def real_clients(rows, start):
    """Distinct real (non-bot, non-self) clients per PT-agnostic UTC test day, and in total."""
    by_day, tags, views = {}, {}, {}
    for r in rows:
        t = bot_tag(r)
        if (r.get("access") or "").startswith("view-"):  # page/doc views (0.11.0+): reported, not clients
            if not t:
                views[r["access"]] = views.get(r["access"], 0) + 1
            continue
        tags[t or "real"] = tags.get(t or "real", 0) + 1
        if t:
            continue
        by_day.setdefault(dt.datetime.fromtimestamp(float(r["ts"]), dt.timezone.utc).date().isoformat(), set()).add(r["client"])
    allc = set().union(*by_day.values()) if by_day else set()
    return {"real_clients_total": len(allc), "real_clients_by_utc_day": {d: len(c) for d, c in sorted(by_day.items())},
            "rows_by_tag": dict(sorted(tags.items())), "real_views": dict(sorted(views.items())), "real_client_ids": sorted(allc)[:50]}


def test_day(ts, start):
    return (dt.datetime.fromtimestamp(float(ts), dt.timezone.utc).date() - start).days + 1


def evaluate(rows, start, today, spend_usd=Decimal("0")):
    days_by_client = {}
    for r in rows:
        if int(float(r.get("qualifying", 1))) != 1:
            continue
        d = test_day(r["ts"], start)
        if 1 <= d <= 28:
            days_by_client.setdefault(r["client"], set()).add(d)

    def window(lo, hi):
        cl = {c: {d for d in ds if lo <= d <= hi} for c, ds in days_by_client.items()}
        cl = {c: ds for c, ds in cl.items() if ds}
        return {"days": [lo, hi], "distinct_clients": len(cl), "clients_on_2plus_days": sum(1 for ds in cl.values() if len(ds) >= 2)}

    w1, w2 = window(1, 7), window(8, 14)
    any_repeat = window(1, 14)["clients_on_2plus_days"] > 0
    day_now = (today - start).days + 1
    if spend_usd >= TEST_SPEND_CAP:
        verdict, why = "kill", f"test spend ${spend_usd} reached the ${TEST_SPEND_CAP} cap"
    elif day_now <= 14:
        verdict, why = "running", f"day {day_now} of 14"
    elif w2["distinct_clients"] >= 10 and w2["clients_on_2plus_days"] >= 3:
        verdict, why = "pass", ">=10 distinct qualifying clients in days 8-14 and >=3 active on 2+ days"
    elif w2["distinct_clients"] < 3 or not any_repeat:
        verdict, why = "kill", "<3 distinct qualifying clients in days 8-14" if w2["distinct_clients"] < 3 else "no repeat client in 14 days"
    else:
        ext = w2["distinct_clients"] > w1["distinct_clients"]
        verdict = "inconclusive"
        why = f"{w2['distinct_clients']} clients in days 8-14; " + ("one 14-day extension allowed (week 2 beat week 1)" if ext else "no extension (week 2 did not beat week 1)")
    return {"test_day": day_now, "week1": w1, "week2": w2, "repeat_client_in_14_days": any_repeat,
            "test_spend_usd": str(spend_usd), "verdict": verdict, "why": why}


def by_source(rows):
    """Distinct qualifying clients per source: the ref parameter, else the Referer host, else "none"."""
    src = {}
    for r in rows:
        key = (r.get("ref") or "") or ("referer:" + r["referer"] if r.get("referer") else "none")
        src.setdefault(key, set()).add(r["client"])
    return {k: len(v) for k, v in sorted(src.items())}


def spend_since(ledger_path, start):
    if not os.path.exists(ledger_path):
        return Decimal("0")
    with open(ledger_path, encoding="utf-8") as fh:
        entries = json.load(fh).get("entries", [])
    return sum((Decimal(e["amount_usd"]) for e in entries if e.get("day", "") >= start.isoformat()), Decimal("0"))


class BaseRpc:
    def __init__(self, urls=BASE_RPC):
        self.urls = urls

    def call(self, method, params):
        for u in self.urls:
            r = xp.http_call("POST", u, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), timeout=20)
            if r.get("ok") and r["status"] == 200:
                j = json.loads(r["body"].decode("utf-8"))
                if "result" in j:
                    return j["result"]
        raise RuntimeError(f"Base RPC {method} failed")


def payer_confirmations(rows, rpc):
    """Return one record per lookup that sent a payer: was a USDC transfer to a returned vendor seen within 30 min?"""
    todo = [r for r in rows if r.get("payer") and r.get("pay_to")]
    if not todo:
        return []
    head = int(rpc.call("eth_blockNumber", []), 16)
    head_ts = int(rpc.call("eth_getBlockByNumber", [hex(head), False])["timestamp"], 16)
    usdc = xp.NETWORKS["base"]["usdc"]
    out = []
    for r in todo:
        vendors = [v for v in str(r["pay_to"]).split(",") if v.startswith("0x") and len(v) == 42]
        ts = int(float(r["ts"]))
        b0 = max(0, head - (head_ts - ts) // BASE_BLOCK_S - 30)
        b1 = min(head, b0 + PAYER_WINDOW_S // BASE_BLOCK_S + 60)
        rec = {"client": r["client"], "lookup_at": xp.iso_z(dt.datetime.fromtimestamp(ts, dt.timezone.utc)), "payer": r["payer"],
               "confirmed": None, "tx": None}
        if not vendors or b1 < b0 or head_ts - ts < PAYER_WINDOW_S:
            rec["note"] = "window not complete yet or no vendor address"
            out.append(rec)
            continue
        pad = lambda a: "0x" + a.lower().removeprefix("0x").rjust(64, "0")
        logs = rpc.call("eth_getLogs", [{"address": usdc, "fromBlock": hex(b0), "toBlock": hex(b1),
                                         "topics": [TRANSFER_TOPIC, pad(r["payer"]), [pad(v) for v in vendors]]}])
        rec["confirmed"] = bool(logs)
        rec["tx"] = logs[0]["transactionHash"] if logs else None
        out.append(rec)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True, help="UTC date the first listing went live (day 1), YYYY-MM-DD")
    ap.add_argument("--rows", help="JSON file with Analytics Engine rows (offline)")
    ap.add_argument("--today", help="override today's UTC date (tests)")
    ap.add_argument("--site", default=os.path.dirname(HERE))
    ap.add_argument("--out", help="default: <site>/results/demand_weekly.json")
    ap.add_argument("--paid-rows", help="JSON file with paid-lookup rows (offline; see sql_paid)")
    ap.add_argument("--no-payer-check", action="store_true")
    a = ap.parse_args(argv)
    start = dt.date.fromisoformat(a.start)
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone.utc).date()
    if a.rows:
        with open(a.rows, encoding="utf-8") as fh:
            rows = json.load(fh)
            rows = rows.get("data", rows) if isinstance(rows, dict) else rows
    else:
        rows = query_ae(dt.datetime.combine(start, dt.time(), dt.timezone.utc))
    if a.paid_rows:
        with open(a.paid_rows, encoding="utf-8") as fh:
            paid = json.load(fh)
            paid = paid.get("data", paid) if isinstance(paid, dict) else paid
    elif a.rows:
        paid = []
    else:
        paid = query_ae(dt.datetime.combine(start, dt.time(), dt.timezone.utc), sql_paid)
    real = real_clients(rows, start)
    rows = [r for r in rows if not bot_tag(r)]  # everything below counts real clients only
    spend = spend_since(os.path.join(a.site, "results", "spend_ledger.json"), start)
    report = {"schema": 1, "generated_at": xp.iso_z(), "start": start.isoformat(),
              "note": "Distinct qualifying clients of the reliability lookup. Client ids are weekly-salted hashes or self-chosen names; no raw IPs.",
              **evaluate(rows, start, today, spend), "real": real, "by_source": by_source([r for r in rows if int(float(r.get("qualifying", 1))) == 1]), "paid": paid_summary(paid, start)}
    if not a.no_payer_check:
        try:
            report["payer_check"] = payer_confirmations([r for r in rows if int(float(r.get("qualifying", 1))) == 1], BaseRpc())
        except RuntimeError as e:
            report["payer_check_error"] = str(e)
    out = a.out or os.path.join(a.site, "results", "demand_weekly.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps({**{k: report[k] for k in ("test_day", "week1", "week2", "verdict", "why")},
                      "real_clients_total": real["real_clients_total"], "real_clients_by_utc_day": real["real_clients_by_utc_day"],
                      "paid_lookups": report["paid"]["outside"]["paid_lookups"], "revenue_usd": report["paid"]["outside"]["revenue_usd"],
                      "self_test_paid_lookups": report["paid"]["self_test"]["paid_lookups"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
