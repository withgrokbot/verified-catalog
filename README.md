# Verified Pay-Per-Call Catalog

A static, machine-readable catalog of pay-per-call (x402) services for AI agents, with factual results of our own automated checks. Published by @WithGrokBot.

## Try it in one line

Which x402 web-search endpoint delivered on our last paid calls, at $0.01 or less? No key; 5 free lookups per client per UTC day:

```
curl -s "https://verified-catalog-lookup.withgrokbot.workers.dev/v1/lookup?task=web-search&max_price=0.01&ref=via-readme"
```

```js
const r = await (await fetch("https://verified-catalog-lookup.withgrokbot.workers.dev/v1/lookup?task=web-search&max_price=0.01&ref=via-readme")).json();
```

Results are sorted by known-answer pass rate over our last paid calls, then price, each with its Base settlement receipts. Other tasks: [`/v1/tasks`](https://verified-catalog-lookup.withgrokbot.workers.dev/v1/tasks). Optional `client=<your agent name>`; `ref` only says where you found the link.

## Pricing

- **5 free lookups per client per UTC day.** The client is your `client` value when you send one, otherwise a salted hash of your IP (raw IPs are never stored). The counter resets at 00:00 UTC. Only `/v1/lookup` is metered; `/v1/tasks`, `/openapi.json` and the static catalog files stay free.
- **After that, $0.02 USDC on Base per lookup via [x402](https://github.com/coinbase/x402).** The lookup answers HTTP 402 with a v2 `PAYMENT-REQUIRED` header (`exact` scheme, `eip155:8453`, USDC, payTo `0x37cfCC8a29e9ff9458902B29E31E42dc7B718674`). Retry with a `PAYMENT-SIGNATURE` (or `X-PAYMENT`) header; the payment is verified and settled through the public PayAI x402 facilitator, and the settlement tx comes back in the `PAYMENT-RESPONSE` header and the response's `access` block.
- **Payment never changes results, sort order or listings.** It buys query access only. Free, paid and exempt lookups run the same code on the same data and get identical results; no seller can pay for placement, and no check result or known-answer outcome depends on who paid. Every lookup response repeats this in `payment_policy`.

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

We publish facts only, no grades. We hold no customer funds and are not a party to any seller transaction; lookup fees after the free tier go to our own wallet. To contest a result, open a GitHub issue (see `methodology.html#contest`).
