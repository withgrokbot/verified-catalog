# 0.49.2: docs placeholder hosts are rejected before any probe

Approved by Max. Live before this release: 0.49.1 (main ff64761, Worker version c9852dba-bfd6-49ff-9c84-d657e48e61fb).

## Hosts

`example.com`, `example.org`, `example.net` and any of their subdomains, plus `localhost` (and `*.localhost`), `127.0.0.1`,
`test.com`, `*.test`, `*.invalid` and `*.example`. Matching ignores case and a trailing dot. A URL given without a scheme
(`example.com/x`) also matches. The list lives in `worker/src/ops.js` (`isPlaceholderHost`, `isPlaceholderUrl`,
`placeholderSql`).

## Behaviour

Routes: `GET`/`POST /v1/products/endpoint-spot-check` (including `mode=dry-run` and the MCP tool, which uses the same handler),
`POST /v1/products/endpoint-report`, `POST /v1/products/endpoint-report/bulk` (any `urls[i]`) and `POST /v1/watch` (`url`).

The check runs after the basic parameter validation and before the listing lookup, the SSRF/DNS check, the probe,
the hosted key, the free quota and the payment verify. A placeholder request never fetches anything, never uses free
quota and never stores a receipt.

- **No payment header:** the route's normal 402 (same `accepts`, `PAYMENT-REQUIRED` header). This is the 0.49.1 shape
  (docs/input-error-0.49.1.md), plus:
  - `error`: `This looks like the docs placeholder. Submit a real x402 endpoint URL.`
  - `input_error`: `{code: "placeholder_host", field: "url" | "urls[i]", expected, received, note, message}`
  - headers: `x-402-input-error: <field>` and `x-402-placeholder: 1`
- **Payment header present:** a strict 400 `{error: <same message>, code: "placeholder_host", field, expected, received}`
  (plus openapi from explain400). This is returned before verify or settle, so nothing is charged.

## Counting (D1 only, no KV writes, no migration)

`opsWrap` reads `x-402-placeholder`. Such a request is written to `paywall_daily` with only one row:
`event = 'placeholder'`, `reason = 'unpaid' | 'paid'`. It is **not** counted as `402`, `attempt` or `not_charged`.
`paywall_daily` already allows any event/reason text, so **no migration is needed** (0016 was not created).

`/v1/ops/stats` (Bearer WATCH_STATS_TOKEN):
- per route/segment: `402`, `attempt` etc. are now the true counts. New fields: `placeholder`, `402_raw` (402 + unpaid
  placeholders) and `attempt_raw` (attempt + paid placeholders).
- `placeholder_hits`: the total for the window.
- `endpoints_checked` (from `spot_receipts`, the window since `since` 00:00 UTC): `endpoints` / `endpoints_raw` (distinct
  URLs), `checks` / `checks_raw`, `demand` / `demand_raw` (check_type != 'self-checked'), `demand_endpoints` /
  `demand_endpoints_raw`, and `placeholder_checks`. These numbers also filter old rows written before 0.49.2.

`worker/scripts/ops_weekly.sh` excludes `event = 'placeholder'` from the funnel, prints the placeholder hits separately,
and adds an endpoints-checked/demand query (true and raw) that uses the same SQL predicate as the Worker.
The public `/v1/skips.json` recent_checks list never publishes a placeholder host (test.com and 127.0.0.1 were added to the
existing junk-host filter).

Note: before 0.49.2, `paywall_daily` has no host, so old funnel rows cannot be split by placeholder. Only `spot_receipts`
(endpoints checked/demand) can be filtered retroactively.

## Tests

`tests/placeholder_test.mjs` (8 tests, real SQLite through all migrations). Existing fixtures that used `*.test` hosts now use
`*.fixture`, and the watch tests use `example-fixture.com`. The SSRF test now expects localhost/127.0.0.1 to be placeholder
402s, and the other private addresses keep their 400 ssrf_blocked.
Total: 175/175 (baseline 167 + 8).

## Deploy plan (not done in this change)

Commands run from `worker/` with
`env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN WRANGLER_CACHE_DIR=/tmp/wrangler-cache npx -y -p node@22 -p wrangler@latest wrangler`.

1. Merge `fix/0.49.2-placeholder-hosts` after review. Run all 6 test files on Node 22 (175/175).
2. No migration and no secret or var changes.
3. `… wrangler deploy --config wrangler.toml`, then record the new version id.
4. Verify:
   - `/health` reports 0.49.2.
   - `GET /v1/products/endpoint-spot-check?url=https://example.com/api/paid` returns a 402 with `input_error.code = placeholder_host`,
     the normal $0.02 accepts and `x-402-input-error: url`.
   - The same request with any `PAYMENT-SIGNATURE` returns a 400 with the same message and no settlement.
   - A real URL (`https://api.402rates.com/v1/ping`) still gives the free answer.
   - `POST /v1/products/endpoint-report {"url":"https://example.com/x"}` returns a 402 with input_error.
   - `/v1/ops/stats?days=1` shows `placeholder_hits` > 0 and `endpoints_checked`.
5. Watch for 24 h: spot-check 200/402 rates for real hosts should be unchanged, and placeholder hits should show up on their
   own counter.

**Rollback:** `… wrangler rollback c9852dba-bfd6-49ff-9c84-d657e48e61fb --config wrangler.toml` (the 0.49.1 version, main
ff64761). Nothing in D1 needs undoing. The `placeholder` rows in paywall_daily are ignored by 0.49.1's stats, because
0.49.1 only reads known events.
