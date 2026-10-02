# Reliability lookup Worker

One free JSON endpoint on the Cloudflare Workers free plan. It answers "is endpoint E reliable for task X at price <= Y?"
from the catalog's own data and counts distinct clients for the demand test. It stores no catalog data itself.

Live: https://verified-catalog-lookup.withgrokbot.workers.dev/ (deployed 2026-09-30; test day 1 = 2026-10-01).

```
GET /v1/lookup?task=web-search&max_price=0.01&n=5     # n = paid receipts per service (1-20, default 5)
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
- Weekly report: `python3 scripts/demand_weekly.py --start <day 1>` (needs `CF_ACCOUNT_ID` and a read-only
  `CF_API_TOKEN` with Account Analytics: Read).

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
