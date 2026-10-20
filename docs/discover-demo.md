# /v1/discover demo (0.43.0, LOCAL ONLY, not deployed)

**Status: preliminary.** This run uses the newest crawl we have, `receipts-20261013T143614Z.jsonl` (121,785 receipts: 54,504 pay, 32,084 skip, 35,197 recheck; last checked 2026-10-13T14:59:54Z). The crawl has not been updated since Oct 13 (a separate fix is in progress). As a result every result is `stale: true` and every crawl "pay" is older than 7 days, so it comes back as `recheck` (`original_verdict: "pay"`), and `verdict=pay` returns 0 results. **The final demo will be re-run once the crawl is fresh.** Run the same script against a freshly seeded D1.

Receipts are unsigned here because local dev has no `RECEIPT_SIGNING_KEY`. Signing is covered by `tests/discover_test.mjs`, which signs with a test key and verifies ed25519 over JCS.

## Run it
```bash
cd worker   # Node 22+
npx wrangler d1 migrations apply RECEIPTS_DB --local --persist-to ../.wrangler-state
node scripts/seed-discover.mjs <path>/receipts-20261013T143614Z.jsonl /tmp/discover-seed.sql
npx wrangler d1 execute RECEIPTS_DB --local --persist-to ../.wrangler-state --file /tmp/discover-seed.sql
npx wrangler dev --local --port 8793 --persist-to ../.wrangler-state
scripts/demo-discover.sh http://127.0.0.1:8793
```

## Sample output (2026-10-20, local D1 seeded with the Oct 13 crawl; results trimmed by jq to the key fields)
```text

$ curl -s 'http://127.0.0.1:8793/v1/discover?q=weather&limit=3'
{
  "query": {
    "q": "weather",
    "verdict": null,
    "limit": 3
  },
  "count": 3,
  "index_last_crawled": "2026-10-13T14:59:54Z",
  "index_stale": true,
  "results": [
    {
      "endpoint": "https://raffle-app-avs2z.ondigitalocean.app/weather",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-13T14:58:49Z",
      "stale": true,
      "verdict": "skip",
      "reason": "domain does not resolve (DNS)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://sbx-x402.sapa-ai.com/weather",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-13T14:58:37Z",
      "stale": true,
      "verdict": "skip",
      "reason": "domain does not resolve (DNS)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://sandbox-mcp-vaxm.vercel.app/weather",
      "verified_price_usd": 0.001,
      "network": "eip155:8453",
      "last_checked": "2026-10-13T14:58:36Z",
      "stale": true,
      "verdict": "recheck",
      "reason": "last pay check is older than 7 days; run the free check before paying",
      "original_verdict": "pay",
      "signed": false
    }
  ]
}
[HTTP 200, 0.149878s]

$ curl -s 'http://127.0.0.1:8793/v1/discover?q=crypto+price&verdict=pay&limit=3'
{
  "query": {
    "q": "crypto price",
    "verdict": "pay",
    "limit": 3
  },
  "count": 0,
  "index_last_crawled": "2026-10-13T14:59:54Z",
  "index_stale": true,
  "results": []
}
[HTTP 200, 0.016949s]

$ curl -s 'http://127.0.0.1:8793/v1/discover?q=crypto+price&verdict=recheck&limit=3'
{
  "query": {
    "q": "crypto price",
    "verdict": "recheck",
    "limit": 3
  },
  "count": 3,
  "index_last_crawled": "2026-10-13T14:59:54Z",
  "index_stale": true,
  "results": [
    {
      "endpoint": "https://nova-crypto-prices.nova-data.workers.dev/prices",
      "verified_price_usd": 0.01,
      "network": "eip155:8453",
      "last_checked": "2026-10-13T14:56:40Z",
      "stale": true,
      "verdict": "recheck",
      "reason": "last pay check is older than 7 days; run the free check before paying",
      "original_verdict": "pay",
      "signed": false
    },
    {
      "endpoint": "https://x402-wrapper.onrender.com/v1/crypto-price",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-13T14:56:40Z",
      "stale": true,
      "verdict": "recheck",
      "reason": "endpoint did not answer in 5 s, try again later",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://nova-crypto-prices.nova-data.workers.dev/prices/:coin",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-13T14:56:39Z",
      "stale": true,
      "verdict": "recheck",
      "reason": "listing URL is a template (like /:id), check a filled-in URL",
      "original_verdict": null,
      "signed": false
    }
  ]
}
[HTTP 200, 0.050519s]

$ curl -s 'http://127.0.0.1:8793/v1/discover?verdict=skip&limit=2'
{
  "query": {
    "q": null,
    "verdict": "skip",
    "limit": 2
  },
  "count": 2,
  "index_last_crawled": "2026-10-13T14:59:54Z",
  "index_stale": true,
  "results": [
    {
      "endpoint": "https://market.datapackvibe.com",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-13T14:59:54Z",
      "stale": true,
      "verdict": "skip",
      "reason": "no x402 payment request (HTTP 200)",
      "original_verdict": null,
      "signed": false
    },
    {
      "endpoint": "https://monthly-javascript-abroad-english.trycloudflare.com/liveness/0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      "verified_price_usd": null,
      "network": null,
      "last_checked": "2026-10-13T14:58:56Z",
      "stale": true,
      "verdict": "skip",
      "reason": "domain does not resolve (DNS)",
      "original_verdict": null,
      "signed": false
    }
  ]
}
[HTTP 200, 0.012795s]

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
      "endpoint": "https://pulse402.6ynqsr8bxd.workers.dev/v1/news/search",
      "verdict": "skip",
      "reason": "no x402 payment request (HTTP 400)"
    }
  ]
}

# rate limit (60/min per client): 65 requests
status counts:      60 200       5 429 
```
