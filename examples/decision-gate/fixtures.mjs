// Offline fixtures for the demos and tests: a fake seller 402 and fake spot-check answers. No network.
import { termsSha256 } from "./gate.mjs";

export const REQUIREMENT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
};
export const RESOURCE = "https://seller.example/api/data";

export function seller402() {
  return new Response(JSON.stringify({ x402Version: 2, accepts: [REQUIREMENT], resource: { url: RESOURCE } }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/** fetch stub for the spot-check API: verdict per call ("pay" answers carry the hash of REQUIREMENT). */
export function stubSpotFetch(verdict = "pay", reasonCode = verdict === "pay" ? "price_ok" : "pay_to_mismatch") {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (verdict === "down") throw new Error("connect ECONNREFUSED");
    if (verdict === "quota") return new Response("{}", { status: 402 });
    return new Response(JSON.stringify({
      verdict, reason: reasonCode, reason_code: reasonCode, confidence: "high",
      payment_terms_sha256: verdict === "pay" ? termsSha256(REQUIREMENT) : null,
      receipt_url: "https://api.402xagent.com/v1/receipts/sc-0000000000000000",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}
