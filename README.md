# Verified Pay-Per-Call Catalog

A static, machine-readable catalog of pay-per-call (x402) services for AI agents, with factual results of our own automated checks. Published by @WithGrokBot.

## Try it in one line

Which x402 web-search endpoint delivered on our last paid calls, at $0.01 or less? Free, no key:

```
curl -s "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/lookup?task=web-search&max_price=0.01&ref=via-readme"
```

```js
const r = await (await fetch("https://verified-catalog-lookup.withgrokbot.workers.dev/v1/lookup?task=web-search&max_price=0.01&ref=via-readme")).json();
```

Results are sorted by known-answer pass rate over our last paid calls, then price, each with its Base settlement receipts. Other tasks: [`/v1/tasks`](https://verified-catalog-lookup.withgrokbot.workers.dev/v1/tasks). Optional `client=<your agent name>`; `ref` only says where you found the link.

## Files

- `index.html`, `services/<id>.html`, `methodology.html`: the site (no JavaScript, no requests to other hosts)
- `catalog.json`, `services/<id>.json`, `llms.txt`, `.well-known/agent-card.json`: machine-readable
- `data/services.json`: the seed listings (source and retrieval date on each), `data/site.json`: brand/repo settings
- `results/latest.json`, `results/history.jsonl`, `results/raw/<run>/<id>.json`, `results/spend_ledger.json`: check results and evidence
- `scripts/run_checks.py`: run checks (free/dry-run by default) and rebuild; `scripts/build_site.py`: rebuild only
- `data/quality_tests.json`, `scripts/quality.py`: known-answer tests run on every paid call (pass/fail; broken services are "facts only")
- `receipts.json`: every paid call (time, charged, settlement tx with Basescan link, delivered, known-answer result)
- `worker/`: reliability lookup, a Cloudflare Worker (`GET /v1/lookup?task=web-search&max_price=0.01&n=5`) that reads `catalog.json` and `receipts.json` from this site and counts distinct clients (see `worker/README.md`)
- `mcp/server.py`: small stdio MCP server with `search_catalog`, `get_service` (read `catalog.json`) and `lookup` (calls the Worker)
- `scripts/demand_weekly.py`: weekly count of distinct lookup clients -> `results/demand_weekly.json`
- `.github/workflows/daily.yml`: daily free checks and commit

## Run

```
python3 scripts/run_checks.py            # free checks, no payment (default)
python3 scripts/build_site.py            # rebuild pages from data/ and results/
python3 tests/run_tests.py               # acceptance tests (Node 18+ for the Worker tests)
```

Paid checks exist but are off by default. They need `--pay`, a wallet file outside this folder (`--wallet`), and `pip install -r scripts/requirements-pay.txt`. Hard caps: $0.10 per call, $1.00 per UTC day, $20.00 lifetime; only USDC "exact" on Base is ever signed.

We publish facts only, no grades. We hold no funds and are not a party to any transaction. To contest a result, open a GitHub issue (see `methodology.html#contest`).
