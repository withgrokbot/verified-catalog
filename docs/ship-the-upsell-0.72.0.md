# 0.72.0: ship the upsell (finishes the 0.62.0 paid_check work)

Every free check answer now carries one structured offer for the full (paid) check, and receipt pages show a "Full check" panel. Nothing else about the free tier changes: no new limits, no removed or renamed fields, same status codes.

## The offer object (`paid_check`)

Built by `paidCheckBlock(url)` in `worker/src/paidcheck.js`:

| Field | Meaning |
|---|---|
| `product` | `402xAgent paid check` |
| `price_usd` | Price of one paid check, derived from `SPOT_DEFAULT_PRICE_ATOMIC` in `spotcheck.js` (the amount the paid 402 asks for). Not typed anywhere. |
| `endpoint` | `{method, url}` of the paid product. |
| `payment` | Network, asset and atomic amount the 402 quotes. |
| `adds` | What the full report adds over the free check. |
| `how` | Request to send for this URL, plus the steps. |
| `note` | One-sentence summary, built from the price. |

## Where it appears

| Surface | Before | Now |
|---|---|---|
| `GET /v1/products/endpoint-spot-check` free answers, dry run, MCP `endpoint_spot_check` | `paid_check` (0.62.0) | same, plus `product` and `endpoint` |
| `GET /v1/hygiene` (fresh and cached answers) and MCP `x402_hygiene` | none | `paid_check` for the checked URL |
| Receipt pages (live free/redacted and dry-run, crawl) | one-line note | "Full check" panel (`#full-check`) |

Not changed: paid and exempt answers (they are the paid check), 400/429 error answers, the hygiene cache row, `/pricing`, and these free surfaces which do not get the offer yet: facilitator-check, payment-status, get_receipt, discover.

## Price check

`FREE_UPSELL` in lib.js (the "for $0.02" line on free answers) is built from the same constant. `tests/paidcheck_0720_test.mjs` asserts the price in the offer equals the live 402 amount, the `/pricing` row and `SPOT_PAID_ATOMIC`, and that `paidcheck.js` has no price literal.

## Deploy

Normal Worker deploy. No migration, no secret, no config change.
