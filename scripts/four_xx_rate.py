#!/usr/bin/env python3
"""4xx rate of the verified-catalog Worker, by route family, from read-only sources. Stdlib only. (0.71.0)

4xx here means client errors other than 402 (402 is the x402 paywall working as designed; it is counted on its own).
Source 1 (HTTP status per request): the Worker's Analytics Engine dataset vc_lookups (worker/src/lib.js dataPoint()).
  blob16 product (spot, lookup, lookup-paid, pack, paystatus, mcp, view), blob13 access (e.g. spot-bad-params,
  ps-bad-params, view-receipts), blob6 'self' for our own clients, double3 HTTP status, _sample_interval for sampling.
  It sees only the routes that write a data point: the free check, lookup, pack, payment-status and the page views. The
  render, page-to-markdown, pdf-tables, endpoint-report, watch, feed and MCP-protocol routes write none, so their 4xx
  are NOT in this number (before or after): compare like with like.
Source 2 (optional, --d1): 404s per day from D1 notfound_daily via read-only `wrangler d1 execute --remote` (one SELECT).
  Only 404s are logged there, aggregated by normalized path; 400/422 are not.

Auth: CF_ACCOUNT_ID (or --account) and a token with Account Analytics: Read in AE_READ_TOKEN (or CF_API_TOKEN). Never printed.

Measure now:      python3 scripts/four_xx_rate.py --days 7 --label baseline --out results/four_xx/baseline.json --d1
Re-measure +7d:   python3 scripts/four_xx_rate.py --days 7 --label after --out results/four_xx/after.json --d1 \
                      --compare results/four_xx/baseline.json
  (--end 'YYYY-MM-DD HH:MM:SS' pins the window end in UTC; default now. Run the "after" window only once 7 full days have
   passed since the deploy, so it holds no pre-deploy traffic. Note the deploy time in --label, e.g. after-deployed-20261119T1500Z.)
Offline test: --rows rows.json (the AE JSON "data" array) skips the network.
"""
import argparse, collections, datetime as dt, json, os, subprocess, sys, urllib.request, urllib.error

DEFAULT_ACCOUNT = "aa4453a0042a949537d2fcae99590a5f"  # account id, not a secret
WRANGLER_DIR = "/home/box/tools/wrangler"
WRANGLER_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "wrangler.toml")


def ae_sql(start, end):
    f = "%Y-%m-%d %H:%M:%S"
    return (f"SELECT blob16 AS product, blob13 AS access, double3 AS status, if(blob6 = 'self', 1, 0) AS self, SUM(_sample_interval) AS n "
            f"FROM vc_lookups WHERE timestamp >= toDateTime('{start.strftime(f)}') AND timestamp < toDateTime('{end.strftime(f)}') "
            f"GROUP BY product, access, status, self ORDER BY n DESC LIMIT 5000 FORMAT JSON")


def query_ae(sql, account):
    tok = os.environ.get("AE_READ_TOKEN") or os.environ.get("CF_API_TOKEN")
    if not (account and tok):
        raise SystemExit("set CF_ACCOUNT_ID (or --account) and AE_READ_TOKEN (or CF_API_TOKEN), or pass --rows")
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql", data=sql.encode(),
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "text/plain"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode()).get("data", [])
    except urllib.error.URLError as e:
        raise SystemExit(f"Analytics Engine query failed: {e}")


def query_d1_404(start, end):
    """Total and top-15 404 paths for the UTC days in [start, end) from notfound_daily (read-only SELECT)."""
    d0, d1 = start.strftime("%Y-%m-%d"), (end - dt.timedelta(seconds=1)).strftime("%Y-%m-%d")
    out = {}
    for key, q in (("total", f"SELECT SUM(n) AS n FROM notfound_daily WHERE day >= '{d0}' AND day <= '{d1}'"),
                   ("top", f"SELECT method, path, SUM(n) AS n FROM notfound_daily WHERE day >= '{d0}' AND day <= '{d1}' GROUP BY method, path ORDER BY n DESC LIMIT 15")):
        env = {k: v for k, v in os.environ.items() if k != "CF_API_TOKEN"}
        p = subprocess.run([os.path.join(WRANGLER_DIR, "node_modules/.bin/wrangler"), "d1", "execute", "vc-spot-receipts", "--remote", "--json", "--config", WRANGLER_CONFIG, "--command", q],
                           cwd=WRANGLER_DIR, env=env, capture_output=True, text=True, timeout=120)
        t = p.stdout
        try:
            res = json.loads(t[t.index("["):])[0]["results"]
        except Exception:
            raise SystemExit("wrangler d1 failed: " + (p.stderr or t)[-300:])
        out[key] = int(res[0]["n"] or 0) if key == "total" else [{"method": r["method"], "path": r["path"], "n": int(r["n"])} for r in res]
    return out


