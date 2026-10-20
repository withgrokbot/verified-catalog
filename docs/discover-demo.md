# /v1/discover demo (0.45.0, LOCAL ONLY, not deployed)

**Status: final run on the fresh crawl.** Local D1 seeded from `receipts-20261020T192957Z.jsonl` (122,891 receipts: 51,123 pay, 37,686 skip, 34,082 recheck; last checked 2026-10-20T19:52:33Z = 12:52 PM PDT). Results are `stale: false`, and `verdict=pay` now returns real pay results. Rebased onto main after the 0.44.0 D1 crawl cutover; the version is 0.45.0 because 0.44.0 is live.

Receipts are unsigned here because local dev has no `RECEIPT_SIGNING_KEY`. Signing is covered by `tests/discover_test.mjs`, which signs with a test key and verifies ed25519 over JCS.

## Run it
```bash
cd worker   # Node 22+
npx wrangler d1 migrations apply RECEIPTS_DB --local --persist-to ../.wrangler-state
node scripts/seed-discover.mjs <path>/receipts-20261020T192957Z.jsonl /tmp/discover-seed.sql
npx wrangler d1 execute RECEIPTS_DB --local --persist-to ../.wrangler-state --file /tmp/discover-seed.sql
npx wrangler dev --local --port 8793 --persist-to ../.wrangler-state
scripts/demo-discover.sh http://127.0.0.1:8793
```

## Sample output (2026-10-20, local D1 seeded with the Oct 20 crawl; results trimmed by jq to the key fields)
```text

$ curl -s 'http://127.0.0.1:8793/v1/discover?q=weather&limit=3'
{
  "query": {
    "q": "weather",
    "verdict": null,
    "limit": 3
  },
  "count": 3,
  "index_last_crawled": "2026-10-20T19:52:33Z",
  "index_stale": false,
  "results": [
    {
      "endpoint": "https://raffle-app-avs2z.ondigitalocean.app/weather",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-20T19:52:25Z",
      "stale": false,
      "verdict": "skip",
      "reason": "domain does not resolve (DNS)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://ca-weather-alerts-mcp.donniertf.workers.dev/x402/area_alerts",
      "verified_price_usd": 0.03,
      "network": "eip155:8453",
      "last_checked": "2026-10-20T19:52:24Z",
      "stale": false,
      "verdict": "pay",
      "reason": "payment request matches the listing (price, token, network, wallet)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://ca-weather-forecast-mcp.donniertf.workers.dev/x402/forecast",
      "verified_price_usd": 0.03,
      "network": "eip155:8453",
      "last_checked": "2026-10-20T19:52:24Z",
      "stale": false,
      "verdict": "pay",
      "reason": "payment request matches the listing (price, token, network, wallet)",
      "original_verdict": null,
      "signed": false
    }
  ]
}
[HTTP 200, 0.187561s]

$ curl -s 'http://127.0.0.1:8793/v1/discover?q=crypto+price&verdict=pay&limit=3'
{
  "query": {
    "q": "crypto price",
    "verdict": "pay",
    "limit": 3
  },
  "count": 3,
  "index_last_crawled": "2026-10-20T19:52:33Z",
  "index_stale": false,
  "results": [
    {
      "endpoint": "https://x402-crypto-price.netlify.app/v1/price",
      "verified_price_usd": 0.01,
      "network": "eip155:8453",
      "last_checked": "2026-10-20T19:50:45Z",
      "stale": false,
      "verdict": "pay",
      "reason": "payment request matches the listing (price, token, network, wallet)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://nova-crypto-prices.nova-data.workers.dev/prices",
      "verified_price_usd": 0.01,
      "network": "eip155:8453",
      "last_checked": "2026-10-20T19:50:43Z",
      "stale": false,
      "verdict": "pay",
      "reason": "valid payment request, no listed price to compare",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://currency-api-production-4a8d.up.railway.app/crypto/prices",
      "verified_price_usd": 0.001,
      "network": "eip155:8453",
      "last_checked": "2026-10-20T19:50:24Z",
      "stale": false,
      "verdict": "pay",
      "reason": "payment request matches the listing (price, token, network, wallet)",
      "original_verdict": null,
      "signed": false
    }
  ]
}
[HTTP 200, 0.016745s]

$ curl -s 'http://127.0.0.1:8793/v1/discover?q=crypto+price&verdict=recheck&limit=3'
{
  "query": {
    "q": "crypto price",
    "verdict": "recheck",
    "limit": 3
  },
  "count": 3,
  "index_last_crawled": "2026-10-20T19:52:33Z",
  "index_stale": false,
  "results": [
    {
      "endpoint": "https://coingecko-crypto-price-history.hergertsynthora.com",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-20T19:50:46Z",
      "stale": false,
      "verdict": "recheck",
      "reason": "server error (HTTP 502), try again later",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://nova-crypto-prices.nova-data.workers.dev/prices/:coin",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-20T19:50:43Z",
      "stale": false,
      "verdict": "recheck",
      "reason": "listing URL is a template (like /:id), check a filled-in URL",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://nova-crypto-prices.nova-data.workers.dev/prices/:coin/history",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-20T19:50:43Z",
      "stale": false,
      "verdict": "recheck",
      "reason": "listing URL is a template (like /:id), check a filled-in URL",
      "original_verdict": null,
      "signed": false
    }
  ]
}
[HTTP 200, 0.028065s]

$ curl -s 'http://127.0.0.1:8793/v1/discover?verdict=skip&limit=2'
{
  "query": {
    "q": null,
    "verdict": "skip",
    "limit": 2
  },
  "count": 2,
  "index_last_crawled": "2026-10-20T19:52:33Z",
  "index_stale": false,
  "results": [
    {
      "endpoint": "https://www.tetrac.xyz",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-20T19:52:28Z",
      "stale": false,
      "verdict": "skip",
      "reason": "no x402 payment request (HTTP 200)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://agent-audit-x402.vercel.app/api/agent-audit?url=https://example.com",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-20T19:52:28Z",
      "stale": false,
      "verdict": "skip",
      "reason": "payment request has no readable payment options",
      "original_verdict": null,
      "signed": false
    }
  ]
}
[HTTP 200, 0.013283s]

# input validation
$ curl 'http://127.0.0.1:8793/v1/discover?q=x' -> "q must be 2-100 characters: letters, digits, space and . _ : / -" [HTTP 400]
$ curl 'http://127.0.0.1:8793/v1/discover?verdict=maybe' -> "verdict must be pay, skip or recheck" [HTTP 400]
$ curl 'http://127.0.0.1:8793/v1/discover?limit=abc' -> "limit must be an integer 1-20" [HTTP 400]
$ curl 'http://127.0.0.1:8793/v1/discover?foo=1' -> "unknown parameter foo" [HTTP 400]

# MCP tool
$ curl -s -X POST http://127.0.0.1:8793/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover","arguments":{"q":"news","verdict":"skip","limit":2}}}'
{
  "isError": null,
  "count": 2,
  "results": [
    {
      "endpoint": "https://solo-newsletter-os.soloearn.workers.dev/download",
      "verdict": "skip",
      "reason": "price looks wrong ($39)"
    },
    {
      "endpoint": "https://pulse402.6ynqsr8bxd.workers.dev/v1/news/pulse",
      "verdict": "skip",
      "reason": "no x402 payment request (HTTP 400)"
    }
  ]
}

# rate limit (60/min per client): 65 requests
status counts:      60 200       5 429 
```
