# Plan 0.49.0: explanation line, re-check window, bulk endpoint report

Status: plan only (Max approved the build on 2026-10-21; no code in this branch). Base: main bb07e78 (0.48.0 live, CF 05b2f7c2).
Files read: worker/src/report.js (teasers, commitments, receiptV2/diffOf), lib.js handleEndpointReport + free-answer `locked` path
(lockedBlock at ~1552, free diff reduced to field names at ~1600), privacy.js (scrubView), migrations 0012/0014, ops.js.

## 1) Explanation line (`explain`)

Deterministic template over structured data we already have. No LLM, no free text from sellers.

- Input (paid): `diffOf(exp, probe, pm0)` (listed vs observed price / pay_to / network) plus `driftSnapshot().changes` and the
  hygiene snapshot. Input (free): only what the free answer already shows: `receipt_v2.diff[].field` names, `locked.drift.count_30d`
  and the `locked.hygiene.grade`.
- New pure function `explainLine({ diff, drift, hygiene, tier })` in report.js. It uses a fixed clause order (price, payee, network, asset, drift,
  hygiene) and joins with "; ". Numbers are formatted by one helper: USD with 2 to 6 significant decimals, and pct = round((obs-listed)/listed*100), signed.
  - Paid example: "Price moved $0.02 to $0.05 (+150%) since the listing; payee and network unchanged; 2 term changes in 30d; hygiene A."
  - "Unchanged" clauses are emitted only for fields we actually compared (a field missing from the listing becomes "payee not listed").
  - Payee is never printed as an address in the line, even in paid: "payee changed" plus the field already in `revealed`. This keeps the line
    safe to quote in a chat or ticket.
- Free (redacted) variant: field names and the locked teasers only, with no values, direction, percentages or dates:
  "Price differs from the listing; payee and network match; 2 term changes in 30d (locked); hygiene grade C."
  - The price clause is "differs" or "matches" and has no amount or direction, because direction leaks part of the paid diff.
  - The free check already shows the drift count and grade (`locked`), so repeating them adds nothing that wasn't public.
  - Free string templates are a closed enum. A test asserts the free line matches one regex built from that enum (no digits except the count).
- Placement: `explain` and `explain_v` ("1") go in the response. Recommendation: put it inside the signed paid er- receipt,
  but keep it out of the signed sc- receipt core. Reasons:
  - Paid er-: the line is derived only from signed fields (`revealed`, `current`), so signing it costs nothing. Buyers will paste the sentence,
    and a signed sentence can't be edited to say "unchanged". Because the templates are versioned (`explain_v`), a verifier can regenerate the line and compare.
  - Free sc-: receipts are re-signed by the privacy scrub (redacted_v2). A redacted line inside the signature would need its own scrub rule
    and would freeze the template wording in already-published receipts. It stays response-only and goes next to `receipt_v2`, not in it.
    A later wording change is then a response change, not a receipt-format change.

## 2) Re-check window (24h or 10 re-checks)

A paid er- report buys re-checks of the same normalized endpoint (hkey = sha256 of the normalized URL, as today) until
`min(paid_at + 24h, 10 uses)`.

- Proof of possession: a 32-byte random `recheck_secret` (hex, prefix `rks_`).
  - It is returned once, in the paid 200 response body only. It is outside the signed object (the body is spread after signing, the same as the
    Watchtower `watch_secret`), so it never reaches D1 `endpoint_reports.body` or any public view.
  - D1 stores `secret_hash = HMAC-SHA256(RECHECK_PEPPER, receipt_id ":" secret)`. RECHECK_PEPPER is a new Worker secret
    (fallback WATCH_PEPPER? see open questions). No wallet, payer or tx is involved.
  - Request: `POST /v1/products/endpoint-report` with body `{url, recheck_of: "er-…"}` and header `X-Recheck-Secret: rks_…`.
    It is a header, so it doesn't land in bodies, logs or the 400 `received` echo. The 0.48.0 sanitizer already hides long tokens; add `recheck_of` to the sensitive set anyway.
  - Replay safety: a public er- id alone is useless without the secret. Compare with a constant-time compare on the hashes. The secret is per
    receipt and bound to its hkey, so a leaked secret can't be used for other endpoints.
