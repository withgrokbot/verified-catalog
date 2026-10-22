# Plan: list 402xAgent in CDP x402 Bazaar (PLAN ONLY, 2026-10-22, no code/deploy/payments)
## 1. How indexing works (CDP docs)
- No registration: CDP catalogs a route the first time **the CDP facilitator settles** a payment for it (verify alone is not enough), and only if the settled paymentPayload carries `resource` and the 402 carries `extensions.bazaar` (info.input/output + JSON schema; `declareDiscoveryExtension` shape). Indexing is async. Listings with calls but no activity in 30 days drop out.
- We settle via **PayAI** (`FACILITATOR_URL = https://facilitator.payai.network`, wrangler.toml:50, lib.js:78), so nothing has ever settled through CDP. Confirmed: a 32,724-item scan of /discovery/resources on Oct 22 had 0 hits for us.
- Our 402s: `extensions.bazaar` is present on lookup/paid, overnight-cos-pack, endpoint-spot-check (trimmed in 0.50.2: output = {type, docs}) and payment-status. It is **missing** on endpoint-report, bulk and watch (lib.js:2241 `extensions: {}`). v2 `resource` is present, so x402 v2 clients echo it in the payload.
## 2. Options
- A) Switch fully to CDP: one facilitator, every paid call indexed. Adds KYT/OFAC screening (may decline some payers).
- B) **Recommended: CDP primary, PayAI fallback.** settle() tries CDP; on 5xx/timeout (not a 4xx decline) it retries on PayAI, with the facilitator recorded per receipt. Both settle the same EIP-3009 authorization, and the nonce makes a double settle impossible.
- C) Route only selected products via CDP: smaller blast radius, but partial listing.
- Requires a CDP account and project, plus `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` as wrangler secrets. Each verify/settle call needs a short-lived JWT signed with the key (Ed25519/ES256 via WebCrypto in the Worker; the cdp-sdk is not needed).
## 3. Buyer / payTo impact
- accepts are unchanged (scheme exact, eip155:8453, USDC, amount, payTo 0x37cf…8674, maxTimeoutSeconds), so buyers see no change: the facilitator is server-side only. Not a breaking change.
- Differences: CDP KYT may reject flagged payers (a new 402 reason, to be logged). The settle response/tx shape differs slightly, so normalise it in one adapter.
## 4. Cost
- CDP: first 1,000 on-chain settles per month free, then $0.001 each; verify is free; gas is covered by the facilitator. Our volume is far below 1,000/month, so ≈$0.
- **Flag for the owner:** a listing needs ≥1 real **mainnet settlement through CDP** per route. A self-payment ($0.02–$1, net-zero to payTo) is a real payment and needs owner approval. Alternative: wait for organic buyers.
## 5. Steps (est. 1.5–2 dev days + async index wait)
1. Owner creates the CDP project + API key (secret handling by the owner only).
2. Add a `facilitator.js` adapter: CDP JWT auth, verify/settle, normalised result, PayAI fallback, flag `FACILITATOR_PRIMARY=cdp|payai` (default payai = no change).
3. Add `extensions.bazaar` to endpoint-report, bulk and watch (POST body schemas). Consider restoring a small output example on spot-check (<4 KB budget).
4. Tests: mock CDP verify/settle (ok, decline, 5xx→fallback, timeout), JWT shape, accepts byte-identical snapshots for all 7 402s, bazaar schema validity (ajv against the declared schema).
5. Deploy with flag=payai (no-op), set secrets, flip to cdp on one route (spot-check) first.
6. With owner approval: one self-paid $0.02 spot-check settle via CDP. Check EXTENSION-RESPONSES, then poll /discovery/resources and /search.
7. Roll out to all routes; add the 30-day activity watch (alert if a route has no CDP settle in 25 days).
## Test plan (live)
/health; 402 accepts unchanged; one CDP settle lands (Basescan tx to payTo); PayAI fallback forced via a bad CDP URL on a dry-run route; listing appears; hygiene stays 100.
## Risks
CDP outage (mitigated by the fallback); KYT declines; indexing delays or misses (see x402 issue #2156); key leak (secrets only, never logged); facilitator double-settle (prevented by the nonce; check receipts); the 30-day delisting rule.
## Sources
https://docs.cdp.coinbase.com/x402/bazaar · https://docs.cdp.coinbase.com/x402/seller/facilitator · https://docs.cdp.coinbase.com/x402/quickstart-for-sellers · https://docs.cdp.coinbase.com/x402/core-concepts/facilitator · https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/list-x402-resources · https://docs.x402.org/extensions/bazaar · https://github.com/coinbase/x402/blob/main/docs/extensions/bazaar.mdx · https://github.com/x402-foundation/x402/issues/2156
