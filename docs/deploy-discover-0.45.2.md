# Runbook: deploy discovery 0.45.2 (Workers Paid)

**Gate:** run only once the account is confirmed on Workers Paid (confirmed 2026-10-20 1:48 PM PDT).
Branch `discover-paid-0.45.2` (from main `ecc8844`) = the discovery rework (`9f077f9`) + the signer fix (`b438bb8`), plus 0.45.2 (cold/warm CPU cuts, `[limits] cpu_ms = 5000`).
Production D1 already has the 76 `d:` rows (Oct 20 crawl) and an empty `discover_index`, so no data step is needed.
Rollback target: **`885a995b-36da-4a83-b1cf-cfbd4193f134`** (0.44.0, == main `ecc8844`).

All git goes through the guard hooks with the repo-local withgrokbot identity, never `--no-verify`.
`W` = `env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx -y -p node@22 -p wrangler@latest wrangler`.

## 0. Pre-checks
- `git status -sb` clean, main == origin/main.
- Paid plan: `$W deploy` must accept `[limits] cpu_ms` (on the free plan, a CPU limit is rejected by the API), and `wrangler tail` must show cpuTime > 10 ms requests with outcome `ok`.
- `$W d1 execute RECEIPTS_DB --remote --command "select count(*) n from crawl_store where key like 'd:%'"`: expect 76.

## 1. Merge + test + push
`git merge --no-ff discover-paid-0.45.2`, then `node tests/worker_test.mjs && node tests/discover_test.mjs` (105/105, 11/11), then push main with `-c credential.helper='!/usr/local/bin/gh auth git-credential'`.
Sync the factory copy: copy every file in `git diff --name-only ecc8844 HEAD` into `$F/app`, plus `scripts/weekly-crawl/{d1_upload.py,weekly_refresh_skips.sh,build_discover_blobs.py}` into `$F/receipts/scripts/`. Then `diff -rq` must be empty.

## 2. Deploy committed code: `cd worker && $W deploy` (note the Version ID).

## 3. Tail during a burst of >= 100 requests
Start `timeout 300 $W tail --format json > /tmp/tail-0452.json` first and wait ~8 s. Then run step 4. Count the `/v1/discover` events by `outcome` (`ok`, `exceededCpu`, ...), by response status, and the cpuTime p50/p95/max.
**Pass:** >= 100 discover events, `exceededCpu` = 0, 503 <= 1% (429s from the rate-limit step are expected).

## 4. Production checks: `node scripts/deploy/discover-prod-check.mjs 120`
- a. `/health` returns 0.45.2.
- b. `q=crypto price&verdict=pay` returns 200 with pays only, not stale, not partial.
- c. `q=weather` shows skips by default, labeled `verdict:"skip"` with a reason.
- d. `q=x`, `verdict=maybe`, `limit=abc` and `foo=1` each return 400.
- e. Rate limit: 65 x `limit=1` from one UA gives 60 x 200 and 5 x 429.
- f. MCP `tools/call discover` at `/mcp` returns results.
- g. Every receipt verifies against `/.well-known/402xagent-keys.json` (ed25519/JCS).
- h. Production p50/p95 (client-side from the box, N=120 mixed queries).

## 5. Rollback: if 503s are above ~1%, any `exceededCpu`, receipts fail, or other routes regress
`$W rollback 885a995b-36da-4a83-b1cf-cfbd4193f134 -y`, then check that `/health` returns 0.44.0 and `/v1/discover` returns 404.
Then `git revert -m 1 <merge>` on main, test, sync the factory copy and push, so the weekly crawl's own deploy doesn't ship discovery again.

## Notes
- Deploy needs 0 D1 writes; the weekly crawl rewrites only changed `d:` shards (about 230 rows written). KV writes: 0.
- Local (Node): cold full-index load ~0.37 s CPU (was ~0.6 s); a warm query takes 0.04-2.7 ms (19 ms for a word with no hits).
