// Mastercard Agent Pay "check-before-voucher" demo. SELF-CONTAINED: every Mastercard call below is a STUB.
// No Mastercard API is called, no credentials are used, no token or voucher is real.
//
// Flow (as Mastercard describes Agent Pay / Agent Pay for Machines publicly): the agent meets an HTTP 402, then
// creates or requests a payment credential (an agentic token, or a signed payment voucher within its limit) and
// presents it to the provider. Here the 402xAgent check runs FIRST; on anything but "pay" the agent never asks
// for the credential at all. Assumption: the real buyer-side API exposes some "request credential / create
// voucher" step the agent controls; plug the gate in right before that call.
//   node examples/decision-gate/mastercard-check-before-voucher.mjs [pay|skip|recheck|down]
import { decide } from "./gate.mjs";
import { REQUIREMENT, RESOURCE, stubSpotFetch } from "./fixtures.mjs";

// ---- STUBS (not Mastercard code) ----------------------------------------------------------------
export const mastercardStub = {
  calls: [],
  /** STUB for the buyer-side "create voucher / get agentic token" step. Returns a fake, unusable value. */
  async requestVoucher({ amountMinor, currency, merchant, riskSignals }) {
    this.calls.push({ amountMinor, currency, merchant, riskSignals });
    return { stub: true, voucher_id: "STUB-voucher-0001", amount_minor: amountMinor, currency, merchant };
  },
};
// --------------------------------------------------------------------------------------------------

export async function checkBeforeVoucher({ url, requirement, spotOpts, mc = mastercardStub }) {
  const gate = await decide({ url, requirement }, spotOpts);
  if (!gate.allow) return { voucher: null, blocked: gate.verdict + "/" + gate.reason_code, check: gate.check };
  // USDC has 6 decimals; card rails use ISO 4217 minor units (cents). 10000 atomic = $0.01 = 1 cent (rounded up).
  const amountMinor = Number((BigInt(requirement.amount) + 9_999n) / 10_000n);
  const voucher = await mc.requestVoucher({
    amountMinor, currency: "USD", merchant: new URL(url).host,
    riskSignals: { "com.402xagent.check": { verdict: gate.verdict, reason_code: gate.reason_code, terms_sha256: gate.check.terms_sha256 } },
  });
  return { voucher, blocked: null, check: gate.check };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await checkBeforeVoucher({ url: RESOURCE, requirement: REQUIREMENT, spotOpts: { fetch: stubSpotFetch(process.argv[2] || "pay") } });
  console.log(JSON.stringify(out, null, 2));
}