- Atomic counters (D1 is single-writer per DB, so one conditional UPDATE is atomic):
  ```sql
  UPDATE recheck_credits SET used = used + 1, last_used_at = ?
   WHERE receipt_id = ? AND secret_hash = ? AND hkey = ? AND used < max_uses AND expires_at > ?
  RETURNING used, max_uses, expires_at;
  ```
  - Zero rows returned means the request is refused. Then one SELECT by receipt_id tells which error applies (not_found, wrong_secret, wrong_endpoint, exhausted, expired).
    This happens only on the failure path.
  - If the report fails after the credit was taken (store or probe failure), run a compensating `UPDATE … SET used = used - 1 WHERE receipt_id = ? AND used > 0`
    and return 503 with `credit_refunded: true`.
- Rate limit: at most 1 re-check per receipt per 60 s, using `last_used_at` in the same UPDATE (`AND (last_used_at IS NULL OR last_used_at < ?)`).
  - There is a per-IP-prefix cap on failed secret attempts (QUOTA Durable Object, daily-salted /24 hash, as the free counter does; nothing stored in D1).
    After 20 failures in a day, that prefix gets 429 for re-checks.
- Response: a new signed er- receipt with `recheck_of`, `recheck: {used, max_uses, expires_at}` and `tier: "recheck"`, with no `payment_received`.
  It includes a fresh `current` and the same `revealed` from the original commitment (or a new commitment if expired, see open questions).
- Error shapes (JSON, the 0.48.0 400 contract plus `code`; "nothing was charged" wording kept):
  - 401 `recheck_unauthorized` {field:"X-Recheck-Secret"}. Covers both a missing secret and a wrong one, so it doesn't reveal whether the id exists.
  - 404 `recheck_not_found` is not used, because it would let anyone probe ids. Unknown ids → 401 too.
  - 409 `recheck_wrong_endpoint` {field:"url", expected:"the endpoint of er-…"} (only after the secret verifies).
  - 402 `recheck_exhausted` | `recheck_expired`: the normal $0.05 402 with accepts plus `recheck: {used, max_uses, expires_at}`, so the agent can just pay.
  - 429 `recheck_rate_limited` {retry_after_s}, with a Retry-After header.
- Funnel: re-checks count as event `recheck` in paywall_daily (no new table). The event field is free text in 0014, so no migration is needed for that.

## 3) Bulk report (up to 5 URLs, $0.20 = 200000 atomic, Base mainnet)

- Route: `POST /v1/products/endpoint-report/bulk` with body `{urls: [..1-5], commitment_refs?: {url: ref}}`.
  - A separate route with its own 402 accepts (amount 200000, eip155:8453, same payTo/asset). It is listed in .well-known, OpenAPI, llms.txt, MCP and pricing.
  - A bare call or a missing header returns the discovery 402.
- Validation before any settlement:
  - Parse, normalize and dedupe (by hkey) all URLs. Run the SSRF and URL checks (no fetch).
  - Any invalid entry → 400 with `field: "urls[i]"`, and nothing is charged. Fewer than 5 is still $0.20 (flat; see open questions). More than 5 → 400.
- Then verify + settle once, and only then build the reports. The current single-report flow stores data and has no live probe, so
  the work is D1 only:
  - For 5 URLs: about 5 × (history read + quality read + commitment insert + report insert). Do the reads in one `db.batch`, and the inserts in one batch.
  - Budget: under 150 ms of CPU (5 signatures at about 1 ms each; JCS and sha256 are small) and 2 to 3 D1 round trips. That is well under cpu_ms 5000 and the subrequest limit.
  - `include_current` stays stored-data only, so there are no outbound probes. If a later version adds live probes, cap at 5 parallel with a 4 s timeout each.
- Per-URL results: `{results: [{url, status: "ok"|"failed", receipt_id?, receipt? (signed er-), error?: {code, message}, credit?}], bulk_id: "eb-…", payment_received (scrubbed in views), explain per result}`.
  - Each ok result is an independent signed er- receipt with `bulk_id` and `bulk_index` (verifiable alone). The bulk envelope is signed too.
- Partial failure after payment: no money is refunded on-chain (x402 has no refund path). A failed URL instead returns a credit:
  - A `recheck_credits` row with `max_uses = 1`, a 7-day expiry, `kind = "bulk_retry"` and its own `rks_` secret, bound to that URL's hkey.
  - The client redeems it with the same re-check call, and it yields a full first report (not a re-check of a missing one).
  - Ok URLs also get the normal 24h/10 re-check window each. Five secrets are returned, all outside the signed objects.
  - If ALL URLs fail before any report row is written (D1 down), the call returns 503 with credits for all 5 if the credit insert works. If even
    that fails, it is logged as `bulk_unfulfilled` in paywall_daily so we can handle it manually. This is an open question for Max.
