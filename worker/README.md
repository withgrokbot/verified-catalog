# Reliability lookup Worker

One JSON endpoint on the Cloudflare Workers free plan. It answers "is endpoint E reliable for task X at price <= Y?"
from the catalog's own data and counts distinct clients for the demand test. It stores no catalog data itself.

**Pricing (0.3.0+; products 0.5.0 / spot-check 0.6.0):** 5 free `/v1/lookup` calls per client per UTC day, then HTTP 402 with an x402 payment requirement of
$0.02 USDC on Base. **Payment never changes results, sort order or listings**: it buys query access only, and free, paid
and exempt lookups run the same `lookup()` on the same data (unit-tested: paid and free results are identical).

Live: https://verified-catalog-lookup.withgrokbot.workers.dev/ (deployed 2026-09-30; test day 1 = 2026-10-01).

```
GET /v1/lookup?task=web-search&max_price=0.01&n=5     # n = paid receipts per service (1-20, default 5)
GET /v1/lookup/paid?task=...      # same lookup, always x402 $0.02 USDC on Base (no free quota); 402 has Bazaar metadata (0.4.0)
POST /mcp                         # free remote MCP (Streamable HTTP, stateless JSON-RPC): search_catalog, get_service, lookup (0.4.0)
GET /.well-known/x402             # x402 discovery fan-out (0.4.0)
GET /v1/products/overnight-cos-pack  # Overnight CoS Setup Pack, always $9 USDC via x402 (0.5.0)
                                     # MCP tool: get_overnight_cos_pack (paid; SELF_CLIENTS not exempt)
GET /v1/products/endpoint-spot-check # x402 Endpoint Spot-Check, 1 free/day then $0.25 USDC (0.6.0)
                                     # SSRF-safe probe; never pays the target. MCP: endpoint_spot_check
    optional: endpoint=<id or url>, limit=<services, default 10>, client=<your agent name>, payer=<0x wallet>,
              ref=<where you found it, e.g. via-readme>
GET /v1/tasks          task names -> service ids
GET /openapi.json      OpenAPI 3.1
```

- Data: `catalog.json` and `receipts.json` from `DATA_BASE_URL` (the Pages site), cached 5 minutes.
- Sorting: known-answer pass rate over the last n paid calls (no graded calls = last), then price, then id.
  Services marked facts only (broken on the seller's side) come back under `facts_only`, unsorted and without a pass rate.
- `stale` = newest paid receipt older than 36 h, or none yet.
- Counting: one Analytics Engine data point per lookup (dataset `vc_lookups`). Client id = the `client` value, or a
  SHA-256 of IP /24 (IPv6 /48) + User-Agent salted with `CLIENT_SALT` and a 7-day period aligned to `WEEK_EPOCH`.
  Raw IPs are never stored. Qualifying = task + max_price (or endpoint), at least 1 candidate, not self/crawler/uptime bot.
- Attribution (0.2.0): `ref` (blob11) and the Referer host (blob12) are stored next to the client id; they never change
  the client id, so many people clicking one tagged link still count as distinct clients. Links we publish carry
  `ref=via-readme`, `via-awesome-x402`, `via-awesome-mcp-servers`, `via-x`, `via-gh-issue`. Untagged browser clicks fall back to
  the Referer host (e.g. github.com); agents and curl usually send none.
- Free quota: one SQLite-backed Durable Object (`QuotaCounter`, binding `QUOTA`, free plan) per client key holds
  `{day, used}`. Key = `c:<client>` when `client` is sent, else `ip:` + SHA-256 of `CLIENT_SALT`, the UTC day and the IP
  (IPv6 /64). The User-Agent is not part of the quota key. Bad requests (400) never use the quota. If the counter is
  unreachable the call is served free (fail open). `SELF_CLIENTS` (by `client` value only) are exempt.
- Payment (x402 v2, `exact`, `eip155:8453`, USDC `0x8335…2913`, amount `20000` = $0.02, payTo `PAY_TO`): after the
  free calls the lookup answers 402 with `PAYMENT-REQUIRED` (base64 JSON, also in the body). A retry with
  `PAYMENT-SIGNATURE` (or `X-PAYMENT`) is checked against our own requirements, then `POST /verify` and `POST /settle`
  at `FACILITATOR_URL` (PayAI, `https://facilitator.payai.network`: public, Base mainnet, free tier of 1,000 settlements
  per receiving wallet with no API key or account). The answer is computed before settlement and is the same as a
  free answer; the settlement comes back in `PAYMENT-RESPONSE` and in the body's `access` block. A failed verify or
  settle answers 402 again with the reason; nothing is charged.
- Paid lookups in Analytics Engine: blob13 access (`free`, `paid`, `exempt`, `payment-required`, `payment-failed`),
  blob14 settlement tx, blob15 paying wallet, blob11 ref, double5 USD charged, double6 free calls used today.
  402 answers are not qualifying lookups.
- Weekly report: `python3 scripts/demand_weekly.py --start <day 1>` (needs `CF_ACCOUNT_ID` and a read-only
  `CF_API_TOKEN` with Account Analytics: Read). It includes paid lookups and revenue (by week and ref; our own
  self-test payments listed separately).

## Local test (no account needed)

```
cd worker
npx wrangler dev --local --var DATA_BASE_URL:http://127.0.0.1:8799/    # after: python3 -m http.server 8799 in the site root
curl "http://127.0.0.1:8787/v1/lookup?task=web-search&max_price=0.01&client=withgrokbot-selftest"
# unit tests: tests/worker_test.mjs in the build folder (not published)
```

Wrangler 4 needs Node 22+.

## Deploy (needs the brand's Cloudflare account)

```
npx wrangler login                      # browser OAuth as the brand Cloudflare account
npx wrangler secret put CLIENT_SALT     # any long random string, never committed
# set WEEK_EPOCH in wrangler.toml to the UTC date the first listing goes live
npx wrangler deploy                     # prints https://verified-catalog-lookup.<subdomain>.workers.dev
```

Then set `lookup_url` in `data/site.json` to the Worker URL (with a trailing slash), rebuild the site,
and the lookup section appears in `llms.txt`, the agent card and `catalog.json`.

Self-tests must send `client=withgrokbot-selftest` so they are not counted.
