# Ops counters (0.48.0): paywall funnel, 404 path log, explicit 405/400

## What is counted (D1 `vc-spot-receipts`, migration `0014_ops_counts.sql`, no KV writes)

- `paywall_daily(day, route, segment, event, reason, n)`, per UTC day and paywalled route:
  - `402`: a 402 was served (with or without a payment header)
  - `attempt`: the request carried `X-PAYMENT` or `PAYMENT-SIGNATURE`
  - `failed` + `reason`: `bad_sig | wrong_network_or_asset | insufficient_amount | expired | facilitator_error | other`
    (from the rejection text; a header that isn't base64 JSON counts as `bad_sig`; a payTo mismatch counts as `other`)
  - `settled`: the answer carried `PAYMENT-RESPONSE`
  - `not_charged`: there was a header but no settlement and no 402 (for example, free quota left, exempt or a 400)
  - `segment`: `self` when the signer (`authorization.from`) is our `PAY_TO` or one of `DRILL_WALLETS` (comma list, a `[vars]` entry or
    secret, unset by default), otherwise `outside`. This is decided at request time and only the label is stored. A 402 served
    with no payment header has no wallet to check, so it counts as `outside`.
- `notfound_daily(day, method, path, n)`: every 404 is stored as a normalized method + path only. No query string; hex runs, 0x values,
  UUIDs, numbers, long tokens and emails are collapsed; the result is capped at 120 characters.
- Never stored: IPs, wallets, payment payloads/proofs, tx hashes, query strings, client values.
- Kill switch: `OPS_COUNTERS = "off"`.

## Read

- `GET /v1/ops/stats?days=7` with `Authorization: Bearer $WATCH_STATS_TOKEN` (404 without it). It returns `paywall_funnel[route][segment]` and `not_found.top20`.
- Weekly top 20: `worker/scripts/ops_weekly.sh` (read-only `wrangler d1 execute --remote`), or the curl line inside it.

## Deploy order (not done in 0.48.0's branch)

1. Apply the migration remotely (prepared, NOT applied):
   `cd worker && env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN WRANGLER_CACHE_DIR=/tmp/wrangler-cache npx -y -p node@22 -p wrangler@latest wrangler d1 migrations apply vc-spot-receipts --remote --config wrangler.toml`
2. Deploy. If the Worker deploys before the migration is applied, the counter writes fail silently (waitUntil, caught) and `/v1/ops/stats` returns 503 `store_unavailable`. Answers are unaffected.

## 405 / 400

- 405: `Allow` header plus `{error:"method_not_allowed", message, method, allowed[], path, openapi, skill}`. A non-GET request to an unknown path
  is now a 404 (before 0.48.0 every non-GET request to any unmatched path was a 405).
- 400: each JSON 400 gets `field`, `expected`, `received` (sanitized: URLs lose their query string; wallets, hashes, long tokens, emails and
  payment/client fields are shown only as a character count) and `openapi`. On `/mcp`, the same details go in `error.data` (JSON-RPC shape kept).
  The badge SVG 400 (`/badge/<bad host>`) stays an SVG image so `<img>` embeds still render.
- `/skill.md` is new (it is linked from 405 bodies).
