# Facilitator fallback (researched Oct 9, 2026, ~1:45 PM PT). NOT deployed.

Today: PayAI (https://facilitator.payai.network). There is no API key. Each Base settlement costs the payee
2.18 credits (live GET /pricing), drawn from 1,000 lifetime free credits per receiving wallet, which is about 450
settlements. After that it needs an API key plus paid credits. PayAI also notes that requests from shared
hosts/IPs (our Worker egresses from Cloudflare) "may reach the limit sooner".
Weekly estimate: receipts/scripts/payai_credits.py (on Oct 9, 2:55 PM PT: ~986.9 credits left, ~452 Base settlements; 6 settlements
to PAY_TO so far). PayAI's /openapi.json has no balance endpoint; its public /discovery/resources/{resource}/stats (4 settlements
in 30 days on our paid resources) is printed as a cross-check.

| Facilitator | Base USDC fee at our volume (hundreds to a few thousand/month) | Account / key | Switch |
|---|---|---|---|
| Coinbase CDP (https://api.cdp.coinbase.com/platform/v2/x402) | 1,000 on-chain settlements free **per month** (resets), then $0.001 each; verify is free; failed settles are free (docs.cdp.coinbase.com/x402/seller/facilitator, /x402/support/faq) | CDP account + Secret API Key (Ed25519), sent as a Bearer JWT on every /verify and /settle (docs.cdp.coinbase.com/api-reference/v2/authentication). Signup at portal.cdp.coinbase.com is a human step | patches/cdp-facilitator.patch (adds the JWT) + config |
| Dexter (https://x402.dexter.cash) | "$0 Dexter fee", no account (dexter.cash/facilitator/base); /supported lists v2 exact eip155:8453 | none | config only. Base payment floor ~$0.0014 (/supported `minPaymentAmountUsd`, Oct 9); our smallest settlement is $0.01, so OK |
| xpay (https://facilitator.xpay.sh) | zero protocol fees, gas sponsored, no auth (docs.xpay.sh/en/x402-protocol/facilitator); /supported lists v2 exact eip155:8453 | none | config only (no OFAC/KYT screening) |

Cost at our volume: CDP is $0 up to 1,000/month, and 3,000/month would cost $2. PayAI after the allowance: ~$0.0022 x N.

## Config-only switch (no code)
Dexter or xpay: in app/worker/wrangler.toml [vars], change
    FACILITATOR_URL = "https://x402.dexter.cash"        # or "https://facilitator.xpay.sh"
then run the tests and deploy. Rollback: set it back to "https://facilitator.payai.network".

## CDP switch (needs the patch + 2 secrets)
1. git apply patches/cdp-facilitator.patch (cfg() gains facilitatorAuth; facilitatorCall adds the Authorization: Bearer <EdDSA JWT>
   with claims {sub, iss:"cdp", aud:["cdp_service"], nbf, exp:+120, uri:"POST api.cdp.coinbase.com/platform/v2/x402/<verify|settle>"}).
   With the secrets unset, it behaves exactly as it does today.
2. printf '%s' "<key id>"     | wrangler secret put CDP_API_KEY_ID
   printf '%s' "<key secret>" | wrangler secret put CDP_API_KEY_SECRET
3. FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"
Local test: node patches/cdp_auth_test.mjs (throwaway Ed25519 key: checks the JWT shape, verifies the signature, checks the
Worker sends the Bearer header to CDP /verify, and checks that unset means PayAI with no header). Not tested against live CDP (no key).

Recommendation: keep PayAI while its credits last (~450 settlements). Before ~100 remain, switch FACILITATOR_URL to Dexter
(config only) after one real low-value settlement test. That test was not run, because there are no more self-test
payments by instruction. For the long term, use CDP (monthly free tier, KYT screening) once a CDP Secret API Key exists (portal signup is a human step).
