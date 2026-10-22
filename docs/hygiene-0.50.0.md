# 0.50.0: x402 hygiene scorer (free GET /v1/hygiene)

Branch `feat/0.50.0-hygiene` (from main after the 0.49.3 deploy). Plan: docs/plan-hygiene.md, with Max's answers (2026-10-22).

## What
- `worker/src/hygiene.js`: pure `hygiene(probe) -> {score, grade, deductions[{code, points, fix}], na[]}`.
  Weights: version consistency 20, amount/units 20, maxTimeoutSeconds 60–3600 10, parseability 20 (unknown network 10, listing-vs-402 network mismatch 10), quote < 4 KB 10, 402-vs-400 10, p50 latency 10 (≤500 ms full, ≤1.5 s half, else 0).
  Grades A ≥90, B ≥75, C ≥60, D ≥40, F <40. v1-only sellers are neutral: only inconsistency (or no version) costs.
  402-vs-400 is scored only from the normal unpaid probe (402 = ok; 400/422 carrying x402 terms = deduction); otherwise n/a. n/a signals (also latency with no sample) are dropped and the rest reweighted to 100.
  We never send deliberately bad requests to sellers.
- `GET /v1/hygiene?url=` (free): bad url / placeholder / SSRF -> 400 before any probe or quota. Cache hit (24 h) is free. Otherwise 20/day per client network (D1 `hygiene_quota`, key = salted sha256 of the /24 or /48; no raw IP or prefix stored) -> 429 after. Up to 3 normal unpaid GETs (only 1 if the first is not a 402), 5 s timeout, redirects not followed. Returns {url, score, grade, deductions, scored_at, cached}.
- Paid endpoint report (er-) gets `hygiene` (cached score only, no extra seller request; null + note when not scored in 24 h). Informational; never changes any verdict.
- Privacy: no leaderboard, no badges for others; `hygiene_cache`/`hygiene_quota` are read only by hygiene.js and never exported to /v1/skips, /saves, /bazaar, recent lists or ops stats (test-enforced).
- Listed in llms.txt, /skill.md and MCP tools/list (`x402_hygiene`).
- Fixtures: tests/fixtures/hygiene.mjs (synthetic, anonymised): CDP Bazaar network mismatch, Frantic-style v1/v2 mix, good v2, good v1.
- Tests: 178 -> 193 (tests/hygiene_test.mjs, 15; worker_test MCP list + version bumped).

## Deploy plan (NOT executed)
1. Migration: `cd worker && env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN WRANGLER_CACHE_DIR=/tmp/wrangler-cache <node> <wrangler> d1 migrations apply vc-spot-receipts --remote --config wrangler.toml` (applies `0016_hygiene.sql`; additive, IF NOT EXISTS).
2. Merge feat/0.50.0-hygiene to main, push, `wrangler deploy --config wrangler.toml`; note the version id.
3. Live checks: /health = 0.50.0; `/v1/hygiene?url=https://example.com/x` -> 400; `?url=http://127.0.0.1/` -> 400; `?url=https://api.402xagent.com/v1/products/endpoint-spot-check` -> 200 with score/grade/deductions, second call `cached: true`; llms.txt, /skill.md, MCP tools/list show it; lookup, discover, placeholder 402 and the $0.05 report accepts unchanged; /v1/skips, /saves, /bazaar, ops stats show no hygiene data.
4. Rollback: `wrangler rollback b4404f4b-59a1-428e-9e05-0625b54d2017` (the 0.49.2 version; 0.49.3 is 2942a157-5c05-43d5-af70-356e4b4fa8e7 if you only want to step back one). The tables can stay (unused).
