# Plan 0.46.0: locked teasers + commitments + receipts v2

**Status (2026-10-21): built on branch release-0.46.0.** Differences from the text below:
- Wash is out (Max's decision a).
- Nonces and refs are HMAC(CLIENT_SALT or COMMIT_SECRET) of endpoint + snapshot + 15-day period. This dedupes with an INSERT OR IGNORE and no read. With no secret set, they are random.
- `policy` is echoed in the answer only and is never stored or signed (it is the caller's private budget).
- `?view=evidence` / `evidence_sha256` are deferred: full receipts already carry probe_snapshot.
- Hosted keys are not accepted on endpoint-report: x402 only, $0.05 for everyone.

**Max's decisions (2026-10-21), which override anything below:**
(a) The **wash teaser is removed from 0.46.0**. Future work: on-chain inflows to payTo that look circular or self-funded. Drop `locked.wash`, the `wash` commitment, the wallet_wash table and its tests.
(b) **Keep** the free `history.stable_since` / `last_changed`, marked as deprecation candidates. The no-leak rule applies to the new teaser fields only.
(c) Legacy receipts are **re-signed redacted**: buyer data removed, `redacted_v2: true`, current key, ids stable, old signatures never served. **Shipped first as the 0.45.6 privacy hotfix** (branch privacy-hotfix-0.45.6).
(d) Commitment TTL is **30 days**.
(e) endpoint-report costs **$0.05 for everyone** (hosted integrators too).
(f) Grades: quality_ok **A**, bad_content_type **C**, schema_mismatch **D**, bad_status/unreachable **F**; quality_unverified shows **"–"** plus a reason (no letter).

One release: Part A teasers, locked_commitments, compact receipt v2 fields, privacy fixes. **Later: Watchtower** (push alerts on endpoint drift; reuses commitments and receipt chains).

## 0. Audit: what Ed25519-signed live receipts (`buildLiveReceipt`, lib.js ~1363; signed as served, `signed_view`) carry today
| Item | Today | Fields / gap |
|---|---|---|
| Observed 402 terms | **partial** | `live_402.accepts[]` = scheme, network, asset, amount_atomic, pay_to; `approved_payment` (pay only) has `valid_before`. **Missing:** x402Version, validBefore per accept. Free/dry-run views are redacted (`accepts_count` only) |
| Structured diff | **no** | only `reason`/`reason_code`/`reason_text` plus `listing` and `expected` side by side; no `[{field, listed, observed}]` |
| observed_at + latency | **partial** | `checked_at`, `probe.probed_at`, `probe.cached`; `latency_ms` exists on the probe (spotcheck.js) but is **not** in the receipt |
| Queried URL + request hash | **partial** | `url` (stored form; query stripped), `method`, `norm_key` = sha256(normalized URL+method), deleted from redacted views; `payment_terms_sha256`. No hash of the exact request (method+URL+body) bound in |
| supersedes | **no** | `pay_to_changed` does a prev-receipt lookup (1 indexed read) but does not keep the id |
| confidence + uncertainty | **partial** | `reason_code`, `confidence` (rules.js); no `uncertain:[{what, why}]` (e.g. wash unknown, RPC unreachable) |
| Source vintage | **partial** | `listing.source`/`expected.source` (list name); crawl receipts have `timestamp`; no `crawl_id` or crawl date on live receipts (RECEIPTS_META.crawled_at exists) |
| Hygiene grade | **no** | `quality` code only (not in the receipt body); no letter |
| Policy context (guard) | **no** | nothing; must stay opt-in |

## 1. Shapes
Free spot-check answer (free branch lib.js ~1847, dry-run ~2113, MCP `endpoint_spot_check`) adds:
```json
"locked": { "drift": {"teaser":"2 changes in 30d","count_30d":2}, "wash": {"teaser":"not yet analysed","status":"not_cached"},
            "hygiene": {"grade":"B"},
            "unlock": {"method":"POST","url":"https://api.402xagent.com/v1/products/endpoint-report","price_usd":"0.05","body":{"url":"https://api.402rates.com/v1/ping","commitment_ref":"cm-…"}} },
"locked_commitments": { "ref":"cm-<16 hex>", "expires_at":"…", "alg":"sha256(JCS({snapshot,nonce}))",
            "drift_history":"sha256:…", "wash":"sha256:…", "hygiene_detail":"sha256:…" }
```
Paid `POST /v1/products/endpoint-report` `{url, commitment_ref?}` ($0.05 x402; signed `er-<16 hex>` receipt) returns `revealed: {drift_history:{snapshot, nonce}, wash:{…}, hygiene_detail:{…}}`. These are exactly the committed snapshots, plus a separate `current` block if the caller asks for fresh data. Without a ref (or after the ref expires) it commits and reveals in one step.

Receipt v2 compact fields (all additive and signed; the receipt stays under ~1.5 KB): `x402_version`, `accepts[].valid_before`, `diff:[{field:"price",listed:"0.02",observed:"0.05"}]` (diff values are redacted on free receipts: field names only), `probe.latency_ms`, `request_sha256` (JCS of method+normalized URL+body hash), `supersedes` (previous sc- id from the existing pay_to_changed read, 0 extra reads), `confidence` + `uncertain:[{what:"wash",why:"rpc_unreachable"}]`, `source_vintage:{list, crawl_id, crawl_date}`, `hygiene_grade`, and `policy` **only when the caller sends** `policy={cap_usd, remaining_usd}` (echoed, never inferred). The full verbose evidence (probe_snapshot, history rows, raw headers excerpt) moves behind `permalink` + `?view=evidence`; it is not signed inline but bound by `evidence_sha256`.

## 2. Data sources and cost per free call
- **Drift:** the `summary.list` from `recordHistory` (rows are already read) → `driftCount30d`. 0 extra reads. The cap is 30 rows (say "≥N" when the window is cut).
- **Hygiene:** `qualityFor` code → letter map (ok A, unverified B, bad_content_type C, schema_mismatch D, bad_status/unreachable F), published in rules.json. 0 reads.
- **Wash:** nothing exists. New table `wallet_wash(pay_to_hash, network, status, signals_json, checked_at)` is filled only by paid reports or a capped cron. The free path does 1 indexed read and never calls RPC.
- **Commitments:** 1 D1 insert per free call into `commitments(ref, digest_json, snapshots_json, nonces_json, created_at, expires_at)`, TTL 7 d, pruned on cron. Dedupe by (hkey, snapshot hash) within the 5-min probe cache window so repeated calls reuse one ref. Nonces come from `crypto.getRandomValues` (32 B each).
- **Total:** +1 read, +1 write (at most), about 1 ms CPU (3 sha256 over small JCS). KV untouched. Quota is 5/day, unchanged.

## 3. Paid route wiring
Copy the payment-status flow (lib.js ~3487-3725): a bare request gets a discovery 402 with nothing read → parse → hosted → always 402 unless paid/hosted/exempt → `checkPayload` → settle → sign → store → `recordHosted("endpoint-report")`. Constants `ER_ID`, `ER_PAID_ATOMIC="50000"`. List it in PAYMENT_POLICY/pricing, `/.well-known/x402` resources, OpenAPI (requestBody example, no bare templates), llms.txt (concrete example), /docs#endpoint-report, and the MCP tool `endpoint_report`. The settle response is not written into the report body (see §5).

## 4. Commitment verify procedure (published in /docs and x402-spotcheck)
1. From the free answer keep `locked_commitments` (and its signed receipt if one exists; the digests are included in the signed free receipt).
2. After paying, for each key k: `d' = "sha256:" + hex(sha256(JCS({snapshot: revealed[k].snapshot, nonce: revealed[k].nonce})))`.
3. Accept only if `d' === locked_commitments[k]` and the er- receipt signature verifies against `/.well-known/402xagent-keys.json`.
4. Server side: the report loads the row by `commitment_ref` and returns the stored snapshot+nonce verbatim; it never recomputes from live data. Newer data goes only in `current`.

## 5. Privacy invariants (enforced in one `publicView()` and asserted by tests)
Never: client IPs (or IP-derived ids), buyer wallets, payment payloads/signatures/authorizations, nonces of buyer payments. The paying tx hash is omitted by default and included only with `include_payment_tx=1`.
**Current violations found (fix in 0.46.0):**
- Paid live receipts: `payment_received.payer` (buyer wallet), `settle_tx`, `basescan_url` (lib.js ~1841, `paymentReceived` ~3729). Paid tiers are FULL_TIERS, so these are served publicly at the permalink and are inside `signed_view`.
- payment-status receipts (`/v1/receipts/ps-…`, paystatus.js ~355): `query.from`, `query.nonce`, `query.tx_hash`, `authorization.from/nonce`, `tx.hash`, `tx.submitter`, `tx.transfer` (buyer wallet and tx), served publicly by id.
- Fix: new writes store these only in private columns. Old signed rows are served re-signed by the current key with the fields removed plus `redacted_v2:true` (the original signature is kept private). Decide whether that is acceptable (open question). `client` is already stripped (0.42.4); seller `pay_to` is public by design.

## 6. Tests
1. `locked` and `locked_commitments` key sets are exactly the whitelist. The free body contains no change timestamps/observed_at, no diff values, no field names inside `locked`, and no wallet.
2. Drift count 0/1/2, rows older than 30 d excluded. The grade map covers every QUALITY_CODE.
3. Wash on the free path: stubbed fetch shows 0 RPC calls; cache-only; `uncertain` is set when the cache is empty.
4. Commitments: reveal verifies; **tampered snapshot** fails; **wrong nonce** fails; **newer data**: history changes after the commit, the report still reveals the committed snapshot, the digest matches, and the newer data appears only in `current`; expired ref → fresh commit-and-reveal; nonces unique and 32 B.
5. Free-path D1 budget is at most baseline +1 read +1 write; the quota counter is unchanged.
6. endpoint-report: discovery 402 with nothing read; bad payload 402; paid 200 + signature verifies; hosted metered; $0.05 in accepts.
7. Receipt v2: every compact field is present and signed; size under 1.5 KB; `supersedes` chains; `policy` absent unless sent; `evidence_sha256` matches `?view=evidence`.
8. Privacy sweep over every public view (sc-, ps-, er-, crawl, /v1/receipts lists, MCP): no buyer payer address, no `settle_tx` unless opted in, no payment payload/nonce, no IP. Run with synthetic paid and payment-status fixtures. These tests should fail on today's code.
9. Discovery docs list endpoint-report; the 0.45.5 no-bare-template test still passes.

## 7. Rollout, risks, open questions
Migrations 0012 wallet_wash and 0013 commitments go in before deploy. Paid route behind `ENDPOINT_REPORT=1`, tested first on Base Sepolia, then one $0.05 mainnet self-test. VERSION/package/server.json 0.46.0. Deploy only after approval.
Risks: commitment writes on every free call (dedupe, TTL); thin data oversells (show "no data yet"); re-signing old receipts changes their signatures; 30-row history cap.
Open: (a) wash definition and data source; (b) whether to trim free `history.stable_since/last_changed` (they leak "when"; affects x402-spotcheck); (c) how to treat already-public buyer wallets/tx in old signed receipts; (d) commitment TTL (7 d?); (e) hosted price for reports; (f) grade boundaries.
