// 0.62.0: what the $0.02 paid check adds, attached to every free endpoint-spot-check answer (JSON and MCP) and shown as
// one line on free results (homepage box, /docs Try it) and on receipt pages. Wording comes from the paid path
// (spotPaymentRequired) and the agent card's spot-check skill; no new claims.
// 0.72.0: the price is no longer typed here. It is derived from SPOT_DEFAULT_PRICE_ATOMIC (spotcheck.js), the amount the
// paid 402 quotes (tests/paidcheck_0720_test.mjs checks it against a live 402 and the /pricing row), and the offer also
// goes on the free x402 hygiene answer (HTTP and MCP) and, as a "Full check" panel, on receipt pages.
// Imports only spotcheck.js (which imports neither lib.js nor this file) so tryit.js / receipts-html.js can use it without a cycle.
import { SPOT_DEFAULT_PRICE_ATOMIC, SPOT_DEFAULT_FREE_PER_DAY } from "./spotcheck.js";
const usdFromAtomic = (a) => (Number(a) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); // USDC has 6 decimals: "20000" -> "0.02"
export const PAID_CHECK_AMOUNT_ATOMIC = SPOT_DEFAULT_PRICE_ATOMIC;
export const PAID_CHECK_PRICE_USD = usdFromAtomic(PAID_CHECK_AMOUNT_ATOMIC);
export const PAID_CHECK_NOTE = `The $${PAID_CHECK_PRICE_USD} paid check adds the full payment terms, pay_to, the deadline and mismatch checks via claimed_price, pay_to and network.`;
const API = "https://api.402xagent.com";

/** The paid_check block for a free answer; target is the checked URL (null for the generic example). */
export function paidCheckBlock(target) {
  const u = target ? encodeURIComponent(String(target)) : "<endpoint>";
  return {
    product: "402xAgent paid check",
    price_usd: PAID_CHECK_PRICE_USD,
    endpoint: { method: "GET", url: API + "/v1/products/endpoint-spot-check" }, // 0.72.0: the bare route; how.url is the filled template
    payment: { scheme: "exact", network: "eip155:8453", asset: "USDC on Base", amount_atomic: PAID_CHECK_AMOUNT_ATOMIC, protocol: "x402 (HTTP 402)" },
    adds: [
      "the full payment terms (the exact payment to sign)",
      "pay_to",
      "the deadline",
      "mismatch checks via claimed_price, pay_to and network: a mismatch turns into skip or recheck",
    ],
    how: {
      method: "GET",
      url: API + "/v1/products/endpoint-spot-check?url=" + u + "&claimed_price=<usd>&pay_to=<0x...>&network=eip155:8453",
      steps: `After the ${SPOT_DEFAULT_FREE_PER_DAY} free checks per UTC day the same call answers HTTP 402 with the x402 terms; pay them with an x402 client and retry with the PAYMENT-SIGNATURE header. claimed_price, pay_to and network are optional. Never pays the target.`,
      mcp: "endpoint_spot_check at " + API + "/mcp (forward PAYMENT-SIGNATURE)",
    },
    note: PAID_CHECK_NOTE,
  };
}