- Privacy: there are the same scrub rules for eb- and er- views (payer/settle_tx/basescan removed). No IP, wallet, proof or tx in any new table. Secrets are hashed only.

## Migrations

- `0015_recheck_credits.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS recheck_credits (
    receipt_id TEXT PRIMARY KEY,    -- er-… (window) or er-… placeholder id for a bulk_retry credit
    kind TEXT NOT NULL,             -- window | bulk_retry
    hkey TEXT NOT NULL,             -- sha256(normalized url)
    secret_hash TEXT NOT NULL,      -- HMAC(RECHECK_PEPPER, receipt_id ":" secret)
    used INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL,      -- 10 | 1
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,       -- +24h | +7d
    last_used_at TEXT,
    bulk_id TEXT                    -- eb-… or NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recheck_expires ON recheck_credits (expires_at);
  CREATE TABLE IF NOT EXISTS endpoint_bulk (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL); -- signed eb- envelope
  ```
- Prune expired credits on paid calls (the same waitUntil as pruneCommitments). Apply the migration before the deploy, as with 0014.
  All new code tolerates a missing table (503 `store_unavailable`, nothing charged, because the table check runs before settle).

## Test plan (tests/report_test.mjs, real SQLite through all migrations, the 0.48.0 ops_test harness)

- explain:
  - Golden strings for about 12 diff/drift/hygiene combinations, and the same input gives the same bytes.
  - The paid line is inside the signature and regenerates from the signed fields.
  - The free line matches the closed-enum regex. Property test: 200 random diffs where no amount, address, % or date appears in the free line or anywhere in the free answer.
- recheck:
  - The paid response has the `rks_` secret, but D1 and the public er- view don't (raw table dump scan).
  - 10 successes, then the 11th returns 402 exhausted. After 24h (clock stub) it returns 402 expired.
  - A wrong secret, a missing secret and an unknown id all return the identical 401. A wrong URL returns 409. Two calls within 60 s → 429.
  - Concurrency: 12 parallel redeems against a count of 9 used allow exactly 1 success.
  - A failure after the credit was taken → refunded (used unchanged).
- bulk:
  - A bare call returns 402 with amount 200000. A 6th URL, a bad URL or a duplicate URL → 400 with nothing settled (facilitator stub count 0).
  - 5 ok → 5 independently verifying er- receipts plus the eb- envelope.
  - An injected failure on URL 3 → 4 ok, plus 1 failed with a bulk_retry credit that redeems to a full report once.
  - CPU: 5 URLs under 150 ms on a local run (a guard test with headroom).
  - The privacy sweep covers all new tables and views.
- Regression: worker 120, watch 18, discover 11 and ops 6 all stay green. ops funnel counts `recheck` and the bulk route.

## Open questions for Max

1. Should a bulk with fewer than 5 URLs cost a flat $0.20, or should 1 to 3 URLs be refused with a pointer to the $0.05 single report? Plan: flat, with a hint field.
2. For a re-check after the original commitment expired (30d TTL > 24h, so only for bulk_retry credits), make a new commitment? Plan: yes.
3. RECHECK_PEPPER as a new secret (recommended), or reuse WATCH_PEPPER?
4. Is a bulk_retry credit valid for 7 days long enough? And is there a manual path when the credit store itself is down after settlement (rare; logged)?
5. Should the paid explain line ever name the new payee address? Plan: no; the address stays in `revealed`.
6. Should the free explain line go on MCP `check_endpoint` too? Plan: yes, the same redacted variant.

## Size estimate

- report.js explainLine + templates: about 120 lines. Re-check (lib.js route branch + report.js credits): about 180. Bulk route + 402 + listings: about 220.
- Migration 0015: about 25 lines. Tests: about 450 lines. Docs/OpenAPI/llms/pricing: about 80.
- Total: about 600 lines of code plus 450 of tests, which is about 1.5 to 2 build days including review. Each feature ships behind a flag (`EXPLAIN_LINE`, `RECHECK`, `BULK_REPORT`),
  in the order 1 → 2 → 3, because 3 reuses 2's credit table.