def summarize(rows, start, end, d1=None, label=""):
    days = (end - start).total_seconds() / 86400
    tot = collections.Counter(); four = collections.Counter(); by_status = collections.Counter(); by_family = collections.defaultdict(collections.Counter); pay402 = collections.Counter()
    detail = []
    for r in rows:
        n, st = int(float(r["n"])), int(float(r["status"]))
        prod, acc, selfx = r.get("product") or "", r.get("access") or "", int(float(r.get("self") or 0))
        tot[("all", prod)] += n
        if st == 402: pay402[prod] += n
        if not selfx: tot[("outside", prod)] += n
        if 400 <= st < 500 and st != 402:  # 402 is the paywall working as designed, reported on its own below
            four[("all", prod)] += n
            if not selfx: four[("outside", prod)] += n
            by_status[st] += n
            by_family[prod][st] += n
            detail.append({"product": prod, "access": acc, "status": st, "self": bool(selfx), "n": n})
    fam = {}
    for prod in sorted({k[1] for k in tot}):
        fam[prod] = {"requests": tot[("all", prod)], "paywall_402": pay402[prod], "four_xx": four[("all", prod)], "requests_outside": tot[("outside", prod)], "four_xx_outside": four[("outside", prod)],
                     "by_status": dict(sorted(by_family[prod].items()))}
        for k in ("", "_outside"):
            q = fam[prod]["requests" + k]
            fam[prod]["rate_pct" + k] = round(100.0 * fam[prod]["four_xx" + k] / q, 2) if q else None
    all_req, all_4 = sum(v for k, v in tot.items() if k[0] == "all"), sum(v for k, v in four.items() if k[0] == "all")
    s = {"label": label, "window_utc": {"start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"), "days": round(days, 2)},
         "source": "Analytics Engine vc_lookups (routes that write a data point only)" + ("; D1 notfound_daily for 404" if d1 else ""),
         "total": {"requests": all_req, "paywall_402": sum(pay402.values()), "four_xx": all_4, "rate_pct": round(100.0 * all_4 / all_req, 2) if all_req else None, "four_xx_per_day": round(all_4 / days, 1) if days else None,
                   "by_status": dict(sorted(by_status.items()))},
         "by_family": fam, "detail": sorted(detail, key=lambda d: -d["n"])}
    if d1: s["d1_404"] = {**d1, "per_day": round(d1["total"] / days, 1) if days else None}
    return s


def show(s):
    t = s["total"]; w = s["window_utc"]
    print(f"[{s['label']}] {w['start']} .. {w['end']} ({w['days']} d)  source: {s['source']}")
    print(f"  4xx errors (402 excluded) {t['four_xx']} of {t['requests']} logged requests = {t['rate_pct']}%  ({t['four_xx_per_day']}/day)  by status {t['by_status']};  402 paywall answers (not errors): {t['paywall_402']}")
    print(f"  {'family':14} {'requests':>9} {'4xx':>7} {'rate%':>7} {'4xx(outside)':>13} {'402':>7}  by status")
    for p, f in sorted(s["by_family"].items(), key=lambda kv: -kv[1]["four_xx"]):
        print(f"  {p or '(none)':14} {f['requests']:>9} {f['four_xx']:>7} {str(f['rate_pct']):>7} {f['four_xx_outside']:>13} {f['paywall_402']:>7}  {f['by_status']}")
    print("  top 4xx rows (product / access / status), 402 excluded:")
    for d in s["detail"][:12]:
        print(f"    {d['n']:>6}  {d['product'] or '(none)'} / {d['access'] or '(none)'} / {d['status']}{'  [self]' if d['self'] else ''}")
    if "d1_404" in s: print(f"  404s (D1 notfound_daily): {s['d1_404']['total']} ({s['d1_404']['per_day']}/day); top: " + ", ".join(f"{x['method']} {x['path']} {x['n']}" for x in s["d1_404"]["top"][:5]))


def compare(a, b):
    print(f"\nCOMPARE {a['label']} -> {b['label']}  (rates are per logged request, so a different traffic level does not move them)")
    ta, tb = a["total"], b["total"]
    print(f"  4xx/day {ta['four_xx_per_day']} -> {tb['four_xx_per_day']};  4xx rate {ta['rate_pct']}% -> {tb['rate_pct']}%;  by status {ta['by_status']} -> {tb['by_status']}")
    key = lambda d: (d["product"], d["access"], d["status"], d["self"])
    ka = {key(d): d["n"] / a["window_utc"]["days"] for d in a["detail"]}; kb = {key(d): d["n"] / b["window_utc"]["days"] for d in b["detail"]}
    print("  per day, by (product / access / status):")
    for k in sorted(set(ka) | set(kb), key=lambda k: -(ka.get(k, 0) + kb.get(k, 0))):
        print(f"    {ka.get(k, 0):8.1f} -> {kb.get(k, 0):8.1f}  {k[0] or '(none)'} / {k[1] or '(none)'} / {k[2]}{' [self]' if k[3] else ''}")
    if "d1_404" in a and "d1_404" in b: print(f"  404/day {a['d1_404']['per_day']} -> {b['d1_404']['per_day']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=float, default=7); ap.add_argument("--end", help="UTC 'YYYY-MM-DD HH:MM:SS' (default now)")
    ap.add_argument("--label", default="run"); ap.add_argument("--out"); ap.add_argument("--compare", help="earlier --out JSON to compare with")
    ap.add_argument("--account", default=os.environ.get("CF_ACCOUNT_ID") or DEFAULT_ACCOUNT); ap.add_argument("--d1", action="store_true", help="also read 404s from D1 via wrangler (read-only)")
    ap.add_argument("--rows", help="AE 'data' JSON array instead of querying")
    a = ap.parse_args()
    end = dt.datetime.strptime(a.end, "%Y-%m-%d %H:%M:%S") if a.end else dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None)
    start = end - dt.timedelta(days=a.days)
    rows = json.load(open(a.rows)) if a.rows else query_ae(ae_sql(start, end), a.account)
    s = summarize(rows, start, end, query_d1_404(start, end) if a.d1 else None, a.label)
    show(s)
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        json.dump(s, open(a.out, "w"), indent=1); print("wrote", a.out)
    if a.compare: compare(json.load(open(a.compare)), s)


if __name__ == "__main__":
    main()
