"""Read-only estimate of PayAI free credits left for our receiving wallet (PAY_TO). PayAI has no per-wallet
balance endpoint (its /openapi.json lists none, Oct 9) for the free allowance, so: 1,000 lifetime credits minus our settlements to PAY_TO, each weighted
at PayAI's live Base rate (GET /pricing; settlements before 2026-09-21 count 1 credit).
Settlements = our own self-test payments in the spend ledger (service ids verified-catalog-lookup*) + outside paid
calls from Analytics Engine (needs CF_API_TOKEN analytics-read; skipped if absent). Prints one JSON line. Never pays."""
import json, os, sys, datetime, urllib.request, urllib.parse, urllib.error
JOB = "/workspace/factory/jobs/BM-001-verified-catalog"
ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "aa4453a0042a949537d2fcae99590a5f")
ALLOWANCE, CUTOVER = 1000.0, "2026-09-21"

def base_rate():
    try:
        j = json.load(urllib.request.urlopen(urllib.request.Request("https://facilitator.payai.network/pricing", headers={"user-agent": "verified-catalog-credits-check"}), timeout=20))
        r = [x for x in j["rates"] if x["network"] == "eip155:8453" and x["scheme"] == "exact" and x.get("transferMethod") == "eip3009"]
        return float(r[0]["credits"]) if r else None
    except Exception:
        return None

def ledger_self():
    L = json.load(open(JOB + "/app/results/spend_ledger.json"))["entries"]
    return {e["tx"].lower(): e["ts"] for e in L if str(e.get("service_id", "")).startswith("verified-catalog-lookup") and e.get("status") == "settled" and e.get("tx")}

def ae_outside():
    tok = os.environ.get("CF_API_TOKEN")
    if not tok: return None
    sql = ("SELECT toUInt32(timestamp) AS ts, blob14 AS tx, blob6 AS reason FROM vc_lookups WHERE blob13 = 'paid' "
           "AND timestamp >= toDateTime('2026-09-01 00:00:00') LIMIT 100000")
    try:
        req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/analytics_engine/sql", data=sql.encode(),
                                     headers={"Authorization": "Bearer " + tok, "Content-Type": "text/plain"})
        rows = json.load(urllib.request.urlopen(req, timeout=60)).get("data", [])
        return {r["tx"].lower(): (datetime.datetime.fromtimestamp(int(float(r["ts"])), datetime.timezone.utc).isoformat(), r.get("reason") == "self") for r in rows if r.get("tx")}
    except Exception:
        return None

def payai_stats():
    """Cross-check from PayAI itself (read-only, public): GET /discovery/resources/{resource}/stats per paid resource.
    Only covers settlements PayAI attributes to a Bazaar resource (not direct /settle tests); last30d is exact."""
    base = "https://verified-catalog-lookup.withgrokbot.workers.dev"
    n = 0
    try:
        for path in ("/v1/lookup/paid", "/v1/lookup", "/v1/products/endpoint-spot-check", "/v1/products/overnight-cos-pack"):
            u = "https://facilitator.payai.network/discovery/resources/" + urllib.parse.quote(base + path, safe="") + "/stats"
            try:
                j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": "verified-catalog-credits-check"}), timeout=20))
            except urllib.error.HTTPError:
                continue
            n += int((j.get("settlements") or {}).get("last30d") or 0)
        return n
    except Exception:
        return None

rate = base_rate()
led, ae = ledger_self(), ae_outside()
txs = {tx: ts for tx, ts in led.items()}
for tx, (ts, _) in (ae or {}).items(): txs.setdefault(tx, ts)
all_ts = list(txs.values())
selfs = [tx for tx in txs if tx in led or (ae and ae.get(tx, (0, False))[1])]
outs = None if ae is None else [tx for tx in txs if tx not in selfs]
used = sum(1.0 if t[:10] < CUTOVER else (rate or 2.31) for t in all_ts)
out = {"payai_credits_left_est": round(ALLOWANCE - used, 1), "settlements_to_pay_to": len(all_ts), "self": len(selfs),
       "outside": None if outs is None else len(outs), "base_rate_credits": rate,
       "settlements_left_at_rate_est": int((ALLOWANCE - used) // (rate or 2.31)),
       "simple_1000_minus_settlements": int(ALLOWANCE - len(all_ts)),
       "payai_stats_settlements_30d": payai_stats(),
       "note": "estimate; PayAI exposes no allowance balance API. Cloudflare egress IPs may also draw a shared-host pool."}
print(json.dumps(out))
