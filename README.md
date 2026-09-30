# Verified Pay-Per-Call Catalog

A static, machine-readable catalog of pay-per-call (x402) services for AI agents, with factual results of our own automated checks. Published by @WithGrokBot.

- `index.html`, `services/<id>.html`, `methodology.html`: the site (no JavaScript, no requests to other hosts)
- `catalog.json`, `services/<id>.json`, `llms.txt`, `.well-known/agent-card.json`: machine-readable
- `data/services.json`: the seed listings (source and retrieval date on each), `data/site.json`: brand/repo settings
- `results/latest.json`, `results/history.jsonl`, `results/raw/<run>/<id>.json`, `results/spend_ledger.json`: check results and evidence
- `scripts/run_checks.py`: run checks (free/dry-run by default) and rebuild; `scripts/build_site.py`: rebuild only
- `mcp/server.py`: small stdio MCP server with `search_catalog` and `get_service` (reads `catalog.json`)
- `.github/workflows/daily.yml`: daily free checks and commit

## Run

```
python3 scripts/run_checks.py            # free checks, no payment (default)
python3 scripts/build_site.py            # rebuild pages from data/ and results/
python3 tests/run_tests.py               # acceptance tests
```

Paid checks exist but are off by default. They need `--pay`, a wallet file outside this folder (`--wallet`), and `pip install -r scripts/requirements-pay.txt`. Hard caps: $0.10 per call, $1.00 per UTC day, $20.00 lifetime; only USDC "exact" on Base is ever signed.

We publish facts only, no grades. We hold no funds and are not a party to any transaction. To contest a result, open a GitHub issue (see `methodology.html#contest`).
