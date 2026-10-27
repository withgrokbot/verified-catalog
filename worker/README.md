# 402xAgent Worker (formerly Spot-Check) + reliability lookup

402xAgent (formerly x402 Endpoint Spot-Check) checks an x402 endpoint right before your agent pays. Since 0.17.0 the
canonical home is https://402xagent.com (browser landing page + every API route) with https://api.402xagent.com as the
API host. The original https://verified-catalog-lookup.withgrokbot.workers.dev and the older hosts keep answering every
API, x402 and MCP call unchanged; only browser page views (GET with Accept: text/html, no payment header) on those hosts
get a 301 to the same path on 402xagent.com. The x402 `resource` is the host the client called, so payments verify on
any host; links in responses (receipts, skips, docs) and x402 discovery point at 402xagent.com. Route paths, response
fields and MCP tool names are unchanged (`/v1/products/endpoint-spot-check`, `endpoint_spot_check`); the MCP
serverInfo name is now `402xagent`.

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
GET /v1/products/endpoint-spot-check # x402 Endpoint Spot-Check, 5 free/day then $0.02 USDC flat (0.38.0)
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

## History, reason codes and confidence (0.29.0, 0.30.0)

- Every check records one observation per fresh probe in D1 (`endpoint_history`, last 30 per normalized URL; key is a hash of the URL). Answers and receipts carry `history`: `observations`, `stable_for_days`, `stable_since`, `last_changed`, `drift` (summary only, never the raw price or wallet). Paid, router and exempt check answers (0.34.0) also get `history_observations`: the last 30 observations, newest first (observed_at, http_status, price_usd, amount_atomic, network, asset, pay_to). Free answers, dry runs and receipts keep the summary only.
- Every verdict carries `reason_code` (stable machine code) and `confidence` (`high` | `medium` | `low`). Free answers keep the plain-words `reason`. Codes and confidence rules: `/rules` (HTML) and `/rules.json`.

## Free-check network cap (0.33.0)

Free live checks: 5 per client name per UTC day **and** at most 25 per network (IP; IPv6 /64) per UTC day across all client names. Over the network cap the check answers HTTP 429 with `Retry-After` (seconds to 00:00 UTC) and points to the paid check ($0.02 flat) and the router pack ($0.20 for 10 checks). The IP is only kept as a salted hash (`CLIENT_SALT`) in the QuotaCounter Durable Object. Paid, router, dry-run and self-test checks are unchanged.

## Status badge (0.32.0)

`/badge/<host>.svg` (optional `?path=/exact/path`) shows only the real current status: green **pay · stable N days** when the latest stored live verdict is pay and under 72 h old; grey **stale** (pay, older) or **not verified** (skip, recheck, nothing yet). The badge never fetches the host and never writes; one D1 read, `Cache-Control: max-age=300`. `/badge/<host>` is a small page with the current status, the receipt link (redacted public view) and these embed snippets. Every receipt includes `badge.markdown` and `badge.html`.

```markdown
[![402xAgent status](https://402xagent.com/badge/api.example.com.svg)](https://402xagent.com/badge/api.example.com)
```

```html
<a href="https://402xagent.com/badge/api.example.com"><img src="https://402xagent.com/badge/api.example.com.svg" alt="402xAgent status"></a>
```

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

## 0.36.0: daily re-check (badge hosts)

