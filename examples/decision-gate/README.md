# Decision-gate adapters (examples)

Small, dependency-free examples (Node 18+) of calling 402xAgent's endpoint spot-check **before** an agent
commits to a payment, and of carrying the result into other agent-payment formats. They are examples, not a
published package; nothing here changes the Worker or the `x402-spotcheck` npm package.

Service: `GET https://api.402xagent.com/v1/products/endpoint-spot-check?url=<x402 endpoint>` returns `verdict`
(`pay` | `skip` | `recheck`), `reason_code`, and `payment_terms_sha256` (hash of the approved terms). 5 free
checks per day per client, then the service answers 402 ($0.02). These examples never pay that 402; they treat
it as "unavailable" and, by default, do not proceed.

| File | What it shows |
| --- | --- |
| `gate.mjs` | `decide({url, method, requirement})`: call the check, allow only on `pay` for the exact terms (sha256 of `network\|asset\|amount\|payTo`, same formula as the service). Fail closed by default. |
| `check-before-sign.mjs` | Agent gets a 402, runs the gate, signs only on `pay`. Signing is a stub. `--live <url>` uses the real check. |
| `facilitator-gate.mjs` | `decideFacilitator({url, method, requirement})`: same shape as `decide()`, but calls `POST /v1/facilitator/check` (live terms vs the requirement). Allows only a 200 `match` with `recommendation: "settle"` and the same terms hash; fails closed on timeouts (8 s default), non-200 and malformed bodies. Used by `../verify-before-sign/`. |
| `ap2.mjs` | AP2 payment mandate: `risk_data["com.402xagent.check"]` = `{v, verdict, reason_code, checked_at, endpoint, terms_sha256, terms_match, receipt_url, source}`. |
| `mastercard-check-before-voucher.mjs` | Mastercard Agent Pay style flow: the check runs before the agent requests a voucher / agentic token. **All Mastercard calls are stubs**; no Mastercard API, no credentials. |
| `verifiable-intent.mjs` | Verifiable Intent custom constraint `com.402xagent.counterparty_check` (`allowed_verdicts`, `max_age_s`). |
| `fixtures.mjs` | Offline seller 402 and spot-check stubs used by the demos and `tests/decision_gate_test.mjs`. |

```
node examples/decision-gate/check-before-sign.mjs            # offline, verdict pay
node examples/decision-gate/check-before-sign.mjs skip       # offline, blocked
node examples/decision-gate/mastercard-check-before-voucher.mjs recheck
node --test tests/decision_gate_test.mjs
```

Assumptions (also in the file comments):

- AP2: `risk_data` is an optional, untyped top-level object on `mandate.payment.1` and `mandate.payment.open.1`
  (AP2 repo, `code/sdk/schemas/ap2/payment_mandate.json`, read 2026-10-27). AP2 defines no keys inside it, so we
  use one reverse-DNS key. The value is plain JSON; it is signed along with the mandate by whoever creates it.
- Mastercard: public descriptions of Agent Pay / Agent Pay for Machines say the agent meets a 402 and then creates
  a signed voucher or uses an agentic token. The demo only assumes there is such a step the agent controls, and
  puts the check before it. Amount conversion (USDC 6 decimals to USD cents, rounded up) is a demo choice.
- Verifiable Intent: `spec/constraints.md` (0.1-draft) allows organisation-specific constraint types with
  reverse-DNS names (sec. 6.1, Model B). `com.402xagent.counterparty_check` is our own, unregistered type;
  verifiers that don't know it skip it in permissive mode.
- `checked_at`: the free answer has no timestamp, so the gate uses `checked_at` / `probe.probed_at` when the
  answer has one and the client clock otherwise.
