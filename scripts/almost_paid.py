#!/usr/bin/env python3
"""'Almost paid' report for 402xAgent -> results/almost_paid.json (+ a 3-line summary on stdout).

An almost-paid session: a real caller gets a FREE answer (any product), then within --free-window minutes (default 10)
hits a paid 402 (402xAgent check /v1/products/endpoint-spot-check, paid lookup, or the pack) and does NOT complete a
payment within --pay-window minutes (default 15) after its last 402. A 402 with no free answer before it (and no signed attempt) is a cold 402, counted separately. A signed payment that failed verify/settle
(access payment-failed, Worker 0.19.0+ records the signer wallet and the reason) also makes an almost-paid session when
no payment succeeds within the window, even without a free answer first. Consecutive 402s by one caller inside the
pay window are one session. Sessions whose window has not closed yet are reported as "open", not counted.

Caller = client id (blob1: "c:<client param>" or the weekly-salted ip/24+UA hash "h:..."), shown only hashed again,
plus the UA family (blob9); a payer wallet, when present, links sessions across client ids. A caller (or wallet) with
more than one almost-paid session, across days too, is a REPEAT: the free answer was close but not close enough.
Excluded with the same tags as demand_weekly.py: self, uptime, crawler, scanner, example-param, indexer, ssrf-probe,
dry-run (blob6/blob13 + the box-side rules for older rows). NO payments are made; read-only Analytics Engine SQL.

Live:    CF_ACCOUNT_ID=aa4453a0042a949537d2fcae99590a5f CF_API_TOKEN=<analytics read> python3 scripts/almost_paid.py --start 2026-10-05
Offline: python3 scripts/almost_paid.py --rows rows.json      Self-test: python3 scripts/almost_paid.py --selftest
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from collections import defaultdict
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import demand_weekly as dw  # noqa: E402  (bot_tag, query_ae, DATASET)

PT = ZoneInfo("America/Vancouver")
FREE = {"free", "partner"}
PAID = {"paid", "router-pack"}
PAYWALL = {"payment-required", "payment-failed"}
SITE_REF = ("via-402xagent-site", "via-payscout-site")  # the landing page's Try-it: its 402 is an automatic step to a free dry run
# Our own calls that went out without a self tag (hashed caller ids as printed by this script), excluded by hand:
KNOWN_OWN = {
    "u_1e94a7532860": "our 0.17.0 release samples (a free answer then a 402 for api.402rates.com/v1/ping, Oct 10 15:54-15:55 PT, "
                      "followed by our exempt self-test and a dry run at 15:57)",
}


def sql(since):
    return f"""SELECT blob1 AS client, blob2 AS source, blob3 AS task, blob4 AS endpoint, blob5 AS max_price, blob6 AS reason,
  blob9 AS ua, blob11 AS ref, blob13 AS access, blob15 AS wallet, blob16 AS product, blob17 AS fail_reason,
  double3 AS status, double6 AS free_used, toUInt32(timestamp) AS ts
FROM {dw.DATASET}
WHERE timestamp >= toDateTime('{since.strftime('%Y-%m-%d %H:%M:%S')}')
  AND (blob13 IN ('free','partner','paid','router-pack','payment-required','payment-failed','view-pack-402','view-pack-paid'))
