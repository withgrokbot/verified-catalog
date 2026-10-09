#!/usr/bin/env bash
# Weekly (Monday): re-download every public x402 list we can read (no logins, no payments), crawl EVERY listed endpoint
# once, unpaid and SSRF-gated, deduped by normalized URL, at most 3 requests in flight per host; rebuild /v1/skips +
# /v1/receipts (page 1 bundled, everything else in Workers KV, changed keys only); run the Worker tests; upload KV;
# deploy; verify live; push the data + scripts to withgrokbot/verified-catalog (withgrokbot identity only).
# Prints one COVERAGE line at the end for the weekly report.
# Usage: bash /workspace/factory/jobs/BM-001-verified-catalog/receipts/scripts/weekly_refresh_skips.sh
#   DRY_RUN=1   -> stop after tests (no KV upload, no deploy, no push)
#   SKIP_FETCH=1 -> reuse the lists already in receipts/crawl (debugging only)
# Never pays anything: no payment headers are ever sent, no wallet is loaded.
set -euo pipefail
JOB=/workspace/factory/jobs/BM-001-verified-catalog
R=$JOB/receipts; APP=$JOB/app; S=$R/scripts
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$R/logs"; LOG="$R/logs/weekly-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1
echo "== weekly refresh $STAMP (log $LOG)"
WR() { (cd "$APP/worker" && env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx -y -p node@22 -p wrangler@latest wrangler "$@"); }

# 1) lists -> temp dir; swap into crawl/ only if the Bazaar lists came back complete
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ "${SKIP_FETCH:-0}" != "1" ]; then
  mkdir -p "$TMP/lists" && python3 "$S/fetch_lists.py" "$TMP/lists"
  mkdir -p "$R/crawl" && find "$R/crawl" -maxdepth 1 -type f -delete && cp "$TMP/lists"/* "$R/crawl/"
fi

# 2) crawl every endpoint (box, not the Worker: no subrequest/CPU limits involved)
cd "$S" && CRAWL_DIR="$R/crawl" python3 crawl_probe.py
python3 - "$R" <<'PY'
import sys, os
r = sys.argv[1]; name = open(os.path.join(r, "latest.txt")).read().strip()
n = sum(1 for _ in open(os.path.join(r, name))); print("receipts:", n); assert n >= 5000, "crawl too small; not publishing"
PY

# 3) Worker data + KV payload; the COVERAGE line comes from here
python3 "$S/build_worker_data.py" | tee "$TMP/build.out"
COV=$(grep '^COVERAGE' "$TMP/build.out")

# 4) tests
cd "$APP" && node tests/worker_test.mjs
if [ "${DRY_RUN:-0}" = "1" ]; then echo "DRY_RUN: stopping before KV upload/deploy"; echo "$COV"; exit 0; fi

# 5) KV first (changed keys only), so the new bundle never points at missing pages
N=$(python3 -c "import json;print(len(json.load(open('$R/kv/changed.json'))))")
if [ "$N" -gt 0 ]; then
  [ "$N" -le 900 ] || { echo "KV change set $N > 900 (free plan: 1,000 writes/day); not uploading"; exit 1; }
  WR kv bulk put "$R/kv/changed.json" --binding CRAWL_KV --remote
  cp "$R/kv/pending.json" "$R/kv/uploaded.json"
fi
echo "kv keys written: $N"

# 6) deploy + verify live (cache-busted)
WR deploy
WANT=$(python3 -c "import json,re;s=open('$APP/worker/src/receipts-data.js').read();m=json.loads(re.search(r'RECEIPTS_META = (\{.*?\});', s).group(1));print(m['crawled_at'], m['endpoints_covered'])")
GOT=""
for i in 1 2 3 4 5 6; do
  GOT=$(curl -fsS "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/skips.json?cb=$RANDOM$RANDOM" | python3 -c "import json,sys;j=json.load(sys.stdin);print(j['crawled_at'], j['endpoints_covered'])" || true)
  [ "$GOT" = "$WANT" ] && break; sleep 10
done
[ "$GOT" = "$WANT" ] || { echo "LIVE CHECK FAILED: got '$GOT' want '$WANT'"; exit 1; }
LAST=$(python3 -c "import json;s=json.load(open('$R/kv/bulk.json'));print(max(int(b['key'][2:]) for b in s if b['key'].startswith('s:')))")
curl -fsS "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/skips.json?page=$LAST&cb=$RANDOM" | python3 -c "import json,sys;j=json.load(sys.stdin);assert j['skips'], 'last skip page empty';print('live last skip page', j['page'], 'ok')"
echo "live /v1/skips: $GOT"

# 7) push data + crawl scripts to the public repo (brand identity only)
export GH_CONFIG_DIR=/workspace/.gh-brand
REPO="$TMP/vc"; gh repo clone withgrokbot/verified-catalog "$REPO" -- -q
cp "$APP/worker/src/receipts-data.js" "$REPO/worker/src/receipts-data.js"
mkdir -p "$REPO/scripts/weekly-crawl" && cp "$S"/{fetch_lists.py,crawl_probe.py,build_worker_data.py,payai_credits.py,weekly_refresh_skips.sh} "$REPO/scripts/weekly-crawl/"
cd "$REPO" && git add worker/src/receipts-data.js scripts/weekly-crawl
if git diff --cached --quiet; then echo "repo already up to date"; else
  git -c user.name=withgrokbot -c user.email=336192572+withgrokbot@users.noreply.github.com commit -qm "Weekly /v1/skips refresh: $COV"
  git push -q origin HEAD:main && echo "pushed $(git rev-parse --short HEAD)"
fi

# 8) PayAI free credits left (read-only estimate) + the one-line summary
CRED=$(python3 "$S/payai_credits.py" | python3 -c "import json,sys;j=json.load(sys.stdin);print(f\"payai_credits_left~{j['payai_credits_left_est']} (~{j['settlements_left_at_rate_est']} Base settlements; {j['settlements_to_pay_to']} so far; PayAI stats 30d: {j.get('payai_stats_settlements_30d')})\")" || echo "payai_credits_left=unknown")
echo "== done $STAMP"
echo "$COV $CRED"
