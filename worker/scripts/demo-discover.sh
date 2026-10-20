#!/usr/bin/env bash
# 0.43.0/0.45.0 discovery demo against a LOCAL wrangler dev (never production). Usage: scripts/demo-discover.sh [base]
# Setup (from worker/, Node 22+):
#   npx wrangler d1 migrations apply RECEIPTS_DB --local --persist-to ../.wrangler-state
#   python3 ../scripts/weekly-crawl/build_discover_blobs.py <receipts-*.jsonl> /tmp/d-blobs.json   (0.45.0: d: blobs)
#   CRAWL_WORKER_DIR=$PWD python3 ../scripts/weekly-crawl/d1_upload.py --local --persist-to ../.wrangler-state --source discover --changed /tmp/d-blobs.json
#   (plus the crawl `meta` key, which the weekly d1_upload.py run writes; freshness comes from its crawled_at)
#   npx wrangler dev --local --port 8793 --persist-to ../.wrangler-state
set -u
B=${1:-http://127.0.0.1:8793}
short='{query, count, index_last_crawled, index_stale, results: [.results[] | {endpoint, verified_price_usd, network, last_checked, stale, verdict, reason, original_verdict, signed: (.receipt.signature != null)}]}'
run() { echo; echo "\$ curl -s '$B$1'"; curl -s -w '\n[HTTP %{http_code}, %{time_total}s]\n' "$B$1" | { body=$(cat); echo "$body" | sed '$d' | jq "$short" 2>/dev/null || echo "$body" | sed '$d'; echo "$body" | tail -1; }; }
run "/v1/discover?q=weather&limit=3"
run "/v1/discover?q=crypto+price&verdict=pay&limit=3"
run "/v1/discover?q=crypto+price&verdict=recheck&limit=3"
run "/v1/discover?verdict=skip&limit=2"
echo; echo "# input validation"
for u in "q=x" "verdict=maybe" "limit=abc" "foo=1"; do echo "\$ curl '$B/v1/discover?$u' -> $(curl -s "$B/v1/discover?$u" | jq -c .error) [HTTP $(curl -s -o /dev/null -w %{http_code} "$B/v1/discover?$u")]"; done
echo; echo "# MCP tool"
echo "\$ curl -s -X POST $B/mcp -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"discover\",\"arguments\":{\"q\":\"news\",\"verdict\":\"skip\",\"limit\":2}}}'"
curl -s -X POST "$B/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover","arguments":{"q":"news","verdict":"skip","limit":2}}}' | jq "{isError: .result.isError, count: .result.structuredContent.count, results: [.result.structuredContent.results[] | {endpoint, verdict, reason}]}"
echo; echo "# rate limit (60/min per client): 65 requests"
codes=$(for i in $(seq 65); do curl -s -o /dev/null -w '%{http_code}\n' -A demo-flood "$B/v1/discover?limit=1"; done | sort | uniq -c | tr '\n' ' '); echo "status counts: $codes"
