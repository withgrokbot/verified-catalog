# 0.72.1: paid_check on discover and MCP get_receipt

Follow-up to 0.72.0 (stacked on it). Same `paid_check` object, same price source (`SPOT_DEFAULT_PRICE_ATOMIC`).

| Surface | Where the offer is |
|---|---|
| `GET /v1/discover` and MCP `discover` (200 only) | top-level `paid_check` (generic: `how.url` has `<endpoint>`) |
| MCP `get_receipt` by `url` | top-level `paid_check` on the by-url wrapper (for that URL) |
| MCP `get_receipt` by `id`: crawl receipts and free/redacted/dry-run live receipts | **beside** the receipt: `result._meta.paid_check` and a second content block `{"paid_check": ...}`. `structuredContent` and `content[0]` are the signed receipt, byte for byte (the signature is ed25519 over JCS of the receipt minus signature, so a new key inside it would break verification) |

Not changed: full (paid) live receipts, ps-/er- receipts, error answers, HTTP `/v1/receipts/*` (its pages got the 0.72.0 panel), facilitator-check, payment-status (by decision).

Deploy: normal Worker deploy, no migration.
