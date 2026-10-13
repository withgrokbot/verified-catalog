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

# 0) deploy only committed code: the factory worker + tests must equal withgrokbot/verified-catalog HEAD
#    (receipts-data.js is the one generated file; it is committed below before the deploy). Checked now and again before deploy.
export GH_CONFIG_DIR=/workspace/.gh-brand
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/vc"
clean_or_die() {
  rm -rf "$REPO" && gh repo clone withgrokbot/verified-catalog "$REPO" -- -q
  local d
  d=$(diff -rq --exclude=node_modules --exclude=.wrangler --exclude=receipts-data.js "$APP/worker" "$REPO/worker"; diff -rq --exclude=run_tests.py --exclude=__pycache__ "$APP/tests" "$REPO/tests") || true
  if [ -n "$d" ]; then echo "REFUSING ($1): factory tree differs from withgrokbot/verified-catalog HEAD $(git -C "$REPO" rev-parse --short HEAD):"; echo "$d"; exit 1; fi
  echo "factory tree == repo HEAD $(git -C "$REPO" rev-parse --short HEAD) ($1)"
}
[ "${DRY_RUN:-0}" = "1" ] || clean_or_die "start"

# 1) lists -> temp dir; swap into crawl/ only if the Bazaar lists came back complete
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

# 5) KV first (changed keys only, under a daily write budget), so the new bundle never points at missing pages
set +e; python3 "$S/kv_upload.py"; KRC=$?; set -e
[ "$KRC" = 3 ] && { echo "KV budget reached: rest deferred; rerun tomorrow (UTC) to finish, then deploy"; exit 3; }
[ "$KRC" = 0 ] || { echo "KV upload failed"; exit 1; }

# 6) commit the data locally, re-check the tree is clean, deploy that commit, verify live (cache-busted)
REPO_HEAD_BEFORE=$(git -C "$REPO" rev-parse HEAD)
clean_or_die "pre-deploy"
cp "$APP/worker/src/receipts-data.js" "$REPO/worker/src/receipts-data.js"
mkdir -p "$REPO/scripts/weekly-crawl" && cp "$S"/{fetch_lists.py,crawl_probe.py,build_worker_data.py,payai_credits.py,weekly_refresh_skips.sh,kv_upload.py} "$REPO/scripts/weekly-crawl/" && cp "$APP/scripts/almost_paid.py" "$APP/scripts/funnel_weekly.py" "$REPO/scripts/"
git -C "$REPO" add worker/src/receipts-data.js scripts/weekly-crawl scripts/almost_paid.py scripts/funnel_weekly.py
if git -C "$REPO" diff --cached --quiet; then CHANGED=0; else CHANGED=1; git -C "$REPO" -c user.name=withgrokbot -c user.email=336192572+withgrokbot@users.noreply.github.com commit -qm "Weekly /v1/skips refresh: $COV"; fi
[ "$(git -C "$REPO" log -1 --format=%an)" = "withgrokbot" ] || { echo "REFUSING: commit author is not withgrokbot"; exit 1; }
WR deploy
WANT=$(python3 -c "import json,re;s=open('$APP/worker/src/receipts-data.js').read();m=json.loads(re.search(r'RECEIPTS_META = (\{.*?\});', s).group(1));print(m['crawled_at'], m['endpoints_covered'])")
GOT=""
for i in 1 2 3 4 5 6; do
  GOT=$(curl -fsS -H "accept: application/json" "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/skips.json?cb=$RANDOM$RANDOM" | python3 -c "import json,sys;j=json.load(sys.stdin);print(j['crawled_at'], j['endpoints_covered'])" || true)
  [ "$GOT" = "$WANT" ] && break; sleep 10
done
[ "$GOT" = "$WANT" ] || { echo "LIVE CHECK FAILED: got '$GOT' want '$WANT'"; exit 1; }
LAST=$(python3 -c "import json;s=json.load(open('$R/kv/bulk.json'));print(max(int(b['key'][2:]) for b in s if b['key'].startswith('s:')))")
curl -fsS -H "accept: application/json" "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/skips.json?page=$LAST&cb=$RANDOM" | python3 -c "import json,sys;j=json.load(sys.stdin);assert j['skips'], 'last skip page empty';print('live last skip page', j['page'], 'ok')"
echo "live /v1/skips: $GOT"

# 7) push the commit that was deployed (brand identity only); rebase over any github-actions commit meanwhile
cd "$REPO"
if [ "$CHANGED" = "0" ]; then echo "repo already up to date"; else
  git pull -q --rebase origin main && git push -q origin HEAD:main && echo "pushed $(git rev-parse --short HEAD)"
fi

# 8) PayAI free credits left (read-only estimate) + the one-line summary
CRED=$(python3 "$S/payai_credits.py" | python3 -c "import json,sys;j=json.load(sys.stdin);print(f\"payai_credits_left~{j['payai_credits_left_est']} (~{j['settlements_left_at_rate_est']} Base settlements; {j['settlements_to_pay_to']} so far; PayAI stats 30d: {j.get('payai_stats_settlements_30d')})\")" || echo "payai_credits_left=unknown")
# 9) almost-paid report (read-only Analytics Engine SQL; free answer -> paid 402 -> no payment within 15 min; repeats)
ALMOST=$(cd "$APP" && CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-aa4453a0042a949537d2fcae99590a5f}" python3 scripts/almost_paid.py --start "${ALMOST_START:-2026-10-05}" 2>&1) || ALMOST="almost_paid=unavailable (${ALMOST%%$'\n'*})"
echo "$ALMOST"
ALMOST1=$(printf '%s\n' "$ALMOST" | head -1); ALMOST3=$(printf '%s\n' "$ALMOST" | sed -n 3p)
# 10) verdict mix + per-host funnel (read-only Analytics Engine SQL; Worker 0.22.0+ blob19 verdict, blob20 host)
FUNNEL=$(cd "$APP" && CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-aa4453a0042a949537d2fcae99590a5f}" python3 scripts/funnel_weekly.py --days 7 2>&1) || FUNNEL="funnel=unavailable (${FUNNEL%%$'\n'*})"
echo "$FUNNEL"
echo "== done $STAMP"
echo "$COV $CRED | $ALMOST1${ALMOST3:+; $ALMOST3} | $(printf '%s\n' "$FUNNEL" | head -1)"
