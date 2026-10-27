// AP2 (Agent Payments Protocol) adapter: turn a 402xAgent check into a risk_data entry for a payment mandate.
//
// Placement (AP2 repo google-agentic-commerce/AP2, code/sdk/schemas/ap2/payment_mandate.json and
// open_payment_mandate.json, checked 2026-10-27): both mandates have an optional top-level `risk_data`
// object, "a map of relevant risk signals collected by the trusted surface at time of mandate creation".
// The schema does not define keys inside it. Assumptions, stated plainly:
//  - we use one reverse-DNS key, "com.402xagent.check", so the entry cannot collide with other signals;
//  - the value is plain JSON (no JWT); whoever builds the mandate signs it with the rest of the mandate;
//  - for x402 rails the endpoint is the resource URL and terms_sha256 covers network|asset|amount|payTo
//    (same formula as the service's payment_terms_sha256), since AP2's payment_amount is ISO 4217 minor units
//    and does not carry the on-chain terms.
import { RISK_KEY } from "./gate.mjs";

export const AP2_RISK_VERSION = 1;

/** { "com.402xagent.check": {...} } from decide(...).check */
export function ap2RiskDataEntry(check) {
  if (!check || !check.endpoint) throw new TypeError("check with endpoint required");
  return {
    [RISK_KEY]: {
      v: AP2_RISK_VERSION,
      verdict: check.verdict ?? null,
      reason_code: check.reason_code ?? null,
      checked_at: check.checked_at ?? null,
      endpoint: check.endpoint,
      terms_sha256: check.terms_sha256 ?? null,
      terms_match: check.approved_terms_sha256 ? check.approved_terms_sha256 === check.terms_sha256 : null,
      receipt_url: check.receipt_url ?? null,
      source: "https://api.402xagent.com/v1/products/endpoint-spot-check",
    },
  };
}

/** Returns a copy of `mandate` with the entry merged into risk_data (other risk signals are kept). */
export function attachToPaymentMandate(mandate, check) {
  const risk = mandate && mandate.risk_data && typeof mandate.risk_data === "object" ? mandate.risk_data : {};
  return { ...mandate, risk_data: { ...risk, ...ap2RiskDataEntry(check) } };
}