ORDER BY ts
LIMIT 200000"""


def product_of(r):
    """Worker 0.19.0+ writes blob16; older rows: view-pack-* = pack, freeUsed 1 (402xAgent's 1 free/day) = spot,
    -1 on a 402 = the always-paid lookup route, else lookup."""
    p = r.get("product") or ""
    if p:
        return p
    a = r.get("access") or ""
    if a.startswith("view-pack"):
        return "pack"
    fu = float(r.get("free_used") if r.get("free_used") not in (None, "") else -1)
    if a in PAYWALL or a in PAID:
        if fu == 1:
            return "spot"
        if fu < 0:
            return "lookup-paid"
        return "lookup"
    if a in FREE:
        return "spot" if fu == 1 and not (r.get("task") or "") else "lookup"
    return ""


def norm_access(r):
    a = r.get("access") or ""
    return {"view-pack-402": "payment-required", "view-pack-paid": "paid"}.get(a, a)


def hid(x):
    return "u_" + hashlib.sha256(("almost-paid|" + x).encode()).hexdigest()[:12]


def short_wallet(w):
    return (w[:6] + "…" + w[-4:]) if w and len(w) == 42 else ""


def pt(ts):
    return dt.datetime.fromtimestamp(int(ts), tz=dt.timezone.utc).astimezone(PT)


def analyse(rows, now_ts, free_win_s=600, pay_win_s=900):
    real, tags = [], defaultdict(int)
    for r in rows:
        r = dict(r)
        r["product"] = product_of(r)  # before norm_access: view-pack-* rows are the pack
        r["access"] = norm_access(r)
        t = dw.bot_tag(r)
        if r["access"] == "payment-required" and (r.get("reason") or "") == "payment-required":
            t = dw.bot_tag({**r, "reason": ""})  # blob6 = access on a paywalled row; re-check the bot rules only
        if not t and r["access"] in PAYWALL and (r.get("ref") or "") in SITE_REF:
            t = "site-try-it"
        if not t and hid(r.get("client") or "") in KNOWN_OWN:
            t = "known-own"
        if t:
            tags[t] += 1
            continue
        r["ts"] = int(r["ts"])
        r["wallet"] = (r.get("wallet") or "").lower() if r["access"] in PAYWALL | PAID else ""
        real.append(r)
    real.sort(key=lambda r: r["ts"])
    by_client = defaultdict(list)
    for r in real:
        by_client[r.get("client") or ""].append(r)
    paid_by_wallet = defaultdict(list)
    for r in real:
        if r["access"] in PAID and r["wallet"]:
            paid_by_wallet[r["wallet"]].append(r["ts"])

    sessions, conversions = [], []
    cold = defaultdict(lambda: {"rows": 0, "callers": set(), "ua": defaultdict(int)})
    for cid, rs in by_client.items():
        last_free = None
        cur = None  # open session: dict
        paid_ts = [r["ts"] for r in rs if r["access"] in PAID]

        def close(s):
            end = s["last_402"] + pay_win_s
            paid = any(s["first_402"] <= t <= end for t in paid_ts) or any(
                s["first_402"] <= t <= end for w in s["wallets"] for t in paid_by_wallet.get(w, []))
            s["status"] = "converted" if paid else ("open" if end > now_ts else "almost_paid")
            sessions.append(s)

        for r in rs:
            a = r["access"]
            if cur and r["ts"] > cur["last_402"] + pay_win_s:
                close(cur); cur = None
            if a in FREE:
                last_free = r
                continue
            if a in PAID:
                after_free = bool(last_free and r["ts"] - last_free["ts"] <= free_win_s + pay_win_s)
                conversions.append({"ts": r["ts"], "product": r["product"], "client": cid, "after_free": after_free})
                if cur:
                    close(cur); cur = None
                continue
            if a in PAYWALL:
                qualifies = (last_free and r["ts"] - last_free["ts"] <= free_win_s) or a == "payment-failed" or cur
                if not qualifies:
                    cold[r["product"]]["rows"] += 1
                    cold[r["product"]]["callers"].add(cid)
                    cold[r["product"]]["ua"][r.get("ua") or "none"] += 1
                    continue
                if not cur:
                    cur = {"client": cid, "ua": r.get("ua") or "none", "refs": set(), "targets": set(), "products": set(),
                           "wallets": set(), "fail_reasons": [], "first_402": r["ts"], "last_402": r["ts"], "n402": 0,
                           "signed_failed": 0, "after_free": bool(last_free and r["ts"] - last_free["ts"] <= free_win_s),
                           "free_product": last_free["product"] if last_free else ""}
                cur["last_402"] = r["ts"]; cur["n402"] += 1
                cur["products"].add(r["product"])
                if r.get("ref"): cur["refs"].add(r["ref"])
                if r.get("endpoint") and r["product"] == "spot": cur["targets"].add(r["endpoint"])
                if last_free and last_free.get("endpoint") and last_free["product"] == "spot": cur["targets"].add(last_free["endpoint"])
                if a == "payment-failed":
                    cur["signed_failed"] += 1
                    if r["wallet"]: cur["wallets"].add(r["wallet"])
                    if r.get("fail_reason"): cur["fail_reasons"].append(r["fail_reason"][:120])
        if cur:
            close(cur)

    almost = [s for s in sessions if s["status"] == "almost_paid"]
    per_day = defaultdict(lambda: {"almost_paid_sessions": 0, "with_signed_failed_payment": 0, "after_free_answer": 0, "open": 0,
                                   "paid_conversions": 0, "paid_after_free_answer": 0})
    for s in sessions:
        d = pt(s["first_402"]).date().isoformat()
        if s["status"] == "almost_paid":
            per_day[d]["almost_paid_sessions"] += 1
            per_day[d]["with_signed_failed_payment"] += 1 if s["signed_failed"] else 0
            per_day[d]["after_free_answer"] += 1 if s["after_free"] else 0
        elif s["status"] == "open":
            per_day[d]["open"] += 1
    for c in conversions:
        d = pt(c["ts"]).date().isoformat()
        per_day[d]["paid_conversions"] += 1
        per_day[d]["paid_after_free_answer"] += 1 if c["after_free"] else 0

    # repeats: same client id, or same payer wallet across client ids
    groups = defaultdict(list)
    for s in almost:
        groups["client:" + s["client"]].append(s)
        for w in s["wallets"]:
            groups["wallet:" + w].append(s)
    repeats = []
    for k, ss in groups.items():
        if len(ss) < 2:
            continue
        kind, val = k.split(":", 1)
        last = max(s["last_402"] for s in ss)
        repeats.append({
            "caller": hid(val) if kind == "client" else "wallet " + short_wallet(val),
            "linked_by": kind,
            "id_kind": ("client param" if val.startswith("c:") else "ip/24+UA hash (weekly salt)") if kind == "client" else "payer wallet",
            "ua_family": sorted({s["ua"] for s in ss}),
            "refs": sorted(set().union(*[s["refs"] for s in ss])),
            "products": sorted(set().union(*[s["products"] for s in ss])),
            "targets": sorted(set().union(*[s["targets"] for s in ss]))[:20],
            "times": len(ss),
            "days": len({pt(s["first_402"]).date() for s in ss}),
            "signed_failed_payments": sum(s["signed_failed"] for s in ss),
            "wallets": sorted({short_wallet(w) for s in ss for w in s["wallets"]}),
            "fail_reasons": sorted({f for s in ss for f in s["fail_reasons"]})[:5],
            "last_seen_pt": pt(last).strftime("%Y-%m-%d %H:%M PT"),
        })
    repeats.sort(key=lambda x: (-x["times"], x["caller"]))
    return {
        "real_rows": len(real), "excluded_rows_by_tag": dict(sorted(tags.items())),
        "totals": {
            "almost_paid_sessions": len(almost),
            "with_signed_failed_payment": sum(1 for s in almost if s["signed_failed"]),
            "after_free_answer": sum(1 for s in almost if s["after_free"]),
            "open_sessions": sum(1 for s in sessions if s["status"] == "open"),
            "converted_sessions": sum(1 for s in sessions if s["status"] == "converted"),
            "paid_conversions": len(conversions),
            "paid_after_free_answer": sum(1 for c in conversions if c["after_free"]),
            "almost_paid_callers": len({s["client"] for s in almost}),
            "repeat_callers": len(repeats),
            "by_product": {p: sum(1 for s in almost if p in s["products"]) for p in sorted({p for s in almost for p in s["products"]})},
        },
        "cold_402s": {p: {"rows": v["rows"], "callers": len(v["callers"]), "top_ua_families": dict(sorted(v["ua"].items(), key=lambda x: -x[1])[:5])} for p, v in sorted(cold.items())},
        "known_own_excluded": KNOWN_OWN,
        "per_day_pt": dict(sorted(per_day.items())),
        "repeat_callers": repeats,
        "sessions": [{"caller": hid(s["client"]), "ua_family": s["ua"], "refs": sorted(s["refs"]), "products": sorted(s["products"]),
                      "targets": sorted(s["targets"])[:5], "first_402_pt": pt(s["first_402"]).strftime("%Y-%m-%d %H:%M PT"),
                      "n402": s["n402"], "signed_failed": s["signed_failed"], "after_free": s["after_free"], "status": s["status"]}
                     for s in sessions if s["status"] != "converted"][-200:],
    }


def summary(rep, since):
    t = rep["totals"]
    top = rep["repeat_callers"][0] if rep["repeat_callers"] else None
    return [
        f"almost_paid since {since}: {t['almost_paid_sessions']} sessions from {t['almost_paid_callers']} callers "
        f"({t['after_free_answer']} right after a free answer, {t['with_signed_failed_payment']} with a signed payment that failed; {t['open_sessions']} still open)",
        f"paid conversions: {t['paid_conversions']} ({t['paid_after_free_answer']} within the window after a free answer); by product almost-paid {json.dumps(t['by_product'])}",
        f"repeat callers: {t['repeat_callers']}" + (f"; top {top['caller']} ({', '.join(top['ua_family'])}, refs {top['refs'] or '-'}) x{top['times']} over {top['days']} day(s), last {top['last_seen_pt']}" if top else ""),
    ]


def selftest():
    T0 = 1_791_400_000
    R = lambda **k: {"client": "c:a", "ua": "node", "ref": "", "reason": "", "access": "free", "endpoint": "https://t.real/x", "task": "", "free_used": 1, "ts": T0, **k}
    rows = [
        R(ts=T0), R(access="payment-required", ts=T0 + 60),                      # A: free -> 402, never paid -> almost
        R(ts=T0 + 90000), R(access="payment-required", ts=T0 + 90100),            # A again next day -> repeat
        R(client="c:b", ts=T0), R(client="c:b", access="payment-required", ts=T0 + 30), R(client="c:b", access="paid", ts=T0 + 200, wallet="0x" + "1" * 40),  # B converts
        R(client="h:x", access="payment-failed", wallet="0x" + "2" * 40, fail_reason="payment not valid: insufficient_funds", ts=T0 + 10),  # C signed, failed
        R(client="h:y", access="payment-failed", wallet="0x" + "2" * 40, fail_reason="settlement failed", ts=T0 + 5000),  # same wallet, other id -> repeat by wallet
        R(client="c:d", ts=T0), R(client="c:d", access="payment-required", ts=T0 + 2000),  # 402 after > 10 min: not almost
        R(client="c:withgrokbot", ts=T0), R(client="c:withgrokbot", access="payment-required", ts=T0 + 5),  # self: excluded
        R(client="h:z", ts=T0 + 100000), R(client="h:z", access="payment-required", ts=T0 + 100010),  # open (now inside window)
    ]
    rep = analyse(rows, now_ts=T0 + 100100)
    t = rep["totals"]
    assert t["almost_paid_sessions"] == 4, t
    assert t["with_signed_failed_payment"] == 2 and t["after_free_answer"] == 2, t
    assert t["open_sessions"] == 1 and t["paid_conversions"] == 1 and t["paid_after_free_answer"] == 1, t
    kinds = sorted(r["linked_by"] for r in rep["repeat_callers"])
    assert kinds == ["client", "wallet"], rep["repeat_callers"]
    assert rep["excluded_rows_by_tag"].get("self") == 2
    assert all("c:a" not in json.dumps(r) for r in rep["repeat_callers"]), "ids are hashed"
    print("selftest ok:", json.dumps(t))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-10-05", help="PT date")
    ap.add_argument("--free-window", type=float, default=float(os.environ.get("ALMOST_FREE_WINDOW_MIN", 10)), help="minutes")
    ap.add_argument("--pay-window", type=float, default=float(os.environ.get("ALMOST_PAY_WINDOW_MIN", 15)), help="minutes")
    ap.add_argument("--rows")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "results", "almost_paid.json"))
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    since_pt = dt.datetime.fromisoformat(a.start).replace(tzinfo=PT)
    since_utc = since_pt.astimezone(dt.timezone.utc).replace(tzinfo=None)
    rows = json.load(open(a.rows)) if a.rows else dw.query_ae(since_utc, sql)
    now = dt.datetime.now(dt.timezone.utc)
    rep = analyse(rows, int(now.timestamp()), int(a.free_window * 60), int(a.pay_window * 60))
    rep = {"generated_at": now.astimezone(PT).strftime("%Y-%m-%d %H:%M PT"), "since_pt": a.start,
           "definition": {"free_window_min": a.free_window, "pay_window_min": a.pay_window,
                          "text": __doc__.split("\n\n")[1].replace("\n", " ")},
           **rep}
    rep["summary"] = summary(rep, a.start)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(rep, f, indent=2)
    print("\n".join(rep["summary"]))


if __name__ == "__main__":
    main()
