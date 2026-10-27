# Listing snapshots before 0.50.2 (taken 2026-10-22 ~10:40 MST, UTC-7), public sources only

## CDP Bazaar: cdp_bazaar_402xagent.json
Source: GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources (public, all 32,724 items paged).
Result: **no entry** for api.402xagent.com / 402xagent.com / verified-catalog-lookup (file is []). endpoint-spot-check
is not currently listed in CDP Bazaar, so there is no output description/example there to lose.

## x402scan: x402scan_server_b2e7a5af.html, x402scan_recipient_payTo.html
Server page https://www.x402scan.com/server/b2e7a5af-8db5-4019-b0e7-952a93be55c1 (origin https://api.402xagent.com,
found via the public recipient page for our payTo). The JSON API (/api/x402/...) is paid x402, so it was not used.
endpoint-spot-check resource, lastUpdated 2026-10-16T16:19:44Z (Oct 16, 9:19 AM MST):
- description: "402xAgent: SSRF-safe probe of a public URL for an x402 PAYMENT-REQUIRED challenge. Never pays the target. $0.02 USDC on Base after 5 free checks per UTC day."
- stored 402 accepts: amount 20000, eip155:8453, USDC, payTo 0x37cf...8674
- extensions.bazaar.info.output: type json + full paid **example** (verdict/reason/pay_to/history/quality/reputation/access...) + **free_example**; full output schema.
After 0.50.2, a re-scan would see output {type: "json", docs: ".../endpoint-spot-check/docs"} and an input-only schema.

_AT-06 (2026-10-23): the two saved x402scan HTML pages were removed (third-party pages with embedded scripts; nothing linked
to them). The facts above are what was recorded from them._
