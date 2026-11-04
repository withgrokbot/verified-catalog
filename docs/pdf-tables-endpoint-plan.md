# Plan: x402 / MCP endpoint for PDF table extraction (draft, not built)

Status: implemented in `worker/src/pdftables.js` behind `PDF_TABLES = "1"` (off by default). It fails closed without the `APIFY_TOKEN` secret (503: nothing quoted, charged or run). Not deployed. Migration `0025_pdf_results.sql` is a file only.

## Goal
`POST https://api.402xagent.com/v1/products/pdf-tables`: an agent sends a PDF (URL or bytes), pays per page in USDC on Base via x402, and gets back tables as CSV / JSON / Markdown plus per-page text. Same thing as MCP tool `pdf_tables` on `/mcp`.

## Why the Worker can't do the extraction itself
`verified-catalog-lookup` is a Cloudflare Worker (JS, `cpu_ms = 5000`). pdfplumber, pdfium and Tesseract need Python plus native binaries, and OCR takes 3 to 15 s of CPU per page. So the extraction runs in the private Apify Actor `withgrokbot/pdf-table-extractor` (id `J6l09FT6O2px5hXva`). The Worker only does payment, validation and proxying. Time spent awaiting `fetch()` doesn't count against Worker CPU time.

## Request flow
1. **Validate (free).** Body is `{url, pages?, formats?, ocr?}` or `application/pdf` bytes (max 10 MB). Run the URL through the existing `assertSafeUrl` SSRF guard. Per-network and per-host rate limits come from the existing `QuotaCounter` DO, the same way as `p2m.js`.
2. **Quote.** We bill per page, so the Worker needs a page count before it can ask for payment. It fetches the raw PDF bytes (`guardedGetBytes`: the SSRF guard on every hop, 10 MB cap) and reads the page tree. That is the largest `/Count` of a `/Type /Pages` node, falling back to the number of `/Type /Page` leaves. When the page tree sits inside compressed object streams (PDF 1.5+, `/Type /ObjStm` + `/FlateDecode`, so nothing is visible in the clear), those streams are inflated with `DecompressionStream("deflate")` (at most 200 streams, 8 MB each) and scanned the same way. There's no pdf.js and no extra Apify call. PDFs whose page tree can't be found (e.g. other filters, or encryption) get 422 `page_count_unknown` and are never charged. The count is clamped to `pages` (sync cap 20). The 402 quotes `pages x price` with x402 v2 `exact`, plus `quoted_pages`.
3. **Paid retry.** Call `checkPayload` (amount must equal the quote), then call the Actor synchronously:
   `POST https://api.apify.com/v2/acts/withgrokbot~pdf-table-extractor/run-sync-get-dataset-items?timeout=120&memory=2048`
   with `{pdfUrls:[url], pageRange, maxPages, outputFormats, ocr}`. The header is `Authorization: Bearer ${env.APIFY_TOKEN}`, a new Worker secret that is never in wrangler.toml. If the client uploaded bytes, the Worker first PUTs them to a short-lived KV-store record and passes its signed `recordPublicUrl`.
4. **Settle only on an exact match.** Settle (`verifyAndSettle` with the existing settle-pending/idempotency store) only if the Actor returned exactly one `status: success` row for **every requested page number and no other**. The check is the page set itself, not just the row count, so a missing, duplicate or unexpected page answers 422 "not charged". This matches the Actor's rule that failures are free.
4b. **Replay cache.** Before running the Actor, look up `pdf_results` (D1, migration 0025) by `key = sha256(signature | nonce)` of the x402 payload. A hit with the same request binding (`sha256(url # pages # ocr)`) returns the cached body with `access.cached = true` and **does not re-run the Actor**. A hit with a different binding gets 409 (nothing more charged). After a successful settle, the body is stored with a 24 h TTL, and expired rows are deleted on write. Bodies over 900 KB aren't cached; a replay of those re-runs the Actor, but settlement stays idempotent. The cache is fail-soft: with no table it acts as a miss. No IP, wallet, payment header or tx hash is stored.
5. **Response.** `{pages:[{page, mode, tables:[{rows, csv, json, markdown}], text}], quoted_pages, charged_usd}`, plus the PAYMENT-RESPONSE header.

The MCP tool `pdf_tables` reuses the same route, the same way `page_to_markdown` does. Discovery surfaces (openapi, llms.txt, x402 resources, server.json) get the entry behind an off switch, `PDF_TABLES=off` by default.

## Latency estimate (measured on the Actor, Nov 4 2026)
| Case | Estimate |
|---|---|
| Apify sync-run overhead (container start, input, dataset read) | ~3 to 5 s |
| Digital page | ~0.3 to 0.8 s/page at 1 GB (57 pages in 46 s incl. downloads and startup) |
| Scanned page (OCR, 2 to 4 GB) | ~4 to 15 s/page (OSD rotation check plus Tesseract at 300 DPI) |
| 5-page digital PDF end to end | ~5 to 8 s |
| 5-page scanned PDF end to end | ~25 to 60 s |
| Measured: run-sync with 1 digital page + 1 OCR page + 1 bad URL (2 GB) | ~9 s total |
Apify's run-sync waits up to 300 s, so the sync route should cap at 20 pages, with OCR capped lower if needed. Larger jobs would need an async variant (pay, get a job id, poll), which is out of scope for v1.

## Cost per call (to us)
Measured compute is about $0.045 per 1k digital pages and about $1.2 to $2.7 per 1k scanned pages at $0.20/CU, plus roughly $0.0003 of sync-run overhead per call. A 1-page call costs well under $0.001 in compute, so the x402 price per page (proposed $0.005 digital / $0.015 OCR, mirroring the Actor: an OCR page = 3 `page` units) covers compute with margin even at 1 page. Since the actor is private and called with our own token, there is no Apify marketplace commission on this path.

## Why this needed review (now addressed in PR #59)
- It adds a new Worker secret (`APIFY_TOKEN`) and a new external dependency on a paid service in the request path.
- Quote-then-settle has a variable amount (pages x price), which is new for this codebase. Every existing product uses a fixed price.
- It touches the version-stamped snapshot tests (15+ files per release, as in 0.63.0) and the discovery surfaces.
- It needs a refund-free design for partial failures (decided above: all pages succeed or nothing is settled).

## Suggested implementation steps (next PR, after approval)
1. `worker/src/pdftables.js` modelled on `p2m.js`: config `PDF_TABLES`, `PDF_PRICE_ATOMIC`, `PDF_OCR_PRICE_ATOMIC`, `PDF_MAX_SYNC_PAGES`; `countPdfPages(bytes)`; `handlePdfTables`.
2. Wire the route and `/docs` into `lib.js` with the off switch. Add the MCP tool, openapi, and x402 resources.
3. Tests with a mocked Apify fetch: quote math, page clamping, all-success settle, partial-failure no-settle, SSRF rejection, oversize rejection.
4. Set the secret with `wrangler secret put APIFY_TOKEN` (an Apify token scoped to running this one actor) only when going live.
