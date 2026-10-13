#!/usr/bin/env python3
"""Verdict mix + per-host funnel from Analytics Engine (vc_lookups), read-only. Worker 0.22.0+ fields:
blob17 mistake (spot-bad-params), blob18 request shape, blob19 verdict (check-route 200s incl. dry runs), blob20 host.
Rows before 0.22.0 have no host/verdict and show as host "(pre-0.22)" / verdict "(unrecorded)".
Usage: CF_ACCOUNT_ID=... CF_API_TOKEN=... python3 scripts/funnel_weekly.py [--days 7] [--json out.json]"""
import argparse, collections, datetime as dt, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import demand_weekly as dw

STAGES = ("page_view", "free_check", "dry_run", "402", "paid")


def stage(r):
    a, p = r.get("access") or "", r.get("product") or ""
    if a.startswith("view-pack"):
        return "402" if a == "view-pack-402" else None  # the pack's own 402/paid rows come from its handler too
    if a.startswith("view-"):
        return "page_view"
    if a.startswith("dry-run"):
        return "dry_run"
    if a == "payment-required":
        return "402"
    if a == "paid" or a == "router-prepaid":
        return "paid"
    if a in ("free", "partner") or (a == "exempt" and p == "spot"):
        return "free_check" if p in ("spot", "") else None  # free lookups are not the check funnel
    return None


def sql(since):
    return f"""SELECT blob1 AS client, blob3 AS task, blob4 AS endpoint, blob6 AS reason, blob9 AS ua, blob11 AS ref,
 blob13 AS access, blob16 AS product, blob17 AS detail, blob18 AS shape, blob19 AS verdict, blob20 AS host, toUInt32(timestamp) AS ts
 FROM vc_lookups WHERE timestamp >= toDateTime('{since.strftime('%Y-%m-%d %H:%M:%S')}') LIMIT 200000"""


def report(rows):
    out = {"verdicts": {"all": collections.Counter(), "real": collections.Counter()}, "funnel": collections.defaultdict(collections.Counter), "funnel_real": collections.defaultdict(collections.Counter), "mistakes": collections.Counter()}
    for r in rows:
        real = not dw.bot_tag(r)
        st = stage(r)
        h = r.get("host") or "(pre-0.22)"
        if st:
            out["funnel"][h][st] += 1
            if real:
                out["funnel_real"][h][st] += 1
        if (r.get("product") == "spot" or not r.get("product")) and r.get("access") in ("free", "partner", "exempt", "paid", "router-prepaid") or (r.get("access") or "").startswith("dry-run"):
            if r.get("access") != "dry-run-capped":
                v = r.get("verdict") or "(unrecorded)"
                out["verdicts"]["all"][v] += 1
                if real:
                    out["verdicts"]["real"][v] += 1
        if r.get("access") == "spot-bad-params" and r.get("detail"):
            out["mistakes"][r["detail"]] += 1
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json")
    a = ap.parse_args(argv)
    since = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(days=a.days)
    o = report(dw.query_ae(since, sql))
    v = o["verdicts"]
    fmt = lambda c: " ".join(f"{k}={c[k]}" for k in sorted(c)) or "none"
    print(f"verdict mix {a.days}d: all {fmt(v['all'])} | real {fmt(v['real'])}")
    for h in sorted(o["funnel"]):
        f, fr = o["funnel"][h], o["funnel_real"][h]
        print(f"funnel {h}: " + " ".join(f"{s}={f[s]}({fr[s]} real)" for s in STAGES))
    if o["mistakes"]:
        print("400 mistakes: " + " ".join(f"{k}={n}" for k, n in o["mistakes"].most_common(8)))
    if a.json:
        def plain(x):  # nested Counters/dicts -> dicts; scalars (counts) as-is
            return {k: plain(v) for k, v in x.items()} if isinstance(x, dict) else x
        json.dump(plain(o), open(a.json, "w"), indent=2)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # one line, no traceback: outputs are kept in reports and must not carry local paths
        print(f"funnel_weekly failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        sys.exit(1)
