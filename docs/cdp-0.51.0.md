# 0.51.0: CDP facilitator (Bazaar listing), PayAI fallback, Bazaar metadata on all paid routes, self_test label

Plan: docs/plan-cdp-bazaar.md. Ships **inert**: without `FACILITATOR_PRIMARY = "cdp"` and both CDP secrets, every payment
goes to PayAI exactly as in 0.50.2 (test-enforced: same URL, same headers, same body).

## What changed
- `worker/src/facilitator.js`: CDP bearer JWT via WebCrypto (Ed25519 base64 secret, or ES256 PEM in PKCS8 / SEC1 form),
  `facilitatorChain(env, path)`, `callFacilitator` (10 s timeout).
- `verifyAndSettle` (lib.js): if the route's chain starts with CDP:
  - CDP verify 5xx / timeout / network error: verify + settle on PayAI (`fallback_from: "cdp"`).
  - CDP verify 4xx or `isValid: false`: declined, no fallback.
  - After CDP verify succeeds, settle **only** on CDP. A settle 5xx or timeout is a failure, never re-settled on PayAI
    (no double settle). The EIP-3009 nonce also blocks a second on-chain transfer.
- Facilitator recorded per receipt: `access.facilitator` (`payai` | `cdp` | host) on every paid response, and
  `payment_received.facilitator` in Watchtower `wr-` receipts. The PAYMENT-RESPONSE settle object is unchanged.
- `extensions.bazaar` added to the endpoint-report, bulk and watch 402s (POST body schema, small output example,
  docs link). All 8 unpaid 402s keep byte-identical `accepts` (snapshot: tests/fixtures/accepts_0.50.2.json).
- self_test: a paid spot-check whose signer is our payTo or a `DRILL_WALLETS` address gets `access.self_test: true`.
  Its stored receipt is `check_type: "self-checked"` / `caller: "self-test"`, so it is excluded from demand (ops.js) and
  revenue (Analytics `excluded: "self"`, funnel segment `self`). It can never be self-declared by a header.

## Config (names only; no values in the repo)
| Name | Kind | Default | Meaning |
|---|---|---|---|
| `FACILITATOR_PRIMARY` | var | `payai` | `cdp` = CDP first, PayAI fallback |
| `FACILITATOR_CDP_ROUTES` | var | empty (= all) | comma list of route paths that use CDP |
| `CDP_API_KEY_ID` | **secret** | - | CDP API key id (owner sets it) |
| `CDP_API_KEY_SECRET` | **secret** | - | CDP API key secret (owner sets it; never logged/returned) |
| `DRILL_WALLETS` | var | - | extra self-test payer addresses |

## Deploy plan
1. Deploy 0.51.0 with the flag **off** (no FACILITATOR_PRIMARY). Live checks: /health 0.51.0; all 402 accepts unchanged;
   endpoint-report/bulk/watch 402s now carry extensions.bazaar; hygiene still 100; one existing paid flow unaffected.
2. The **owner** creates the CDP project + API key and sets the secrets: `wrangler secret put CDP_API_KEY_ID`,
   `wrangler secret put CDP_API_KEY_SECRET` (no agent handles key material).
3. Flip on spot-check only: `FACILITATOR_PRIMARY = "cdp"`, `FACILITATOR_CDP_ROUTES = "/v1/products/endpoint-spot-check"`; deploy.
4. **With the owner's explicit approval only**: one $0.02 self-test spot-check paid from payTo (or a DRILL_WALLETS
   address) through CDP. Expect `access.facilitator: "cdp"`, `self_test: true`, a Basescan tx to payTo, and a
   self-checked receipt.
5. Poll CDP discovery (`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` and `/discovery/search`)
   for api.402xagent.com/v1/products/endpoint-spot-check; indexing is async.
6. If good, widen FACILITATOR_CDP_ROUTES (or clear it) route by route; organic buyers keep listings fresh (30-day window).

**No recurring self-payments.** One self-test only, with approval. Rollback = unset FACILITATOR_PRIMARY (or redeploy the
previous version); no migration in this release.

## Tests (211 = 198 + 13 in tests/facilitator_test.mjs)
JWT shape (EdDSA + ES256 PKCS8/SEC1, fresh nonce, `uris`), CDP ok / decline / 5xx fallback / timeout fallback, no double
settle, route-scoped flip, default PayAI unchanged, accepts byte-identical for all 8 402s (flag off and on), Bazaar info
validates against its own schema, self_test only for own wallets.

## Unverified (check on first live CDP call)
- JWT claim details are modelled on the CDP SDK (`sub`, `iss: "cdp"`, `nbf`, `exp = nbf + 120`, `uris: ["POST host/path"]`,
  header `kid` + random `nonce`). Older SDKs used a singular `uri` claim; CDP's acceptance of `uris` is untested here.
- The Ed25519 secret format (base64 of seed||pubkey, 64 bytes) and the CDP verify/settle response fields (`isValid`, `invalidReason`,
  `success`, `transaction`, `errorReason`) are assumed to match the x402 facilitator spec. Whether CDP indexes our
  hand-built bazaar extension (vs the SDK's `declareDiscoveryExtension`) is unproven until step 5.
