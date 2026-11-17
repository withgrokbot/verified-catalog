# Fix the asking (0.71.0)

Every 400 and 422 JSON answer now carries one machine-readable `fix` object, so a caller can correct the request without reading docs. Status codes and every existing field are unchanged; `fix` is added.

```json
"fix": {
  "expected": { "required": { "url": "..." }, "optional": { "claimed_price": "..." }, "rules": ["..."] },
  "endpoint": { "method": "GET", "url": "https://api.402xagent.com/v1/products/endpoint-spot-check" },
  "example":  { "method": "GET", "url": "https://api.402xagent.com/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping" },
  "docs": "https://api.402xagent.com/v1/products/endpoint-spot-check/docs"
}
```

POST routes get `example: {method, url, headers, body}`. The object is static (worker/src/fix.js): nothing the caller sent is copied into it, so it cannot echo a secret or unbounded input. Where the route already had its own `example` or `fixed_example`, those fields are untouched.

## Where it applies

| Surface | Change |
|---|---|
| Every 400 with a JSON body (API routes, paid x402 products when a payment header is present, unfilled `{template}` paths) | `fix` added by the existing 0.48.0 wrapper (`explain400`), next to `field`/`expected`/`received`/`openapi` |
| 422 (page-to-markdown, pdf-tables) | body unchanged, `fix` added; the route's `reasons` table (robots_txt_disallow, login_wall, ...) is included where it has one |
| JSON-RPC parse error (HTTP 400 on `/mcp`) | `error.data.fix` |
| MCP tool input errors (`isError: true`) | `content[0]` unchanged; a second text block `{"fix": ...}` and `structuredContent.fix`, built from the tool's own `inputSchema`. `search_catalog` and `get_service` are left out: their answers are pinned byte-for-byte to `mcp/server.py` |
| `GET /v1/render/card` with no `t` and no `sig` (401) | `fix` says a card is made by `POST /v1/render/card`; GET only serves a signed link |
| 404 on a known wrong URL (render/card aliases, `GET /v1/render/keys`, `/render`, `/docs/render`, `/mcp/mcp`, `/sse`, `/api/mcp`, `/mcp/v1`) | `fix` names the right route. Status stays 404 and the other fields are unchanged. Render hints only when `RENDER=1`. Unknown paths get nothing extra |

Unchanged on purpose: an unpaid bad request to a paid POST route is still the normal 402 plus `input_error` (crawlers need the challenge); 405 bodies; every 200.

The spot-check 400 already had its own compact hint (`example`, `fixed_example`, `mistake`, `hint`). Its `fix` is a compact variant (+about 520 bytes), so the two size guards in `tests/worker_test.mjs` moved from 1024/1100 to 1536/1650 bytes.

## Where the real mistakes are (baseline, 7 days to 2026-11-17 17:08 UTC)

Source: Analytics Engine `vc_lookups`, which logs only the free check, lookup, pack, payment-status and page views, plus D1 `notfound_daily` for 404s. Render, page-to-markdown, pdf-tables, endpoint-report, watch, feed and MCP-protocol routes write no data point, so their 400/422 are not in these numbers (before or after). 402 is the paywall working as designed and is not counted as an error.

| | count | note |
|---|---|---|
| 4xx errors in AE (402 excluded) | 3,617 of 267,401 logged requests = 1.35% (517/day) | 400: 256, 404: 3,219, 405: 142 |
| 402 paywall answers in AE | 19,818 | not errors |
| 400 by route: payment-status `ps-bad-params` | 72 of 80 requests (90%) | the worst rate of any route |
| 400: free check `spot-bad-params` | 65 of 11,795 (0.55%) | already had a hint; `fix` adds the endpoint and example |
| 400: receipt pages | 96 | `view-receipts` |
| 400: lookup, badge, reputation | 3, 16, 2 | |
| 404 total (D1) | 14,428 (2,061/day) | `GET /v1/receipts/:hex` 2,359 plus 924 with a stray quote (stale or mangled receipt ids), then scanners (`/wp-admin`, `/.env`, `/.git`) and discovery guesses (`/.well-known/*`) |
| 404 that a `fix` now answers | `/mcp/mcp` 44, `/api/mcp` 26, `/mcp/v1` 26, `/sse` 26, `GET /v1/render/keys` 15 (+12 HEAD), `/render` 2, `/docs/render` 2 | about 150 a week |

Render traffic is small: 3 card, 5 pdf and 3 screenshot 402s in the same week (`paywall_daily`), and no render 400/422 is logged anywhere. The "render/card URL mismatch" shows up as `GET /v1/render/keys` (the key signup is POST only), the `/render` and `/docs/render` guesses (the docs are `/v1/render/docs`) and `GET /v1/render/card` without `t` and `sig` (cards are made by POST).

Full numbers: `results/four_xx/baseline-20261117.json`.

## Re-measure 7 days after deploy

Run once 7 full UTC days have passed since the deploy (so the window has no old traffic). Needs `AE_READ_TOKEN` (Account Analytics: Read) and, for `--d1`, the read-only wrangler login.

```
python3 scripts/four_xx_rate.py --days 7 --label after-deployed-<UTC time> \
  --out results/four_xx/after.json --d1 --compare results/four_xx/baseline-20261117.json
```

It prints the 4xx rate and per-day counts by route family and by (product / access / status), and the delta against the baseline. Compare **rates and per-day counts**, not raw totals, since traffic changes. The numbers to watch: `ps-bad-params` and `spot-bad-params` per day, 404s on the wrong-URL list above per day (D1 `top`), and the overall 4xx/day. Self-tagged rows are split out (`four_xx_outside`). The window is 7 days, so expect noise on counts this small (a few hundred 400s a week): treat a change under about 30% as inconclusive.

`python3 tests/four_xx_rate_test.py` checks the script offline.

## No deploy needed to merge; deploy needs

No migration, no new binding, no env var, no secret. Deploy = the normal Worker deploy of 0.71.0.
