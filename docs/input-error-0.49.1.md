# 0.49.1: unpaid 402 with input_error, bare /v1/lookup usage

Paid POST routes: `/v1/products/endpoint-report`, `/v1/products/endpoint-report/bulk` and `POST /v1/watch`.

- **No payment header and invalid input:** the route returns the normal 402 (same `accepts`, same `PAYMENT-REQUIRED` header). It adds an `input_error` block, `{code, field, expected, received, note}`, and the response header `x-402-input-error: <field>`. The block is informational only: it never changes the price or the accepts. `received` is sanitized the same way as the 0.48.0 400s: wallets and hashes are not echoed, and URL query strings are dropped.
- **Payment header present and invalid input:** the strict 400 is unchanged and is returned before verify or settle, so nothing is charged.
- **Re-check requests** (`recheck_of`) keep their 400 and 401 responses.

## Bulk price when input is invalid

- `urls` is a non-empty array: the 402 shows the price for `min(urls.length, 5)` URLs, which is `min(n x $0.05, $0.20)`. The agent sees what the corrected request would cost.
- `urls` is missing, empty or not an array: the 402 shows the 1-URL price ($0.05).

The price shown is never more than $0.20.

## Funnel

opsWrap reads `x-402-input-error`. An unpaid 402 that carries it is written to `paywall_daily` with reason `input_error`. It still counts in `402`. `/v1/ops/stats` adds a `402_input_error` counter per route and segment.

## GET /v1/lookup

A request with no parameters other than `client` or `ref` returns 200 with usage, examples, params and links (tasks, paid, openapi, skill). It sets cache-control public max-age=300, loads no data and uses no free quota. An analytics point is written with access `lookup-usage`.
