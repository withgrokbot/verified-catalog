// "Check before you sign": the agent gets a 402, asks 402xAgent about the endpoint, and only signs if the
// verdict is "pay" for the exact terms it is about to sign.
//   node examples/decision-gate/check-before-sign.mjs            offline (stubbed seller + stubbed spot-check)
//   node examples/decision-gate/check-before-sign.mjs --live URL calls the real spot-check (uses 1 of 5 free/day)
// Signing is ALWAYS a stub here: this file never holds a key and never pays anyone.
import { decide } from "./gate.mjs";
import { REQUIREMENT, RESOURCE, seller402, stubSpotFetch } from "./fixtures.mjs";

// STUB: put your x402 client's signer here (e.g. @x402/fetch's onBeforePaymentCreation hook).
function stubSign(requirement) {
  return { signed: true, note: "STUB signature, nothing was signed", amount: requirement.amount };
}

export async function payIfSafe({ url, method = "GET", fetchTarget, spotOpts }) {
  const first = await fetchTarget(url, { method });
  if (first.status !== 402) return { paid: false, why: "no 402 (HTTP " + first.status + ")" };
  const body = await first.json();
  const requirement = (body.accepts || []).find((a) => a.scheme === "exact");
  if (!requirement) return { paid: false, why: "no exact-scheme accepts entry" };

  const gate = await decide({ url, method, requirement }, spotOpts); // <- the check, before any signature
  if (!gate.allow) return { paid: false, why: gate.verdict + "/" + gate.reason_code + ": " + gate.reason, check: gate.check };
  return { paid: true, signature: stubSign(requirement), check: gate.check };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const live = process.argv[2] === "--live";
  const url = live ? process.argv[3] : RESOURCE;
  if (live && !url) { console.error("usage: --live <x402 endpoint url>"); process.exit(2); }
  const out = await payIfSafe({
    url,
    fetchTarget: live ? fetch : async () => seller402(),
    spotOpts: live ? { ref: "via-decision-gate-example" } : { fetch: stubSpotFetch(process.argv[2] || "pay") },
  });
  console.log(JSON.stringify(out, null, 2));
}
