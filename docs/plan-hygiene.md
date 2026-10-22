# Plan: x402 hygiene scorer (plan only, no code yet)

1. **Pure function** `hygiene(probe) -> {score, grade, deductions[]}` in worker/src/hygiene.js. Input = one unpaid probe (status, headers, body, latency samples); no I/O, no payment. Signals and weights (max 100):
   - x402Version consistency (body vs PAYMENT-REQUIRED header vs accepts shape v1/v2): 20. Fix: "Send one x402Version; v2 uses `amount`, v1 `maxAmountRequired`."
   - amount/units sanity (integer atomic string, >0, matches asset decimals, not implausible): 20. Fix: "amount is atomic units (USDC 6 decimals)."
   - validBefore / maxTimeoutSeconds present and sane (60–3600 s, not past): 10. Fix: "Set maxTimeoutSeconds 60–3600."
   - parseability (valid JSON or base64 header, required fields, known network ids): 20. Fix: "Return JSON with accepts[]: scheme, network, amount, asset, payTo."
   - quote size < 4 KB: 10. Fix: "Trim the 402 body under 4 KB."
   - 402-vs-400 discipline (bad params → 400, not 402; unpaid → 402): 10. Fix: "Validate input before the paywall; reply 400."
   - p50 latency (≤500 ms full, ≤1.5 s half, else 0): 10. Fix: "Unpaid 402 should be fast; p50 was N ms."
2. **Grades**: A ≥90, B ≥75, C ≥60, D ≥40, F <40. Each deduction carries code, points, fix note.
3. **Fixtures** (tests/hygiene_test.mjs):
   - CDP Bazaar network mismatch (listing vs 402 network): NOT in results/ or data/ as a raw capture; only synthetic cases in tests/worker_test.mjs (~L990, L1186). Need to capture a real one (anonymised) from the daily /bazaar run.
   - Frantic v1/v2 mix: NOT found anywhere in repo/results ("frantic" has 0 hits). Need a real capture or a faithful synthetic.
   - Good case: our own api.402xagent.com 402 (or the v1 solana fixture at worker_test L110 as a v1 variant).
4. **GET /v1/hygiene?url=** (free): returns {score, grade, deductions[{code, points, fix}]}. Reuse SSRF guard + isPlaceholderUrl (0.49.2) → 400 before any probe. Rate limit: own free quota (e.g. 20/day per ip prefix, D1 counter), 429 after. Cache: D1 table hygiene_cache(hkey, scored_at, json) TTL 6 h; no new KV writes. 3 latency samples max, 5 s timeout.
5. **Paid reports**: add `hygiene` field (same object) to report.js output; never changes the verdict.
6. **Privacy / no publishing**: no public leaderboard, no badges for other sellers, no page or feed listing anyone's grade. Cache rows are private, never exported to /v1/skips, /saves, /bazaar, recent lists or ops stats; grades returned only to the caller.
7. **Effort**: ~1.5–2 days. Tests: ~12 unit (scorer, each signal + bands + 3 fixtures), ~6 endpoint (SSRF/placeholder, quota 429, cache hit, 400 discipline), ~2 report-field. ≈20 new → ~198 total.
8. **Open questions**: exact latency thresholds and sample count? Weight v1-only sellers down or neutral? Quota shared with spot-check free 5/day or separate? Cache TTL 6 h vs 24 h? Should probe for 402-vs-400 send a deliberately bad param (extra request to the seller)?
