"""0.28.0 one-off: apply price_below_listing to a stored crawl jsonl without recrawling (same rule as crawl_probe.judge)."""
import json, re, sys, collections
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from crawl_probe import USDC_MAINNET, SANE_MAX_USD
RX = re.compile(r"^asks a different price than listed \(listed \$([0-9.eE+-]+), asks \$([0-9.eE+-]+)\)$")
path = sys.argv[1]; rows = [json.loads(l) for l in open(path) if l.strip()]
before = collections.Counter(r.get("verdict") for r in rows); flipped = 0; above = 0
for r in rows:
    m = r.get("verdict") == "skip" and RX.match(str(r.get("reason") or ""))
    if not m: continue
    a, b = float(m.group(1)), float(m.group(2))
    if b >= a: above += 1; continue
    n_, as_ = str(r.get("network") or "").lower(), str(r.get("asset") or "").lower()
    if not (0 < b <= SANE_MAX_USD):
        r["reason"] = f"price looks wrong (${b:g})"; continue
    if n_ not in USDC_MAINNET:
        r["reason"] = f"wants payment on a testnet or a network we don't support ({r.get('network')})"; continue
    if as_ != USDC_MAINNET[n_]:
        r["reason"] = f"asks for a token other than USDC on {r.get('network')} ({r.get('asset')})"; continue
    r["verdict"] = "pay"; r["reason"] = f"live price lower than listed (listed ${a:g}, asks ${b:g})"; r["recomputed"] = "price_below_listing 2026-10-13"; flipped += 1
after = collections.Counter(r.get("verdict") for r in rows)
open(path, "w").write("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
print(json.dumps({"before": before, "after": after, "flipped_to_pay": flipped, "above_listing_kept_skip": above}))
