#!/usr/bin/env bash
# 0.48.0: weekly ops pull from D1 (vc-spot-receipts): top 20 normalized 404 paths and the paywall funnel, last 7 UTC days.
# Read-only. Needs a wrangler login (or CLOUDFLARE_API_TOKEN with D1 read). Usage: worker/scripts/ops_weekly.sh [days]
# Alternative without wrangler: curl -s -H "Authorization: Bearer $WATCH_STATS_TOKEN" "https://api.402xagent.com/v1/ops/stats?days=7"
set -euo pipefail
DAYS="${1:-7}"
case "$DAYS" in ''|*[!0-9]*) echo "days must be an integer" >&2; exit 2;; esac
cd "$(dirname "$0")/.."
SINCE="$(date -u -d "-$((DAYS - 1)) days" +%F)"
W=(npx -y -p node@22 -p wrangler@latest wrangler d1 execute vc-spot-receipts --remote --config wrangler.toml)
echo "== top 20 404 paths since $SINCE (UTC)"
"${W[@]}" --command "SELECT method, path, SUM(n) AS n FROM notfound_daily WHERE day >= '$SINCE' GROUP BY method, path ORDER BY n DESC, path LIMIT 20"
echo "== paywall funnel since $SINCE (UTC)"
"${W[@]}" --command "SELECT route, segment, event, reason, SUM(n) AS n FROM paywall_daily WHERE day >= '$SINCE' GROUP BY route, segment, event, reason ORDER BY route, segment, event, reason"
