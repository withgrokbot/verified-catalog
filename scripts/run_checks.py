#!/usr/bin/env python3
"""Run the catalog checks, write results, rebuild the site.

Default is a FREE, DRY-RUN check: one unpaid request per service, parse the HTTP 402
challenge, no payment is ever signed or sent.

Paid checks need ALL of: --pay, a wallet (--wallet FILE or env PROBE_WALLET_KEY), and room
under the hard caps ($0.10 per call, $1.00 per UTC day, $20.00 lifetime). Caps given on the
command line can only lower those limits. Only USDC 'exact' on Base is ever signed.

Usage:
  python3 scripts/run_checks.py                 # free checks for every service (default)
  python3 scripts/run_checks.py --only id1,id2  # subset
  python3 scripts/run_checks.py --pay --wallet ../secrets/wallet.json --only some-id
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import x402_probe as xp  # noqa: E402
import build_site  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default=os.path.dirname(HERE), help="site root (default: folder above scripts/)")
    ap.add_argument("--services", help="services file (default: <site>/data/services.json)")
    ap.add_argument("--only", help="comma-separated service ids")
    ap.add_argument("--timeout", type=float, default=20)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--run-id")
    ap.add_argument("--no-build", action="store_true", help="do not rebuild the site")
    ap.add_argument("--pay", action="store_true", help="make PAID calls (off by default)")
    ap.add_argument("--wallet", help="wallet JSON with private_key (kept out of the site folder)")
    ap.add_argument("--network", choices=sorted(xp.NETWORKS), default="base")
    ap.add_argument("--per-call-cap", type=float)
    ap.add_argument("--per-day-cap", type=float)
    ap.add_argument("--lifetime-cap", type=float)
    a = ap.parse_args(argv)

    site = os.path.abspath(a.site)
    services_path = a.services or os.path.join(site, "data", "services.json")
    with open(services_path, encoding="utf-8") as fh:
        services = json.load(fh)["services"]
    if a.only:
        want = {s.strip() for s in a.only.split(",") if s.strip()}
        services = [s for s in services if s["id"] in want]
        missing = want - {s["id"] for s in services}
        if missing:
            ap.error(f"unknown service id(s): {', '.join(sorted(missing))}")

    results_dir = os.path.join(site, "results")
    ledger_path = os.path.join(results_dir, "spend_ledger.json")
    guard = xp.SpendGuard(ledger_path, a.per_call_cap, a.per_day_cap, a.lifetime_cap)
    signer = None
    if a.pay:
        if a.wallet:
            wallet = os.path.abspath(a.wallet)
            if wallet.startswith(site + os.sep):
                ap.error("refusing to use a wallet file inside the site folder (it could be published)")
            signer = xp.EvmSigner.from_wallet_file(wallet)
        elif os.environ.get("PROBE_WALLET_KEY"):
            signer = xp.EvmSigner(os.environ["PROBE_WALLET_KEY"])
        else:
            ap.error("--pay needs --wallet FILE or env PROBE_WALLET_KEY")
        print(f"PAID MODE: wallet {signer.address}, network {a.network}, caps {guard.summary()['caps_usd']}, "
              f"spent so far ${guard.summary()['total_usd']}")
    else:
        print("DRY-RUN (free checks only, no payments). Use --pay to enable paid calls.")

    now = xp.utc_now()
    run_id = a.run_id or now.strftime("%Y%m%dT%H%M%SZ")
    raw_dir = os.path.join(results_dir, "raw", run_id)
    os.makedirs(raw_dir, exist_ok=True)

    def one(svc):
        return xp.check_service(svc, timeout=a.timeout, signer=signer, guard=guard, network=a.network)

    if signer:  # paid calls run one at a time so the caps are checked in order
        pairs = [one(s) for s in services]
    else:
        with ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
            pairs = list(ex.map(one, services))

    results = []
    for res, raw in pairs:
        rel = f"results/raw/{run_id}/{res['service_id']}.json"
        raw["run_id"] = run_id
        raw["checked_at"] = res["checked_at"]
        with open(os.path.join(site, rel), "w", encoding="utf-8") as fh:
            json.dump(raw, fh, indent=2)
        res["run_id"] = run_id
        res["raw_log"] = rel
        results.append(res)

    latest_path = os.path.join(results_dir, "latest.json")
    prev = {}
    if os.path.exists(latest_path) and a.only:
        with open(latest_path, encoding="utf-8") as fh:
            prev = {r["service_id"]: r for r in json.load(fh).get("results", [])}
    merged = dict(prev)
    merged.update({r["service_id"]: r for r in results})
    allr = list(merged.values())  # summary covers the latest result of every service, not just this run
    summary = {
        "services_checked": len(allr),
        "checked_this_run": len(results),
        "reachable": sum(1 for r in allr if r["reachable"]),
        "x402_challenge_ok": sum(1 for r in allr if r["x402_challenge"]),
        "price_matches_listing": sum(1 for r in allr if r["price_matches_listing"]),
        "paid_calls": sum(1 for r in allr if r["paid"]),
    }
    latest = {"schema": 1, "generated_at": xp.iso_z(now), "run_id": run_id, "mode": "paid" if signer else "dry-run",
              "checker_version": xp.CHECKER_VERSION, "summary": summary, "spend": guard.summary(),
              "results": sorted(merged.values(), key=lambda r: r["service_id"])}
    with open(latest_path, "w", encoding="utf-8") as fh:
        json.dump(latest, fh, indent=2)
    with open(os.path.join(results_dir, "history.jsonl"), "a", encoding="utf-8") as fh:
        for r in results:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")
    if not guard.entries and not os.path.exists(ledger_path):
        guard._save()

    for r in results:
        print(f"  {r['service_id']:<34} reachable={'yes' if r['reachable'] else 'no ':<3} status={r['http_status']} "
              f"latency={r['latency_ms']}ms 402={'yes' if r['x402_challenge'] else 'no'} "
              f"quoted=${r['quoted_price_usd']} listed=${r['advertised_price_usd']} "
              + (f"paid={r['paid']} valid={r['delivered_valid']} charged=${r['charged_price_usd']} "
                 f"refused={r['payment_refused_reason']}" if signer else ""))
    print("summary:", json.dumps(summary), "spend:", json.dumps(guard.summary()))
    if not a.no_build:
        build_site.build(site)
        print("site rebuilt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
