# Deploy checklist 0.49.0 (explanation line, re-check window, bulk report)

Every new feature is behind a flag that is OFF by default. Deploying 0.49.0 with no flag changes behaves like 0.48.0 except for the
version string. Plan: docs/plan-0.49.0.md (Max-approved, with changes: bulk = min(n x $0.05, $0.20); RECHECK_PEPPER; payee shown as
first 6 + last 4 in paid lines; free line also in the MCP check tool).

Commands run from `/workspace/vc-repo/worker` with the prefix
`env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN WRANGLER_CACHE_DIR=/tmp/wrangler-cache npx -y -p node@22 -p wrangler@latest wrangler`.

## 0. Base deploy (all flags off)
1. Tests on Node 22: worker, watch, discover, ops, report (all green).
2. Apply migration 0015 (safe with flags off; it only adds `recheck_credits` and `endpoint_bulk`):
   `… wrangler d1 migrations apply vc-spot-receipts --remote --config wrangler.toml`
3. `… wrangler deploy --config wrangler.toml`. Verify that /health shows 0.49.0, that endpoint-report gives a 402 with the $0.05 accepts, that discover works, and that
   POST /v1/products/endpoint-report/bulk returns 404 `not_enabled`.

## 1. EXPLAIN_LINE (no migration, no secret)
- Set `EXPLAIN_LINE = "1"` in `[vars]` and deploy.
- Verify:
  - A free check has `explain` (field names and teasers only, e.g. "Price differs from the listing; payee and network match; 2 term changes in 30d (locked); hygiene grade C.").
  - The MCP endpoint_spot_check has the same line.
  - A paid er- report carries a signed `explain`.
- Rollback: remove the var.

## 2. RECHECK (needs 0015 + secret)
- Set the secret, which was generated locally in /home/box/.secrets/recheck-pepper.txt (mode 600) and must never be printed:
  `… wrangler secret put RECHECK_PEPPER --config wrangler.toml < /home/box/.secrets/recheck-pepper.txt`
  (Wrangler reads stdin. Rotating the pepper invalidates every outstanding secret.)
- Set `RECHECK = "1"` and deploy.
- Verify:
  - A paid report returns `recheck.secret` (rks_…), and `/v1/receipts/<er->` does not show it.
  - A POST with `{url, recheck_of}` plus `X-Recheck-Secret` gives a 200 with `tier: recheck`.
  - A wrong secret gives a 401, and a second call within 60 s gives a 429.
- With RECHECK on but no pepper, paid reports say `recheck.available: false` and re-checks return 503 (fail closed).

## 3. BULK_REPORT (needs 0015; RECHECK on for failure credits)
- Set `BULK_REPORT = "1"` and deploy.
- Verify:
  - A bare POST to /v1/products/endpoint-report/bulk gives a 402 with 200000.
  - `{urls:[3]}` gives a 402 with 150000.
  - .well-known and OpenAPI list the route.
- With RECHECK off, a URL that fails after payment gets `credit: null, unfulfilled: true` and is counted as `bulk_unfulfilled` in
  /v1/ops/stats. The manual path is to issue a report by hand (the endpoint URL is in the eb- envelope; there is no wallet).

## Rollback
Turn the flag off and redeploy, or run `… wrangler rollback 05b2f7c2-aa4d-4fd6-8ba3-7db265d7532d` (0.48.0). The migration 0015 tables can stay.
