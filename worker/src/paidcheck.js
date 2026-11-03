// 0.62.0: what the $0.02 paid check adds, attached to every free endpoint-spot-check answer (JSON and MCP) and shown as
// one line on free results (homepage box, /docs Try it) and on receipt pages. Price and wording come from the paid path
// (SPOT_DEFAULT_PRICE_ATOMIC, spotPaymentRequired) and the agent card's spot-check skill; no new claims.
// Kept import-free so tryit.js / receipts-html.js can use it without a cycle.
export const PAID_CHECK_PRICE_USD = "0.02";
export const PAID_CHECK_AMOUNT_ATOMIC = "20000"; // = SPOT_DEFAULT_PRICE_ATOMIC (USDC, 6 decimals)
export const PAID_CHECK_NOTE = "The $0.02 paid check adds the full payment terms, pay_to, the deadline and mismatch checks via claimed_price, pay_to and network.";
const API = "https://api.402xagent.com";

/** The paid_check block for a free answer; target is the checked URL (null for the generic example). */
export function paidCheckBlock(target) {
  const u = target ? encodeURIComponent(String(target)) : "<endpoint>";
  return {
    price_usd: PAID_CHECK_PRICE_USD,
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
      steps: "After the 5 free checks per UTC day the same call answers HTTP 402 with the x402 terms; pay them with an x402 client and retry with the PAYMENT-SIGNATURE header. claimed_price, pay_to and network are optional. Never pays the target.",
      mcp: "endpoint_spot_check at " + API + "/mcp (forward PAYMENT-SIGNATURE)",
    },
    note: PAID_CHECK_NOTE,
  };
}