- Cron `17 10 * * *` (10:17 UTC = 03:17 PDT / 02:17 PST), alongside the existing `*/20 * * * *`.
- Re-runs the free, unpaid 402 probe (same endpoint-spot-check handler, exempt `withgrokbot-selftest` client, ref `daily-recheck`, access_tier `auto` so receipts stay redacted) on one listed endpoint per badge host (26, `src/daily.js`). Never pays.
- Batching: the daily trigger seeds today's queue in D1 and checks 8 URLs (~3 subrequests each, ~24 + a few D1 calls, under 50). The rest drain on the 20-min cron's idle steps (8 per step, in place of that step's stale recheck; never on a Bazaar step), so 26 hosts finish in the daily run + 3 steps (~1 h).
- No duplicate work: a URL with a non-request-sourced receipt under 20 h old is marked done without a probe. The Bazaar list's endpoints are not probed here; the 20-min cron already re-checks all of them once per UTC day.
- Storage: D1 tables `daily_runs` + `daily_queue` (migrations/0006, queue rows older than 14 days pruned). **KV writes per run: 0.** Apply before deploy: `npx wrangler d1 migrations apply vc-spot-receipts --remote`. Without it the job fails open (no-op) and pages show "Last checked: pending".
- Pages: `last_checked` in /saves.json (latest daily re-check) and /bazaar.json (= generated_at); a "Last checked: YYYY-MM-DD HH:MM UTC" line on /saves, /bazaar and /badge/<host> (that host's latest receipt); `x-402xagent-last-checked` header on badge SVGs. Off switch: `DAILY_RECHECK = "off"`.

## 0.37.0: seller reputation + response quality (additive only)

No existing field, verdict, reason_code or confidence changes (x402-spotcheck 1.x safe). **KV writes: 0.**

- `quality` (src/quality.js): from the unpaid probe that already runs (never pays the seller): reachability, HTTP 402 status, content-type (JSON body, or terms in the PAYMENT-REQUIRED header), output schema declared (x402 v2 `extensions.bazaar` info/schema, or v1 `accepts[].outputSchema`) and, when the challenge publishes a sample (`info`, `output.example`), whether it validates. Codes: `quality_ok`, `quality_unverified`, `quality_bad_content_type`, `quality_schema_mismatch`, `quality_bad_status`, `quality_unreachable` (/rules.json `quality_codes`). Paid/router/exempt: `{code, checks}`; free and dry runs: `{code}`.
- Stored: D1 `endpoint_quality` (migrations/0007), one row per fresh probe, last 30 per URL hash; metadata only (status, media type, bytes, schema flags, code, host). No bodies, headers, paths or query strings.
- `reputation` (src/reputation.js): one 0..100 score per seller host, computed on read (4 indexed D1 reads, no writes) from spot_receipts, endpoint_history and endpoint_quality. `score = round(100 * Σ w·c / Σ w)` over components with data; weights stability 25, drift 20, verdicts 30, freshness 10, quality 15; verdicts = pay_share × (0.5 + 0.5 × consistency); a host with ≥ 5 pay/skip checks and pay_share < 0.2 is capped at 49 (low). Under 5 observations or first seen < 2 days ago: `insufficient_data`, score null. Published at /rules and /rules.json `reputation`. Paid/router/exempt: score, band, confidence, breakdown, inputs; free and dry runs: `{host, band}`. Free page: `/reputation/<host>` (+ `.json`), band only. Cron self-checks skip the reputation read.
- Apply before deploy: `npx wrangler d1 migrations apply vc-spot-receipts --remote`. Without it the Worker fails open (no quality rows; reputation leaves out the quality component).

## Signed receipts (0.37.3)

New receipts carry `kid` + `signature`: ed25519 (base64url) over the RFC 8785 (JCS) canonical JSON of the served receipt minus `signature`. Public keys: `/.well-known/402xagent-keys.json` (alias `/.well-known/402xagent-receipt-key.json`; linked from `/.well-known/x402` as `receipt_keys`). Verify offline: `/docs#receipt-signatures` or `x402-spotcheck` 1.1.0 `verifyReceipt()`.

- Key generation (local, once): `node worker/scripts/gen-receipt-key.mjs` writes the private JWK to `~/.secrets/402xagent-receipt-ed25519.json` (mode 600, never printed) and the public part into `src/sign.js`.
- Secret (deploy step, operator only): `wrangler secret put RECEIPT_SIGNING_KEY < ~/.secrets/402xagent-receipt-ed25519.json`.
- No secret, an unpublished key, or any error: receipts are stored unsigned exactly as before. 0 KV writes.
- Rotation: generate a new key (`--out` a new path), deploy with both public keys listed, then switch the secret. Keep old keys listed.

## Payment status (0.40.0): the after-payment check

`POST /v1/products/payment-status` with JSON `{"payment_payload":"<base64 PAYMENT-SIGNATURE you sent>","seller_url":"<url>"}` (or `tx_hash`, or `from` + `nonce` + `valid_before`). Base USDC (EIP-3009 exact) only. It answers `status` (landed | not_landed | pending | canceled | unknown), `safe_to_retry_same_payload` (always true), and `safe_to_resign`. `safe_to_resign` is true only when two independent RPC sources agree the nonce is unused and the chain head is past validBefore + 120 s. The answer also carries tx details, `terms_match`, `claim`, `cannot_know`, `finality`, `rpc` (source names only) and a signed `receipt`. Price and free quota are the same as the check: $0.02, and the same 5 free per day counter. A bare request answers the x402 402 (amount 20000).

Chain reads use these sources, in this order:
- `ALCHEMY_BASE_RPC_URL` (secret): `https://base-mainnet.g.alchemy.com/v2/<key>`. Never logged or returned.
- `RPC2_BASE_URL`: default `https://base-rpc.publicnode.com` (Allnodes, keyless). Configurable; `off` disables it.
- `RPC3_BASE_URL` (0.40.1, secret): a keyed second provider (e.g. Infura), tried after Alchemy and ahead of keyless sources; `PAYSTATUS_RPC3_LOG_WINDOW` (default 9000 blocks).
- Alchemy free tier caps `eth_getLogs` at 10 blocks, so on Alchemy the nonce-only lookup uses `alchemy_getAssetTransfers` (newest 100 USDC transfers from the payer, full history) and reads at most `PAYSTATUS_ALCHEMY_MAX_RECEIPTS` (default 20) receipts. Cancellations are confirmed on Alchemy only by reading the cancel tx another source located.
- 0.40.1: every paid call (payment-status and spot-check) stores its own signed receipt with `payment_received` (payer, amount, settle tx); payment-status paid receipts embed and link the chain answer (`chain_answer`).
- `https://mainnet.base.org` (Coinbase): `PAYSTATUS_PUBLIC_RPC` overrides it, `off` disables both public nodes.
- `https://base.drpc.org` (dRPC, keyless): `PAYSTATUS_PUBLIC_RPC2` overrides it.

Answers name sources only, never URLs. Free-tier limits found on 2026-10-16:
- publicnode: no receipts or logs older than its recent window without a token (HTTP 403).
- mainnet.base.org: rate-limits `eth_getLogs` (429).
- dRPC: caps `eth_getLogs` at a few hundred blocks.
- llamarpc: down (525).

So looking up a payment by from + nonce alone finds its event only within the last ~5 h (send `tx_hash` or `valid_before` for older ones). Alchemy lifts these limits.
With no secrets set there is only one source, so `safe_to_resign` is never true. Each answer costs 2–4 point RPC reads (`eth_getBlockByNumber`, `eth_call authorizationState`, a bounded topic-filtered `eth_getLogs`, `eth_getTransactionReceipt`). There are no KV writes. D1 table `payment_status` (migration 0008) stores final answers only. Optional `PAYSTATUS_FACILITATORS` takes JSON of the form `{"0xsubmitter":{"name":"…","contact":"…"}}` to name the relayers behind a facilitator.


## Hosted mode (0.41.0, part one)
Integrator keys for routers/wallets: `Authorization: Bearer 402x_live_<id>_<secret>` (or `x-402xagent-key`) on the check and payment status. 1,000 free hosted checks (lifetime), then $0.02, $0.01 for each billable check after the first 1,000 in a UTC month; cached answers count. Credit limit $20 until the first invoice is paid, then $100 (from `hosted_usage`); over it the call takes the normal free/x402 path. D1 only (migration 0009: `integrators` with the key hash only, `hosted_usage` one row per hosted receipt). Secret `HOSTED_KEY_PEPPER` (without it a keyed call gets 501; calls without a key are unchanged). `GET /v1/integrators/me` shows the meter. Owner tool: `node scripts/hosted_key.mjs pepper|issue <name>|revoke <id>|meter <id>`. Not yet: invoices and the invoice cron (part two).

## Facilitator pre-settle check (0.53.0)

`POST /v1/facilitator/check` with JSON `{paymentRequirements: {scheme, network, amount, asset, payTo, resource?}, url?, method?}`
is meant for a facilitator's `onBeforeSettle` hook. It re-reads the seller's live 402 terms for the resource with
`spotProbe` (same SSRF guards on every redirect, 8 s timeout, 64 KB cap, never a payment header; a 405 to GET is
retried once with POST) and compares scheme, network (CAIP-2; x402 v1 names mapped), amount (integer), asset and
payTo (EVM case-insensitive) against every live accepts entry. Answer: `{match, mismatches[{field, expected, live}],
live_terms_sha256, checked_at, recommendation}`; `settle` only on an exact match, else `hold`. Errors also carry
`recommendation: "hold"`: 400 `bad_input` / `ssrf_blocked` (nothing probed, no rate tick), 429 `rate_limited`,
502 `seller_unreachable` / `seller_redirect_blocked`, 503 `busy`, 504 `seller_timeout`.
Free for now: 60 per minute per caller IP (`QuotaCounter`, key `fck:` + `quotaKey()` IP digest (salted, daily, IPv6 /64;
never the raw IP; `?client=` is ignored so rotating it gains nothing), counter `fck`) and 30 probes per minute per
seller host across all callers (key `fckh:<lowercase hostname>`, counter `fckh`; over it: 429 `host_rate_limited`,
nothing probed). Unlike other routes, a counter error or missing `QUOTA` binding fails CLOSED here: 503
`limiter_unavailable`, `hold`, nothing probed. x402 v1 sellers (`maxAmountRequired`, v1 network names) compare the same way. Both are separate from the
spot-check 5/day. No D1/KV writes, no logging. A `paymentPayload` in the body is ignored and never echoed or stored.
Not on the pricing page. Code: `worker/src/facilcheck.js`; tests: `tests/facilcheck_test.mjs`.

## Post-payment delivery check (0.53.3, off by default)

"Did I get what I paid for." Our own paid check rounds (`scripts/run_checks.py --pay`) classify the seller's response
after settlement with `scripts/delivery.py`: `delivery_flag` ok|failed plus a reason (`server_error`, `http_error`,
`empty_body`, `challenge_page`, `soft_paywall`, `canned_refusal`, `error_body`, `placeholder_body`, `no_response`).
The Worker never pays a seller; `scripts/delivery_upload.py` copies the flags (hkey, host, time, flag, reason, status only)
into D1 `delivery_checks` (migration 0020, additive). With `DELIVERY_CHECK=1`: a new check whose verdict would be `pay`
returns `recheck` / `delivery_failed` when the endpoint's latest delivery check in the last 14 days failed, and host
reputation gets a `delivery` component (weight 15, only for hosts with delivery rows). Skip/recheck verdicts, stored
receipts and sellers without delivery data are unchanged. Code: `src/delivery.js`; tests: `tests/delivery_test.mjs`,
`tests/delivery_test.py` (fixtures in `tests/fixtures/delivery/`).
