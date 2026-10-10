# PayScout Worker (formerly Spot-Check) + reliability lookup

PayScout (formerly x402 Endpoint Spot-Check) checks an x402 endpoint right before you pay. Since 0.15.0 the same Worker
serves https://payscout.dev (browser landing page + every API route), https://api.payscout.dev (API) and the original
https://verified-catalog-lookup.withgrokbot.workers.dev, with identical routes, responses and payments on all three (no
redirects between hosts; the x402 `resource` is the host the client called, and payments verify on any host). Route paths,
response fields and MCP tool names are unchanged (`/v1/products/endpoint-spot-check`, `endpoint_spot_check`); the MCP
serverInfo name is now `payscout`.

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
GET /v1/products/endpoint-spot-check # x402 Endpoint Spot-Check, 1 free/day then $0.25 USDC (0.6.2)
                                     # Decision-shaped: verdict/reason/quoted vs claimed. Never pays target. MCP: endpoint_spot_check
    optional: endpoint=<id or url>, limit=<services, default 10>, client=<your agent name>, payer=<0x wallet>,
              ref=<where you found it, e.g. via-readme>
GET /v1/products/endpoint-spot-check?url=<endpoint>&mode=dry-run   # free dry run (0.13.0); ref=dry-run-<caller> also sets it
GET /v1/receipts?type=dry-run[&ref=<ref>][&limit=1-100][&cursor=<next_cursor>]   # stored dry-run receipts (type=self-checked: ours; type=live: pre-0.14 rows), free
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
  Per-router refs (0.11.0, Spot-Check): `via-cdp`, `via-x402scan`, `via-agentkit`, `via-lucid`, `via-payai`; the
  x402-spotcheck guard (0.2.1+) sends `via-x402-spotcheck` unless the integrator passes its own `ref`. Any ref is accepted.
  Bot tags (0.11.0, blob6): `scanner` (bare call, no params), `example-param` (example.com target or the documented
  web-search/0.01 example, without ref/client), `indexer` (named x402 indexer UAs), plus `self`/`uptime`/`crawler`.
  Views (access `view-*`) are counted on the $9 pack, /v1/skips, /v1/receipts and the docs routes.
- Verdicts (0.14.0, Spot-Check): `pay` only for a readable 402 on a supported mainnet (Base, Ethereum, OP, Polygon,
  Arbitrum, Avalanche, Solana) in that network's canonical USDC, at the listed price, to the listed pay_to. `skip` for no
  paywall (any response without 402 terms: `no_paywall`), a wrong network vs the listing (`network_mismatch`), a testnet or
  unknown network (`network_unsupported`), any other token (`asset_not_usdc`), a different pay_to (`pay_to_mismatch`) or price
  (`price_mismatch`), an unreadable 402 (`bad_challenge`), SSRF. `recheck` only for transient cases: `timeout`, `unreachable`
  (network error), `server_error` (5xx), and `free_trial_active` (the target sends `x-free-trial` / `x-free-trial-remaining`;
  paid tier adds `free_trial_remaining`; still skip if the listing already shows a mismatch). The weekly crawl and /v1/skips
  apply the same rules (build_worker_data.py re-applies the mainnet/USDC rule to older crawls).
- Payment object (0.14.0): a paid or self-test `pay` answer carries `payment` = {network, asset (canonical USDC), amount
  {atomic, usd}, pay_to, deadline (UTC; the 402's validBefore, else probed_at + maxTimeoutSeconds, else + 60 s),
  deadline_source} (plus the older flat scheme/amount_atomic/amount_usd/asset_is_usdc fields for x402-spotcheck 0.2.x).
- Determinism (0.14.0): one live probe per normalized URL + method is reused for 5 minutes (`SPOT_PROBE_CACHE_S`, D1, so
  global), so two consecutive calls get the same verdict even when the target answers callers differently (trials) or flaps.
  `probe: {probed_at, cached, cache_ttl_s}` in the paid answer and every receipt says which probe was used.
- Receipts (0.14.0): every call that probes is stored in D1 with `check_type` `self-checked` (our exempt self-test client;
  the weekly crawl is self-checked too) or `dry-run` (everyone else, and `mode=dry-run`), plus `mode` / `dry_run`. Not stored:
  SSRF-blocked or bad-parameter calls (nothing was probed) and unpaid 402 answers (no decision was delivered, and a public
  receipt would hand out the paid terms for free). Rows stored before 0.14.0 read as `check_type: "live"`.
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

## Spot-Check dry runs (0.13.0)

`mode=dry-run` (or `ref=dry-run-<caller>`) runs one unpaid probe of the target, signs and pays nothing (a payment header is
ignored), and always stores a public receipt in D1 (`check_type: "dry-run"`, `mode: "dry-run"`; `self-checked` when our own self-test
client runs it). The receipt holds
the url, the listing (claimed price, pay_to, network and their source, if any), the live demand (the 402 terms: scheme(s),
network, asset, amount, pay_to; or what came back instead: HTTP status, `x-free-trial` headers), verdict + reason, `checked_at`
(UTC) and the ref / caller (`<caller>` from `ref=dry-run-<caller>`). Never a client id, IP or payer. Read it at
`/v1/receipts/<id>` or list newest first with `/v1/receipts?type=dry-run` (`ref=`, `limit`, `cursor`).

Abuse guard: the answer is the free-tier shape (verdict + plain-words reason) with `payment_terms_sha256: null` and no
`payment` object, so a dry run is never an approval (x402-spotcheck and the router hooks need a live check's hash or terms
to pay). Dry runs are capped at 50 per caller per UTC day (key: ref, else client, else IP hash; `SPOT_DRY_PER_DAY`) and 200
per IP hash per UTC day across refs (`SPOT_DRY_PER_IP_DAY`), then 429; a capped call probes nothing. Analytics: blob6 and
blob13 are `dry-run` (`dry-run-capped` on a 429), never qualifying; demand_weekly.py leaves them out of paid and
real-client counts.

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
